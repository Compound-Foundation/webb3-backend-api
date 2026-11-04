import type { Address, MarketV1, NetworkV1, RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';

/*
 * A market the API serves: one that is not disabled, with its Comet, which
 * is what it is addressed and keyed by. Validation refuses a market that does
 * not declare its Comet (comet-contract-declared), so of a validated version
 * only the disabled markets are left out.
 */
type ServedMarket = MarketV1 & { contracts: MarketV1['contracts'] & { comet: Address } };

/*
 * Whether the API serves a market. A disabled market is not served: the
 * version keeps it for diagnostics, and nothing the API serves may resolve
 * through it, its tokens included. A deprecated one is, because positions
 * and history in it must stay reachable. Every read of a version asks this;
 * validation judges a candidate's markets by their status alone, and
 * /admin/status asks the same in SQL (candidate-drops-markets).
 */
function isServed(market: MarketV1): market is ServedMarket {
  return market.status !== 'disabled' && market.contracts.comet !== null;
}

/*
 * The networks of a version that serve a market, each with the markets it
 * serves. A network whose every market is disabled serves nothing — a chain
 * the source has just added arrives that way, with nothing about it reviewed
 * — and is left out.
 */
function servedNetworks(snapshot: RegistrySnapshotV1): Array<{ network: NetworkV1, markets: ServedMarket[] }> {
  return snapshot.networks
    .map(network => ({ network, markets: network.markets.filter(isServed) }))
    .filter(({ markets }) => markets.length > 0);
}

export type { ServedMarket };
export { isServed, servedNetworks };
