import {
  ActivationAction,
  ActivationRecordV1,
  ActivationResultV1,
  Address,
  CONTRACT_ROLES,
  CONTRACT_ROLE_KEYS,
  MARKET_KEY_SEPARATOR,
  MarketAssetRow,
  MarketContractRow,
  MarketRow,
  MarketStatus,
  MarketV1,
  NetworkPriceExceptionRow,
  NetworkV1,
  PriceExceptionV1,
  PriceQuote,
  RegistryNetworkRow,
  RegistrySnapshotV1,
  RegistryTables,
  RegistryVersionRefV1,
  RegistryVersionRow,
  TokenV1,
  ValidationResultRow,
  ValidationSummaryV1,
  marketKey,
} from '../../lib/model/comet-registry.js';

import { RegistryError } from './errors.js';
import type { VersionRef } from './version-headers.js';
import {
  MarketOverlay,
  NetworkOverlay,
  overlayOfException,
  parseMarketOverlay,
  parseNetworkOverlay,
  storedInstant,
} from './overlay.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { sha256Hex } from '../../lib/hash.js';

/*
 * Reads and writes of the registry tables of APP_DB: candidates and their
 * snapshots, validation attempts, overlays, and the active pointer. The
 * database owns the invariants: the lifecycle, singleton, and append-only
 * triggers of migrations/0001_comet_registry.sql reject anything this module
 * gets wrong, so these functions stay thin and never re-implement those rules.
 */
type SqlValue = string | number | null;

/*
 * What must still hold when a write applies: an expression for a WHERE
 * clause, and the values it binds. Its parameters are numbered from `first`,
 * so it can follow whatever the statement it is added to binds itself.
 *
 * D1 rolls a batch back when a statement fails, not when one changes nothing,
 * so a write that must not apply once something has moved names that in every
 * statement it is made of.
 */
type Condition = {
  sql:    (first: number) => string,
  values: SqlValue[],
};

function both(left: Condition, right: Condition): Condition {
  return {
    sql:    first => `(${left.sql(first)}) AND (${right.sql(first + left.values.length)})`,
    values: [ ...left.values, ...right.values ],
  };
}

/*
 * A statement that applies only while a condition holds. `sql` ends in its own
 * WHERE clause, a conjunction the condition is added to; its parameters are
 * numbered from one, and the condition's follow them. Without a condition it
 * is the statement as written.
 */
function conditioned(db: D1Database, sql: string, values: SqlValue[], condition?: Condition): D1PreparedStatement {
  return condition === undefined
    ? db.prepare(sql).bind(...values)
    : db.prepare(`${sql} AND (${condition.sql(values.length + 1)})`).bind(...values, ...condition.values);
}

type CandidateInput = {
  repository:     string,
  commitSha:      string,
  sourceChecksum: string,
  attempt:        number,
  createdBy:      string,
  versionId?:     string,
  createdAt?:     string,
};

/*
 * The reviewed overlay of one stored version, keyed by chain id and by
 * market key (marketKey), which is how an import looks up the decisions made
 * for a market it rediscovers. `comets` is the Comet each market overlay was
 * made for: a key the source gives another Comet does not hand it them.
 */
type ClonedOverlays = {
  networks: Map<number, NetworkOverlay>,
  markets:  Map<string, MarketOverlay>,
  comets:   Map<string, Address | null>,
};

/*
 * An INSERT of one row, checked against the row type of its table: a column
 * the type names cannot be left out and fall back to its default, which for
 * `reviewed` would record a decision nobody made. With a condition the row is
 * selected rather than stated, so it is inserted only while the condition
 * holds.
 */
function insertStatement<Table extends keyof RegistryTables>(
  db: D1Database,
  table: Table,
  row: RegistryTables[Table],
  condition?: Condition,
): D1PreparedStatement {
  const columns      = Object.keys(row);
  const values       = Object.values(row) as SqlValue[];
  const placeholders = columns.map((_, index) => `?${index + 1}`).join(', ');
  return condition === undefined
    ? db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).bind(...values)
    : db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${placeholders} WHERE ${condition.sql(values.length + 1)}`)
        .bind(...values, ...condition.values);
}

function boolean(value: boolean): number {
  return value ? 1 : 0;
}

/*
 * The checksum of the semantic snapshot: it covers the networks alone, and
 * within them everything except the generated row ids, so importing the same
 * markets twice produces the same value. Row ids are per-write UUIDs; keeping
 * them would make every re-import of unchanged source look like a change.
 * The serialization is canonical JSON, every object's keys sorted, so the
 * order an object happens to be built in never reaches the checksum.
 */
async function snapshotChecksum(networks: NetworkV1[]): Promise<string> {
  const semantic = networks.map(network => ({
    ...network,
    markets: network.markets.map(({ id: _id, ...market }) => market),
  }));
  return sha256Hex(canonicalJson(semantic));
}

/*
 * Every attempt for one commit, whatever roots it produced. Discovery uses
 * this to recognize a commit it has already imported, without reading the
 * whole source again.
 */
async function findAttemptsByCommit(
  db: D1Database,
  repository: string,
  commitSha: string,
): Promise<RegistryVersionRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM registry_versions
     WHERE source_repository = ?1 AND source_commit_sha = ?2
     ORDER BY attempt DESC`
  ).bind(repository.toLowerCase(), commitSha).all<RegistryVersionRow>();
  return results ?? [];
}

// the failed check that closes a draft a newer attempt of its commit replaced
const SUPERSEDED_CHECK = 'superseded-by-newer-attempt';

type Replacement = Pick<RegistryVersionRow, 'id' | 'attempt' | 'source_repository' | 'source_commit_sha'>;

/*
 * Closes the drafts of a commit that a newer, successful attempt of the same
 * commit has replaced.
 *
 * Attempts of one commit are numbered in order, and once a newer attempt has
 * imported every root — and validated, or been held for review — an older
 * attempt still importing is a draft nobody will finish. It stays open,
 * though, and an open draft is what an operator is told to review and what
 * discovery stops at. So it is closed as invalid.
 *
 * Two limits keep this from discarding work:
 *
 *  - The replacement must have succeeded. A forced attempt that fails leaves
 *    the draft it was meant to replace open, so that draft can still be
 *    validated; closing it when the new attempt was merely created would
 *    leave nothing to validate if that attempt then failed.
 *  - Only attempts of the same commit are closed. Reviews are inherited
 *    between attempts of one commit (readImportOverlays) but not across
 *    commits, so a draft of a commit the tracked ref has moved past may hold
 *    review work nothing else carries; it stays open until someone validates
 *    or replaces it, and the status endpoint keeps saying so.
 *
 * The reason is one failed check, `superseded-by-newer-attempt`, added to the
 * draft's latest validation attempt — so the draft still reports what had
 * failed on it before — naming the attempt that replaced it. A draft that was
 * never validated gets its first attempt. Each draft is closed in its own
 * batch and only while it is still importing, so two invocations closing the
 * same draft cannot collide: the second changes nothing. Returns the ids this
 * call actually closed.
 */
