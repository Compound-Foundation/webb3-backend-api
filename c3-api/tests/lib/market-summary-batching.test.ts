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
import { REGISTRY_KEYS } from '../util/summary-registry-fields.js';

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
const USDC   = '0xc3d688b66703497daa19211eedff47f25384cdc3';
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

/*
 * The error the node answers a call to a Comet with instead of its result,
 * if any, by the Comet called, the function, and its argument where it
 * takes one: an asset's index, a feed or a token. Addresses are lowercase.
 */
type Fault = (comet: string, fragment: string, argument: string | undefined) => { code: number, message: string, data?: string } | undefined;

// the registry version's description of a Comet's market
const marketOf = (comet: string) => catalog.markets().find(entry => entry.comet.address.toLowerCase() === comet)!.comet.registry.market;

/*
 * The prices the node answers, at eight decimals, where they are not 1.0:
 * BTC / USD, through which the version prices the base asset of WBTC's market
 * in USD, so that its base_usd_price shows which feed was read.
 */
const PRICES = new Map<string, number>([
  [ marketOf(WBTC).baseAsset.usdPriceFeed!.address, 8_610_669_000_000 ], // BTC / USD: 86106.69
]);

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
    const argument: string | undefined = COMET.decodeFunctionData(fragment, data)[0]?.toString().toLowerCase();
    const error = fault(to.toLowerCase(), fragment.name, argument);
    if (error !== undefined) {
      return { jsonrpc: '2.0', id, error };
    }
    const entry = markets.get(to.toLowerCase());
    const values = ((): unknown[] => {
      switch (fragment.name) {
        case 'numAssets':          return [ entry!.collateralAssets.length ];
        case 'getAssetInfo': {
          const asset = entry!.collateralAssets[Number(argument)]!;
          return [ [ asset.assetIndex, asset.token.address, asset.priceFeed.address, EthersBigNumber.from(10).pow(asset.token.decimals), 0, 0, 0, 0 ] ];
        }
        case 'baseTokenPriceFeed': return [ entry!.baseAsset.priceFeed.address ];
        case 'getPrice':           return [ PRICES.get(argument!) ?? EthersBigNumber.from(10).pow(8) ];
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

// a market of the summary as the route answers it, in JSON
type Summary = {
  comet: { address: string },
  [field: string]: unknown,
};

// the summary of every market, as the route answers it from `node`
async function summaryFrom(t: Test, node: ReturnType<typeof fakeNode>): Promise<Summary[]> {
  serving(t, node);
  const response = await marketHandlers.latestSummary(everyMarket(), context());
  t.equal(response.status, 200, 'the summary is answered');
  return await response.json() as Summary[];
}

const entryOf = (summary: Summary[], comet: string) => summary.find(entry => entry.comet.address.toLowerCase() === comet)!;
const without = (entry: object, ...fields: string[]) => Object.fromEntries(Object.entries(entry).filter(([ field ]) => !fields.includes(field)));

const REVERT = { code: 3, message: 'execution reverted', data: '0x' };

// the warnings the summary logs while a test runs, kept out of its output
function captureWarnings(t: Test): void {
  const warn = console.warn;
  console.warn = () => {};
  t.teardown(() => { console.warn = warn; });
}

const USDT = '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840';
const WETH = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
const AERO = '0x784efeb622244d2348d4f2522f8860b96fbece89';

/*
 * Has the node answer WBTC / BTC, the base price of WBTC's market, at
 * 0.9984988 for the length of a test, so that its base_price shows which
 * feed was read.
 */
function pricingWbtcInBtc(t: Test): void {
  const feed = marketOf(WBTC).baseAsset.priceFeed.address;
  PRICES.set(feed, 99_849_880);
  t.teardown(() => { PRICES.delete(feed); });
}

const describedOf = (entry: Summary) => Object.fromEntries(Object.entries(entry).filter(([ field ]) => (REGISTRY_KEYS as readonly string[]).includes(field)));

// a fixture market has no slug, so the version's keys are these, in the order the summary writes them
const VERSION_KEYS = REGISTRY_KEYS.filter(key => key !== 'slug');

const answered = [
  'chain_id', 'comet', ...VERSION_KEYS, 'status', 'borrow_apr', 'supply_apr',
  'total_borrow_value', 'total_supply_value', 'total_collateral_value', 'utilization', 'base_usd_price', 'base_price',
  'collateral_asset_symbols', 'collaterals',
];

const USDC_COMET = {
  address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
  rewards: '0x1B0e765F6224C21223AeA2af16c1C46E38885a40',
  bulker:  '0xa397a8C2086C554B531c02E29f3291c9704B00c7',
};
const USDC_FIELDS = {
  deployment_key:    'usdc',
  display_name:      'USDC',
  base_asset_name:   'USD Coin',
  is_wrapped_native: false,
  is_default:        true,
  is_institutional:  false,
};
const WETH_COMET = {
  address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
  rewards: '0x1B0e765F6224C21223AeA2af16c1C46E38885a40',
  bulker:  '0xa397a8C2086C554B531c02E29f3291c9704B00c7',
};
const WETH_FIELDS = {
  deployment_key:    'weth',
  display_name:      'ETH',
  base_asset_name:   'Ether',
  is_wrapped_native: true,
  is_default:        false,
  is_institutional:  false,
};

/*
 * Beside what was read of each market, the summary answers what its registry
 * version says of it, as /registry/v1/active serves the market: the rewards
 * contract and the bulker beside its Comet, then its keys and labels, before
 * its status. Right after the base asset's USD price it answers the base
 * price its totals are valued at: the same number on a market quoted in USD,
 * which reads both through its base feed, and WBTC in BTC on the WBTC
 * market, whose USD price is that of BTC. Each form of the route answers a
 * market alike.
 */
t.test('each market of the summary has what its version says of it, and its base price, in every form', async t => {
  const node = fakeNode();
  serving(t, node);
  pricingWbtcInBtc(t);

  const every = await (await marketHandlers.latestSummary(everyMarket(), context())).json() as Summary[];
  t.equal(every.length, catalog.markets().length, 'every market is answered');
  for (const { network, deploymentKey, comet } of catalog.markets()) {
    const entry = entryOf(every, comet.address.toLowerCase());
    t.strictSame(Object.keys(entry), answered, `${network} ${deploymentKey}: what the version says after its Comet, and the base price after the USD price`);
  }
  const usdc = entryOf(every, USDC);
  t.equal(JSON.stringify(usdc.comet), JSON.stringify(USDC_COMET), 'mainnet USDC: its Comet, then its rewards contract and its bulker');
  t.strictSame(describedOf(usdc), USDC_FIELDS, 'mainnet USDC: its keys and labels');
  const weth = entryOf(every, WETH);
  t.equal(JSON.stringify(weth.comet), JSON.stringify(WETH_COMET), 'mainnet WETH: its Comet, then its rewards contract and its bulker');
  t.strictSame(describedOf(weth), WETH_FIELDS, 'mainnet WETH: its keys and labels');
  t.strictSame([ entryOf(every, WBTC).base_price, entryOf(every, WBTC).base_usd_price ], [ '0.9984988', '86106.69' ],
    'the WBTC market: its base price, WBTC in BTC, beside the price of BTC in USD');

  const asked = node.requests.length;
  const mainnet = await (await marketHandlers.latestSummary({ ...everyMarket(), network: 'ethereum-mainnet' }, context())).json() as Summary[];
  t.equal(JSON.stringify(mainnet), JSON.stringify(every.filter(entry => entry.chain_id === 1)),
    'the summary of a network answers each of its markets alike');

  const wbtc  = catalog.marketAt('ethereum-mainnet', WBTC)!.comet;
  const alone = await (await marketHandlers.latestSummary({ ...everyMarket(), network: 'ethereum-mainnet', contract: wbtc }, context())).json() as Summary;
  t.equal(JSON.stringify(alone), JSON.stringify(entryOf(every, WBTC)), 'and so does the summary of one market');
  t.equal(node.requests.length - asked, 8, 'four node requests each, as before');
});

/*
 * What the version says of a market needs nothing read, so a market whose
 * prices revert answers it as any other. Its base price is there wherever it
 * was read: on a partial market, and on an error its USD price alone made.
 */
t.test('a market whose prices revert answers what its version says of it, and its base price where it was read', async t => {
  captureWarnings(t);
  pricingWbtcInBtc(t);
  // the feed that reverts on each of three markets
  const feeds = new Map<string, string>([
    [ WBTC, marketOf(WBTC).baseAsset.usdPriceFeed!.address ],        // BTC / USD: its USD price alone fails
    [ WETH, marketOf(WETH).baseAsset.priceFeed.address ],            // its base feed: its base price fails
    [ USDC, marketOf(USDC).collateralAssets[0]!.priceFeed.address ], // COMP / USD: one of its collaterals fails
  ]);
  const summary = await summaryFrom(t, fakeNode((comet, fragment, argument) => (
    fragment === 'getPrice' && argument === feeds.get(comet) ? REVERT : undefined
  )));

  const usdc = entryOf(summary, USDC);
  t.equal(JSON.stringify(usdc.comet), JSON.stringify(USDC_COMET), `mainnet USDC, ${usdc.status}: its Comet, its rewards contract and its bulker`);
  t.strictSame(describedOf(usdc), USDC_FIELDS, `mainnet USDC, ${usdc.status}: its keys and labels`);
  const errored = entryOf(summary, WETH);
  t.equal(JSON.stringify(errored.comet), JSON.stringify(WETH_COMET), `mainnet WETH, ${errored.status}: its Comet, its rewards contract and its bulker`);
  t.strictSame(describedOf(errored), WETH_FIELDS, `mainnet WETH, ${errored.status}: its keys and labels`);

  const wbtc = entryOf(summary, WBTC);
  t.match(wbtc, { status: 'error', base_price: '0.9984988' }, 'WBTC, an error of its USD price: its base price');
  t.notOk('base_usd_price' in wbtc, 'without the USD price that reverted');
  const weth = entryOf(summary, WETH);
  t.match(weth, { status: 'error', base_usd_price: '1.0' }, 'WETH, an error of its base price: its USD price');
  t.notOk('base_price' in weth || 'total_supply_value' in weth, 'without the base price that reverted, nor the totals made of it');
  t.match(entryOf(summary, USDC), { status: 'partially', base_price: '1.0', base_usd_price: '1.0' }, 'USDC, partial: both prices');
});

/*
 * A contract or a slug the version has none of, which /registry/v1/active
 * answers as null, is left out, as the summary leaves out whatever it cannot
 * give. A slug the version has is answered, between whether the base asset
 * wraps the chain's own token and whether the market is the default.
 */
t.test('a market whose version has no rewards contract, no bulker or no slug leaves it out', async t => {
  // USDC's market without a bulker, AERO's without a rewards contract, WETH's with neither, and USDT's institutional, with a slug
  const version = {
    ...snapshot,
    networks: snapshot.networks.map(network => ({
      ...network,
      markets: network.markets.map(entry => ({
        ...entry,
        ...(entry.contracts.comet === USDT ? { slug: 'usdt-institutional', isInstitutional: true } : {}),
        contracts: {
          ...entry.contracts,
          ...([ USDC, WETH ].includes(entry.contracts.comet!) ? { bulker: null } : {}),
          ...([ AERO, WETH ].includes(entry.contracts.comet!) ? { rewards: null } : {}),
        },
      })),
    })),
  };
  serving(t, fakeNode());
  const response = await marketHandlers.latestSummary({ ...everyMarket(), catalog: fixtureCatalog(version) }, context());
  t.equal(response.status, 200, 'the summary is answered');
  const summary = await response.json() as Summary[];

  const keysOf = (comet: string) => Object.keys(entryOf(summary, comet).comet);
  t.strictSame(keysOf(USDC), [ 'address', 'rewards' ], 'USDC: its Comet and its rewards contract');
  t.strictSame(keysOf(AERO), [ 'address', 'bulker' ], 'AERO: its Comet and its bulker');
  t.strictSame(keysOf(WETH), [ 'address' ], 'WETH: its Comet alone');
  const others = summary.filter(entry => ![ USDC, AERO, WETH ].includes(entry.comet.address.toLowerCase()));
  t.strictSame(others.map(entry => Object.keys(entry.comet)), others.map(() => [ 'address', 'rewards', 'bulker' ]), 'and every other market all three');

  const usdt = entryOf(summary, USDT);
  t.strictSame(Object.keys(usdt).slice(2, 9),
    [ 'deployment_key', 'display_name', 'base_asset_name', 'is_wrapped_native', 'slug', 'is_default', 'is_institutional' ],
    'USDT: its slug after whether its base asset wraps the chain\'s own token');
  t.match(usdt, { slug: 'usdt-institutional', is_institutional: true }, 'as the version has it, in its institutional section');
  const rest = summary.filter(entry => entry !== usdt);
  t.strictSame(rest.map(entry => 'slug' in entry), rest.map(() => false), 'and no other market has a slug');
  t.strictSame(summary.map(entry => entry.status), summary.map(() => 'success'), 'each market a success all the same');
});

/*
 * The summary keeps in its cache only what it read, and keys it without the
 * labels of the market (catalog.ts, marketDigest): a version that changes
 * only a label is answered at once, from the summary already cached.
 */
t.test('a version that changes only a label is answered at once, from the summary already cached', async t => {
  const node = fakeNode();
  serving(t, node);
  const cached = context();
  const before = await (await marketHandlers.latestSummary(everyMarket(), cached)).json() as Summary[];

  const relabeled = {
    ...snapshot,
    registryVersion: { ...snapshot.registryVersion, id: 'relabeled', checksum: 'f'.repeat(64) },
    networks: snapshot.networks.map(network => ({
      ...network,
      markets: network.markets.map(entry => entry.contracts.comet !== USDC ? entry : {
        ...entry, displayName: 'USDC-cr', baseAsset: { ...entry.baseAsset, displayName: 'USD Coin (Circle)' },
      }),
    })),
  };
  const asked = node.requests.length;
  const after = await (await marketHandlers.latestSummary({ ...everyMarket(), catalog: fixtureCatalog(relabeled) }, cached)).json() as Summary[];

  const networks = new Set(catalog.markets().map(entry => entry.network)).size;
  t.equal(node.requests.length - asked, networks, 'the summary is read from the cache: only the latest block of each network is asked for');
  t.match(entryOf(after, USDC), { display_name: 'USDC-cr', base_asset_name: 'USD Coin (Circle)' }, 'and USDC\'s market answers its new labels');
  t.strictSame(without(entryOf(after, USDC), 'display_name', 'base_asset_name'), without(entryOf(before, USDC), 'display_name', 'base_asset_name'),
    'and everything else as before');
});

/*
 * A market whose base asset could not be priced is an error, and answers
 * every field that does not need the price it lacks. The Comet of WBTC's
 * market prices its totals with WBTC / BTC, and the version its base asset
 * in USD with BTC / USD: without the first, it answers all but its base
 * price and its totals. One feed prices both on USDC's market, which answers
 * all but its totals and both its prices.
 */
t.test('a market whose base feed reverts answers every field it can', async t => {
  const reading = await summaryFrom(t, fakeNode());
  captureWarnings(t);
  const feeds = new Map([ WBTC, USDC ].map(comet => [ comet, marketOf(comet).baseAsset.priceFeed.address ]));
  const reverting = await summaryFrom(t, fakeNode((comet, fragment, argument) => (
    fragment === 'getPrice' && argument === feeds.get(comet) ? REVERT : undefined
  )));

  const described = VERSION_KEYS;

  const wbtc = entryOf(reverting, WBTC);
  t.strictSame(wbtc, { ...without(entryOf(reading, WBTC), 'total_borrow_value', 'total_supply_value', 'base_price'), status: 'error', message: 'execution reverted' },
    'WBTC: an error, and every field as read but its totals and its base price');
  t.strictSame(Object.keys(wbtc), [
    'chain_id', 'comet', ...described, 'status', 'message', 'borrow_apr', 'supply_apr', 'total_collateral_value',
    'utilization', 'base_usd_price', 'collateral_asset_symbols', 'collaterals',
  ], 'WBTC: its message after its status');
  t.equal(wbtc.base_usd_price, '86106.69', 'WBTC: its USD price, which is the price of BTC');

  const usdc = entryOf(reverting, USDC);
  t.strictSame(usdc, { ...without(entryOf(reading, USDC), 'total_borrow_value', 'total_supply_value', 'base_usd_price', 'base_price'), status: 'error', message: 'execution reverted' },
    'USDC: an error, and every field as read but its totals and its prices');
  t.strictSame(Object.keys(usdc), [
    'chain_id', 'comet', ...described, 'status', 'message', 'borrow_apr', 'supply_apr', 'total_collateral_value',
    'utilization', 'collateral_asset_symbols', 'collaterals',
  ], 'USDC: its message after its status');

  const others = (summary: Summary[]) => summary.filter(entry => ![ WBTC, USDC ].includes(entry.comet.address.toLowerCase()));
  t.strictSame(others(reverting), others(reading), 'and every other market as read');
});
