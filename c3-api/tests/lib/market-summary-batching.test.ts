import t, { Test } from 'tap';

import { Interface, type FunctionFragment } from '@ethersproject/abi';
import { BigNumber as EthersBigNumber } from '@ethersproject/bignumber';

import * as Debug    from '../../lib/debug-log.js';
import * as Flags    from '../../lib/flags.js';
import * as jsonRpc  from '../../lib/json-rpc.js';
import { BigNumber } from '../../lib/bignumber.js';
import { BigFixnum } from '../../lib/bigfixnum.js';

import * as Evaluator  from '../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../lib/symbolic/cache.js';

import * as evm     from '../../lib/computations/evm.js';
import * as comet   from '../../lib/computations/comet.js';
import * as market  from '../../lib/computations/market.js';
import * as rewards from '../../lib/computations/rewards.js';

import * as marketHandlers from '../../src/market.js';
import {
  AllContracts,
  AllNetworks,
  type MarketRouteData,
  type UninstantiatedContext,
} from '../../src/router.js';

import { fixtureCatalog, loadRegistrySnapshotFixture } from '../util/registry-fixture.js';

import '../../shim/node-self.js';

/*
 * The summary and the rewards of every market, on the real evaluator against
 * a fake node, counting what reaches the node. Each request to the node
 * provider proxy is a subrequest, of which a Worker invocation has a budget
 * (README, "Workers Plan"), so what the summary of every market costs has to
 * grow with the networks, not with the markets.
 *
 * This is where their batching is counted, and only here: what the route asks
 * the node is the cost that matters, however the handler and the evaluator
 * share the work out between them.
 *
 * It is also where one market's read failing at the node meets the real
 * computations: a price feed that reverts is that market's answer, and a call
 * the node did not serve fails the summary, as does a request the node
 * provider failed, both as a request the node did not serve.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const snapshot = loadRegistrySnapshotFixture();
const catalog  = fixtureCatalog(snapshot);

const LATEST = { number: 30_000_000, timestamp: 1_790_000_000 };
const WBTC   = '0xe85dc543813b8c2cfeaac371517b925a166a9293';

const COMET = new Interface([
  'function numAssets() view returns (uint8)',
  'function getAssetInfo(uint8) view returns (tuple(uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
  'function baseTokenPriceFeed() view returns (address)',
  'function getPrice(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalBorrow() view returns (uint256)',
  'function getUtilization() returns (uint256)',
  'function getSupplyRate(uint) returns (uint)',
  'function getBorrowRate(uint) returns (uint)',
  'function totalsCollateral(address) view returns (uint128)',
  'function symbol() view returns (string)',
  // the rewards of a market
  'function baseBorrowMin() view returns (uint)',
  'function baseMinForRewards() view returns (uint256)',
  'function baseTrackingSupplySpeed() view returns (uint256)',
  'function baseTrackingBorrowSpeed() view returns (uint256)',
  'function trackingIndexScale() view returns (uint256)',
  'function totalsBasic() view returns (tuple(uint64 baseSupplyIndex, uint64 baseBorrowIndex, uint64 trackingSupplyIndex, uint64 trackingBorrowIndex, uint104 totalSupplyBase, uint104 totalBorrowBase, uint40 lastAccrualTime, uint8 pauseFlags))',
]);

type Call = { id: number, method: string, params: any[] };

// the error the node answers a call to a Comet with instead of its result, if any
type Fault = (comet: string, fragment: string) => { code: number, message: string, data?: string } | undefined;

/*
 * A node that answers the summary's reads from the fixture snapshot, and
 * records every request it receives: its network and its calls.
 */
