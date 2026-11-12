import t, { Test } from 'tap';

import * as Debug    from '../../lib/debug-log.js';
import * as Flags    from '../../lib/flags.js';
import * as jsonRpc  from '../../lib/json-rpc.js';
import { BigNumber } from '../../lib/bignumber.js';
import { BigFixnum } from '../../lib/bigfixnum.js';

import { checksumAddress } from '../../lib/model/comet-registry.js';

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
  type MarketContext,
  type MarketRouteData,
} from '../../src/router.js';

import { consoleLines } from '../util/console.js';
import { type Call, type FakeNode, type NodeScript, fakeNode, headerReads, serve } from '../util/fake-node.js';
import { fixtureCatalog, loadRegistrySnapshotFixture } from '../util/registry-fixture.js';
import { REGISTRY_KEYS } from '../util/summary-registry-fields.js';
import { COLLATERAL_KEYS, scaled } from '../util/summary-token-fields.js';
import { summaryDecisionsOf } from '../util/summary-decisions.js';

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
 * the node did not serve fails the summary and the history, as does a request
 * the node provider failed, both as a request the node did not serve.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const snapshot = loadRegistrySnapshotFixture();
const catalog  = fixtureCatalog(snapshot);

const LATEST = { number: 30_000_000, timestamp: 1_790_000_000 };
const USDC   = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WBTC   = '0xe85dc543813b8c2cfeaac371517b925a166a9293';

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
 * What a market holds of a collateral, where it is not the one token every
 * market holds of every collateral: by the Comet and the token, lowercase,
 * the amount the Comet answers, in the token's smallest unit.
 */
type Held = (comet: string, token: string) => bigint | undefined;

/*
 * The node of the fixture at LATEST, which answers the prices above, what
 * `held` says a market holds, and, in place of a call's result, the error
 * `fault` answers it with. `block` scripts its reads of a block.
 */
function nodeOf(fault: Fault = () => undefined, held: Held = () => undefined, block?: NodeScript['block']): FakeNode {
  return fakeNode(snapshot, LATEST, {
    answer: ({ comet, name, argument }) => {
      const failed = fault(comet, name, argument);
      if (failed !== undefined) {
        return failed;
      }
      const amount = name === 'totalsCollateral' ? held(comet, argument!) : undefined;
      if (amount !== undefined) {
        return [ amount.toString() ];
      }
      return name === 'getPrice' && PRICES.has(argument!) ? [ PRICES.get(argument!) ] : undefined;
    },
    ...(block === undefined ? {} : { block }),
  });
}

function everyMarket(): MarketRouteData {
  return { apiHost: '', nodeHost: 'node.test', nodeKey: 'key', network: AllNetworks, contract: AllContracts, catalog, queryParams: new URLSearchParams() };
}

/*
 * What the router hands a market handler: the evaluator it makes for the
 * route, with ROUTE_EVALUATOR_FLAGS, and the decisions of the summary, none
 * unless a test passes them. Every evaluation the handler starts is kept in
 * `evaluations`: a summary that one network fails, or a history that one
 * market fails, answers without waiting for the others, and a test waits
 * until none of them is running and none starts, so none of them asks a node
 * after it ends. A test that reads what was cached passes its own cache.
 */
function context(
  evaluations: Promise<unknown>[] = [],
  decisions = summaryDecisionsOf(),
  cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]),
): MarketContext {
  const evaluator = Evaluator.instantiate(
    { ...evm, ...comet, ...market, ...rewards } as any,
    { cache, debug, flags: { ...flags, ...Flags.ROUTE_EVALUATOR_FLAGS } },
  );
  // a handler takes evaluate off the evaluator, so the evaluations are kept where it reads it
  const evaluate = evaluator.evaluate;
  evaluator.evaluate = (redex => {
    const evaluation = evaluate(redex);
    evaluations.push(evaluation);
    return evaluation;
  }) as typeof evaluate;
  return { flags, evaluator, decisions } as unknown as MarketContext;
}

// how `handler` failed over every market, once every evaluation it started has ended, and no more start
async function failureOf(node: FakeNode, t: Test, handler: typeof marketHandlers.latestSummary): Promise<unknown> {
  serve(t, node);
  const evaluations: Promise<unknown>[] = [];
  const failure = await handler(everyMarket(), context(evaluations)).then(
    () => null,
    (error: unknown) => error,
  );
  // a market of the history starts only once its network's block is read, which can be after the route failed
  for (let waited = -1; waited !== evaluations.length;) {
    waited = evaluations.length;
    await Promise.allSettled(evaluations);
  }
  return failure;
}

const NETWORKS = [ ...new Set(catalog.markets().map(entry => entry.network)) ];

// what the route asked the node of a network
const requestsOf = (node: FakeNode, network: string) => node.requests.filter(request => request.network === network);

/*
 * The block each market of a network is read at in the minute of LATEST: the
 * latest block less what its creation block leaves over of a minute's blocks
 * on its chain — five blocks on mainnet, and thirty on Base and on Scroll.
 */
const MARKET_BLOCKS: Record<string, number[]> = {
  'ethereum-mainnet': [ 29_999_996, 30_000_000, 29_999_997, 29_999_997 ],
  'base-mainnet':     [ 29_999_975 ],
  'scroll-mainnet':   [ 29_999_994 ],
};

/*
 * A minute nobody has read costs a network four requests, whatever its market
 * count: its latest block, then three rounds of reads, the header of each
 * market's block among the first, once for the markets read at the same
 * block. A request in a minute already read reads the latest blocks alone.
 */
t.test('the summary of every market makes four node requests per network, the headers of its markets\' blocks among them', async t => {
  const node = nodeOf();
  serve(t, node);
  const cached = context();

  const response = await marketHandlers.latestSummary(everyMarket(), cached);
  const body = await response.json() as Array<{ status: string }>;

  t.equal(response.status, 200);
  t.equal(body.length, catalog.markets().length, 'every market is answered');
  t.ok(body.every(entry => entry.status === 'success'));

  for (const network of NETWORKS) {
    const requests = requestsOf(node, network);
    t.equal(requests.length, 4, `${network}: the latest block, then three rounds of reads, whatever its market count`);
    t.strictSame(headerReads({ ...node, requests: requests.slice(1, 2) }).sort(), [ ...new Set(MARKET_BLOCKS[network]) ].sort(),
      `${network}: the first round asks for the header of each market's block, once for the markets read at the same block`);
    t.strictSame(headerReads({ ...node, requests: requests.slice(2) }), [], `${network}: and no later round asks for one`);
  }
  t.equal(node.requests.length, 4 * NETWORKS.length);
  t.strictSame(headerReads({ ...node, requests: requestsOf(node, 'ethereum-mainnet') }).sort(), [ 29_999_996, 29_999_997, 30_000_000 ],
    'mainnet: three headers for four markets, USDT\'s and WBTC\'s being read at the same block, and WETH\'s at the latest');

  for (const { network, calls } of node.requests) {
    const distinct = new Set(calls.map(({ method, params }) => JSON.stringify([ method, params ])));
    t.equal(distinct.size, calls.length, `${network}: no call is sent twice in one batch`);
  }

  node.requests.length = 0;
  t.equal((await marketHandlers.latestSummary(everyMarket(), cached)).status, 200);
  t.equal(node.requests.length, NETWORKS.length, 'the next request of the minute reads the latest block of each network alone');
});

