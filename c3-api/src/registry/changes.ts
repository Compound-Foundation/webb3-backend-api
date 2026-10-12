import type { Address, MarketStatus, MarketV1, NetworkV1 } from '../../lib/model/comet-registry.js';
import { marketKey } from '../../lib/model/comet-registry.js';

import { isServed } from './catalog.js';

/*
 * What a version changes against the one that is on.
 *
 * The shadow comparison measures a version against the static constants,
 * which is what moving an environment onto the registry needs and what a
 * routine update does not: a market the constants never described is only a
 * name there, and a change to a known market is measured against constants
 * that are out of date anyway. Before switching a newer version on, the
 * question is what switching changes — which markets it adds or drops, and
 * which of their facts and decisions differ from what is served now. A market
 * the version adds is reported whole, with everything its import read from
 * the source and the chain, because describing it starts from those facts.
 *
 * Values are compared field by field on flattened paths, so a change reads as
 * `baseAsset.priceFeed.address` rather than as two market documents to tell
 * apart. Lists are flattened by position, with their length alongside, so a
 * collateral the source adds shows as a longer list and one more entry.
 */
type FieldChange = {
  scope:  string,
  field:  string,
  before: unknown,
  after:  unknown,
};

type VersionChanges = {
  networks: {
    added:   number[],
    removed: number[],
    changed: FieldChange[],
  },
  markets: {
    added:    Array<{ scope: string, reviewed: boolean, market: Omit<MarketV1, 'id'> }>,
    removed:  string[],
    changed:  FieldChange[],
    /*
     * Every Comet the version on serves and this one does not, by the scope
     * the version on serves it under, with where this one holds it: under a
     * scope that does not serve it, or nowhere (null).
     */
    unserved: Array<{ scope: string, comet: Address | null, now: { scope: string, status: MarketStatus } | null }>,
  },
};

function flatten(value: unknown, path: string, into: Map<string, unknown>): Map<string, unknown> {
  if (Array.isArray(value)) {
    into.set(`${path}.length`, value.length);
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, into));
    return into;
  }
  if (typeof(value) === 'object' && value !== null) {
    for (const [ key, item ] of Object.entries(value)) {
      flatten(item, path === '' ? key : `${path}.${key}`, into);
    }
    return into;
  }
  into.set(path, value === undefined ? null : value);
  return into;
}

function fieldChanges(scope: string, before: unknown, after: unknown): FieldChange[] {
  const left  = flatten(before, '', new Map());
  const right = flatten(after, '', new Map());
  const fields = [ ...new Set([ ...left.keys(), ...right.keys() ]) ].sort();
  return fields
    .filter(field => JSON.stringify(left.get(field) ?? null) !== JSON.stringify(right.get(field) ?? null))
    .map(field => ({ scope, field, before: left.get(field) ?? null, after: right.get(field) ?? null }));
}

// a market's id is a row identity each version assigns anew, not something it says
function withoutId({ id: _id, ...market }: MarketV1): Omit<MarketV1, 'id'> {
  return market;
}

function withoutMarkets({ markets: _markets, ...network }: NetworkV1): Omit<NetworkV1, 'markets'> {
  return network;
}

type Scoped = { chainId: number, market: MarketV1 };

function marketsByScope(networks: NetworkV1[]): Map<string, Scoped> {
  return new Map(networks.flatMap(network => network.markets.map(market => (
    [ marketKey(network.chainId, market.deploymentKey), { chainId: network.chainId, market } ] as const
  ))));
}

function inScopeOrder(markets: Map<string, Scoped>, scopes: string[]): string[] {
  const order = (left: Scoped, right: Scoped) => left.chainId - right.chainId || (
    left.market.deploymentKey < right.market.deploymentKey ? -1 : left.market.deploymentKey > right.market.deploymentKey ? 1 : 0
  );
  return [ ...scopes ].sort((left, right) => order(markets.get(left)!, markets.get(right)!));
}

// a market as whoever uses it knows it, whatever its key: its Comet on its chain
function cometOf({ chainId, market }: Scoped): string {
  return `${chainId}/${market.contracts.comet}`;
}

/*
 * What users of the version on stop reaching once this one is on. That is a
 * Comet, not a key: a market the source dropped, one it renamed to a key
 * nobody has reviewed yet, one whose key it gave another Comet, and one a
 * review switched off all stop being served, while `removed` lists only the
 * keys this version no longer has.
 */
function unservedBy(before: Map<string, Scoped>, after: Map<string, Scoped>): VersionChanges['markets']['unserved'] {
  const served = new Set([ ...after.values() ].filter(entry => isServed(entry.market)).map(cometOf));
  const held   = new Map([ ...after ].map(([ scope, entry ]) => [ cometOf(entry), { scope, status: entry.market.status } ] as const));
  const lost   = [ ...before ]
    .filter(([ , entry ]) => isServed(entry.market) && !served.has(cometOf(entry)))
    .map(([ scope ]) => scope);
  return inScopeOrder(before, lost).map(scope => {
    const entry = before.get(scope)!;
    return { scope, comet: entry.market.contracts.comet, now: held.get(cometOf(entry)) ?? null };
  });
}

/*
 * `before` is the version that is on, or null when none is: then everything
 * the version holds is new. `unreviewed` names the markets of `after` nobody
 * has reviewed, which is what an operator describes next.
 */
function compareVersions(
  before: NetworkV1[] | null,
  after: NetworkV1[],
  unreviewed: ReadonlySet<string>,
): VersionChanges {
  const beforeNetworks = new Map((before ?? []).map(network => [ network.chainId, network ]));
  const afterNetworks  = new Map(after.map(network => [ network.chainId, network ]));

  const networkChanges = [ ...afterNetworks ]
    .filter(([ chainId ]) => beforeNetworks.has(chainId))
    .flatMap(([ chainId, network ]) => fieldChanges(
      String(chainId), withoutMarkets(beforeNetworks.get(chainId)!), withoutMarkets(network),
    ));

  const beforeMarkets = marketsByScope(before ?? []);
  const afterMarkets  = marketsByScope(after);
  const scopes        = inScopeOrder(afterMarkets, [ ...afterMarkets.keys() ]);

  return {
    networks: {
      added:   [ ...afterNetworks.keys() ].filter(chainId => !beforeNetworks.has(chainId)).sort((a, b) => a - b),
      removed: [ ...beforeNetworks.keys() ].filter(chainId => !afterNetworks.has(chainId)).sort((a, b) => a - b),
      changed: networkChanges,
    },
    markets: {
      added: scopes
        .filter(scope => !beforeMarkets.has(scope))
        .map(scope => ({ scope, reviewed: !unreviewed.has(scope), market: withoutId(afterMarkets.get(scope)!.market) })),
      removed: inScopeOrder(beforeMarkets, [ ...beforeMarkets.keys() ].filter(scope => !afterMarkets.has(scope))),
      changed: scopes
        .filter(scope => beforeMarkets.has(scope))
        .flatMap(scope => fieldChanges(
          scope,
          withoutId(beforeMarkets.get(scope)!.market),
          withoutId(afterMarkets.get(scope)!.market),
        )),
      unserved: unservedBy(beforeMarkets, afterMarkets),
    },
  };
}

export type { FieldChange, VersionChanges };
export { compareVersions };