function fakeNode(fault: Fault = () => undefined) {
  const markets = new Map(snapshot.networks.flatMap(network => network.markets.map(entry => (
    [ entry.contracts.comet!.toLowerCase(), entry ] as const
  ))));
  const symbols = new Map(snapshot.networks.flatMap(network => network.markets.flatMap(entry => (
    entry.collateralAssets.map(asset => [ asset.token.address.toLowerCase(), asset.token.symbol ] as const)
  ))));
  const requests: Array<{ network: string, calls: Call[] }> = [];

  const answer = ({ id, method, params }: Call) => {
    if (method === 'eth_getBlockByNumber') {
      return { jsonrpc: '2.0', id, result: { number: `0x${LATEST.number.toString(16)}`, timestamp: `0x${LATEST.timestamp.toString(16)}`, transactions: [] } };
    }
    const [ { to, data } ] = params;
    const fragment = COMET.getFunction(data.slice(0, 10)) as FunctionFragment;
    const error = fault(to.toLowerCase(), fragment.name);
    if (error !== undefined) {
      return { jsonrpc: '2.0', id, error };
    }
    const entry = markets.get(to.toLowerCase());
    const values = ((): unknown[] => {
      switch (fragment.name) {
        case 'numAssets':          return [ entry!.collateralAssets.length ];
        case 'getAssetInfo': {
          const asset = entry!.collateralAssets[Number(COMET.decodeFunctionData(fragment, data)[0])]!;
          return [ [ asset.assetIndex, asset.token.address, asset.priceFeed.address, EthersBigNumber.from(10).pow(asset.token.decimals), 0, 0, 0, 0 ] ];
        }
        case 'baseTokenPriceFeed': return [ entry!.baseAsset.priceFeed.address ];
        case 'symbol':             return [ symbols.get(to.toLowerCase()) ?? 'TKN' ];
        case 'totalsBasic': {
          const [ index, base ] = [ EthersBigNumber.from(10).pow(15), EthersBigNumber.from(10).pow(12) ];
          return [ [ index, index, 0, 0, base, base, LATEST.timestamp, 0 ] ];
        }
        default:                   return [ EthersBigNumber.from(10).pow(8) ];
      }
    })();
    return { jsonrpc: '2.0', id, result: COMET.encodeFunctionResult(fragment, values) };
  };

  const fetch = async (input: string | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const network = new URL(request.url).pathname.split('/')[1]!;
    const body = await request.json() as Call | Call[];
    const calls = body instanceof Array ? body : [ body ];
    requests.push({ network, calls });
    const responses = calls.map(answer);
    return new Response(JSON.stringify(body instanceof Array ? responses : responses[0]));
  };
  return { fetch, requests };
}

// puts `node` in place of the global fetch for the length of a test
function serving(t: Test, node: ReturnType<typeof fakeNode>) {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = node.fetch as typeof globalThis.fetch;
  t.teardown(() => { globalThis.fetch = fetchBefore; });
}

function everyMarket(): MarketRouteData {
  return { apiHost: '', nodeHost: 'node.test', nodeKey: 'key', network: AllNetworks, contract: AllContracts, catalog, queryParams: new URLSearchParams() };
}

/*
 * What the router hands a handler that makes its own evaluator. Every
 * evaluation the handler starts is kept in `evaluations`: a summary that one
 * network fails answers without waiting for the others, and a test waits for
 * them, so none of them asks a node after it ends.
 */
function context(evaluations: Promise<unknown>[] = []): UninstantiatedContext {
  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  return {
    flags,
    instantiateEvaluator: (_: string, overrides: { flags?: Flags.SomeFlags } = {}) => {
      const evaluator = Evaluator.instantiate(
        { ...evm, ...comet, ...market, ...rewards } as any,
        { cache, debug, flags: { ...flags, ...overrides.flags } },
      );
      // a handler takes evaluate off the evaluator, so the evaluations are kept where it reads it
      const evaluate = evaluator.evaluate;
      evaluator.evaluate = (redex => {
        const evaluation = evaluate(redex);
        evaluations.push(evaluation);
        return evaluation;
      }) as typeof evaluate;
      return evaluator;
    },
  } as unknown as UninstantiatedContext;
}

// how the summary of every market failed, once every evaluation it started has ended
async function failureOf(node: ReturnType<typeof fakeNode>, t: Test): Promise<unknown> {
  serving(t, node);
  const evaluations: Promise<unknown>[] = [];
  const failure = await marketHandlers.latestSummary(everyMarket(), context(evaluations)).then(
    () => null,
    (error: unknown) => error,
  );
  await Promise.allSettled(evaluations);
  return failure;
}

t.test('the summary of every market makes four node requests per network', async t => {
  const node = fakeNode();
  serving(t, node);

  const response = await marketHandlers.latestSummary(everyMarket(), context());
  const body = await response.json() as Array<{ status: string }>;

  t.equal(response.status, 200);
  t.equal(body.length, catalog.markets().length, 'every market is answered');
  t.ok(body.every(entry => entry.status === 'success'));

  const networks = [ ...new Set(catalog.markets().map(entry => entry.network)) ];
  for (const network of networks) {
    const requests = node.requests.filter(request => request.network === network);
    t.equal(requests.length, 4, `${network}: the latest block, then three rounds of reads, whatever its market count`);
  }
  t.equal(node.requests.length, 4 * networks.length);

  for (const { network, calls } of node.requests) {
    const distinct = new Set(calls.map(({ method, params }) => JSON.stringify([ method, params ])));
    t.equal(distinct.size, calls.length, `${network}: no call is sent twice in one batch`);
  }
});

