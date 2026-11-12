import {
  Address,
  PriceFeedV1,
  ValidationSummaryV1,
  marketKey,
} from '../../lib/model/comet-registry.js';

import { ApiError } from '../http/errors.js';

import { RegistryError, conflict, isRegistryError } from './errors.js';
import type { RegistryErrorCode } from './errors.js';
import {
  feedOf,
  networkDecisions,
  networkOverlayFeedAddresses,
  overlayDigest,
  overlayFeedAddresses,
  parseMarketOverlay,
  parseNetworkOverlay,
} from './overlay.js';
import type { MarketOverlay, NetworkOverlay } from './overlay.js';
import { readOverlays } from './overlay-store.js';
import { exceptionStatements, readUnreviewed, readVersion } from './repository.js';
import type { RegistryVersionRow, VersionStatus } from './rows.js';
import { Condition, changedRows, conditioned, insertStatement } from './sql-condition.js';
import { importOf, noRunImporting } from './sync.js';
import { judgeVersion, verdictStatements } from './validation.js';
import { readRevision, readValidationSummary, unchanged } from './validation-store.js';

// the version a route names by its id: one that does not exist is the same 404 on every route
async function requireVersion(db: D1Database, versionId: string): Promise<RegistryVersionRow> {
  const version = await readVersion(db, versionId);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }
  return version;
}

/*
 * The administrative command behind `POST /versions/{id}/validate`.
 *
 * Validation is a decision about a stored candidate, so it reads the rows
 * back rather than trusting whatever the importer held in memory, and it is
 * fail-closed: a candidate that does not pass completely becomes invalid and
 * keeps the diagnostics that explain why. It is the same pass the importer
 * makes when it finishes a run.
 */
type ValidationOutcome = {
  version: { id: string, status: VersionStatus, checksum: string | null },
  changed: boolean,
  summary: ValidationSummaryV1,
};

// the answer for a version that is already decided, which validating it again does not change
async function decided(
  db: D1Database,
  version: { id: string, status: VersionStatus, snapshot_checksum: string | null },
): Promise<ValidationOutcome> {
  return {
    version: { id: version.id, status: version.status, checksum: version.snapshot_checksum },
    changed: false,
    summary: await readValidationSummary(db, version.id),
  };
}

async function validateStoredVersion(db: D1Database, versionId: string): Promise<ValidationOutcome> {
  const version = await requireVersion(db, versionId);

  /*
   * Revalidating a decided version is the same answer again, whichever way
   * it was decided: its checks are already recorded, and its rows can no
   * longer change.
   */
  if (version.status !== 'importing') {
    return decided(db, version);
  }

  // the run that imported the candidate, whose checkpoints say which roots the source had
  const run = await importOf(db, versionId);

  /*
   * A candidate whose import is still running is missing markets it will
   * have in a minute. Validating it now would find them missing and freeze it
   * as invalid, so the answer is to wait rather than to fail.
   */
  if (run?.status === 'running') {
    throw conflict('IMPORT_STILL_RUNNING', `the import of this registry version is still running`);
  }

  /*
   * The results and the status they decide are one transaction, written only
   * while no import has started on the candidate and no overlay has been
   * written to it since its rows were read. A review written in between
   * would otherwise leave a version validated with a checksum and checks of
   * rows it no longer holds.
   */
  const verdict = await judgeVersion(db, versionId, run === null ? null : run.roots);
  const [ written ] = await db.batch(verdictStatements(db, verdict, {
    hold: false,
    when: noRunImporting(versionId),
    at:   new Date().toISOString(),
  }));
  if (changedRows(written!) === 0) {
    const current = await readVersion(db, versionId);
    if (current !== null && current.status !== 'importing') {
      /*
       * Something else decided it first: a validation that ran at the same
       * time, over the same rows, or a newer attempt of its commit that
       * closed it. Either way the answer is that decision.
       */
      return decided(db, current);
    }
    throw conflict('CANDIDATE_CHANGED', `the candidate changed while it was being validated; validate it again`);
  }

  return {
    version: { id: version.id, status: verdict.checksum === null ? 'invalid' : 'validated', checksum: verdict.checksum },
    changed: true,
    summary: await readValidationSummary(db, versionId),
  };
}