async function supersedeEarlierAttempts(db: D1Database, replacement: Replacement): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT id FROM registry_versions
     WHERE source_repository = ?1 AND source_commit_sha = ?2 AND attempt < ?3 AND status = 'importing'`
  ).bind(replacement.source_repository.toLowerCase(), replacement.source_commit_sha, replacement.attempt)
    .all<{ id: string }>();

  const createdAt = new Date().toISOString();
  const details   = JSON.stringify({ supersededBy: replacement.id, attempt: replacement.attempt });
  const closed: string[] = [];
  for (const { id } of results ?? []) {
    const [ , update ] = await db.batch([
      db.prepare(
        `INSERT INTO validation_results (
           registry_version_id, validation_attempt, check_name, scope, passed, details, created_at
         )
         SELECT ?1, latest.attempt, ?2, 'global', 0, ?3, ?4
         FROM (
           SELECT COALESCE(MAX(validation_attempt), 1) AS attempt
           FROM validation_results WHERE registry_version_id = ?1
         ) AS latest
         WHERE EXISTS (SELECT 1 FROM registry_versions WHERE id = ?1 AND status = 'importing')`
      ).bind(id, SUPERSEDED_CHECK, details, createdAt),
      db.prepare(`UPDATE registry_versions SET status = 'invalid' WHERE id = ?1 AND status = 'importing'`).bind(id),
    ]);
    if (changedRows(update!) === 1) {
      closed.push(id);
    }
  }
  return closed;
}

/*
 * Closes, for one commit, the drafts older than its newest successful
 * attempt: one that validated, or one still importing whose run finished
 * with every root imported (held for review). Discovery calls this before it
 * decides what is held, so drafts left by attempts made before this rule
 * existed — or by a call that failed to close them — are closed the next time
 * the commit is checked. With no successful attempt, nothing is closed.
 */
async function supersedeStaleAttempts(db: D1Database, repository: string, commitSha: string): Promise<string[]> {
  const newest = await db.prepare(
    `SELECT version.id, version.attempt, version.source_repository, version.source_commit_sha
     FROM registry_versions AS version
     WHERE version.source_repository = ?1 AND version.source_commit_sha = ?2
       AND (
         version.status = 'validated'
         OR (
           version.status = 'importing'
           AND NOT EXISTS (
             SELECT 1 FROM sync_runs WHERE registry_version_id = version.id AND status = 'running'
           )
           AND EXISTS (
             SELECT 1 FROM sync_runs
             WHERE registry_version_id = version.id AND status = 'completed'
               AND completed_count = expected_count
           )
         )
       )
     ORDER BY version.attempt DESC
     LIMIT 1`
  ).bind(repository.toLowerCase(), commitSha).first<Replacement>();
  return newest === null || newest === undefined ? [] : supersedeEarlierAttempts(db, newest);
}

/*
 * An importing candidate, as the row that records it. The repository
 * identifier is stored lowercase, so a casing difference cannot create a
 * second source.
 */
function candidateRow(input: CandidateInput): RegistryVersionRow {
  return {
    id:                input.versionId ?? crypto.randomUUID(),
    source_repository: input.repository.toLowerCase(),
    source_commit_sha: input.commitSha,
    source_checksum:   input.sourceChecksum,
    snapshot_checksum: null,
    attempt:           input.attempt,
    status:            'importing',
    created_at:        input.createdAt ?? new Date().toISOString(),
    validated_at:      null,
    created_by:        input.createdBy,
  };
}

// the statement that creates a candidate, for a caller that commits it together with something else
function candidateStatement(db: D1Database, version: RegistryVersionRow, condition?: Condition): D1PreparedStatement {
  return insertStatement(db, 'registry_versions', { ...version }, condition);
}

async function createCandidate(db: D1Database, input: CandidateInput): Promise<RegistryVersionRow> {
  const version = candidateRow(input);
  await candidateStatement(db, version).run();
  return version;
}

type Scope = { registry_version_id: string, network_id: string };

/*
 * `reviewed` says whether the decisions in a row were made by someone. A row
 * written from a reviewed overlay says so; one written for a network or
 * market nobody has reviewed carries the provisional values of
 * provisionalNetworkOverlay and provisionalMarketOverlay, and is not cloned
 * into the next version. Every writer states which it is: there is no side
 * a row may fall to by default.
 */
function networkStatement(
  db: D1Database,
  versionId: string,
  networkId: string,
  network: NetworkV1,
  reviewed: boolean,
  condition?: Condition,
): D1PreparedStatement {
  return insertStatement(db, 'registry_networks', {
    id:                   networkId,
    registry_version_id:  versionId,
    chain_id:             network.chainId,
    upstream_network_key: network.upstreamKey,
    canonical_name:       network.key,
    display_name:         network.displayName,
    is_testnet:           boolean(network.testnet),
    metadata:             JSON.stringify(network.presentation),
    reviewed:             boolean(reviewed),
  }, condition);
}

function exceptionStatements(
  db: D1Database,
  scope: Scope,
  network: Pick<NetworkV1, 'priceExceptions'>,
  condition?: Condition,
): D1PreparedStatement[] {
  return network.priceExceptions.map(exception => insertStatement(db, 'network_price_exceptions', {
    ...scope,
    price_feed_address:              exception.priceFeedAddress,
    kind:                            exception.kind,
    fixed_price_value:               exception.kind === 'fixed_price' ? exception.price.value : null,
    fixed_price_decimals:            exception.kind === 'fixed_price' ? exception.price.decimals : null,
    replacement_price_feed_address:  exception.kind === 'deprecated_price_remap' ? exception.replacementPriceFeed.address : null,
    replacement_price_feed_decimals: exception.kind === 'deprecated_price_remap' ? exception.replacementPriceFeed.decimals : null,
    provenance:                      exception.provenance,
    expires_at:                      exception.expiresAt,
  }, condition));
}

/*
 * A stored price exception as the wire shape states it: what
 * exceptionStatements wrote, read back. The snapshot and the overlay both read
 * an exception through it. Each kind is written out, so the key order follows
 * the wire contract and the kind stays a literal the union can discriminate;
 * and there is no default, so a kind added to EXCEPTION_KINDS does not compile
 * until it is read here, rather than being read as another.
 */
function priceExceptionOfRow(row: NetworkPriceExceptionRow): PriceExceptionV1 {
  switch (row.kind) {
    case 'zero_price':
      return {
        kind:             'zero_price',
        priceFeedAddress: row.price_feed_address,
        provenance:       row.provenance,
        expiresAt:        row.expires_at,
      };
    case 'fixed_price':
      return {
        kind:             'fixed_price',
        priceFeedAddress: row.price_feed_address,
        price:            { value: row.fixed_price_value!, decimals: row.fixed_price_decimals! },
        provenance:       row.provenance,
        expiresAt:        row.expires_at,
      };
    case 'deprecated_price_remap':
      return {
        kind:                 'deprecated_price_remap',
        priceFeedAddress:     row.price_feed_address,
        replacementPriceFeed: {
          address:  row.replacement_price_feed_address!,
          decimals: row.replacement_price_feed_decimals!,
        },
        provenance:           row.provenance,
        expiresAt:            row.expires_at,
      };
  }
}

/*
 * The rows of one market, given the token ids of its network. Tokens the
 * network does not have yet are created here and added to those ids, so the
 * market's own tokens are written once however many roles they play in it.
 */
function marketStatements(
  db: D1Database,
  scope: Scope,
  market: MarketV1,
  tokenIds: Map<Address, string>,
  reviewed: boolean,
  condition?: Condition,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];

  const tokenId = (token: TokenV1): string => {
    const known = tokenIds.get(token.address);
    if (known !== undefined) {
      return known;
    }
    const id = crypto.randomUUID();
    tokenIds.set(token.address, id);
    statements.push(insertStatement(db, 'tokens', {
      id,
      ...scope,
      address:  token.address,
      symbol:   token.symbol,
      name:     token.name,
      decimals: token.decimals,
    }, condition));
    return id;
  };

  // the caller owns market identity, so the row keeps the id it was assembled with
  const marketId = market.id;
  statements.push(insertStatement(db, 'markets', {
    id:                          marketId,
    ...scope,
    deployment_key:              market.deploymentKey,
    display_name:                market.displayName,
    slug:                        market.slug,
    contract_name:               market.contractName,
    creation_block:              market.creationBlock,
    status:                      market.status,
    is_default:                  boolean(market.isDefault),
    is_institutional:            boolean(market.isInstitutional),
    rewards_enabled:             boolean(market.capabilities.rewards),
    account_rewards_enabled:     boolean(market.capabilities.accountRewards),
    transaction_history_enabled: boolean(market.capabilities.transactionHistory),
    collateral_value_quote:      market.collateralValueQuote,
    reviewed:                    boolean(reviewed),
  }, condition));

  for (const role of CONTRACT_ROLES) {
    const address = market.contracts[CONTRACT_ROLE_KEYS[role]];
    if (address !== null && address !== undefined) {
      statements.push(insertStatement(db, 'market_contracts', { market_id: marketId, role, address }, condition));
    }
  }

  const { baseAsset, rewardAsset } = market;
  statements.push(insertStatement(db, 'market_assets', {
    ...scope,
    market_id:               marketId,
    token_id:                tokenId(baseAsset.token),
    role:                    'base',
    asset_index:             null,
    price_feed_address:      baseAsset.priceFeed.address,
    price_feed_decimals:     baseAsset.priceFeed.decimals,
    price_feed_quote:        null,
    usd_price_feed_address:  baseAsset.usdPriceFeed?.address ?? null,
    usd_price_feed_decimals: baseAsset.usdPriceFeed?.decimals ?? null,
    display_name:            baseAsset.displayName,
    is_wrapped_native:       boolean(baseAsset.isWrappedNative),
  }, condition));

  if (rewardAsset !== null) {
    statements.push(insertStatement(db, 'market_assets', {
      ...scope,
      market_id:               marketId,
      token_id:                tokenId(rewardAsset.token),
      role:                    'reward',
      asset_index:             null,
      price_feed_address:      rewardAsset.priceFeed?.address ?? null,
      price_feed_decimals:     rewardAsset.priceFeed?.decimals ?? null,
      price_feed_quote:        rewardAsset.priceFeedQuote,
      usd_price_feed_address:  null,
      usd_price_feed_decimals: null,
      display_name:            null,
      is_wrapped_native:       null,
    }, condition));
  }

  for (const collateral of market.collateralAssets) {
    statements.push(insertStatement(db, 'market_assets', {
      ...scope,
      market_id:               marketId,
      token_id:                tokenId(collateral.token),
      role:                    'collateral',
      asset_index:             collateral.assetIndex,
      price_feed_address:      collateral.priceFeed.address,
      price_feed_decimals:     collateral.priceFeed.decimals,
      price_feed_quote:        null,
      usd_price_feed_address:  null,
      usd_price_feed_decimals: null,
      display_name:            null,
      is_wrapped_native:       null,
    }, condition));
  }

  return statements;
}

/*
 * One market as an import assembled it, with its network, and whether each
 * carries decisions someone made rather than provisional ones.
 */
type ImportedMarket = {
  network:         NetworkV1,
  market:          MarketV1,
  networkReviewed: boolean,
  marketReviewed:  boolean,
};

/*
 * The writes of one imported market: its network too where the candidate
 * does not hold it yet — an import meets a network at its first market — and
 * every token of the market its network does not already have, so token
 * identity stays shared with the network's other markets. Every market of a
 * candidate is inserted through it, the markets of a whole snapshot a test
 * seeds included.
 *
 * They are statements rather than a write, because an import commits a market
 * in one transaction with the checkpoint that imported it, and every
 * statement carries that checkpoint's condition: a market whose invocation
 * lost the run is not written at all, so it cannot overwrite what was
 * reviewed in the candidate meanwhile, and a market is never in a candidate
 * without its checkpoint saying so.
 *
 * A version has one default market. A market imported as the default while
 * the candidate already holds another one is refused here, naming both,
 * rather than by the unique index in the middle of its write, whose message
 * names neither.
 */
async function marketWrites(
  db: D1Database,
  versionId: string,
  imported: ImportedMarket,
): Promise<(condition?: Condition) => D1PreparedStatement[]> {
  const [ networkRows, tokenRows, defaultRows ] = await db.batch([
    db.prepare(`SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = ?2`)
      .bind(versionId, imported.network.chainId),
    db.prepare(
      `SELECT token.id, token.address
       FROM tokens AS token
       JOIN registry_networks AS network ON network.id = token.network_id
       WHERE token.registry_version_id = ?1 AND network.chain_id = ?2`
    ).bind(versionId, imported.network.chainId),
    db.prepare(
      `SELECT network.chain_id, market.deployment_key
       FROM markets AS market
       JOIN registry_networks AS network ON network.id = market.network_id
       WHERE market.registry_version_id = ?1 AND market.is_default = 1`
    ).bind(versionId),
  ]) as [
    D1Result<{ id: string }>, D1Result<{ id: string, address: Address }>,
    D1Result<{ chain_id: number, deployment_key: string }>,
  ];

  const key   = marketKey(imported.network.chainId, imported.market.deploymentKey);
  const other = (defaultRows.results ?? [])
    .map(row => marketKey(row.chain_id, row.deployment_key))
    .find(market => market !== key);
  if (imported.market.isDefault && other !== undefined) {
    throw new RegistryError(
      'OVERLAY_INVALID',
      `${key} is the default market by the decisions it inherits, but ${other} already is the default of this `
        + `version; review which of them opens by default`,
      key,
    );
  }

  const existing  = networkRows.results?.[0]?.id;
  const networkId = existing ?? crypto.randomUUID();
  const scope     = { registry_version_id: versionId, network_id: networkId };
  const tokens    = (tokenRows.results ?? []).map(token => [ token.address, token.id ] as const);

  return condition => [
    ...(existing !== undefined ? [] : [
      networkStatement(db, versionId, networkId, imported.network, imported.networkReviewed, condition),
      ...exceptionStatements(db, scope, imported.network, condition),
    ]),
    /*
     * A market replaces any row of its deployment, so writing one twice
     * leaves one market rather than a collision with the first. Contracts
     * and assets follow the market by cascade; tokens stay, because they are
     * the network's.
     */
    conditioned(
      db,
      `DELETE FROM markets WHERE registry_version_id = ?1 AND network_id = ?2 AND deployment_key = ?3`,
      [ versionId, networkId, imported.market.deploymentKey ],
      condition,
    ),
    ...marketStatements(db, scope, imported.market, new Map(tokens), imported.marketReviewed, condition),
  ];
}

// an asset row with the token it holds, as both readers select it
type AssetRowWithToken = MarketAssetRow & { token_address: Address, symbol: string, name: string, decimals: number };

const ASSET_COLUMNS = `asset.*, token.address AS token_address, token.symbol, token.name, token.decimals`;

/*
 * One stored market as the snapshot shape, from its row, its contracts and
 * its assets with their tokens. Every reader of a market goes through it, so
 * a market read on its own is the market the whole version holds.
 */
function marketOf(market: MarketRow, contractRows: MarketContractRow[], assets: AssetRowWithToken[]): MarketV1 {
  const contracts = Object.fromEntries(CONTRACT_ROLES.map(role => [
    CONTRACT_ROLE_KEYS[role],
    contractRows.find(contract => contract.role === role)?.address ?? null,
  ])) as MarketV1['contracts'];

  const tokenOf = (row: AssetRowWithToken): TokenV1 => ({
    address:  row.token_address,
    symbol:   row.symbol,
    name:     row.name,
    decimals: row.decimals,
  });
  const feedOf = (address: Address | null, decimals: number | null) => (
    address === null || decimals === null ? null : { address, decimals }
  );

  const base   = assets.find(asset => asset.role === 'base')!;
  const reward = assets.find(asset => asset.role === 'reward') ?? null;

  return {
    id:                   market.id,
    deploymentKey:        market.deployment_key,
    displayName:          market.display_name,
    slug:                 market.slug,
    contractName:         market.contract_name,
    isDefault:            market.is_default === 1,
    isInstitutional:      market.is_institutional === 1,
    status:               market.status,
    creationBlock:        market.creation_block,
    collateralValueQuote: market.collateral_value_quote,
    capabilities: {
      rewards:            market.rewards_enabled === 1,
      accountRewards:     market.account_rewards_enabled === 1,
      transactionHistory: market.transaction_history_enabled === 1,
    },
    contracts,
    baseAsset: {
      token:           tokenOf(base),
      displayName:     base.display_name!,
      isWrappedNative: base.is_wrapped_native === 1,
      priceFeed:       feedOf(base.price_feed_address, base.price_feed_decimals)!,
      usdPriceFeed:    feedOf(base.usd_price_feed_address, base.usd_price_feed_decimals),
    },
    rewardAsset: reward === null ? null : {
      token:          tokenOf(reward),
      priceFeed:      feedOf(reward.price_feed_address, reward.price_feed_decimals),
      priceFeedQuote: reward.price_feed_quote,
    },
    collateralAssets: assets
      .filter(asset => asset.role === 'collateral')
      .sort((left, right) => (left.asset_index ?? 0) - (right.asset_index ?? 0))
      .map(asset => ({
        assetIndex: asset.asset_index!,
        token:      tokenOf(asset),
        priceFeed:  feedOf(asset.price_feed_address, asset.price_feed_decimals)!,
      })),
  };
}

/*
 * Reads a stored version back as the snapshot shape: what validation checks,
 * what the snapshot checksum is taken over, and what the public API will
 * serve. Ordering is the contract's: networks by chain id, markets by
 * creation block then deployment key, collateral by asset index.
 */
async function readSnapshot(db: D1Database, versionId: string): Promise<NetworkV1[]> {
  const [ networkRows, exceptionRows, marketRows, contractRows, assetRows ] = await db.batch([
    db.prepare(
      `SELECT id, chain_id, canonical_name, upstream_network_key, display_name, is_testnet, metadata
       FROM registry_networks WHERE registry_version_id = ?1 ORDER BY chain_id`
    ).bind(versionId),
    db.prepare(
      `SELECT * FROM network_price_exceptions WHERE registry_version_id = ?1 ORDER BY price_feed_address`
    ).bind(versionId),
    db.prepare(
      `SELECT * FROM markets WHERE registry_version_id = ?1 ORDER BY creation_block, deployment_key`
    ).bind(versionId),
    db.prepare(
      `SELECT contract.* FROM market_contracts AS contract
       JOIN markets AS market ON market.id = contract.market_id
       WHERE market.registry_version_id = ?1`
    ).bind(versionId),
    db.prepare(
      `SELECT ${ASSET_COLUMNS}
       FROM market_assets AS asset
       JOIN tokens AS token ON token.id = asset.token_id
       WHERE asset.registry_version_id = ?1
       ORDER BY asset.asset_index`
    ).bind(versionId),
  ]) as [
    D1Result<RegistryNetworkRow>, D1Result<NetworkPriceExceptionRow>, D1Result<MarketRow>,
    D1Result<MarketContractRow>, D1Result<AssetRowWithToken>,
  ];

  const contractsByMarket = new Map<string, MarketContractRow[]>();
  for (const row of contractRows.results ?? []) {
    contractsByMarket.set(row.market_id, [ ...(contractsByMarket.get(row.market_id) ?? []), row ]);
  }
  const assetsByMarket = new Map<string, AssetRowWithToken[]>();
  for (const row of assetRows.results ?? []) {
    assetsByMarket.set(row.market_id, [ ...(assetsByMarket.get(row.market_id) ?? []), row ]);
  }

  return (networkRows.results ?? []).map(network => {
    const presentation = JSON.parse(network.metadata) as NetworkV1['presentation'];
    const markets = (marketRows.results ?? [])
      .filter(market => market.network_id === network.id)
      .map(market => marketOf(market, contractsByMarket.get(market.id) ?? [], assetsByMarket.get(market.id) ?? []));

    return {
      chainId:     network.chain_id,
      key:         network.canonical_name,
      upstreamKey: network.upstream_network_key,
      displayName: network.display_name,
      testnet:     network.is_testnet === 1,
      presentation,
      priceExceptions: (exceptionRows.results ?? [])
        .filter(exception => exception.network_id === network.id)
        .map(priceExceptionOfRow),
      markets,
    };
  });
}

/*
 * One market of a stored version, read on its own: what a caller that needs
 * a single market reads instead of every row of the version. Each statement
 * finds the market by its network and deployment key, so the three are one
 * round trip, and a market the version does not hold is null.
 */
async function readMarket(
  db: D1Database,
  versionId: string,
  { chainId, deploymentKey }: { chainId: number, deploymentKey: string },
): Promise<MarketV1 | null> {
  const target = `(
    SELECT market.id FROM markets AS market
    JOIN registry_networks AS network ON network.id = market.network_id
    WHERE market.registry_version_id = ?1 AND network.chain_id = ?2 AND market.deployment_key = ?3
  )`;
  const [ marketRows, contractRows, assetRows ] = await db.batch([
    db.prepare(`SELECT * FROM markets WHERE id = ${target}`),
    db.prepare(`SELECT * FROM market_contracts WHERE market_id = ${target}`),
    db.prepare(
      `SELECT ${ASSET_COLUMNS}
       FROM market_assets AS asset
       JOIN tokens AS token ON token.id = asset.token_id
       WHERE asset.market_id = ${target}
       ORDER BY asset.asset_index`
    ),
  ].map(statement => statement.bind(versionId, chainId, deploymentKey))) as [
    D1Result<MarketRow>, D1Result<MarketContractRow>, D1Result<AssetRowWithToken>,
  ];

  const market = marketRows.results?.[0];
  return market === undefined ? null : marketOf(market, contractRows.results ?? [], assetRows.results ?? []);
}

/*
 * The version a request resolves against, and the snapshot it serves.
 */
async function readActiveVersionId(db: D1Database): Promise<string | null> {
  const active = await db
    .prepare(`SELECT active_version_id FROM registry_state WHERE singleton_id = 1`)
    .first<string | null>('active_version_id');
  return active ?? null;
}

/*
 * The active version and the checksum of its snapshot, in one statement.
 *
 * This is what a request pays to find out whether what it already holds is
 * still current: the pointer is the only thing that moves, and the checksum
 * with it names the immutable bytes a cache entry may be keyed by. Hydrating
 * the snapshot to learn its checksum would defeat the cache it is read for.
 * The source the version was imported from comes with it, from the same row,
 * so everything that names the version in a cached snapshot is checked
 * against D1 rather than taken from the cache.
 */
async function readActivePointer(db: D1Database): Promise<RegistryVersionRefV1 | null> {
  const pointer = await db.prepare(
    `SELECT version.id AS id, version.source_repository AS sourceRepository,
            version.source_commit_sha AS sourceCommitSha, version.snapshot_checksum AS checksum
     FROM registry_state AS state
     JOIN registry_versions AS version ON version.id = state.active_version_id
     WHERE state.singleton_id = 1`
  ).first<{ id: string, sourceRepository: string, sourceCommitSha: string, checksum: string | null }>();
  return pointer === null || pointer === undefined || pointer.checksum === null
    ? null
    : {
        id:               pointer.id,
        sourceRepository: pointer.sourceRepository,
        sourceCommitSha:  pointer.sourceCommitSha,
        checksum:         pointer.checksum,
      };
}

/*
 * The validated versions whose bytes are worth keeping cached: the active
 * one, and every validated version newer than it — what an import validated
 * and cached for an activation that has not happened yet. With nothing
 * active, every validated version is a candidate for the first activation.
 */
async function readRetainedVersions(db: D1Database): Promise<VersionRef[]> {
  const { results } = await db.prepare(
    `SELECT version.id AS id, version.snapshot_checksum AS checksum
     FROM registry_versions AS version
     LEFT JOIN registry_state AS state ON state.singleton_id = 1
     LEFT JOIN registry_versions AS active ON active.id = state.active_version_id
     WHERE version.status = 'validated' AND version.snapshot_checksum IS NOT NULL
       AND (active.id IS NULL OR version.id = active.id OR version.created_at > active.created_at)`
  ).all<VersionRef>();
  return results ?? [];
}

/*
 * The versions there are, newest first, with the active one named.
 *
 * An operator who has run a few imports has several ids and no way to tell
 * them apart; everything else about a version is read by id, so something
 * has to list them. It is bounded and never carries a snapshot: this says
 * which versions exist and what became of them, not what is in them.
 *
 * It is read a page at a time. `before` is the last version of the page read
 * so far, and the next page holds the versions listed after it; `next` is
 * that version for the page answered here, and null on the last one. The
 * order is total, so a page boundary never skips or repeats a version.
 */
async function readVersions(
  db: D1Database,
  { status, before, limit }: { status?: string, before?: string, limit: number },
): Promise<{
  versions:        Array<RegistryVersionRow & { is_active: number }>,
  activeVersionId: string | null,
  next:            string | null,
}> {
  /*
   * The pointer travels with the rows rather than being read after them: two
   * reads could straddle an activation, and the answer would then name one
   * version as active while every row was marked against another.
   */
  const rows = await db.prepare(
    `SELECT version.*, state.active_version_id AS active_version_id,
            CASE WHEN state.active_version_id = version.id THEN 1 ELSE 0 END AS is_active
     FROM registry_versions AS version
     LEFT JOIN registry_state AS state ON state.singleton_id = 1
     LEFT JOIN registry_versions AS anchor ON anchor.id = ?3
     WHERE (?1 IS NULL OR version.status = ?1)
       AND (?3 IS NULL OR (version.created_at, version.attempt, version.id) < (anchor.created_at, anchor.attempt, anchor.id))
     ORDER BY version.created_at DESC, version.attempt DESC, version.id DESC
     LIMIT ?2`
  ).bind(status ?? null, limit + 1, before ?? null)
    .all<RegistryVersionRow & { is_active: number, active_version_id: string | null }>();

  // one row past the page says whether there is another one
  const listed   = rows.results ?? [];
  const versions = listed.slice(0, limit);
  return {
    versions,
    // an empty listing carries no row to read it from
    activeVersionId: versions[0]?.active_version_id ?? (versions.length === 0 ? await readActiveVersionId(db) : null),
    next:            listed.length > limit ? versions[versions.length - 1]!.id : null,
  };
}

async function readVersion(db: D1Database, versionId: string): Promise<RegistryVersionRow | null> {
  const version = await db
    .prepare(`SELECT * FROM registry_versions WHERE id = ?1`)
    .bind(versionId).first<RegistryVersionRow>();
  return version ?? null;
}

/*
 * A stored version as the wire contract serves it. Only a validated version
 * has a snapshot checksum, so only a validated version can be served.
 *
 * `known` is the version row, where the caller has already read it. The
 * snapshot is hydrated from it either way; passing it in saves a statement
 * for a caller that needed the row first for something else.
 */
async function readRegistrySnapshot(
  db: D1Database,
  versionId: string,
  known?: RegistryVersionRow,
): Promise<RegistrySnapshotV1 | null> {
  const version = known ?? await readVersion(db, versionId);
  if (version === null || version.status !== 'validated' || version.snapshot_checksum === null) {
    return null;
  }
  return {
    schemaVersion: 1,
    registryVersion: {
      id:               version.id,
      sourceRepository: version.source_repository,
      sourceCommitSha:  version.source_commit_sha,
      checksum:         version.snapshot_checksum,
    },
    networks: await readSnapshot(db, versionId),
  };
}

/*
 * The two writes of a move of the active pointer: the audit event, and the
 * pointer itself. Both carry the same condition, so activating the version
 * that is already active writes neither: it is an idempotent no-op, not a
 * second activation event. `expected`, when given, conditions both as well.
 *
 * The pointer trigger refuses a target that is not validated, and because
 * both statements run in one batch, a refused pointer change rolls back the
 * audit event with it.
 */
function activationStatements(
  db: D1Database,
  move: { activationId: string, versionId: string, action: ActivationAction, actor: string, reason: string, at: string },
  expected?: Condition,
): [ D1PreparedStatement, D1PreparedStatement ] {
  return [
    conditioned(
      db,
      `INSERT INTO registry_activations (id, registry_version_id, previous_version_id, action, actor, reason, created_at)
       SELECT ?1, ?2, active_version_id, ?3, ?4, ?5, ?6
       FROM registry_state
       WHERE singleton_id = 1 AND active_version_id IS NOT ?2`,
      [ move.activationId, move.versionId, move.action, move.actor, move.reason, move.at ],
      expected,
    ),
    conditioned(
      db,
      `UPDATE registry_state SET active_version_id = ?1, updated_at = ?2
       WHERE singleton_id = 1 AND active_version_id IS NOT ?1`,
      [ move.versionId, move.at ],
      expected,
    ),
  ];
}

/*
 * Moves the active pointer, auditing the change, in the two statements
 * above: once only, however often it is asked.
 *
 * A request may name the version it expects to replace. Both statements then
 * require it too, so of two moves made against the same version — a rollback
 * and an activation racing — the later one changes nothing and is refused,
 * rather than silently undoing the other. Null expects that nothing is on.
 */
async function activateVersion(
  db: D1Database,
  input: {
    versionId:                string,
    action:                   ActivationAction,
    actor:                    string,
    reason:                   string,
    expectedActiveVersionId?: string | null,
  },
): Promise<ActivationResultV1> {
  const version = await readVersion(db, input.versionId);
  if (version === null) {
    throw new RegistryError('CANDIDATE_STATE_CONFLICT', `no such registry version`, input.versionId);
  }
  if (version.status !== 'validated' || version.snapshot_checksum === null) {
    throw new RegistryError(
      'CANDIDATE_STATE_CONFLICT',
      `only a validated version can be ${input.action === 'rollback' ? 'restored' : 'activated'}`,
      input.versionId,
    );
  }

  const activationId = crypto.randomUUID();
  const timestamp    = new Date().toISOString();
  const expected: Condition | undefined = input.expectedActiveVersionId === undefined ? undefined : {
    sql:    first => `active_version_id IS ?${first}`,
    values: [ input.expectedActiveVersionId ],
  };

  const [ auditResult, pointerResult ] = await db.batch(activationStatements(db, {
    activationId,
    versionId: input.versionId,
    action:    input.action,
    actor:     input.actor,
    reason:    input.reason,
    at:        timestamp,
  }, expected));

  const audited = changedRows(auditResult!);
  const moved   = changedRows(pointerResult!);
  if (audited !== moved) {
    throw new RegistryError(
      'CANDIDATE_STATE_CONFLICT',
      `the activation audit and the pointer disagree`,
      input.versionId,
    );
  }

  /*
   * Nothing moved. The target already being on is the idempotent case; any
   * other version being on means the expectation no longer held.
   */
  if (moved === 0 && input.expectedActiveVersionId !== undefined) {
    const active = await readActiveVersionId(db);
    if (active !== input.versionId) {
      throw new RegistryError(
        'CANDIDATE_STATE_CONFLICT',
        `the active version is ${active ?? 'none'}, not ${input.expectedActiveVersionId ?? 'none'} as this ${input.action} expected`,
        input.versionId,
      );
    }
  }

  /*
   * What was replaced is read back from the audit row this activation wrote,
   * not from a read taken before the batch. Two activations can race, and the
   * answer an operator is given must be the one the audit trail records, not
   * the state the request happened to observe on the way in.
   */
  const previousVersionId = moved === 1
    ? await db.prepare(`SELECT previous_version_id FROM registry_activations WHERE id = ?1`)
        .bind(activationId).first<string | null>('previous_version_id')
    : null;

  return {
    action:            input.action,
    activationId:      moved === 1 ? activationId : null,
    previousVersionId: previousVersionId ?? null,
    targetVersionId:   input.versionId,
    changed:           moved === 1,
    registryVersion:   { id: input.versionId, checksum: version.snapshot_checksum },
  };
}

async function readValidationSummary(db: D1Database, versionId: string): Promise<ValidationSummaryV1> {
  const attempt = await latestValidationAttempt(db, versionId);
  if (attempt === 0) {
    return { attempt: 0, passed: 0, failed: 0, checks: [] };
  }
  const { results } = await db.prepare(
    `SELECT check_name, scope, passed, details FROM validation_results
     WHERE registry_version_id = ?1 AND validation_attempt = ?2
     ORDER BY passed, check_name, scope`
  ).bind(versionId, attempt).all<{ check_name: string, scope: string, passed: number, details: string }>();

  const checks = (results ?? []).map(row => ({
    name:   row.check_name,
    scope:  row.scope,
    passed: row.passed === 1,
    ...(row.passed === 1 ? {} : { details: JSON.parse(row.details) as unknown }),
  }));
  return {
    attempt,
    passed: checks.filter(check => check.passed).length,
    failed: checks.filter(check => !check.passed).length,
    checks,
  };
}

async function readActivationHistory(
  db: D1Database,
  versionId: string,
): Promise<ActivationRecordV1[]> {
  const { results } = await db.prepare(
    `SELECT id, action, previous_version_id, registry_version_id, actor, reason, created_at
     FROM registry_activations
     WHERE registry_version_id = ?1 OR previous_version_id = ?1
     ORDER BY created_at DESC, rowid DESC`
  ).bind(versionId).all<{
    id: string, action: ActivationAction, previous_version_id: string | null, registry_version_id: string,
    actor: string, reason: string, created_at: string,
  }>();
  return (results ?? []).map(row => ({
    id:                row.id,
    action:            row.action,
    previousVersionId: row.previous_version_id,
    targetVersionId:   row.registry_version_id,
    actor:             row.actor,
    reason:            row.reason,
    createdAt:         row.created_at,
  }));
}

/*
 * An expiry as a version stored it. An overlay used to be stored with any
 * expiry Date.parse accepted, years before 0000 and after 9999 among them;
 * such a value is read as the instant a Worker reads it as, in the form an
 * expiry is stored in now, so a version that holds one can still be cloned.
 * Anything written now is already in that form.
 */
function storedExpiry(value: string | null): string | null {
  const instant = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(instant) ? storedInstant(instant) : value;
}

/*
 * The overlay a network's rows state: its row and its price exceptions, read
 * back through the parser as the document a PUT takes. Every reader of a
 * stored network overlay goes through it, so the digest a read answers is the
 * one a write compares its expectation with. An exception is the one the
 * snapshot serves (priceExceptionOfRow), as the decision it states.
 */
function networkOverlayOf(
  network: { display_name: string, metadata: string },
  exceptions: NetworkPriceExceptionRow[],
  scope: string,
): NetworkOverlay {
  const presentation = JSON.parse(network.metadata) as Record<string, unknown>;
  return parseNetworkOverlay({
    displayName:               network.display_name,
    assetDisplayOverrides:     presentation.assetDisplayOverrides ?? [],
    unwrappedCollateralAssets: presentation.unwrappedCollateralAssets ?? [],
    priceExceptions:           exceptions.map(row => overlayOfException({ ...priceExceptionOfRow(row), expiresAt: storedExpiry(row.expires_at) })),
  }, scope);
}

// a market's key as SQL computes it from the rows of its network and market: the text marketKey writes
function marketKeyIn(network: string, market: string): string {
  return `${network}.chain_id || '${MARKET_KEY_SEPARATOR}' || ${market}.deployment_key`;
}

/*
 * Whether a scope's overlay counts for a source: every reviewed one does,
 * unless the source is read for its edits, and then only the scopes an
 * overlay was written for in that version, which its audit events name.
 */
function countedIn(scopeType: 'network' | 'market', scopeKey: string): string {
  return `(sources.edited = 0 OR EXISTS (
    SELECT 1 FROM registry_overlay_events AS event
    WHERE event.registry_version_id = sources.id AND event.scope_type = '${scopeType}' AND event.scope_key = ${scopeKey}
  ))`;
}

/*
 * The reviewed overlays of the versions `sources` names, merged. `sources` is
 * the body of a common table expression selecting a version `id`, its
 * `precedence`, and whether it counts only for what was `edited` in it; a
 * version of higher precedence overrides a lower one for every network and
 * market both say something about. It is one batch, so one round trip
 * however many versions it reads.
 *
 * Only what someone reviewed is an overlay. A row written for a network or
 * market nobody reviewed carries provisional values, and cloning those into
 * the next version would turn them into decisions nobody made. Rows are read
 * back through the overlay parsers, which normalizes them and rejects a
 * version whose stored overlay no longer satisfies the contract.
 *
 * A version has one default market, and the versions merged here can each
 * name another; the default read at the highest precedence is the one kept,
 * and the market an earlier source made the default is merged as not being
 * it. Otherwise an import would write two defaults, which the schema refuses,
 * on every attempt of the commit.
 */
async function readOverlaysOf(db: D1Database, sources: string, values: SqlValue[]): Promise<ClonedOverlays> {
  const from = `WITH sources (id, precedence, edited) AS (${sources})`;
  const [ networkRows, exceptionRows, marketRows ] = await db.batch([
    db.prepare(
      `${from}
       SELECT sources.id AS version_id, sources.precedence, network.chain_id, network.display_name, network.metadata
       FROM registry_networks AS network
       JOIN sources ON sources.id = network.registry_version_id
       WHERE network.reviewed = 1 AND ${countedIn('network', 'CAST(network.chain_id AS TEXT)')}
       ORDER BY sources.precedence, network.chain_id`
    ).bind(...values),
    db.prepare(
      `${from}
       SELECT sources.precedence, network.chain_id AS chain_id, exception.*
       FROM network_price_exceptions AS exception
       JOIN registry_networks AS network ON network.id = exception.network_id
       JOIN sources ON sources.id = exception.registry_version_id
       WHERE network.reviewed = 1 AND ${countedIn('network', 'CAST(network.chain_id AS TEXT)')}
       ORDER BY sources.precedence, network.chain_id, exception.price_feed_address`
    ).bind(...values),
    db.prepare(
      `${from}
       SELECT sources.id AS version_id, sources.precedence, network.chain_id AS chain_id, market.deployment_key,
              market.display_name, market.slug, market.contract_name, market.is_default, market.is_institutional,
              market.status, market.creation_block, market.collateral_value_quote,
              market.rewards_enabled, market.account_rewards_enabled, market.transaction_history_enabled,
              base.display_name AS base_display_name, base.is_wrapped_native,
              base.usd_price_feed_address, reward.price_feed_address AS reward_price_feed_address,
              reward.price_feed_quote AS reward_price_feed_quote, comet.address AS comet
       FROM markets AS market
       JOIN registry_networks AS network ON network.id = market.network_id
       JOIN sources ON sources.id = market.registry_version_id
       LEFT JOIN market_assets AS base ON base.market_id = market.id AND base.role = 'base'
       LEFT JOIN market_assets AS reward ON reward.market_id = market.id AND reward.role = 'reward'
       LEFT JOIN market_contracts AS comet ON comet.market_id = market.id AND comet.role = 'comet'
       WHERE market.reviewed = 1 AND ${countedIn('market', marketKeyIn('network', 'market'))}
       ORDER BY sources.precedence, network.chain_id, market.creation_block, market.deployment_key`
    ).bind(...values),
  ]) as [
    D1Result<{ version_id: string, precedence: number, chain_id: number, display_name: string, metadata: string }>,
    D1Result<NetworkPriceExceptionRow & { precedence: number, chain_id: number }>,
    D1Result<{
      version_id: string, precedence: number, chain_id: number, deployment_key: string,
      display_name: string, slug: string | null, contract_name: string | null,
      is_default: number, is_institutional: number, status: MarketStatus, creation_block: number,
      collateral_value_quote: PriceQuote, rewards_enabled: number, account_rewards_enabled: number,
      transaction_history_enabled: number, base_display_name: string | null, is_wrapped_native: number | null,
      usd_price_feed_address: string | null, reward_price_feed_address: string | null,
      reward_price_feed_quote: PriceQuote | null, comet: Address | null,
    }>,
  ];

  /*
   * The exceptions of each network, by the precedence it was read at rather
   * than by version: the same version can be a source twice, as the active
   * one and as an earlier attempt, and each reading carries its own.
   */
  const exceptionsOf = new Map<string, NetworkPriceExceptionRow[]>();
  for (const row of exceptionRows.results ?? []) {
    const key = `${row.precedence}:${row.chain_id}`;
    exceptionsOf.set(key, [ ...(exceptionsOf.get(key) ?? []), row ]);
  }

  // rows arrive in precedence order, so a later version's review replaces an earlier one's
  const networks = new Map<number, NetworkOverlay>();
  for (const row of networkRows.results ?? []) {
    networks.set(row.chain_id, networkOverlayOf(
      row,
      exceptionsOf.get(`${row.precedence}:${row.chain_id}`) ?? [],
      `version ${row.version_id} network ${row.chain_id}`,
    ));
  }

  const markets = new Map<string, MarketOverlay>();
  const comets  = new Map<string, Address | null>();
  let defaultMarket: string | null = null;
  for (const row of marketRows.results ?? []) {
    const key     = marketKey(row.chain_id, row.deployment_key);
    const overlay = parseMarketOverlay({
      displayName:          row.display_name,
      slug:                 row.slug,
      contractName:         row.contract_name,
      isDefault:            row.is_default === 1,
      isInstitutional:      row.is_institutional === 1,
      status:               row.status,
      creationBlock:        row.creation_block,
      collateralValueQuote: row.collateral_value_quote,
      capabilities: {
        rewards:            row.rewards_enabled === 1,
        accountRewards:     row.account_rewards_enabled === 1,
        transactionHistory: row.transaction_history_enabled === 1,
      },
      baseAsset: {
        displayName:         row.base_display_name,
        isWrappedNative:     row.is_wrapped_native === 1,
        usdPriceFeedAddress: row.usd_price_feed_address,
      },
      rewardPriceFeed: row.reward_price_feed_address === null ? null : {
        address: row.reward_price_feed_address,
        quote:   row.reward_price_feed_quote,
      },
    }, `version ${row.version_id} market ${key}`);

    if (overlay.isDefault) {
      const replaced = defaultMarket === key ? null : defaultMarket;
      const previous = replaced === null ? undefined : markets.get(replaced);
      if (replaced !== null && previous !== undefined) {
        markets.set(replaced, { ...previous, isDefault: false });
      }
      defaultMarket = key;
    } else if (defaultMarket === key) {
      defaultMarket = null;
    }
    markets.set(key, overlay);
    comets.set(key, row.comet);
  }

  return { networks, markets, comets };
}

// the version that is on, as a source of overlays; none before the first activation
const ACTIVE_SOURCE = `SELECT active_version_id, 0, 0 FROM registry_state WHERE singleton_id = 1 AND active_version_id IS NOT NULL`;

/*
 * Rebuilds the reviewed overlay of a stored version: what an overlay write
 * compares a document with. An import reads what it inherits through
 * readImportOverlays.
 */
async function readOverlays(db: D1Database, versionId: string): Promise<ClonedOverlays> {
  return readOverlaysOf(db, `SELECT ?1, 0, 0`, [ versionId ]);
}

/*
 * The overlay one network of a version holds, and whether somebody reviewed
 * it, or null for a chain the version has not imported. A network nobody
 * reviewed holds the provisional overlay its import wrote. Both statements
 * find the network by its version and chain, so they are one round trip.
 */
async function readNetworkOverlay(
  db: D1Database,
  versionId: string,
  chainId: number,
): Promise<{ overlay: NetworkOverlay, reviewed: boolean } | null> {
  const target = `(SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = ?2)`;
  const [ networkRows, exceptionRows ] = await db.batch([
    db.prepare(`SELECT display_name, metadata, reviewed FROM registry_networks WHERE id = ${target}`),
    db.prepare(`SELECT * FROM network_price_exceptions WHERE network_id = ${target} ORDER BY price_feed_address`),
  ].map(statement => statement.bind(versionId, chainId))) as [
    D1Result<{ display_name: string, metadata: string, reviewed: number }>, D1Result<NetworkPriceExceptionRow>,
  ];

  const network = networkRows.results?.[0];
  return network === undefined ? null : {
    overlay:  networkOverlayOf(network, exceptionRows.results ?? [], `version ${versionId} network ${chainId}`),
    reviewed: network.reviewed === 1,
  };
}

/*
 * The overlay of the currently active version, or empty maps when no version
 * has been activated yet, which is the first import.
 */
async function readActiveOverlays(db: D1Database): Promise<ClonedOverlays> {
  return readOverlaysOf(db, ACTIVE_SOURCE, []);
}

/*
 * The overlay an import applies: what the active version says, with what was
 * reviewed for the earlier attempts at the same commit over it.
 *
 * An earlier attempt matters because a review happens in place, in the rows
 * of an importing candidate, and a candidate that ends invalid is frozen with
 * those rows in it. The next attempt at the same source inherits them rather
 * than asking for the same review again. A different commit does not: what
 * was reviewed for it and then activated is already the active version.
 *
 * What an earlier attempt contributes is what was reviewed for it: the
 * networks and markets an overlay was written for in that attempt. The rest
 * of its rows are marked reviewed too, but they are copies of the version
 * that was on when it was imported, and that version may have been replaced
 * since — by a hotfix, or by a rollback — so they would bring its decisions
 * back over the ones on now.
 *
 * What an attempt reviewed stops being handed down once it, or a later
 * attempt of the commit, has been switched on and off again. Switched on, an
 * attempt had validated, which closed every draft before it, so the reviews
 * it and those drafts hold were all made before it went on; the move that
 * switched it off, a rollback or a hotfix, was made against them, or the
 * version it put on carries them. A review still waiting to be switched on
 * keeps being handed down past moves that switched off another commit, or an
 * earlier attempt.
 *
 * Every earlier attempt is read, oldest first, so the newest review of a
 * market wins and one attempt that reviewed nothing — it failed on the chain
 * before anyone saw it — does not lose the review an attempt before it
 * carried.
 */
async function readImportOverlays(db: D1Database, versionId: string): Promise<ClonedOverlays> {
  return readOverlaysOf(db, `
    ${ACTIVE_SOURCE}
    UNION ALL
    SELECT previous.id, previous.attempt, 1
    FROM registry_versions AS current
    JOIN registry_versions AS previous
      ON previous.source_repository = current.source_repository
     AND previous.source_commit_sha = current.source_commit_sha
     AND previous.attempt < current.attempt
    WHERE current.id = ?1
      AND NOT EXISTS (
        SELECT 1 FROM registry_activations AS activation
        JOIN registry_versions AS replaced ON replaced.id = activation.previous_version_id
        WHERE replaced.source_repository = previous.source_repository
          AND replaced.source_commit_sha = previous.source_commit_sha
          AND replaced.attempt >= previous.attempt
      )`, [ versionId ]);
}

/*
 * What in a version nobody has reviewed: the networks and markets an import
 * wrote with provisional values. It is what an operator works through before
 * the version can be offered, and what a new deployment in the source shows
 * up as.
 */
async function readUnreviewed(db: D1Database, versionId: string): Promise<{
  networks: number[],
  markets:  string[],
}> {
  const [ networks, markets ] = await db.batch([
    db.prepare(
      `SELECT chain_id FROM registry_networks
       WHERE registry_version_id = ?1 AND reviewed = 0 ORDER BY chain_id`
    ).bind(versionId),
    db.prepare(
      `SELECT network.chain_id, market.deployment_key
       FROM markets AS market
       JOIN registry_networks AS network ON network.id = market.network_id
       WHERE market.registry_version_id = ?1 AND market.reviewed = 0
       ORDER BY network.chain_id, market.deployment_key`
    ).bind(versionId),
  ]);
  return {
    networks: ((networks!.results ?? []) as Array<{ chain_id: number }>).map(row => row.chain_id),
    markets:  ((markets!.results ?? []) as Array<{ chain_id: number, deployment_key: string }>)
      .map(row => marketKey(row.chain_id, row.deployment_key)),
  };
}

type ResultInput = Pick<ValidationResultRow, 'check_name' | 'scope' | 'passed'> & { details?: unknown };

/*
 * One validation attempt as one statement. Its results travel as a single
 * JSON document, so an attempt is recorded whole or not at all however many
 * checks it ran: results are append-only, and part of an attempt would be
 * read as all of it. With a condition, it is recorded only while that holds.
 *
 * A repeated attempt number for the same check is a programming error rather
 * than an update, and fails on the unique constraint.
 */
function validationResultsStatement(
  db: D1Database,
  versionId: string,
  attempt: number,
  results: ResultInput[],
  createdAt: string,
  condition?: Condition,
): D1PreparedStatement {
  const rows = results.map(result => ({
    check_name: result.check_name,
    scope:      result.scope,
    passed:     result.passed,
    details:    JSON.stringify(result.details ?? {}),
  }));
  return conditioned(
    db,
    `INSERT INTO validation_results (
       registry_version_id, validation_attempt, check_name, scope, passed, details, created_at
     )
     SELECT ?1, ?2, json_extract(row.value, '$.check_name'), json_extract(row.value, '$.scope'),
            json_extract(row.value, '$.passed'), json_extract(row.value, '$.details'), ?3
     FROM json_each(?4) AS row
     WHERE row.type = 'object'`,
    [ versionId, attempt, createdAt, JSON.stringify(rows) ],
    condition,
  );
}

async function recordValidationResults(
  db: D1Database,
  versionId: string,
  attempt: number,
  results: ResultInput[],
): Promise<void> {
  await validationResultsStatement(db, versionId, attempt, results, new Date().toISOString()).run();
}

/*
 * The latest complete validation attempt of a version, which is the one that
 * decided its status.
 */
async function latestValidationAttempt(db: D1Database, versionId: string): Promise<number> {
  const attempt = await db.prepare(
    `SELECT max(validation_attempt) AS attempt FROM validation_results WHERE registry_version_id = ?1`
  ).bind(versionId).first<number | null>('attempt');
  return attempt ?? 0;
}

// the checks the latest validation attempt of a version failed
async function failedChecks(db: D1Database, versionId: string): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT DISTINCT check_name FROM validation_results
     WHERE registry_version_id = ?1 AND passed = 0
       AND validation_attempt = (SELECT MAX(validation_attempt) FROM validation_results WHERE registry_version_id = ?1)
     ORDER BY check_name`
  ).bind(versionId).all<{ check_name: string }>();
  return (results ?? []).map(row => row.check_name);
}

