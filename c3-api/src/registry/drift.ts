import { Address, MarketV1, NetworkV1, RegistrySnapshotV1, marketKey } from '../../lib/model/comet-registry.js';

import type { CachedSnapshot } from './cache.js';
import { servedNetworks } from './catalog.js';
import type { ServedMarket } from './catalog.js';
import { CometFacts, RpcTransport, readCometFacts } from './enrichment.js';
import { isRegistryError } from './errors.js';

/*
 * The chain drift check: whether what the active version read from the chain
 * when it was imported is still what the chain answers.
 *
 * An import reads each market's base feed and collateral assets from its
 * Comet once, and the registry serves them from then on. Discovery imports
 * again only when the tracked commit moves, while governance can change a
 * market on chain — a collateral's price feed above all — without the source
 * moving at all. The version on would then go on describing a market the
 * chain no longer has, and nothing would say so.
 *
 * So the hourly job reads those facts again once a day, and within the hour
 * for a version switched on since, and records what it found in KV, where
 * /admin/status reads it without asking the chain anything itself, and
 * raises `chain-drift` until a check of the version on finds it agrees with
 * the chain. Nothing is changed here, and nothing activated: an operator
 * imports the commit again with a forced attempt, which reads the chain anew,
 * then validates and switches the result on.
 */

// one fact of a market the chain no longer answers as the version stores it
type ChainDrift = {
  chainId: number,
  network: string,
  // the market as `chainId/deploymentKey`, and its Comet
  market:  string,
  comet:   Address,
  /*
   * The asset the fact is about: the base asset, or a collateral asset by its
   * index, with the token the version stores there — or, for a collateral the
   * chain has added, the token the chain names.
   */
  asset: {
    role:       'base' | 'collateral',
    assetIndex: number | null,
    token:      Address | null,
    symbol:     string | null,
  },
  // `token`: a collateral asset added, removed or replaced at its index; `priceFeed`: the feed that prices it
  field:   'token' | 'priceFeed',
  stored:  Address | null,
  current: Address | null,
  /*
   * When the chain was last read answering it: the check that found it, or,
   * while its network cannot be read, the last check that could.
   */
  seenAt:  string,
};

// a network the chain could not be read for: nothing new is known about its markets, drifted or not
type UnreadNetwork = {
  chainId: number,
  network: string,
  error:   string,
};

type ChainCheck = {
  versionId:  string,
  checkedAt:  string,
  drifts:     ChainDrift[],
  unreadable: UnreadNetwork[],
};

type ChainCheckDeps = {
  kv:              KVNamespace,
  // the active version, as the cache resolves it for every other read of it
  active:          () => Promise<CachedSnapshot | null>,
  // one transport per network, the importer's own
  transportFor:    (network: string) => RpcTransport,
  // how often the version on is checked: the interval the source is checked at
  intervalSeconds: number,
  // the time of the invocation: what a check is recorded at, and what it is due by
  now?:            () => Date,
  debug?: {
    log:  (...parameters: unknown[]) => unknown,
    warn: (...parameters: unknown[]) => unknown,
  },
};

// the last check, for the status to read; a new one replaces it
const CHECK_KEY = 'chain-check:v1';

/*
 * The last check recorded, or null for none — or for an entry of some other
 * shape, which is no check this release can read.
 */
async function readChainCheck(kv: KVNamespace): Promise<ChainCheck | null> {
  const check = await kv.get(CHECK_KEY, 'json') as ChainCheck | null;
  if (check === null || typeof(check) !== 'object') {
    return null;
  }
  const readable = typeof(check.versionId) === 'string'
    && typeof(check.checkedAt) === 'string'
    && Number.isFinite(Date.parse(check.checkedAt))
    && Array.isArray(check.drifts)
    && Array.isArray(check.unreadable);
  return readable ? check : null;
}

/*
 * Where a market's chain facts differ from the version's. A collateral
 * replaced at its index is one drift, of its token: the feed of another token
 * is no comparison. A collateral the chain added or removed is one too, with
 * nothing on the side that lacks it.
 */
function driftsOf(network: NetworkV1, market: ServedMarket, facts: CometFacts, seenAt: string): ChainDrift[] {
  const where = {
    chainId: network.chainId,
    network: network.key,
    market:  marketKey(network.chainId, market.deploymentKey),
    comet:   market.contracts.comet,
  };
  const drifts: ChainDrift[] = [];

  const base = market.baseAsset;
  if (base.priceFeed.address !== facts.basePriceFeed) {
    drifts.push({
      ...where,
      asset:   { role: 'base', assetIndex: null, token: base.token.address, symbol: base.token.symbol },
      field:   'priceFeed',
      stored:  base.priceFeed.address,
      current: facts.basePriceFeed,
      seenAt,
    });
  }

  const indices = [ ...new Set([
    ...market.collateralAssets.map(asset => asset.assetIndex),
    ...facts.collateralAssets.map(asset => asset.assetIndex),
  ]) ].sort((left, right) => left - right);
  for (const assetIndex of indices) {
    const stored  = market.collateralAssets.find(asset => asset.assetIndex === assetIndex);
    const current = facts.collateralAssets.find(asset => asset.assetIndex === assetIndex);
    const asset   = {
      role:   'collateral' as const,
      assetIndex,
      token:  stored?.token.address ?? current?.token ?? null,
      symbol: stored?.token.symbol ?? null,
    };
    if (stored?.token.address !== current?.token) {
      drifts.push({ ...where, asset, field: 'token', stored: stored?.token.address ?? null, current: current?.token ?? null, seenAt });
    } else if (stored !== undefined && current !== undefined && stored.priceFeed.address !== current.priceFeed) {
      drifts.push({ ...where, asset, field: 'priceFeed', stored: stored.priceFeed.address, current: current.priceFeed, seenAt });
    }
  }
  return drifts;
}