export type { ValidationOutcome };
export { requireVersion, validateStoredVersion };

/*
 * Complete overlay replacement.
 *
 * An overlay is a decision, so a replacement states all of it: the DTO is
 * validated with exact keys, and what is not said is not kept. Only an
 * importing candidate is writable, and an identical replacement is an
 * idempotent no-op that writes no audit event.
 *
 * The overlay names feeds without their scale, so decimals for any feed it
 * introduces are read from the chain here, exactly as the importer does.
 */
type FeedReader = (network: string, addresses: Address[]) => Promise<Map<Address, PriceFeedV1>>;

/*
 * The creation blocks an overlay states for markets of one network, held
 * against the chain (readCreationBlocks): what is wrong with them, each named
 * as the document names its market, or nothing when every one is right.
 */
type CreationReader = (
  network: string,
  markets: Array<{ scope: string, comet: Address, block: number }>,
) => Promise<string[]>;

/*
 * What a document is decided against: the digest of the reviewed overlay its
 * scope holds, or null for a scope nobody has reviewed. A document that says
 * so is refused if the scope holds anything else, so a change that was read,
 * edited and sent back cannot silently undo one made in the meantime.
 */
type Expectation = { expectedDigest?: string | null };

type OverlayResult = {
  versionId:        string,
  changed:          boolean,
  overlayEventId:   string | null,
  // the digest of the overlay the scope holds now, which the next change is decided against
  digest:           string,
  snapshotChecksum: string | null,
};

type OverlayScope = { versionId: string, actor: string, reason: string };

/*
 * Feed decimals this version already recorded for one network. An overlay
 * that keeps a feed it already named needs no chain read at all, so replacing
 * a label does not depend on a node provider answering.
 *
 * The network is part of the question, not a detail: the same address is a
 * different contract on a different chain, and deterministic deployments make
 * that ordinary. A version-wide lookup would hand one chain's scale to
 * another chain's feed, and every price read through it would be off by a
 * power of ten with nothing to show for it.
 */
async function storedFeeds(db: D1Database, versionId: string, networkId: string): Promise<Map<Address, PriceFeedV1>> {
  const { results } = await db.prepare(
    `SELECT price_feed_address AS address, price_feed_decimals AS decimals
     FROM market_assets
     WHERE registry_version_id = ?1 AND network_id = ?2 AND price_feed_address IS NOT NULL
     UNION
     SELECT usd_price_feed_address, usd_price_feed_decimals
     FROM market_assets
     WHERE registry_version_id = ?1 AND network_id = ?2 AND usd_price_feed_address IS NOT NULL
     UNION
     SELECT replacement_price_feed_address, replacement_price_feed_decimals
     FROM network_price_exceptions
     WHERE registry_version_id = ?1 AND network_id = ?2 AND replacement_price_feed_address IS NOT NULL`
  ).bind(versionId, networkId).all<{ address: Address, decimals: number }>();

  return new Map((results ?? []).map(feed => [ feed.address, { address: feed.address, decimals: feed.decimals } ]));
}

/*
 * What a chain answers about an address that is not a feed it can read: the
 * call reverted, or answered nothing a feed's decimals decode from — which is
 * what an address without code answers, such as a feed of another chain.
 */
const UNREADABLE_FEED: ReadonlySet<RegistryErrorCode> = new Set([ 'CHAIN_CALL_REVERTED', 'CHAIN_RESPONSE_INVALID' ]);

/*
 * The decimals of every feed the overlay names: taken from the version where
 * it already knows them, and read from the chain only for feeds it does not.
 *
 * A feed the chain answered for, but not with decimals, is the document
 * naming something that is not a feed on that chain: it is refused as the
 * document's mistake, naming the feed, rather than answered as a provider
 * that is down. A provider that did not answer is still that, and worth
 * trying again.
 */