/*
 * Where a candidate stands: its revision, and its latest validation attempt.
 *
 * The revision is how many overlay events it has recorded. Every overlay
 * write records one in the transaction that changes the rows, and events are
 * never removed, so the count only moves forward, and anything read at one
 * revision still describes the candidate while the count is the same.
 */
async function readRevision(db: D1Database, versionId: string): Promise<{ revision: number, attempt: number }> {
  const row = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM registry_overlay_events WHERE registry_version_id = ?1) AS revision,
            (SELECT COALESCE(MAX(validation_attempt), 0) FROM validation_results WHERE registry_version_id = ?1) AS attempt`
  ).bind(versionId).first<{ revision: number, attempt: number } | null>();
  return { revision: row?.revision ?? 0, attempt: row?.attempt ?? 0 };
}

// a candidate as it was read: still importing, and at the revision it was read at
function unchanged(versionId: string, revision: number): Condition {
  return {
    sql: first => `EXISTS (SELECT 1 FROM registry_versions WHERE id = ?${first} AND status = 'importing')
       AND (SELECT COUNT(*) FROM registry_overlay_events WHERE registry_version_id = ?${first}) = ?${first + 1}`,
    values: [ versionId, revision ],
  };
}

/*
 * A validation attempt of a candidate has been recorded. A write that belongs
 * with the attempt — closing the run that imported the candidate — follows it
 * in the same transaction on this condition, so it applies only if the
 * attempt did.
 */
function recorded(versionId: string, attempt: number): Condition {
  return {
    sql: first => `EXISTS (
      SELECT 1 FROM validation_results WHERE registry_version_id = ?${first} AND validation_attempt = ?${first + 1}
    )`,
    values: [ versionId, attempt ],
  };
}

/*
 * A candidate's terminal status as one statement, for a caller that commits
 * it in one transaction with the validation attempt that decides it. The
 * transition triggers verify the stored validation results, so a status the
 * results do not support fails here rather than producing a version that
 * claims to be validated.
 */
function endCandidateStatement(
  db: D1Database,
  versionId: string,
  ending: { status: 'validated', checksum: string } | { status: 'invalid' },
  at: string,
  condition?: Condition,
): D1PreparedStatement {
  return conditioned(
    db,
    `UPDATE registry_versions
     SET status            = ?1,
         snapshot_checksum = CASE WHEN ?1 = 'validated' THEN ?2 ELSE snapshot_checksum END,
         validated_at      = CASE WHEN ?1 = 'validated' THEN ?3 ELSE validated_at END
     WHERE id = ?4 AND status = 'importing'`,
    [ ending.status, ending.status === 'validated' ? ending.checksum : null, at, versionId ],
    condition,
  );
}

async function markValidated(db: D1Database, versionId: string, checksum: string): Promise<void> {
  const ending = { status: 'validated', checksum } as const;
  const result = await endCandidateStatement(db, versionId, ending, new Date().toISOString()).run();
  assertChanged(result, versionId, `the candidate is no longer importing`);
}

async function markInvalid(db: D1Database, versionId: string): Promise<void> {
  const result = await endCandidateStatement(db, versionId, { status: 'invalid' }, new Date().toISOString()).run();
  assertChanged(result, versionId, `the candidate is no longer importing`);
}

/*
 * Rows a statement changed. D1 reports it in `meta.changes`, which the
 * workers-types version this worker resolves does not declare.
 */
function changedRows(result: D1Result): number {
  return (result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

function assertChanged(result: D1Result, versionId: string, message: string): void {
  const changes = changedRows(result);
  if (changes !== 1) {
    throw new RegistryError('CANDIDATE_STATE_CONFLICT', message, versionId);
  }
}

export type { CandidateInput, ClonedOverlays, Condition, ImportedMarket, ResultInput, SqlValue };

export {
  changedRows,
  activateVersion,
  activationStatements,
  both,
  candidateRow,
  candidateStatement,
  conditioned,
  createCandidate,
  failedChecks,
  findAttemptsByCommit,
  insertStatement,
  marketWrites,
  exceptionStatements,
  priceExceptionOfRow,
  readSnapshot,
  readUnreviewed,
  latestValidationAttempt,
  readActivationHistory,
  readActiveOverlays,
  readActivePointer,
  readActiveVersionId,
  readImportOverlays,
  readMarket,
  readNetworkOverlay,
  readOverlays,
  readRegistrySnapshot,
  readRetainedVersions,
  readRevision,
  readValidationSummary,
  readVersion,
  readVersions,
  recorded,
  SUPERSEDED_CHECK,
  supersedeEarlierAttempts,
  supersedeStaleAttempts,
  endCandidateStatement,
  markInvalid,
  markValidated,
  recordValidationResults,
  snapshotChecksum,
  unchanged,
  validationResultsStatement,
};