/*
 * The rewards of a market are read in one round once the block is known:
 * each APR reads the base price it divides by beside the reward price and the
 * rates (rewards-apr.ts), not in a round of its own once they are in.
 */
t.test('the rewards of every market make two node requests per network', async t => {
  const node = nodeOf();
  serve(t, node);

  const response = await marketHandlers.rewardsDappData(everyMarket(), context());
  t.equal(response.status, 200);

  const rewarded = catalog.markets().filter(entry => entry.comet.registry.market.capabilities.rewards);
  const networks = [ ...new Set(rewarded.map(entry => entry.network)) ];
  for (const network of networks) {
    const requests = node.requests.filter(request => request.network === network);
    t.equal(requests.length, 2, `${network}: the latest block, then one round of reads, whatever its market count`);
  }
  t.equal(node.requests.length, 2 * networks.length);

  // a market whose APRs divide by the USD price of its base asset, as the rewards summary reads them
  const wbtc = rewarded.find(entry => entry.comet.address.toLowerCase() === WBTC)!;
  node.requests.length = 0;
  const summary = await marketHandlers.latestRewardsSummary({ ...everyMarket(), network: wbtc.network, contract: wbtc.comet }, context());
  t.equal(summary.status, 200);
  t.equal(node.requests.length, 2, 'and so does the rewards summary of one market');
});

/*
 * The rewards of every market cost the same per network. A reward feed that
 * quotes a market's base asset — mainnet's WETH market values COMP in ETH —
 * is converted to USD with one more price, read beside the reward price, not
 * in a round of its own once the rates are in: mainnet takes as many
 * requests as Base, which has no such market.
 */