async function resolveFeeds(
  db: D1Database,
  versionId: string,
  network: { id: string, canonicalName: string },
  addresses: Address[],
  readFeeds: FeedReader,
): Promise<Map<Address, PriceFeedV1>> {
  const known   = await storedFeeds(db, versionId, network.id);
  const missing = addresses.filter(address => !known.has(address));
  if (missing.length === 0) {
    return known;
  }
  let read: Map<Address, PriceFeedV1>;
  try {
    read = await readFeeds(network.canonicalName, missing);
  } catch (error) {
    if (isRegistryError(error) && UNREADABLE_FEED.has(error.code)) {
      throw new RegistryError(
        'OVERLAY_FEED_UNREADABLE',
        `the decimals of a feed the overlay names could not be read on ${network.canonicalName}: ${error.message}`,
        network.canonicalName,
        { cause: error },
      );
    }
    throw error;
  }
  for (const [ address, feed ] of read) {
    known.set(address, feed);
  }
  return known;
}

async function importingVersion(db: D1Database, versionId: string) {
  const version = await requireVersion(db, versionId);
  if (version.status !== 'importing') {
    throw conflict('VERSION_NOT_IMPORTING', `a ${version.status} registry version cannot be changed`);
  }
  return version;
}

function overlayEventStatement(db: D1Database, event: {
  id:             string,
  versionId:      string,
  scopeType:      'network' | 'market',
  scopeKey:       string,
  previousDigest: string | null,
  newDigest:      string,
  actor:          string,
  reason:         string,
}, condition: Condition): D1PreparedStatement {
  return insertStatement(db, 'registry_overlay_events', {
    id:                  event.id,
    registry_version_id: event.versionId,
    scope_type:          event.scopeType,
    scope_key:           event.scopeKey,
    previous_digest:     event.previousDigest,
    new_digest:          event.newDigest,
    actor:               event.actor,
    reason:              event.reason,
    created_at:          new Date().toISOString(),
  }, condition);
}

/*
 * The first event an overlay write records is recorded: what every other
 * statement of the write applies with. That event alone is conditioned on
 * the candidate being as it was read, so the write applies whole or not at
 * all, and the events it records itself do not stand in its way.
 */
function anchoredBy(eventId: string): Condition {
  return {
    sql:    first => `EXISTS (SELECT 1 FROM registry_overlay_events WHERE id = ?${first})`,
    values: [ eventId ],
  };
}

// what a document's scope resolves to: the rows it is written onto (networkRows, marketRows)
type NetworkTarget = { id: string, canonical_name: string };

type MarketTarget = {
  market_id:      string,
  network_id:     string,
  canonical_name: string,
  reward_id:      number | null,
  comet:          Address,
  creation_block: number,
};

/*
 * The statements that write one reviewed network overlay onto the rows the
 * import wrote, as the import writes them (networkDecisions,
 * exceptionStatements). They are built apart from running them so that one
 * document and a whole directory are written by the same code.
 */
function networkStatements(
  db: D1Database,
  versionId: string,
  row: NetworkTarget,
  overlay: NetworkOverlay,
  feeds: Map<Address, PriceFeedV1>,
  condition: Condition,
): D1PreparedStatement[] {
  const network = networkDecisions(overlay, feeds, row.canonical_name);
  return [
    // reviewing a network is what makes its row a decision someone made
    conditioned(db, `UPDATE registry_networks SET display_name = ?1, metadata = ?2, reviewed = 1 WHERE id = ?3`, [
      network.displayName,
      JSON.stringify(network.presentation),
      row.id,
    ], condition),
    conditioned(
      db,
      `DELETE FROM network_price_exceptions WHERE registry_version_id = ?1 AND network_id = ?2`,
      [ versionId, row.id ],
      condition,
    ),
    ...exceptionStatements(db, { registry_version_id: versionId, network_id: row.id }, network, condition),
  ];
}

