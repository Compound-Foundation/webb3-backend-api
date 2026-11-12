import {
  ActivationAction,
  ActivationRecordV1,
  ActivationResultV1,
  Address,
  ApprovalV1,
  CONTRACT_ROLES,
  CONTRACT_ROLE_KEYS,
  MarketV1,
  NetworkV1,
  PriceExceptionV1,
  RegistrySnapshotV1,
  RegistryVersionRefV1,
  TokenV1,
  marketKey,
} from '../../lib/model/comet-registry.js';

import { ClockOption, nowOf } from './clock.js';
import { RegistryError } from './errors.js';
import type {
  MarketAssetRow,
  MarketContractRow,
  MarketRow,
  NetworkPriceExceptionRow,
  RegistryApprovalRow,
  RegistryNetworkRow,
  RegistryVersionRow,
} from './rows.js';
import { Condition, changedRows, conditioned, insertStatement } from './sql-condition.js';
import type { VersionRef } from './version-headers.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { sha256 } from '../../lib/hash.js';

/*
 * Reads and writes of the registry tables of APP_DB: candidates and their
 * snapshots, approvals, and the active pointer. Validation attempts are
 * recorded and read back in validation-store.ts; the only validation result
 * this module writes is the failed check that closes a superseded draft, in
 * the batch that closes it (supersedeEarlierAttempts). Reviewed overlays are
 * read back in overlay-store.ts. The database owns the invariants: the
 * lifecycle, singleton, and append-only triggers of
 * migrations/0001_comet_registry.sql reject anything these modules get wrong,
 * so their functions stay thin and never re-implement those rules. The rules
 * of who may switch a version on are the exception: an environment's
 * database holds them only from its first approval on
 * (migrations/0011_registry_approvals.sql), so activateVersion checks them
 * itself before it writes.
 */