/*
 * Whether a version's markets store a fact as a drift found it stored: the
 * same Comet, the same asset at the same place, the same value. The drift is
 * then theirs too for as long as the chain answers what it answered, whichever
 * version it was found for.
 */
function sharesDrift(markets: MarketV1[], drift: ChainDrift): boolean {
  const market = markets.find(market => market.contracts.comet === drift.comet);
  if (market === undefined) {
    return false;
  }
  if (drift.asset.role === 'base') {
    return market.baseAsset.priceFeed.address === drift.stored;
  }
  const asset = market.collateralAssets.find(asset => asset.assetIndex === drift.asset.assetIndex);
  if (drift.field === 'token') {
    return (asset?.token.address ?? null) === drift.stored;
  }
  return asset !== undefined && asset.token.address === drift.asset.token && asset.priceFeed.address === drift.stored;
}

// why a network could not be read, as safe to keep and to answer as a sync's own diagnostics
function failureOf(error: unknown): string {
  return isRegistryError(error) ? `${error.code}: ${error.message}` : 'the chain could not be read';
}

/*
 * Reads every network of a version that serves a market, side by side, and
 * compares each market it serves with what its Comet answers. A disabled
 * market is not compared: nothing the registry serves describes it.
 *
 * A network that could not be read says nothing new about its markets. What
 * `previous`, the last check, found there still stands wherever this version
 * stores the same, so a chain that does not answer neither raises a drift
 * nor clears one.
 */
async function compareWithChain(
  snapshot: RegistrySnapshotV1,
  previous: ChainCheck | null,
  deps: ChainCheckDeps,
  checkedAt: Date,
): Promise<ChainCheck> {
  const seenAt = checkedAt.toISOString();

  const read = await Promise.all(servedNetworks(snapshot).map(async ({ network, markets }): Promise<{
    drifts: ChainDrift[],
    unread: UnreadNetwork | null,
  }> => {
    try {
      const facts = await readCometFacts(
        deps.transportFor(network.key),
        markets.map(market => market.contracts.comet),
        network.key,
      );
      return {
        drifts: markets.flatMap(market => driftsOf(network, market, facts.get(market.contracts.comet)!, seenAt)),
        unread: null,
      };
    } catch (error) {
      // a chain that did not answer is reported as unread, and read again
      deps.debug?.warn(`registry chain not read`, { network: network.key, error });
      return {
        drifts: (previous?.drifts ?? []).filter(drift => drift.chainId === network.chainId && sharesDrift(markets, drift)),
        unread: { chainId: network.chainId, network: network.key, error: failureOf(error) },
      };
    }
  }));

  return {
    versionId:  snapshot.registryVersion.id,
    checkedAt:  seenAt,
    drifts:     read.flatMap(network => network.drifts),
    unreadable: read.flatMap(network => network.unread === null ? [] : [ network.unread ]),
  };
}

// the interval a moment falls in, counted from the epoch: for a day, the UTC date
function periodOf(at: number, intervalSeconds: number): number {
  return Math.floor(at / (intervalSeconds * 1000));
}

/*
 * Whether the version on is due a check: when no check is of it — none was
 * ever made, or another version has been switched on since — when its last
 * check could not read every network, and once a new day has begun since
 * that check, a day being the interval the source is checked at. The Cron
 * asks every hour, so a version switched on is checked within the hour, a
 * chain that did not answer is read again an hour later, and the daily check
 * is made by the first invocation of each day, whatever hour the last one
 * was made at.
 *
 * The check keeps its own time rather than the source's. An administrative
 * sync checks the source in the Cron's place when it is due, and a check
 * that waited for the Cron to find the source due would not be made that day.
 */
function isDue(previous: ChainCheck | null, versionId: string, now: Date, intervalSeconds: number): boolean {
  return previous === null
    || previous.versionId !== versionId
    || previous.unreadable.length > 0
    || periodOf(now.getTime(), intervalSeconds) > periodOf(Date.parse(previous.checkedAt), intervalSeconds);
}

/*
 * Checks the active version against the chain when it is due, records the
 * check, and answers it; null when nothing was due. A version answered from
 * the cache because the database did not answer is not checked: it may no
 * longer be the one on.
 */
async function checkChain(deps: ChainCheckDeps): Promise<ChainCheck | null> {
  const previous = await readChainCheck(deps.kv);
  const active   = await deps.active();
  if (active === null || active.staleFor !== null) {
    return null;
  }
  const { snapshot } = active;
  const now = deps.now?.() ?? new Date();
  if (!isDue(previous, snapshot.registryVersion.id, now, deps.intervalSeconds)) {
    return null;
  }

  const check = await compareWithChain(snapshot, previous, deps, now);
  await deps.kv.put(CHECK_KEY, JSON.stringify(check));
  if (check.drifts.length > 0) {
    deps.debug?.warn(`registry chain drift`, { versionId: check.versionId, drifts: check.drifts });
  }
  deps.debug?.log({ registryChainCheck: { versionId: check.versionId, drifts: check.drifts.length, unreadable: check.unreadable } });
  return check;
}

export type { ChainCheck, ChainCheckDeps, ChainDrift, UnreadNetwork };
export { CHECK_KEY, checkChain, readChainCheck };