// the same for one market overlay
function marketStatements(
  db: D1Database,
  row: MarketTarget,
  overlay: MarketOverlay,
  feeds: Map<Address, PriceFeedV1>,
  condition: Condition,
): D1PreparedStatement[] {
  const statements = [
    conditioned(
      db,
      /*
       * `reviewed` is set in the same statement that may enable the market:
       * the schema refuses an unreviewed market that is served, and a
       * review is exactly what makes serving it a decision.
       */
      `UPDATE markets
       SET display_name = ?1, contract_name = ?2, is_default = ?3, status = ?4, creation_block = ?5,
           collateral_value_quote = ?6, rewards_enabled = ?7, account_rewards_enabled = ?8,
           transaction_history_enabled = ?9, slug = ?10, is_institutional = ?11, reviewed = 1
       WHERE id = ?12`,
      [
        overlay.displayName, overlay.contractName, overlay.isDefault ? 1 : 0, overlay.status,
        overlay.creationBlock, overlay.collateralValueQuote,
        overlay.capabilities.rewards ? 1 : 0,
        overlay.capabilities.accountRewards ? 1 : 0,
        overlay.capabilities.transactionHistory ? 1 : 0,
        overlay.slug, overlay.isInstitutional ? 1 : 0,
        row.market_id,
      ],
      condition,
    ),
    conditioned(
      db,
      `UPDATE market_assets
       SET display_name = ?1, is_wrapped_native = ?2, usd_price_feed_address = ?3, usd_price_feed_decimals = ?4
       WHERE market_id = ?5 AND role = 'base'`,
      [
        overlay.baseAsset.displayName,
        overlay.baseAsset.isWrappedNative ? 1 : 0,
        overlay.baseAsset.usdPriceFeedAddress,
        overlay.baseAsset.usdPriceFeedAddress === null
          ? null
          : feedOf(feeds, overlay.baseAsset.usdPriceFeedAddress, row.canonical_name).decimals,
        row.market_id,
      ],
      condition,
    ),
  ];

  if (row.reward_id !== null) {
    statements.push(conditioned(
      db,
      `UPDATE market_assets
       SET price_feed_address = ?1, price_feed_decimals = ?2, price_feed_quote = ?3
       WHERE market_id = ?4 AND role = 'reward'`,
      [
        overlay.rewardPriceFeed?.address ?? null,
        overlay.rewardPriceFeed === null
          ? null
          : feedOf(feeds, overlay.rewardPriceFeed.address, row.canonical_name).decimals,
        overlay.rewardPriceFeed?.quote ?? null,
        row.market_id,
      ],
      condition,
    ));
  }
  return statements;
}

function refuseRewardFeedWithoutReward(key: string, row: MarketTarget, overlay: MarketOverlay): void {
  if (overlay.rewardPriceFeed !== null && row.reward_id === null) {
    throw conflict(
      'REWARD_FEED_WITHOUT_REWARD',
      `${key} has no reward asset on chain, so it cannot carry a reward price feed`,
    );
  }
}

/*
 * An exception that has already expired applies to nothing: written that
 * way, it is a mistake in its date, which would be stored, carried into every
 * later version, and never once price the feed it names. It is refused when a
 * document writes it. One the network already holds exactly as it is was
 * decided before, not by this document: a network overlay is replaced whole,
 * so every later change to the network sends it again, and it is kept as it
 * is — imports clone it the same way, and the catalog stops applying it on
 * its own — so this is not a check validation makes either.
 */
function refuseExpired(overlay: NetworkOverlay, held: NetworkOverlay | undefined, scope: string, at: number): void {
  const kept    = new Set((held?.priceExceptions ?? []).map(exception => JSON.stringify(exception)));
  const expired = overlay.priceExceptions.filter(exception => (
    exception.expiresAt !== null && Date.parse(exception.expiresAt) <= at && !kept.has(JSON.stringify(exception))
  ));
  if (expired.length > 0) {
    throw new RegistryError(
      'OVERLAY_INVALID',
      `${scope} has price exceptions that have already expired: `
        + expired.map(exception => `${exception.priceFeedAddress} at ${exception.expiresAt}`).join(', '),
      scope,
    );
  }
}

