import { Interface } from '@ethersproject/abi';

import type * as jsonRpc from '../../lib/json-rpc.js';
import type { Address, MarketV1, RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';
import type { RpcTransport } from '../../src/registry/enrichment.js';

/*
 * A chain that answers what the drift check reads of a Comet: the feed of
 * its base asset, how many collateral assets it has, and each one with its
 * feed — as a registry snapshot describes them, unless `changes` says what a
 * Comet answers instead. A network named in `unreadable` does not answer at
 * all, as a node provider that is down does not.
 *
 * It is a transport per network, as the importer takes one, and a fetch that
 * serves the same answers to JSON-RPC batches sent through the node provider
 * proxy, for a test that runs the worker's own fetch.
 */
const COMET = new Interface([
  'function baseTokenPriceFeed() view returns (address)',
  'function numAssets() view returns (uint8)',
  `function getAssetInfo(uint8) view returns (tuple(
    uint8 offset,
    address asset,
    address priceFeed,
    uint64 scale,
    uint64 borrowCollateralFactor,
    uint64 liquidateCollateralFactor,
    uint64 liquidationFactor,
    uint128 supplyCap
  ))`,
]);

type CometChanges = {
  basePriceFeed?:    Address,
  // what the Comet answers for its collateral, in getAssetInfo order, in place of the snapshot's
  collateralAssets?: Array<{ token: Address, priceFeed: Address }>,
};

type FakeChain = {
  transportFor: (network: string) => RpcTransport,
  // a fetch for the node provider proxy's URLs (`https://<host>/<network>/<key>`)
  fetch:        (request: Request) => Promise<Response>,
  // the networks that were asked anything, a network once per batch
  asked:        string[],
};

function fakeChain(
  snapshot: RegistrySnapshotV1,
  { changes = {}, unreadable = [] }: { changes?: Record<Address, CometChanges>, unreadable?: string[] } = {},
): FakeChain {
  const markets = new Map<string, MarketV1>(snapshot.networks.flatMap(network => network.markets.map(market => (
    [ market.contracts.comet!, market ] as const
  ))));
  const asked: string[] = [];

  const answer = (call: jsonRpc.Call): { result?: string, error?: unknown } => {
    const { to, data } = (call.params as [ { to: string, data: string } ])[0];
    const market = markets.get(to.toLowerCase());
    if (call.method !== 'eth_call' || market === undefined) {
      return { error: { code: -32000, message: `nothing to answer at ${to}` } };
    }
    const change     = changes[market.contracts.comet!] ?? {};
    const collateral = change.collateralAssets
      ?? market.collateralAssets.map(asset => ({ token: asset.token.address, priceFeed: asset.priceFeed.address }));
    const fragment   = COMET.getFunction(data.slice(0, 10));
    switch (fragment.name) {
      case 'baseTokenPriceFeed':
        return { result: COMET.encodeFunctionResult(fragment, [ change.basePriceFeed ?? market.baseAsset.priceFeed.address ]) };
      case 'numAssets':
        return { result: COMET.encodeFunctionResult(fragment, [ collateral.length ]) };
      default: {
        const index = Number(COMET.decodeFunctionData(fragment, data)[0]);
        const asset = collateral[index];
        return asset === undefined
          ? { error: { code: 3, message: 'execution reverted' } }
          : { result: COMET.encodeFunctionResult(fragment, [ [ index, asset.token, asset.priceFeed, 1, 0, 0, 0, 0 ] ]) };
      }
    }
  };

  const transportFor = (network: string): RpcTransport => async calls => {
    asked.push(network);
    if (unreadable.includes(network)) {
      throw new TypeError('fetch failed');
    }
    return calls.map(answer);
  };

  const fetch = async (request: Request): Promise<Response> => {
    const network = new URL(request.url).pathname.split('/')[1]!;
    const calls   = await request.json() as Array<jsonRpc.Call & { id: number }>;
    const answers = await transportFor(network)(calls);
    return new Response(JSON.stringify(answers.map((answered, index) => ({ jsonrpc: '2.0', id: calls[index]!.id, ...answered }))));
  };

  return { transportFor, fetch, asked };
}

export type { CometChanges, FakeChain };
export { fakeChain };