/*
 * The rewards of every market cost the same per network. A reward feed that
 * quotes a market's base asset — mainnet's WETH market values COMP in ETH —
 * is converted to USD with one more price, read beside the reward price, not
 * in a round of its own once the rates are in: mainnet takes as many
 * requests as Base, which has no such market.
 */
t.test('the rewards of every market convert a reward price to USD in no round of its own', async t => {
  const node = fakeNode();
  serving(t, node);

  const response = await marketHandlers.rewardsDappData(everyMarket(), context());
  const body = await response.json() as Array<{ status: string }>;

  t.equal(response.status, 200);
  t.equal(body.length, catalog.markets().filter(entry => entry.comet.registry.market.capabilities.rewards).length,
    'every market with rewards is answered');
  t.ok(body.every(entry => entry.status === 'success'));

  const weth = catalog.marketsOn('ethereum-mainnet').find(entry => entry.deploymentKey === 'weth')!.comet.registry.market;
  const priceRead = (feed: string) => JSON.stringify([ weth.contracts.comet, `0x41976e09${feed.slice(2).padStart(64, '0')}` ]);
  const reads = (request: { calls: Call[] }) => request.calls
    .filter(({ method }) => method === 'eth_call')
    .map(({ params: [ { to, data } ] }) => JSON.stringify([ to.toLowerCase(), data ]));
  const converted = node.requests.find(request => reads(request).includes(priceRead(weth.rewardAsset!.priceFeed!.address)));
  t.ok(converted !== undefined && reads(converted).includes(priceRead(weth.baseAsset.usdPriceFeed!.address)),
    'the USD price of WETH is read in the request that reads COMP in ETH');

  const requestsOn = (network: string) => node.requests.filter(request => request.network === network).length;
  t.equal(requestsOn('ethereum-mainnet'), requestsOn('base-mainnet'), 'and mainnet makes as many requests as Base');

  for (const { network, calls } of node.requests) {
    const distinct = new Set(calls.map(({ method, params }) => JSON.stringify([ method, params ])));
    t.equal(distinct.size, calls.length, `${network}: no call is sent twice in one batch`);
  }
});

t.test('a price feed that reverts is one market\'s error, and the rest are answered', async t => {
  serving(t, fakeNode((comet, fragment) => (
    comet === WBTC && fragment === 'getPrice' ? { code: 3, message: 'execution reverted', data: '0x' } : undefined
  )));
  const response = await marketHandlers.latestSummary(everyMarket(), context());
  t.equal(response.status, 200);
  const body = await response.json() as Array<{ comet: { address: string }, status: string }>;
  t.equal(body.length, catalog.markets().length, 'every market is answered');
  t.same(
    body.filter(entry => entry.status !== 'success').map(entry => [ entry.comet.address.toLowerCase(), entry.status ]),
    [ [ WBTC, 'error' ] ],
    'the market whose feeds revert as an error, and every other one as read',
  );
});

t.test('a call the node did not serve for one market fails the summary', async t => {
  const failure = await failureOf(fakeNode((comet, fragment) => (
    comet === WBTC && fragment === 'totalSupply' ? { code: -32000, message: 'header not found' } : undefined
  )), t);
  t.match((failure as Error | null)?.message, /header not found/);
  t.ok(jsonRpc.isNotServed(failure), 'as a call the node did not serve, which a route answers 503');
});

/*
 * The node provider proxy fails a request outright when no provider served
 * its calls: 503, and how long to wait before asking again. One network's
 * failing so fails the summary of every network.
 */
t.test('a request the node provider failed for one network fails the summary', async t => {
  const node = fakeNode();
  const down = 'base-mainnet';
  const failure = await failureOf({
    ...node,
    fetch: async (input: string | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      return new URL(request.url).pathname.split('/')[1] === down
        ? new Response('upstream error', { status: 503, headers: { 'Retry-After': '5' } })
        : node.fetch(request);
    },
  }, t);
  t.ok(jsonRpc.isNotServed(failure), 'as a request the node did not serve');
  t.same([ (failure as jsonRpc.NotServed).status, (failure as jsonRpc.NotServed).retryAfter ], [ 503, 5 ],
    'with the status the proxy answered, and the seconds it asked to wait, for a route to pass on');
  t.ok(node.requests.some(request => request.network !== down), 'while the other networks were read');
});