/*
 * The schema allows one default market per version and one market per slug
 * and network. Both surface as unique constraint failures, told apart by the
 * columns SQLite names. A version that ended between the check at the start
 * of a write and the write itself is refused by its triggers; the write's own
 * condition normally stops it first, and either way it is the same conflict.
 */
async function writeReview(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (error) {
    const message = String(error);
    if (message.includes('UNIQUE constraint failed') && message.includes('markets.slug')) {
      throw conflict('SLUG_TAKEN', `another market of this network already has that slug`);
    }
    if (message.includes('UNIQUE constraint failed: markets.registry_version_id')) {
      throw conflict('DEFAULT_TAKEN', `another market of this version is already the default`);
    }
    if (message.includes('registry version is not importing')) {
      throw conflict('VERSION_NOT_IMPORTING', `the registry version is no longer importing, so it cannot be changed`);
    }
    throw error;
  }
}

/*
 * Every network, and every market with its Comet and its reward asset, that
 * the import has written into a version. The routes address them by chain id
 * and deployment key; these are the rows those names resolve to.
 */
async function networkRows(db: D1Database, versionId: string): Promise<Map<number, NetworkTarget>> {
  const { results } = await db.prepare(
    `SELECT id, chain_id, canonical_name FROM registry_networks WHERE registry_version_id = ?1`
  ).bind(versionId).all<NetworkTarget & { chain_id: number }>();
  return new Map((results ?? []).map(row => [ row.chain_id, { id: row.id, canonical_name: row.canonical_name } ]));
}

async function marketRows(db: D1Database, versionId: string): Promise<Map<string, MarketTarget>> {
  const { results } = await db.prepare(
    `SELECT market.id AS market_id, market.network_id, network.canonical_name,
            network.chain_id, market.deployment_key, market.creation_block,
            (SELECT asset.id FROM market_assets AS asset
             WHERE asset.market_id = market.id AND asset.role = 'reward') AS reward_id,
            (SELECT contract.address FROM market_contracts AS contract
             WHERE contract.market_id = market.id AND contract.role = 'comet') AS comet
     FROM markets AS market
     JOIN registry_networks AS network ON network.id = market.network_id
     WHERE market.registry_version_id = ?1`
  ).bind(versionId).all<MarketTarget & { chain_id: number, deployment_key: string }>();
  return new Map((results ?? []).map(row => [ marketKey(row.chain_id, row.deployment_key), {
    market_id:      row.market_id,
    network_id:     row.network_id,
    canonical_name: row.canonical_name,
    reward_id:      row.reward_id ?? null,
    comet:          row.comet,
    creation_block: row.creation_block,
  } ]));
}

/*
 * Overlay documents, one or a whole reviewed directory: the way a new
 * environment is reviewed, where every network and market the first import
 * wrote needs its decisions at once, and the way one market is changed.
 *
 * Nothing is written unless everything can be. Every document is parsed, every
 * row it names is found, and every feed it introduces is read before the first
 * statement runs, and the writes go to D1 as one batch, which is one
 * transaction: a directory is either applied or not, never half. A document
 * identical to what is stored writes nothing.
 */
type OverlayDocuments = OverlayScope & {
  networks: Array<{ chainId: number, overlay: unknown } & Expectation>,
  markets:  Array<{ chainId: number, deploymentKey: string, overlay: unknown } & Expectation>,
};

type OverlaysResult = {
  versionId:        string,
  changed:          boolean,
  documents:        Array<{
    scopeType:      'network' | 'market',
    scopeKey:       string,
    changed:        boolean,
    overlayEventId: string | null,
    digest:         string,
  }>,
  snapshotChecksum: string | null,
  unreviewed:       { networks: number[], markets: string[] },
};

/*
 * How a request names what it refuses. A directory names each document by its
 * key and every scope it cannot find at once; a one-document route names its
 * document the overlay, and the scope it cannot find in a sentence of its own.
 */
type Naming = {
  network: (chainId: number) => string,
  market:  (key: string) => string,
  missing: (scopes: string[]) => string,
};