t.test('the rewards of every market convert a reward price to USD in no round of its own', async t => {
  const node = nodeOf();
  serve(t, node);

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
  serve(t, nodeOf((comet, fragment) => (
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

/*
 * The node provider proxy fails a request outright when no provider served
 * its calls: 503, and how long to wait before asking again. The summary reads
 * a network in a request a round, and the history each market in requests of
 * its own; either way, a request with one market's calls that the proxy
 * failed so, or one call the node did not serve, fails every market, as a
 * request the node did not serve, which a route answers 503 with the seconds
 * the proxy asked to wait. A read that reverts, where it is no price, fails
 * every market as a fault, which a route answers 500.
 */
const FAILING = [ [ 'the summary', marketHandlers.latestSummary ], [ 'the history', marketHandlers.historicalSummary ] ] as const;

for (const [ route, handler ] of FAILING) {
  t.test(`${route}: a market whose request or call the node did not serve fails every market, as a request the node did not serve`, async t => {
    const node    = nodeOf();
    const failure = await failureOf({
      ...node,
      fetch: async (input: string | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const calls   = [ await request.clone().json() as Call | Call[] ].flat();
        return calls.some(call => call.params[0]?.to?.toLowerCase() === WBTC)
          ? new Response('upstream error', { status: 503, headers: { 'Retry-After': '5' } })
          : node.fetch(request);
      },
    }, t, handler);
    t.ok(jsonRpc.isNotServed(failure), 'a request of WBTC\'s market failed');
    t.same([ (failure as jsonRpc.NotServed).status, (failure as jsonRpc.NotServed).retryAfter ], [ 503, 5 ],
      'with the status the proxy answered, and the seconds it asked to wait, for a route to pass on');
    t.ok(node.requests.some(({ calls }) => calls.some(call => call.method === 'eth_call')), 'while the other markets were read');

    const read = await failureOf(nodeOf((comet, fragment) => (
      comet === WBTC && fragment === 'totalSupply' ? { code: -32000, message: 'header not found' } : undefined
    )), t, handler);
    t.match((read as Error | null)?.message, /header not found/);
    t.ok(jsonRpc.isNotServed(read), 'and so did one call of it');
  });

  t.test(`${route}: a read of one market that reverts fails every market, as a fault`, async t => {
    const failure = await failureOf(nodeOf((comet, fragment) => (
      comet === WBTC && fragment === 'totalSupply' ? { code: 3, message: 'execution reverted', data: '0x' } : undefined
    )), t, handler);
    t.match((failure as Error | null)?.message, /execution reverted/);
    t.notOk(jsonRpc.isNotServed(failure), 'not as a request the node did not serve: a route answers it 500');
  });
}

// a market of the summary as the route answers it, in JSON
type Summary = {
  comet: { address: string },
  [field: string]: unknown,
};

// the summary of every market, as the route answers it from `node`
async function summaryFrom(t: Test, node: FakeNode): Promise<Summary[]> {
  serve(t, node);
  const response = await marketHandlers.latestSummary(everyMarket(), context());
  t.equal(response.status, 200, 'the summary is answered');
  return await response.json() as Summary[];
}

const entryOf = (summary: Summary[], comet: string) => summary.find(entry => entry.comet.address.toLowerCase() === comet)!;
const without = (entry: object, ...fields: string[]) => Object.fromEntries(Object.entries(entry).filter(([ field ]) => !fields.includes(field)));
const picked  = (entry: object, ...fields: string[]) => Object.fromEntries(Object.entries(entry).filter(([ field ]) => fields.includes(field)));

const REVERT = { code: 3, message: 'execution reverted', data: '0x' };

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
  'total_borrow_value', 'total_supply_value', 'total_collateral_value',
  'total_borrow_value_usd', 'total_supply_value_usd', 'total_collateral_value_usd',
  'utilization', 'base_usd_price', 'base_price',
  'collateral_asset_symbols', 'collateral_value_block', 'collaterals',
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
  const node = nodeOf();
  serve(t, node);
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
  const alone = await (await marketHandlers.latestSummary({ ...everyMarket(), network: 'ethereum-mainnet', contract: wbtc }, context())).json() as Summary[];
  t.equal(JSON.stringify(alone), JSON.stringify([ entryOf(every, WBTC) ]), 'and so does the summary of one market, a list of it alone');
  t.equal(node.requests.length - asked, 8, 'four node requests each, in a minute nothing of theirs is cached');
});

/*
 * What the version says of a market needs nothing read, so a market whose
 * prices revert answers it as any other. Its base price is there wherever it
 * was read: on a partial market, and on an error its USD price alone made.
 */
t.test('a market whose prices revert answers what its version says of it, and its base price where it was read', async t => {
  consoleLines(t, [ 'warn' ]);
  pricingWbtcInBtc(t);
  // the feed that reverts on each of three markets
  const feeds = new Map<string, string>([
    [ WBTC, marketOf(WBTC).baseAsset.usdPriceFeed!.address ],        // BTC / USD: its USD price alone fails
    [ WETH, marketOf(WETH).baseAsset.priceFeed.address ],            // its base feed: its base price fails
    [ USDC, marketOf(USDC).collateralAssets[0]!.priceFeed.address ], // COMP / USD: one of its collaterals fails
  ]);
  const summary = await summaryFrom(t, nodeOf((comet, fragment, argument) => (
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
  t.notOk('base_price' in weth || 'total_supply_value' in weth || 'total_supply_value_usd' in weth, 'without the base price that reverted, nor the totals made of it');
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
  serve(t, nodeOf());
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

type Collateral = { address: string, symbol: string, status: string, [field: string]: unknown };

const collateralsOf = (entry: Summary) => entry.collaterals as Collateral[];
const collateralOf  = (entry: Summary, symbol: string) => collateralsOf(entry).find(collateral => collateral.symbol === symbol)!;

/*
 * After what was read of each collateral, the summary answers what holds of
 * its token on its chain — its name and decimals, whether this market's Comet
 * has it deprecated or hidden, its roles — and the collateral's own value in
 * this market, which the market dates once, by its block. A collateral whose
 * price reverts keeps its message after its status, and its value, which
 * nobody could read, is left out: COMP's price reverts in USDC's market only,
 * so its value is not known there, while USDT's market, where its price was
 * read, values its own COMP. A market whose base asset could not be priced
 * answers its collaterals so all the same, valued where the USD price that
 * converts them was read.
 */
t.test('every collateral answers its token\'s fields and its own value in its market, after what was read of it, in every form', async t => {
  consoleLines(t, [ 'warn' ]);
  const comp = marketOf(USDC).collateralAssets.find(asset => asset.token.symbol === 'COMP')!;
  const node = nodeOf((comet, fragment, argument) => fragment === 'getPrice' && (
    (comet === USDC && argument === comp.priceFeed.address) || (comet === WBTC && argument === marketOf(WBTC).baseAsset.priceFeed.address)
  ) ? REVERT : undefined);
  serve(t, node);
  const every = await (await marketHandlers.latestSummary(everyMarket(), context())).json() as Summary[];

  for (const entry of every) {
    for (const collateral of collateralsOf(entry)) {
      const keys = COLLATERAL_KEYS
        .flatMap((key): string[] => key === 'status' && collateral.status === 'error' ? [ key, 'message' ] : [ key ])
        .filter(key => entry.comet.address.toLowerCase() !== USDC || collateral.symbol !== 'COMP' || key !== 'collateral_value_usd');
      t.strictSame(Object.keys(collateral), keys, `${entry.deployment_key} on ${entry.chain_id}, ${collateral.symbol}: what was read of it, then its token's fields`);
    }
  }

  const usdc = collateralOf(entryOf(every, USDC), 'COMP');
  t.strictSame(usdc, {
    address:  checksumAddress(comp.token.address),
    symbol:   'COMP',
    status:   'error',
    message:  'execution reverted',
    name:     comp.token.name,
    decimals: comp.token.decimals,
    is_deprecated:         false,
    is_network_deprecated: false,
    deprecated_in:         [],
    is_hidden:             false,
    hidden_in:             [],
    is_strategic:          false,
    network_roles:         [ 'reward', 'collateral' ],
    collateral_value_status:    'unavailable',
    collateral_value_exception: null,
    is_visible:        true,
    visibility_reason: 'data_unavailable',
  }, 'COMP in USDC\'s market: its message, then a value nobody could read, left out, and shown for it');
  t.strictSame(collateralOf(entryOf(every, USDT), 'COMP'), {
    ...without(usdc, 'message', 'collateral_value_status', 'collateral_value_exception', 'is_visible', 'visibility_reason'),
    status:                     'success',
    collateral_value_usd:       '1.0',
    collateral_value_status:    'fresh',
    collateral_value_exception: null,
    is_visible:                 false,
    visibility_reason:          'below_threshold',
  }, 'COMP in USDT\'s market: its own price read, so the one COMP it holds is worth a dollar there, and not shown for it');

  const wbtc = entryOf(every, WBTC);
  t.equal(wbtc.status, 'error', 'WBTC\'s market, whose base asset could not be priced');
  t.ok(collateralsOf(wbtc).every(collateral => collateral.collateral_value_status === 'fresh'), 'answers its collaterals, valued all the same');
  t.strictSame([ collateralOf(wbtc, 'pumpBTC').collateral_value_usd, wbtc.collateral_value_block ], [ '86106.69', { number: 29_999_997, timestamp: 1_789_999_997 } ],
    'pumpBTC: one at 1 BTC, at the USD price of BTC, a decimal string, which WBTC\'s market dates by the block it was read at, the one USDT\'s was');

  const mainnet = await (await marketHandlers.latestSummary({ ...everyMarket(), network: 'ethereum-mainnet' }, context())).json() as Summary[];
  t.equal(JSON.stringify(mainnet), JSON.stringify(every.filter(entry => entry.chain_id === 1)), 'the summary of a network answers its collaterals alike');
  const alone = await (await marketHandlers.latestSummary({ ...everyMarket(), network: 'ethereum-mainnet', contract: catalog.marketAt('ethereum-mainnet', USDT)!.comet }, context())).json() as Summary[];
  t.equal(JSON.stringify(alone), JSON.stringify([ entryOf(every, USDT) ]), 'and so does the summary of one market');
});

// the token address of a collateral of a market of mainnet, by its symbol, lowercase
const tokenOf = (comet: string, symbol: string) => marketOf(comet).collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address;

// `whole` tokens of eighteen decimals, and a fraction of one in its smallest unit, as a Comet answers what it holds
const tokens18 = (whole: bigint, fraction = 0n) => whole * 10n ** 18n + fraction;

// what discovery says of a collateral, and the value it said it by
const saidOf = (collateral: Collateral) => [ collateral.collateral_value_usd ?? null, collateral.visibility_reason ];

/*
 * Whether discovery shows a collateral's token in a market is decided by what
 * that market holds of it, whatever the other markets of the chain hold.
 * weETH is a collateral of the USDC, WETH and USDT markets of mainnet: 100,000
 * of it in each, at a dollar, is 300,000 across the chain and short of the
 * threshold in every market; 300,000 in USDC's market alone shows it there and
 * nowhere else. The comparison is exact and inclusive: 250,000 is shown, and
 * a hair less is not, though two markets so hold half a million.
 */
t.test('a collateral is decided by its own value in its market, whatever the chain holds of it', async t => {
  const weEth   = tokenOf(USDC, 'weETH');
  const holding = (amounts: Record<string, bigint>): Held => (comet, token) => token === weEth ? amounts[comet] : undefined;
  const weEthIn = async (amounts: Record<string, bigint>) => {
    const summary = await summaryFrom(t, nodeOf(undefined, holding(amounts)));
    return [ USDC, WETH, USDT ].map(comet => saidOf(collateralOf(entryOf(summary, comet), 'weETH')));
  };

  t.strictSame(await weEthIn({ [USDC]: tokens18(100_000n), [WETH]: tokens18(100_000n), [USDT]: tokens18(100_000n) }), [
    [ '100000.0', 'below_threshold' ], [ '100000.0', 'below_threshold' ], [ '100000.0', 'below_threshold' ],
  ], '100,000 in each of three markets: worth the threshold across the chain, and short of it in every market');
  t.strictSame(await weEthIn({ [USDC]: tokens18(300_000n) }), [
    [ '300000.0', 'collateral_threshold' ], [ '1.0', 'below_threshold' ], [ '1.0', 'below_threshold' ],
  ], '300,000 in USDC\'s market: shown there, and in no other');
  t.strictSame(await weEthIn({ [USDC]: tokens18(250_000n), [WETH]: tokens18(249_999n, 10n ** 18n - 1n), [USDT]: tokens18(249_999n, 10n ** 18n - 1n) }), [
    [ '250000.0', 'collateral_threshold' ],
    [ '249999.999999999999999999', 'below_threshold' ],
    [ '249999.999999999999999999', 'below_threshold' ],
  ], 'exactly the threshold is shown, and a hair less is not, every digit of it compared');
});

/*
 * A value that cannot be read is the market's own: a collateral whose price
 * reverts in one market is shown there for it (data_unavailable), and every
 * other market that takes its token decides by its own value. What a market
 * holds none of is worth nothing, whatever its price, and is not shown: a
 * holding of nothing whose price reverts says so, and its status that the
 * price failed. A Comet that holds another asset at the collateral's index
 * never says what it holds of the collateral, whose value is not known.
 */
t.test('a value that cannot be read is the market\'s own, and nothing held is worth nothing, whatever its price', async t => {
  consoleLines(t, [ 'warn' ]);
  const weEth     = tokenOf(USDC, 'weETH');
  const feedOf    = (comet: string) => marketOf(comet).collateralAssets.find(asset => asset.token.address === weEth)!.priceFeed.address;
  const indexOf   = (comet: string) => String(marketOf(comet).collateralAssets.find(asset => asset.token.address === weEth)!.assetIndex);
  const STRANGER  = '0x1111111111111111111111111111111111111111';
  const summary = await summaryFrom(t, fakeNode(snapshot, LATEST, {
    answer: ({ comet, name, argument }) => (
        comet === WETH && name === 'getPrice' && argument === feedOf(WETH)        ? 'revert'
      : comet === USDT && name === 'getPrice' && argument === feedOf(USDT)        ? 'revert'
      : comet === USDT && name === 'totalsCollateral' && argument === weEth        ? [ 0 ]
      : comet === USDC && name === 'getAssetInfo' && argument === indexOf(USDC)
        ? [ [ Number(indexOf(USDC)), STRANGER, feedOf(USDC), BigNumber.from(10).pow(18), 0, 0, 0, 0 ] ]
      : undefined
    ),
  }));
  const weEthOf = (comet: string) => collateralOf(entryOf(summary, comet), 'weETH');

  t.match(weEthOf(WETH), { status: 'error', collateral_value_status: 'unavailable', is_visible: true, visibility_reason: 'data_unavailable' },
    'WETH\'s market, where its price reverts: not known there, and shown for it');
  t.notOk('collateral_value_usd' in weEthOf(WETH), 'without a value');
  t.match(weEthOf(USDT), { status: 'error', collateral_value_usd: '0', collateral_value_status: 'fresh', is_visible: false, visibility_reason: 'below_threshold' },
    'USDT\'s market, which holds none, its price reverting there too: worth nothing, and not shown');
  t.match(weEthOf(USDC), {
    status:                  'error',
    message:                 `asset ${indexOf(USDC)} of the Comet is ${STRANGER}, not the weETH the registry version describes`,
    collateral_value_status: 'unavailable',
    is_visible:              true,
    visibility_reason:       'data_unavailable',
  }, 'USDC\'s market, whose Comet holds another asset at its index: not known, since what it holds of weETH was never read');
  t.match(entryOf(summary, USDT), { status: 'partially' }, 'and a market with a collateral it could not price is partial, as before');
});

/*
 * On a market quoted in its base asset, a collateral's value is converted to
 * USD at the base asset's USD price, as the market's totals are. Where that
 * reverts, the market is an error, and its collaterals' values are not known,
 * but for one worth nothing whatever converts it: what it holds none of.
 */
t.test('a market quoted in its base asset whose USD price reverts knows the value of nothing it holds but nothing', async t => {
  consoleLines(t, [ 'warn' ]);
  const cbEth   = marketOf(WETH).collateralAssets.find(asset => asset.token.symbol === 'cbETH')!.token.address;
  const summary = await summaryFrom(t, nodeOf(
    (comet, fragment, argument) => comet === WETH && fragment === 'getPrice' && argument === marketOf(WETH).baseAsset.usdPriceFeed!.address ? REVERT : undefined,
    (comet, token) => comet === WETH && token === cbEth ? 0n : undefined,
  ));
  const weth = entryOf(summary, WETH);
  t.match(weth, { status: 'error', message: 'execution reverted' }, 'WETH\'s market, whose USD price reverts, is an error');
  t.notOk('total_collateral_value_usd' in weth, 'without a total in USD');
  t.strictSame(collateralsOf(weth).map(collateral => [ collateral.symbol, collateral.collateral_value_usd ?? null, collateral.visibility_reason ]),
    marketOf(WETH).collateralAssets.map(asset => asset.token.address === cbEth
      ? [ asset.token.symbol, '0', 'below_threshold' ]
      : [ asset.token.symbol, null, 'data_unavailable' ]),
    'every collateral\'s value unknown, and shown for it, but cbETH\'s, of which it holds none');
});

/*
 * In each market whose total in USD is answered, the values of its
 * collaterals that are known add up to it, exactly: each is what the market
 * holds of the collateral at the price the total is made with.
 */
t.test('the values of a market\'s collaterals add up to its total in USD, exactly', async t => {
  consoleLines(t, [ 'warn' ]);
  pricingWbtcInBtc(t);
  const amounts = new Map<string, bigint>();
  // every collateral of every market held in an amount of its own, some of them past the threshold
  catalog.markets().forEach(({ comet }, market) => comet.registry.market.collateralAssets.forEach(asset => amounts.set(
    `${comet.address.toLowerCase()} ${asset.token.address}`,
    (10n ** BigInt(asset.token.decimals)) * BigInt((market + 2) * 100_003 + asset.assetIndex * 17_919 + 1) + BigInt(asset.assetIndex * 1_234_567),
  )));
  const comp    = marketOf(USDC).collateralAssets.find(asset => asset.token.symbol === 'COMP')!;
  const summary = await summaryFrom(t, nodeOf(
    (comet, fragment, argument) => comet === USDC && fragment === 'getPrice' && argument === comp.priceFeed.address ? REVERT : undefined,
    (comet, token) => amounts.get(`${comet} ${token}`),
  ));
  for (const entry of summary) {
    const known = collateralsOf(entry).flatMap(collateral => collateral.collateral_value_usd === undefined ? [] : [ collateral.collateral_value_usd as string ]);
    t.equal(known.reduce((sum, value) => sum + scaled(value), 0n), scaled(entry.total_collateral_value_usd as string),
      `${entry.deployment_key} on ${entry.chain_id}: ${known.length} values add up to ${entry.total_collateral_value_usd}`);
  }
  t.ok(collateralsOf(entryOf(summary, USDC)).some(collateral => collateral.visibility_reason === 'collateral_threshold'),
    'some of them past the threshold');
});

/*
 * A market dates the values of its collaterals once, by the block it was read
 * at, its own block of the minute, which markets of one chain need not share:
 * its number, and the timestamp its header gives, which the node gives a
 * second older for each block below the latest. A value is never carried over
 * from an earlier minute, so it is never stale. Where the node gives no
 * header of that block — a provider that does not have it yet answers null,
 * and a call can still fail — the summary answers all the same, every value
 * and status as read, and leaves out that market's block alone.
 */
t.test('a market dates its values by its own block, and a header the node does not give leaves that out alone', async t => {
  const summary = await summaryFrom(t, nodeOf());
  t.strictSame(Object.fromEntries(summary.map(entry => [ `${entry.chain_id} ${entry.deployment_key}`, entry.collateral_value_block ])), {
    '1 usdc':      { number: 29_999_996, timestamp: 1_789_999_996 },
    '1 weth':      { number: 30_000_000, timestamp: 1_790_000_000 },
    '1 usdt':      { number: 29_999_997, timestamp: 1_789_999_997 },
    '1 wbtc':      { number: 29_999_997, timestamp: 1_789_999_997 },
    '8453 aero':   { number: 29_999_975, timestamp: 1_789_999_975 },
    '534352 usdc': { number: 29_999_994, timestamp: 1_789_999_994 },
  }, 'each market at its own block of the minute, with the timestamp of its own header');

  const logged = consoleLines(t, [ 'warn' ]);
  for (const [ what, answer ] of [ [ 'a header the node does not have', null ], [ 'a header the node fails to read', 'fail' ] ] as const) {
    const headless = await summaryFrom(t, nodeOf(undefined, undefined, reference => reference === 29_999_996 ? answer : undefined));
    const usdc     = entryOf(headless, USDC);
    t.notOk('collateral_value_block' in usdc, `${what}: USDC's market, read at that block, dates no value`);
    t.strictSame(usdc, without(entryOf(summary, USDC), 'collateral_value_block'), `${what}: and answers every value and status as read`);
    t.strictSame(headless.filter(entry => entry !== usdc), summary.filter(entry => entry.comet.address.toLowerCase() !== USDC),
      `${what}: while every other market is answered as it was`);
  }
  t.ok(logged.some(line => line.startsWith(`block header not read: block 29999996 on ethereum-mainnet`)), 'and the log says which header was not read');
});

/*
 * A price exception of the registry that priced a collateral in its market is
 * named on it, and no other: a price the registry states, and a remap whose
 * replacement answered. A network may state prices of one kind for several
 * feeds, and each collateral names the one stated for its own feed. A remap
 * whose replacement reverts while the feed it replaces answers — at the latest
 * block, a replacement that has stopped answering — falls back on that feed,
 * which the market's totals count the collateral at, as any read of a feed
 * the Comet names. The collateral's own value is not known, and names the
 * remap: discovery shows it for that, though the feed the remap replaces
 * values it short of the threshold. The log names the replacement: once a
 * minute, as every feed that reverts, however many markets read it (below).
 */
t.test('a collateral names the exception that priced it in its market, and a remap that fell back leaves its value unknown, naming the remap', async t => {
  const logged = consoleLines(t, [ 'warn' ]);
  const usdtComp    = marketOf(USDT).collateralAssets.find(asset => asset.token.symbol === 'COMP')!;
  const usdcWeth    = marketOf(USDC).collateralAssets.find(asset => asset.token.symbol === 'WETH')!;
  const usdcCbBtc   = marketOf(USDC).collateralAssets.find(asset => asset.token.symbol === 'cbBTC')!;
  const REPLACEMENT = '0x5555555555555555555555555555555555555555';
  const FIXED       = '0x351a133fd850ea81ed8a782016e308acbaddec91';
  const ZERO        = '0xe3a409ed15cd53afdefdd191ad945cec528a2496';
  /*
   * The fixture with COMP / USD remapped to REPLACEMENT, USDC's WETH priced
   * through the fixed feed and WBTC's pumpBTC through the zero one, and a
   * second fixed price, stated for the feed of USDC's cbBTC.
   */
  const version = {
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      priceExceptions: [ ...network.priceExceptions, {
        kind:                 'deprecated_price_remap' as const,
        priceFeedAddress:     usdtComp.priceFeed.address,
        replacementPriceFeed: { address: REPLACEMENT as `0x${string}`, decimals: 8 },
        provenance:           'the feed retired; its replacement answers the same pair',
        expiresAt:            null,
      }, {
        kind:             'fixed_price' as const,
        priceFeedAddress: usdcCbBtc.priceFeed.address,
        price:            { value: '250000000', decimals: 8 },
        provenance:       'a second price the registry states on the network',
        expiresAt:        null,
      } ],
      markets: network.markets.map(entry => ({
        ...entry,
        collateralAssets: entry.collateralAssets.map(asset => (
            entry.contracts.comet === USDC && asset.token.symbol === 'WETH'   ? { ...asset, priceFeed: { ...asset.priceFeed, address: FIXED as `0x${string}` } }
          : entry.contracts.comet === WBTC && asset.token.symbol === 'pumpBTC' ? { ...asset, priceFeed: { ...asset.priceFeed, address: ZERO as `0x${string}` } }
          : asset
        )),
      })),
    }),
  };
  const exceptions = version.networks[0]!.priceExceptions;
  const described  = (feed: string) => {
    const { kind, provenance, expiresAt } = exceptions.find(exception => exception.priceFeedAddress === feed)!;
    return { kind, price_feed_address: checksumAddress(feed), provenance, expires_at: expiresAt };
  };
  // the Comets name the feeds of the version; the replacement answers 2.0 unless `reverting`
  const nodeAt = (reverting: boolean) => fakeNode(version, LATEST, {
    answer: ({ comet, name, argument }) => (
        name === 'getAssetInfo' && comet === USDC && argument === String(usdcWeth.assetIndex)
        ? [ [ usdcWeth.assetIndex, usdcWeth.token.address, FIXED, BigNumber.from(10).pow(18), 0, 0, 0, 0 ] ]
      : name === 'getPrice' && argument === REPLACEMENT ? (reverting ? 'revert' : [ 200_000_000 ])
      : undefined
    ),
  });
  const read = async (reverting: boolean) => {
    serve(t, nodeAt(reverting));
    return await (await marketHandlers.latestSummary({ ...everyMarket(), catalog: fixtureCatalog(version) }, context())).json() as Summary[];
  };
  const fieldsOf = (collateral: Collateral) => picked(collateral, 'collateral_value_usd', 'collateral_value_status', 'collateral_value_exception');

  const replaced = await read(false);
  t.strictSame(fieldsOf(collateralOf(entryOf(replaced, USDT), 'COMP')),
    { collateral_value_usd: '2.0', collateral_value_status: 'exception', collateral_value_exception: described(usdtComp.priceFeed.address) },
    'COMP in USDT\'s market: read from the replacement its remap names, and naming the remap');
  t.strictSame(fieldsOf(collateralOf(entryOf(replaced, USDC), 'WETH')),
    { collateral_value_usd: '1.02447384', collateral_value_status: 'exception', collateral_value_exception: described(FIXED) },
    'WETH in USDC\'s market: at the price the registry states for its feed, naming it, and not the other fixed price');
  t.strictSame(fieldsOf(collateralOf(entryOf(replaced, USDC), 'cbBTC')),
    { collateral_value_usd: '2.5', collateral_value_status: 'exception', collateral_value_exception: described(usdcCbBtc.priceFeed.address) },
    'cbBTC in USDC\'s market: at the other fixed price, stated for its own feed, naming that one alone');
  t.strictSame(fieldsOf(collateralOf(entryOf(replaced, WBTC), 'pumpBTC')),
    { collateral_value_usd: '0.0', collateral_value_status: 'exception', collateral_value_exception: described(ZERO) },
    'pumpBTC in WBTC\'s market: at the zero the registry states, worth nothing, written as a price of zero is, and naming it');
  t.match(collateralOf(entryOf(replaced, WBTC), 'pumpBTC'), { is_visible: false, visibility_reason: 'below_threshold' }, 'and not shown for it');

  t.notOk(logged.some(line => line.includes(REPLACEMENT)), 'and the replacement, which answers, is not logged');

  const fallenBack = await read(true);
  for (const comet of [ USDT, USDC ]) {
    const key = entryOf(fallenBack, comet).deployment_key;
    t.strictSame(fieldsOf(collateralOf(entryOf(fallenBack, comet), 'COMP')),
      { collateral_value_status: 'unavailable', collateral_value_exception: described(usdtComp.priceFeed.address) },
      `COMP in ${key}'s market, its replacement reverting: of a value not known, naming the remap`);
    t.match(collateralOf(entryOf(fallenBack, comet), 'COMP'), { status: 'success', is_visible: true, visibility_reason: 'data_unavailable' },
      `COMP in ${key}'s market: priced through the feed the remap replaces, which values the one COMP held at a dollar, and shown for a value not known`);
  }
  const usdt = entryOf(fallenBack, USDT);
  const known = collateralsOf(usdt).flatMap(collateral => collateral.collateral_value_usd === undefined ? [] : [ collateral.collateral_value_usd as string ]);
  t.strictSame([ usdt.total_collateral_value_usd, entryOf(replaced, USDT).total_collateral_value_usd ], [ '16.0', '17.0' ],
    'USDT\'s total counts the one COMP at the dollar of the feed the remap replaces, where it counted it at the replacement\'s two');
  t.equal(scaled(usdt.total_collateral_value_usd as string) - known.reduce((sum, value) => sum + scaled(value), 0n), scaled('1'),
    'so the values that are known add up to its total but for that dollar');
  t.equal(logged.filter(line => line.startsWith(`price feed reverted: ${REPLACEMENT} `)).length, 1,
    'the replacement logged once, though the USDC and USDT markets both read it in the minute');
});

/*
 * Such a replacement has stopped answering: the summary reads a block after
 * it was deployed. Beside leaving the collateral's value unknown, naming the
 * remap (above), the summary logs the replacement as a read logs a feed that
 * reverts: for each market that read it, at that market's block, naming it
 * as the version does, in lowercase, and the market's Comet, with its own
 * message, whatever the market holds — USDC's market holds no COMP here, so
 * its COMP is worth nothing there and names no remap. A feed no remap names
 * is logged by its read alone, once: rsETH's, which reverts in USDC's market.
 * The clock is a minute later at every reading, so the throttle of those
 * lines (get-price.ts) lets every one through.
 *
 * Nothing of the revert is answered or cached, and the next request of the
 * minute, answered from the cache, reads no feed and logs nothing. The
 * history reads the replacement on its days, and logs it on none: at a block
 * before the replacement was deployed its revert is expected. Nor does any
 * day it answers name the replacement or its revert.
 */
t.test('a remap replacement that stopped answering is logged by the summary of each market that read it, and by nothing else', async t => {
  let clock = Date.now();
  t.capture(Date, 'now', () => (clock += 60_000));
  const logged   = consoleLines(t, [ 'warn' ]);
  const comp     = marketOf(USDT).collateralAssets.find(asset => asset.token.symbol === 'COMP')!;
  const rsEth    = marketOf(USDC).collateralAssets.find(asset => asset.token.symbol === 'rsETH')!;
  const REPLACED = '0x5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b';
  const STOPPED  = 'execution reverted: the replacement stopped answering';
  const RSETH    = 'execution reverted: rsETH / USD';
  // the fixture with COMP / USD, which the USDC and USDT markets price COMP with, remapped to REPLACED
  const version = {
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      priceExceptions: [ ...network.priceExceptions, {
        kind:                 'deprecated_price_remap' as const,
        priceFeedAddress:     comp.priceFeed.address,
        replacementPriceFeed: { address: REPLACED as `0x${string}`, decimals: 8 },
        provenance:           'the feed retired; its replacement answers the same pair',
        expiresAt:            null,
      } ],
    }),
  };
  const remapped = fixtureCatalog(version);
  const node     = fakeNode(version, LATEST, {
    answer: ({ comet, name, argument }) => (
        name === 'getPrice' && argument === REPLACED                                     ? { ...REVERT, message: STOPPED }
      : name === 'getPrice' && comet === USDC && argument === rsEth.priceFeed.address    ? { ...REVERT, message: RSETH }
      : name === 'totalsCollateral' && comet === USDC && argument === comp.token.address ? [ 0 ]
      : undefined
    ),
  });
  serve(t, node);
  const cometOf = (address: `0x${string}`) => remapped.marketAt('ethereum-mainnet', address)!.comet.address;
  const cache   = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  const cached  = context([], summaryDecisionsOf(), cache);

  const response = await marketHandlers.latestSummary({ ...everyMarket(), catalog: remapped }, cached);
  t.equal(response.status, 200, 'the summary is answered');
  const text    = await response.text();
  const summary = JSON.parse(text) as Summary[];
  t.strictSame([ ...logged ].sort(), [
    `price feed reverted: ${REPLACED} read by ${cometOf(USDC)} on ethereum-mainnet at block 29999996: ${STOPPED}`,
    `price feed reverted: ${REPLACED} read by ${cometOf(USDT)} on ethereum-mainnet at block 29999997: ${STOPPED}`,
    `price feed reverted: ${checksumAddress(rsEth.priceFeed.address)} read by ${cometOf(USDC)} on ethereum-mainnet at block 29999996: ${RSETH}`,
  ].sort(), 'the replacement once for each market that read it, at its block, whatever it holds, and rsETH\'s feed once, by its read');

  const held = collateralOf(entryOf(summary, USDT), 'COMP');
  const none = collateralOf(entryOf(summary, USDC), 'COMP');
  t.strictSame(Object.keys(none), COLLATERAL_KEYS, 'usdc: COMP answers what every collateral answers');
  t.match(none, { status: 'success', collateral_value_usd: '0', collateral_value_status: 'fresh', collateral_value_exception: null, visibility_reason: 'below_threshold' },
    'usdc: none of it held, so worth nothing, whatever priced it, naming no exception');
  t.strictSame(Object.keys(held), COLLATERAL_KEYS.filter(key => key !== 'collateral_value_usd'), 'usdt: COMP answers what every collateral of a value not known answers');
  t.match(held, {
    status:                     'success',
    collateral_value_status:    'unavailable',
    collateral_value_exception: { kind: 'deprecated_price_remap', price_feed_address: checksumAddress(comp.priceFeed.address) },
    is_visible:                 true,
    visibility_reason:          'data_unavailable',
  }, 'usdt: priced through the feed the remap replaces, of a value not known, naming the remap, and shown for it');
  t.strictSame(summary.map(entry => Object.keys(entry)), summary.map(() => answered), 'every market answers what it always answers');
  t.notOk(text.includes(REPLACED) || text.includes(STOPPED), 'and nothing names the replacement or its revert');

  const minutes = Object.entries(cache.store).filter(([ key ]) => key.startsWith('marketMinutelySummary-'));
  t.equal(minutes.length, catalog.markets().length, 'the minute of every market is cached');
  t.notOk(JSON.stringify(minutes).includes(REPLACED) || JSON.stringify(minutes).includes(STOPPED), 'with nothing of the replacement or its revert');
  const usdtMinute = (minutes.find(([ key ]) => key.includes(`contract:${USDT}@`))?.[1] ?? null) as { collaterals: object[] } | null;
  t.strictSame(usdtMinute?.collaterals.map(collateral => Object.keys(collateral)),
    marketOf(USDT).collateralAssets.map(() => [ 'address', 'symbol', 'status', 'valueUsd', 'exception' ]),
    'USDT\'s minute holds of each collateral its status, its value and its exception alone');
  t.strictSame(usdtMinute?.collaterals[0], {
    address: checksumAddress(comp.token.address), symbol: 'COMP', status: 'success', valueUsd: null, exception: { kind: 'deprecated_price_remap', priceFeedAddress: comp.priceFeed.address },
  }, 'COMP among them, of a value not known, naming the remap');

  logged.length = 0;
  node.requests.length = 0;
  const again = await marketHandlers.latestSummary({ ...everyMarket(), catalog: remapped }, cached);
  t.equal(await again.text(), text, 'the next request of the minute answers as the first did');
  t.equal(node.requests.length, NETWORKS.length, 'from the cache, reading the latest block of each network alone');
  t.strictSame(logged, [], 'and logs nothing');

  node.requests.length = 0;
  const history = await marketHandlers.historicalSummary({ ...everyMarket(), catalog: remapped }, context());
  t.equal(history.status, 200, 'the history is answered');
  const historyText = await history.text();
  const days = (JSON.parse(historyText) as Summary[]).filter(day => day.comet.address.toLowerCase() === USDT);
  t.ok(days.length > 0 && days.every(day => day.status === 'success'), 'each day of USDT\'s market a success, COMP priced through the feed the remap replaces');
  const replacedRead = `0x41976e09${REPLACED.slice(2).padStart(64, '0')}`;
  t.ok(node.requests.some(({ calls }) => calls.some(call => call.method === 'eth_call' && call.params[0].data === replacedRead)), 'having read the replacement');
  t.strictSame(logged.filter(line => line.includes(REPLACED)), [], 'which the history logs on no day');
  t.ok(logged.some(line => line.startsWith(`price feed reverted: ${checksumAddress(rsEth.priceFeed.address)} `)), 'though it logs a feed no remap names that reverts');
  t.notOk(historyText.includes(REPLACED) || historyText.includes(STOPPED), 'and no day it answers names the replacement or its revert');
});

/*
 * The summary keeps in its cache only what it read, and keys it without the
 * labels of the market (catalog.ts, marketDigest): a version that changes
 * only a label is answered at once, from the summary already cached.
 */
t.test('a version that changes only a label is answered at once, from the summary already cached', async t => {
  const node = nodeOf();
  serve(t, node);
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
 * every field that does not need the price it lacks. The version prices the
 * totals of WBTC's market with WBTC / BTC, and its base asset in USD with
 * BTC / USD: without the first, it answers all but its base price and its
 * borrow and supply totals, in BTC and in USD. One feed prices both on
 * USDC's market, which answers all but those totals and both its prices.
 */
t.test('a market whose base feed reverts answers every field it can', async t => {
  const reading = await summaryFrom(t, nodeOf());
  // the warnings the summary logs, kept out of the test's output
  consoleLines(t, [ 'warn' ]);
  const feeds = new Map([ WBTC, USDC ].map(comet => [ comet, marketOf(comet).baseAsset.priceFeed.address ]));
  const reverting = await summaryFrom(t, nodeOf((comet, fragment, argument) => (
    fragment === 'getPrice' && argument === feeds.get(comet) ? REVERT : undefined
  )));
  const totals = [ 'total_borrow_value', 'total_supply_value', 'total_borrow_value_usd', 'total_supply_value_usd' ];

  const wbtc = entryOf(reverting, WBTC);
  t.strictSame(wbtc, { ...without(entryOf(reading, WBTC), ...totals, 'base_price'), status: 'error', message: 'execution reverted' },
    'WBTC: an error, and every field as read but its borrow and supply totals and its base price');
  t.strictSame(Object.keys(wbtc), [
    'chain_id', 'comet', ...VERSION_KEYS, 'status', 'message', 'borrow_apr', 'supply_apr', 'total_collateral_value', 'total_collateral_value_usd',
    'utilization', 'base_usd_price', 'collateral_asset_symbols', 'collateral_value_block', 'collaterals',
  ], 'WBTC: its message after its status');
  t.equal(wbtc.base_usd_price, '86106.69', 'WBTC: its USD price, which is the price of BTC');

  const usdc = entryOf(reverting, USDC);
  t.strictSame(usdc, { ...without(entryOf(reading, USDC), ...totals, 'base_usd_price', 'base_price'), status: 'error', message: 'execution reverted' },
    'USDC: an error, and every field as read but its totals and both its prices');
  t.strictSame(Object.keys(usdc), [
    'chain_id', 'comet', ...VERSION_KEYS, 'status', 'message', 'borrow_apr', 'supply_apr', 'total_collateral_value', 'total_collateral_value_usd',
    'utilization', 'collateral_asset_symbols', 'collateral_value_block', 'collaterals',
  ], 'USDC: its message after its status');

  const others = (summary: Summary[]) => summary.filter(entry => ![ WBTC, USDC ].includes(entry.comet.address.toLowerCase()));
  t.strictSame(others(reverting), others(reading), 'and every other market as read');
});

/*
 * Where the base feed the version names reverts, a market's base asset is
 * priced through the feed its Comet names at the block: USDC's here, a
 * market quoted in USD, so its USD price too. Asking the Comet for that feed,
 * and reading it, takes two rounds after the one that reverted, which the
 * summary takes anyway for the collateral, so no network sends another
 * request. The rewards are read in one round, so the network of such a
 * market takes two more.
 */
t.test('a base feed that reverts is read through the Comet\'s in the requests the summary makes anyway', async t => {
  const own   = marketOf(USDC).baseAsset.priceFeed.address;
  const OTHER = '0x2222222222222222222222222222222222222222';
  // USDC's Comet names OTHER for its base asset, which answers 2.0, where the feed the version names reverts
  const fallingBack = () => fakeNode(snapshot, LATEST, {
    answer: ({ comet, name, argument }) => {
      if (comet === USDC && name === 'baseTokenPriceFeed') {
        return [ OTHER ];
      }
      if (comet === USDC && name === 'getPrice' && (argument === own || argument === OTHER)) {
        return argument === own ? 'revert' : [ 200_000_000 ];
      }
      return name === 'getPrice' && PRICES.has(argument!) ? [ PRICES.get(argument!) ] : undefined;
    },
  });

  const reading = await summaryFrom(t, nodeOf());
  const node    = fallingBack();
  const summary = await summaryFrom(t, node);
  t.strictSame(entryOf(summary, USDC), {
    ...entryOf(reading, USDC),
    total_borrow_value:     '200.0',
    total_supply_value:     '200.0',
    total_borrow_value_usd: '200.0',
    total_supply_value_usd: '200.0',
    base_usd_price:         '2.0',
    base_price:             '2.0',
  }, 'USDC: a success, its totals and both prices at the 2.0 of the feed its Comet names');
  const others = (entries: Summary[]) => entries.filter(entry => entry.comet.address.toLowerCase() !== USDC);
  t.strictSame(others(summary), others(reading), 'and every other market as read');

  for (const network of NETWORKS) {
    t.equal(requestsOf(node, network).length, 4, `${network}: four requests, as without the revert`);
  }
  for (const { network, calls } of node.requests) {
    const distinct = new Set(calls.map(({ method, params }) => JSON.stringify([ method, params ])));
    t.equal(distinct.size, calls.length, `${network}: no call is sent twice in one batch`);
  }

  const rewarding = fallingBack();
  serve(t, rewarding);
  const rewards = await marketHandlers.rewardsDappData(everyMarket(), context());
  t.equal(rewards.status, 200);
  t.ok((await rewards.json() as Array<{ status: string }>).every(entry => entry.status === 'success'), 'the rewards of every market are answered');
  const requestsOn = (network: string) => rewarding.requests.filter(request => request.network === network).length;
  t.equal(requestsOn('ethereum-mainnet'), 4, 'the rewards of USDC\'s network take two requests more');
  t.equal(requestsOn('base-mainnet'), 2, 'and those of another network none');
});