type CandidateInput = {
  repository:     string,
  commitSha:      string,
  sourceChecksum: string,
  attempt:        number,
  createdBy:      string,
  versionId?:     string,
  createdAt?:     string,
};

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
  return sha256(canonicalJson(semantic));
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
async function supersedeEarlierAttempts(
  db: D1Database,
  replacement: Replacement,
  options: ClockOption = {},
): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT id FROM registry_versions
     WHERE source_repository = ?1 AND source_commit_sha = ?2 AND attempt < ?3 AND status = 'importing'`
  ).bind(replacement.source_repository.toLowerCase(), replacement.source_commit_sha, replacement.attempt)
    .all<{ id: string }>();

  const createdAt = nowOf(options.now).toISOString();
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
async function supersedeStaleAttempts(
  db: D1Database,
  repository: string,
  commitSha: string,
  options: ClockOption = {},
): Promise<string[]> {
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
  return newest === null || newest === undefined ? [] : supersedeEarlierAttempts(db, newest, options);
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
 * `approvalId` is the approval an activation uses, and null for a rollback.
 *
 * The pointer trigger refuses a target that is not validated, and because
 * both statements run in one batch, a refused pointer change rolls back the
 * audit event with it. Both are written at one instant, `at`, which is how
 * migration 0011 tells a move an activation made from any other.
 */
function activationStatements(
  db: D1Database,
  move: {
    activationId: string,
    versionId:    string,
    action:       ActivationAction,
    actor:        string,
    reason:       string,
    at:           string,
    approvalId:   string | null,
  },
  expected?: Condition,
): [ D1PreparedStatement, D1PreparedStatement ] {
  return [
    conditioned(
      db,
      `INSERT INTO registry_activations (id, registry_version_id, previous_version_id, action, actor, reason, created_at, approval_id)
       SELECT ?1, ?2, active_version_id, ?3, ?4, ?5, ?6, ?7
       FROM registry_state
       WHERE singleton_id = 1 AND active_version_id IS NOT ?2`,
      [ move.activationId, move.versionId, move.action, move.actor, move.reason, move.at, move.approvalId ],
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

// that the pointer still names `active`, null for nothing on; undefined expects nothing
function pointerAt(active: string | null | undefined): Condition | undefined {
  return active === undefined ? undefined : { sql: first => `active_version_id IS ?${first}`, values: [ active ] };
}

/*
 * Whether an approval may still let its version be switched on, as SQL over
 * the approval's alias: it is in force at `at`, it was made while `active`
 * was on — the version an activation would replace — and no move has used
 * it, or switched its version on since it was made. Going back to a version
 * and forward again is a new decision, which needs a new approval. Every
 * reader of approvals asks this one question: an activation before it is
 * written, the status of a version waiting to be switched on, and the
 * history of a version; migration 0011's trigger asks it of every
 * activation, with the activator's name besides.
 */
function approvalUsable(approval: string, active: string, at: string): string {
  return `${approval}.expires_at > ${at}
    AND ${approval}.active_version_id IS ${active}
    AND NOT EXISTS (SELECT 1 FROM registry_activations AS spent WHERE spent.approval_id = ${approval}.id)
    AND NOT EXISTS (
      SELECT 1 FROM registry_activations AS later
      WHERE later.registry_version_id = ${approval}.registry_version_id AND later.created_at >= ${approval}.created_at
    )`;
}

function approvalOf(row: RegistryApprovalRow & { activation_id: string | null, usable: number }): ApprovalV1 {
  return {
    id:               row.id,
    versionId:        row.registry_version_id,
    snapshotChecksum: row.snapshot_checksum,
    activeVersionId:  row.active_version_id,
    actor:            row.actor,
    reason:           row.reason,
    createdAt:        row.created_at,
    expiresAt:        row.expires_at,
    activationId:     row.activation_id,
    usable:           row.usable === 1,
  };
}

/*
 * Records that `actor` approves a validated version, against the version
 * that is on: the approval covers that change and no other, and expires
 * `ttlSeconds` after it is given, an expiry stored with it, so changing the
 * setting changes no approval already given. The version on is never
 * approved: it is no change, and an approval of it could only ever wait for
 * a move back. `expectedActiveVersionId` is the version its giver read the
 * changes against, null for nothing on, and the approval is written only
 * while that is what is on: a move made after the reading would have it
 * cover a change nobody read.
 */
async function approveVersion(
  db: D1Database,
  input: {
    versionId:               string,
    actor:                   string,
    reason:                  string,
    ttlSeconds:              number,
    expectedActiveVersionId: string | null,
  },
): Promise<ApprovalV1> {
  const version = await readVersion(db, input.versionId);
  if (version === null) {
    throw new RegistryError('CANDIDATE_STATE_CONFLICT', `no such registry version`, input.versionId);
  }
  if (version.status !== 'validated' || version.snapshot_checksum === null) {
    throw new RegistryError('CANDIDATE_STATE_CONFLICT', `only a validated version can be approved`, input.versionId);
  }

  const id  = crypto.randomUUID();
  const now = Date.now();
  const [ inserted, written ] = await db.batch([
    conditioned(
      db,
      `INSERT INTO registry_approvals (
         id, registry_version_id, snapshot_checksum, active_version_id, actor, reason, created_at, expires_at
       )
       SELECT ?1, ?2, ?3, active_version_id, ?4, ?5, ?6, ?7
       FROM registry_state
       WHERE singleton_id = 1 AND active_version_id IS NOT ?2`,
      [
        id, input.versionId, version.snapshot_checksum, input.actor, input.reason,
        new Date(now).toISOString(), new Date(now + input.ttlSeconds * 1000).toISOString(),
      ],
      pointerAt(input.expectedActiveVersionId),
    ),
    db.prepare(`SELECT * FROM registry_approvals WHERE id = ?1`).bind(id),
  ]);

  const row = (written!.results?.[0] ?? null) as RegistryApprovalRow | null;
  if (changedRows(inserted!) === 0 || row === null) {
    const active = await readActiveVersionId(db);
    throw new RegistryError(
      'CANDIDATE_STATE_CONFLICT',
      active === input.versionId
        ? `registry version ${input.versionId} is on already; an approval is of a version to switch on`
        : `the active version is ${active ?? 'none'}, not ${input.expectedActiveVersionId ?? 'none'} as this approval expected`,
      input.versionId,
    );
  }
  return approvalOf({ ...row, activation_id: null, usable: 1 });
}

/*
 * The approval an activation by `actor` at `at` may use, replacing `active`:
 * the newest by another name, or null for none. Names, not tokens, are the
 * people here: two tokens of one holder never approve each other's
 * activation.
 */
async function usableApprovalOf(
  db: D1Database,
  { versionId, actor, active, at }: { versionId: string, actor: string, active: string | null, at: string },
): Promise<string | null> {
  const id = await db.prepare(
    `SELECT approval.id FROM registry_approvals AS approval
     WHERE approval.registry_version_id = ?1 AND approval.actor <> ?2
       AND ${approvalUsable('approval', '?3', '?4')}
     ORDER BY approval.created_at DESC, approval.rowid DESC
     LIMIT 1`
  ).bind(versionId, actor, active, at).first<string | null>('id');
  return id ?? null;
}

/*
 * The version a rollback from `active` restores: the one `active` replaced
 * when an activation last switched it on, so long as that one is older in
 * the order the version listing uses; null when there is none — `active`
 * replaced nothing then, or a newer version, which only another approved
 * activation brings back. A rollback goes back that one step and no further:
 * the step before it is another rollback, from the version this one
 * restores, announced on its own. Migration 0011's trigger holds the same
 * rule.
 */
async function restorableFrom(db: D1Database, active: string): Promise<string | null> {
  const id = await db.prepare(
    `SELECT replaced.id
     FROM registry_activations AS latest
     JOIN registry_versions AS replaced ON replaced.id = latest.previous_version_id
     JOIN registry_versions AS active ON active.id = latest.registry_version_id
     WHERE latest.id = (
         SELECT id FROM registry_activations
         WHERE action = 'activate' AND registry_version_id = ?1
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1
       )
       AND (replaced.created_at, replaced.attempt, replaced.id) < (active.created_at, active.attempt, active.id)`
  ).bind(active).first<string | null>('id');
  return id ?? null;
}

// what a rollback may restore while `active` is on, as the refusal of one to `versionId` says it
function rollbackRefusal(versionId: string, active: string | null, restorable: string | null): string {
  if (active === null) {
    return `nothing is on, so there is nothing to roll back`;
  }
  const instead = `to switch ${versionId} on, activate it once an admin of another name has approved it`;
  return restorable === null
    ? `a rollback goes back one step, and ${active} replaced no older version when it was last activated, so nothing is restored alone; ${instead}`
    : `a rollback goes back one step, from ${active} to ${restorable}, the version it replaced when it was last activated; ${instead}`;
}

/*
 * Refuses a rollback to anything but the version restorableFrom names. Going
 * back a step is break-glass, which one person may do; going anywhere else is
 * an activation, which needs two.
 */
async function assertRestorable(db: D1Database, versionId: string, active: string | null): Promise<void> {
  const restorable = active === null ? null : await restorableFrom(db, active);
  if (restorable !== versionId) {
    throw new RegistryError('ROLLBACK_TARGET_INVALID', rollbackRefusal(versionId, active, restorable), versionId);
  }
}

/*
 * The batch of a move, whose rule was checked a moment before against the
 * version on. Moves made in between can break it while the pointer comes
 * back to that version: an approval used up by another activation that
 * switched the version on and a move that went back again, or the version
 * on switched off and on again in place of another, which a rollback from it
 * then no longer restores. Migration 0011 refuses the move then, and the
 * refusal is the conflict the check would have answered, not a fault.
 */
async function writeMove(db: D1Database, statements: D1PreparedStatement[], versionId: string): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (error) {
    const message = String(error);
    if (message.includes('an activation requires an approval') || message.includes('UNIQUE constraint failed: registry_activations.approval_id')) {
      throw new RegistryError(
        'APPROVAL_REQUIRED',
        `the approval of registry version ${versionId} this activation was to use was used up while it was decided; read the version and ask again`,
        versionId,
        { cause: error },
      );
    }
    if (message.includes('a rollback restores only')) {
      const active     = await readActiveVersionId(db);
      const restorable = active === null ? null : await restorableFrom(db, active);
      throw new RegistryError(
        'ROLLBACK_TARGET_INVALID',
        `the version on was switched on again while this rollback was decided, and ${rollbackRefusal(versionId, active, restorable)}`,
        versionId,
        { cause: error },
      );
    }
    throw error;
  }
}

/*
 * Moves the active pointer, auditing the change, in the two statements
 * above: once only, however often it is asked.
 *
 * What is on decides the rule a move answers to. Moving to the version that
 * is on is the idempotent no-op, which needs nothing and writes nothing,
 * whatever it expected. An activation needs an approval of its version by
 * another name (usableApprovalOf), which it records and uses up. A rollback
 * needs none, as break-glass, but goes back one step only, to the older
 * version the one on replaced when it was last activated (restorableFrom).
 * Every move is made here, so no caller can skip the rules, and migration
 * 0011 holds them in the database too once the environment has an approval.
 *
 * A request may name the version it expects to replace, null for nothing on,
 * and is refused when that is not what is on: of two moves made against the
 * same version, the later one does not silently undo the other. The rules are
 * then decided against the pointer as it was read, so both statements are
 * written only while it still names that version: a move made in between
 * would leave a decision about one change written as another.
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
  const registryVersion = { id: input.versionId, checksum: version.snapshot_checksum };
  const unchanged: ActivationResultV1 = {
    action:            input.action,
    activationId:      null,
    previousVersionId: null,
    targetVersionId:   input.versionId,
    changed:           false,
    approvalId:        null,
    registryVersion,
  };

  const active = await readActiveVersionId(db);
  if (active === input.versionId) {
    return unchanged;
  }
  if (input.expectedActiveVersionId !== undefined && active !== input.expectedActiveVersionId) {
    throw new RegistryError(
      'CANDIDATE_STATE_CONFLICT',
      `the active version is ${active ?? 'none'}, not ${input.expectedActiveVersionId ?? 'none'} as this ${input.action} expected`,
      input.versionId,
    );
  }

  const activationId = crypto.randomUUID();
  const timestamp    = new Date().toISOString();
  let approvalId: string | null = null;
  if (input.action === 'activate') {
    approvalId = await usableApprovalOf(db, { versionId: input.versionId, actor: input.actor, active, at: timestamp });
    if (approvalId === null) {
      throw new RegistryError(
        'APPROVAL_REQUIRED',
        `registry version ${input.versionId} has no approval ${input.actor} can activate it with: one by another name, `
          + `in force, given while ${active ?? 'no version'} was on, and not used or overtaken by a move since`,
        input.versionId,
      );
    }
  } else {
    await assertRestorable(db, input.versionId, active);
  }

  const [ auditResult, pointerResult ] = await writeMove(db, activationStatements(db, {
    activationId,
    versionId: input.versionId,
    action:    input.action,
    actor:     input.actor,
    reason:    input.reason,
    at:        timestamp,
    approvalId,
  }, pointerAt(active)), input.versionId);

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
   * Nothing moved: the pointer no longer named what the rules were decided
   * against. A move that switched the target on in between leaves this one
   * where a request made a moment later would be, the idempotent no-op; any
   * other is refused, to be decided again against what is on now.
   */
  if (moved === 0) {
    const current = await readActiveVersionId(db);
    if (current === input.versionId) {
      return unchanged;
    }
    throw new RegistryError(
      'CANDIDATE_STATE_CONFLICT',
      `the active version changed to ${current ?? 'none'} while this ${input.action} was decided; read the status and ask again`,
      input.versionId,
    );
  }

  // written only while `active` was on, the move replaced exactly that
  return {
    action:            input.action,
    activationId,
    previousVersionId: active,
    targetVersionId:   input.versionId,
    changed:           true,
    approvalId,
    registryVersion,
  };
}

async function readActivationHistory(
  db: D1Database,
  versionId: string,
): Promise<ActivationRecordV1[]> {
  const { results } = await db.prepare(
    `SELECT id, action, previous_version_id, registry_version_id, actor, reason, created_at, approval_id
     FROM registry_activations
     WHERE registry_version_id = ?1 OR previous_version_id = ?1
     ORDER BY created_at DESC, rowid DESC`
  ).bind(versionId).all<{
    id: string, action: ActivationAction, previous_version_id: string | null, registry_version_id: string,
    actor: string, reason: string, created_at: string, approval_id: string | null,
  }>();
  return (results ?? []).map(row => ({
    id:                row.id,
    action:            row.action,
    previousVersionId: row.previous_version_id,
    targetVersionId:   row.registry_version_id,
    actor:             row.actor,
    reason:            row.reason,
    createdAt:         row.created_at,
    approvalId:        row.approval_id,
  }));
}

/*
 * Every approval of a version, newest first: who gave it, against which
 * version, until when, the activation that used it, and whether an
 * activation could use it at `at`, against the version on then.
 */
async function readApprovals(db: D1Database, versionId: string, at: string = new Date().toISOString()): Promise<ApprovalV1[]> {
  const { results } = await db.prepare(
    `SELECT approval.*, activation.id AS activation_id,
            CASE WHEN ${approvalUsable('approval', 'state.active_version_id', '?2')} THEN 1 ELSE 0 END AS usable
     FROM registry_approvals AS approval
     JOIN registry_state AS state ON state.singleton_id = 1
     LEFT JOIN registry_activations AS activation ON activation.approval_id = approval.id
     WHERE approval.registry_version_id = ?1
     ORDER BY approval.created_at DESC, approval.rowid DESC`
  ).bind(versionId, at).all<RegistryApprovalRow & { activation_id: string | null, usable: number }>();
  return (results ?? []).map(approvalOf);
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

export type { CandidateInput, ImportedMarket };

export {
  activateVersion,
  activationStatements,
  approvalUsable,
  approveVersion,
  candidateRow,
  findAttemptsByCommit,
  marketWrites,
  exceptionStatements,
  priceExceptionOfRow,
  readSnapshot,
  readUnreviewed,
  readActivationHistory,
  readActivePointer,
  readActiveVersionId,
  readApprovals,
  readMarket,
  readRegistrySnapshot,
  readRetainedVersions,
  readVersion,
  readVersions,
  SUPERSEDED_CHECK,
  supersedeEarlierAttempts,
  supersedeStaleAttempts,
  snapshotChecksum,
};