const DIRECTORY: Naming = {
  network: chainId => `networks.${chainId}`,
  market:  key => `markets.${key}`,
  missing: scopes => `${scopes.join(', ')} not imported into this registry version yet`,
};

const ONE_DOCUMENT: Naming = {
  network: () => 'overlay',
  market:  () => 'overlay',
  missing: scopes => `${scopes.join(', ')} has not been imported into this registry version yet`,
};

async function writeOverlays(
  db: D1Database,
  input: OverlayDocuments,
  readFeeds: FeedReader,
  readCreations: CreationReader,
  naming: Naming,
): Promise<Omit<OverlaysResult, 'unreviewed'>> {
  const version = await importingVersion(db, input.versionId);

  const networks = input.networks.map(({ chainId, overlay, expectedDigest }) => ({
    chainId,
    expectedDigest,
    overlay: parseNetworkOverlay(overlay, naming.network(chainId)),
  }));
  const markets = input.markets.map(({ chainId, deploymentKey, overlay, expectedDigest }) => ({
    key: marketKey(chainId, deploymentKey),
    expectedDigest,
    overlay: parseMarketOverlay(overlay, naming.market(marketKey(chainId, deploymentKey))),
  }));

  /*
   * The revision is read before anything the write is decided from, and the
   * write applies only while the candidate is still at it. A review someone
   * else writes in between is refused rather than overwritten by a document
   * decided against what it replaced; and an audit event's previous digest is
   * then always the overlay it really replaced.
   */
  const { revision } = await readRevision(db, input.versionId);

  /*
   * An import writes every network and market it reaches, reviewed or not,
   * so a scope missing here is one this candidate has not reached yet: the
   * answer is to let the import continue, not to record the decision
   * somewhere else.
   */
  const [ networkRow, marketRow ] = await Promise.all([ networkRows(db, input.versionId), marketRows(db, input.versionId) ]);
  const missing = [
    ...networks.filter(({ chainId }) => !networkRow.has(chainId)).map(({ chainId }) => `chain ${chainId}`),
    ...markets.filter(({ key }) => !marketRow.has(key)).map(({ key }) => key),
  ];
  if (missing.length > 0) {
    throw new ApiError('NOT_FOUND', naming.missing(missing));
  }

  const stored = await readOverlays(db, input.versionId);
  const plannedNetworks = await Promise.all(networks.map(async ({ chainId, overlay, expectedDigest }) => {
    const current = stored.networks.get(chainId);
    return {
      chainId, overlay, expectedDigest,
      scope:    `network ${chainId}`,
      row:      networkRow.get(chainId)!,
      previous: current === undefined ? null : await overlayDigest(current),
      digest:   await overlayDigest(overlay),
    };
  }));
  const plannedMarkets = await Promise.all(markets.map(async ({ key, overlay, expectedDigest }) => {
    const current = stored.markets.get(key);
    return {
      key, overlay, expectedDigest,
      scope:    `market ${key}`,
      row:      marketRow.get(key)!,
      previous: current === undefined ? null : await overlayDigest(current),
      digest:   await overlayDigest(overlay),
    };
  }));

  const stale = [ ...plannedNetworks, ...plannedMarkets ]
    .filter(entry => entry.expectedDigest !== undefined && entry.expectedDigest !== entry.previous);
  if (stale.length > 0) {
    throw conflict(
      'OVERLAY_CHANGED',
      `the overlay of ${stale.map(entry => entry.scope).join(', ')} is no longer the one this was decided against; read it again`,
      { current: Object.fromEntries(stale.map(entry => [ entry.scope, entry.previous ])) },
    );
  }

  const changedNetworks = plannedNetworks.filter(entry => entry.previous !== entry.digest);
  const changedMarkets  = plannedMarkets.filter(entry => entry.previous !== entry.digest);

  const at = Date.now();
  for (const { chainId, overlay } of changedNetworks) {
    refuseExpired(overlay, stored.networks.get(chainId), naming.network(chainId), at);
  }
  for (const { key, row, overlay } of changedMarkets) {
    refuseRewardFeedWithoutReward(key, row, overlay);
  }

  /*
   * The creation block is where every index of a market starts. One past the
   * latest block leaves none of the market's values to read, and the market
   * routes and the rewards of an account answer it as an error until the
   * chain reaches it (market.ts, unreachedMarket); one before the deployment
   * fails the history routes that read the market, those over every network
   * among them. A document that changes it has it checked against the chain,
   * with one read per network, whether or not it serves the market: a later
   * document that switches the market on and keeps the block then serves one
   * that was checked. A document that keeps the block reads nothing for it,
   * as one that keeps its feeds does, and a block of 0 states none.
   */
  const creations = new Map<string, Parameters<CreationReader>[1]>();
  for (const { key, row, overlay } of changedMarkets) {
    if (overlay.creationBlock > 0 && overlay.creationBlock !== row.creation_block) {
      creations.set(row.canonical_name, [
        ...(creations.get(row.canonical_name) ?? []),
        { scope: naming.market(key), comet: row.comet, block: overlay.creationBlock },
      ]);
    }
  }
  const wrong = (await Promise.all(
    [ ...creations ].map(([ network, markets ]) => readCreations(network, markets)),
  )).flat();
  if (wrong.length > 0) {
    throw new RegistryError('OVERLAY_CREATION_BLOCK_WRONG', wrong.join('; '));
  }

  /*
   * One read per network for the feeds the changed documents introduce, so a
   * directory costs a chain read per network rather than one per document,
   * and the networks are read side by side rather than one after another.
   */
  const addresses = new Map<string, { canonicalName: string, addresses: Set<Address> }>();
  const want = (networkId: string, canonicalName: string, feeds: Address[]) => {
    const entry = addresses.get(networkId) ?? { canonicalName, addresses: new Set<Address>() };
    feeds.forEach(address => entry.addresses.add(address));
    addresses.set(networkId, entry);
  };
  changedNetworks.forEach(({ row, overlay }) => want(row.id, row.canonical_name, networkOverlayFeedAddresses(overlay)));
  changedMarkets.forEach(({ row, overlay }) => want(row.network_id, row.canonical_name, overlayFeedAddresses(overlay)));
  const feeds = new Map<string, Map<Address, PriceFeedV1>>(await Promise.all(
    [ ...addresses ].map(async ([ networkId, { canonicalName, addresses: wanted } ]) => [
      networkId,
      wanted.size === 0
        ? new Map<Address, PriceFeedV1>()
        : await resolveFeeds(db, input.versionId, { id: networkId, canonicalName }, [ ...wanted ], readFeeds),
    ] as const),
  ));

  const event = (scopeType: 'network' | 'market', scopeKey: string, previous: string | null, digest: string) => ({
    id:             crypto.randomUUID(),
    versionId:      input.versionId,
    scopeType,
    scopeKey,
    previousDigest: previous,
    newDigest:      digest,
    actor:          input.actor,
    reason:         input.reason,
  });
  const events = [
    ...changedNetworks.map(({ chainId, previous, digest }) => event('network', String(chainId), previous, digest)),
    ...changedMarkets.map(({ key, previous, digest }) => event('market', key, previous, digest)),
  ];
  const [ anchor, ...others ] = events;

  if (anchor !== undefined) {
    const condition = anchoredBy(anchor.id);
    const results = await writeReview(db, [
      // the one statement the candidate's revision decides: every other one applies with it
      overlayEventStatement(db, anchor, unchanged(input.versionId, revision)),
      ...changedNetworks.flatMap(({ row, overlay }) => networkStatements(
        db, input.versionId, row, overlay, feeds.get(row.id)!, condition,
      )),
      /*
       * The schema allows one default market per version and one market per
       * slug and network after every statement, not only at the end of the
       * batch. A directory may move the default or a slug, or swap two slugs,
       * and no order of writes satisfies that for every such directory; so
       * every changed market first gives up both, and then takes what its
       * document says. A conflict left after that is one the directory itself
       * holds.
       */
      ...changedMarkets.map(({ row }) => conditioned(
        db, `UPDATE markets SET slug = NULL, is_default = 0 WHERE id = ?1`, [ row.market_id ], condition,
      )),
      ...changedMarkets.flatMap(({ row, overlay }) => marketStatements(
        db, row, overlay, feeds.get(row.network_id)!, condition,
      )),
      ...others.map(event => overlayEventStatement(db, event, condition)),
    ]);

    if (changedRows(results[0]!) !== 1) {
      const current = await readVersion(db, input.versionId);
      throw current === null || current.status !== 'importing'
        ? conflict('VERSION_NOT_IMPORTING', `a ${current?.status ?? 'removed'} registry version cannot be changed`)
        : conflict('OVERLAY_CHANGED', `the registry version changed while this overlay was being written; read it again`);
    }
  }

  const eventOf = new Map(events.map(event => [ `${event.scopeType} ${event.scopeKey}`, event.id ]));
  return {
    versionId: input.versionId,
    changed:   events.length > 0,
    documents: [
      ...plannedNetworks.map(({ chainId, scope, digest }) => ({
        scopeType:      'network' as const,
        scopeKey:       String(chainId),
        changed:        eventOf.has(scope),
        overlayEventId: eventOf.get(scope) ?? null,
        digest,
      })),
      ...plannedMarkets.map(({ key, scope, digest }) => ({
        scopeType:      'market' as const,
        scopeKey:       key,
        changed:        eventOf.has(scope),
        overlayEventId: eventOf.get(scope) ?? null,
        digest,
      })),
    ],
    // a draft has none: validation writes it, in the statement that ends the draft
    snapshotChecksum: version.snapshot_checksum,
  };
}

function oneDocument(written: Omit<OverlaysResult, 'unreviewed'>): OverlayResult {
  const [ document ] = written.documents;
  return {
    versionId:        written.versionId,
    changed:          written.changed,
    overlayEventId:   document!.overlayEventId,
    digest:           document!.digest,
    snapshotChecksum: written.snapshotChecksum,
  };
}

async function replaceNetworkOverlay(
  db: D1Database,
  input: OverlayScope & { chainId: number, overlay: unknown } & Expectation,
  readFeeds: FeedReader,
): Promise<OverlayResult> {
  const { chainId, overlay, expectedDigest, ...scope } = input;
  // a network overlay states no creation block, so none is read
  return oneDocument(await writeOverlays(db, {
    ...scope,
    networks: [ { chainId, overlay, ...(expectedDigest === undefined ? {} : { expectedDigest }) } ],
    markets:  [],
  }, readFeeds, async () => [], ONE_DOCUMENT));
}

async function replaceMarketOverlay(
  db: D1Database,
  input: OverlayScope & { chainId: number, deploymentKey: string, overlay: unknown } & Expectation,
  readFeeds: FeedReader,
  readCreations: CreationReader,
): Promise<OverlayResult> {
  const { chainId, deploymentKey, overlay, expectedDigest, ...scope } = input;
  return oneDocument(await writeOverlays(db, {
    ...scope,
    networks: [],
    markets:  [ { chainId, deploymentKey, overlay, ...(expectedDigest === undefined ? {} : { expectedDigest }) } ],
  }, readFeeds, readCreations, ONE_DOCUMENT));
}

/*
 * A whole reviewed directory in one request. What each document changes is
 * decided exactly as the one-document routes decide it, and the answer says
 * what is still unreviewed.
 */
async function replaceOverlays(
  db: D1Database,
  input: OverlayDocuments,
  readFeeds: FeedReader,
  readCreations: CreationReader,
): Promise<OverlaysResult> {
  const written = await writeOverlays(db, input, readFeeds, readCreations, DIRECTORY);
  return { ...written, unreviewed: await readUnreviewed(db, input.versionId) };
}

export type { CreationReader, Expectation, FeedReader, OverlayDocuments, OverlayResult, OverlaysResult };
export { replaceMarketOverlay, replaceNetworkOverlay, replaceOverlays };
