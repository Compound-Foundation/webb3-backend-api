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

import { checksumAddress } from '../../lib/model/comet-registry.js';

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
 *
 * And it is where the route's JSON is held against what the node answered:
 * each number of a Comet and each price in its place, under its key in
 * snake_case, and reserves that revert left out, and nothing else.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const snapshot = loadRegistrySnapshotFixture();
const catalog  = fixtureCatalog(snapshot);

const LATEST = { number: 30_000_000, timestamp: 1_790_000_000 };
const USDC   = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WETH   = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
const WBTC   = '0xe85dc543813b8c2cfeaac371517b925a166a9293';
const AERO   = '0x784efeb622244d2348d4f2522f8860b96fbece89';

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
  // the reserves and the interest rate model of a market
  'function getReserves() view returns (int256)',
  'function getCollateralReserves(address) view returns (uint256)',
  'function supplyKink() view returns (uint256)',
  'function supplyPerSecondInterestRateBase() view returns (uint256)',
  'function supplyPerSecondInterestRateSlopeLow() view returns (uint256)',
  'function supplyPerSecondInterestRateSlopeHigh() view returns (uint256)',
  'function borrowKink() view returns (uint256)',
  'function borrowPerSecondInterestRateBase() view returns (uint256)',
  'function borrowPerSecondInterestRateSlopeLow() view returns (uint256)',
  'function borrowPerSecondInterestRateSlopeHigh() view returns (uint256)',
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
 * What the node answers, each number its own, so that one reported in
 * another's place shows: the getters of the interest rate model, alike for
 * every Comet; the reserves of a market, positive but for WETH's, which owes
 * its suppliers more than it holds; what a Comet keeps for a collateral, by
 * the collateral's index; and what accounts supplied of a collateral, and
 * the Comet's reserves of it, by its token. ETH / USD and BTC / USD, which
 * convert the markets quoted in ETH and in BTC to USD, answer prices of
 * their own, as does AERO / USD; every other feed answers 1.0.
 */
const RATES: Record<string, string> = {
  supplyKink:                           '850000000000000000',
  supplyPerSecondInterestRateBase:      '31709791',
  supplyPerSecondInterestRateSlopeLow:  '1141552511',
  supplyPerSecondInterestRateSlopeHigh: '101344495180',
  borrowKink:                           '900000000000000000',
  borrowPerSecondInterestRateBase:      '475646879',
  borrowPerSecondInterestRateSlopeLow:  '880834601',
  borrowPerSecondInterestRateSlopeHigh: '114155251141',
};

const reservesOf = (comet: string) => comet === WETH ? -5 : 8_434_471_165_951;

const parametersAt = (assetIndex: number) => ({
  borrowCollateralFactor:    EthersBigNumber.from(10).pow(15).mul(700 + assetIndex),
  liquidateCollateralFactor: EthersBigNumber.from(10).pow(15).mul(800 + assetIndex),
  liquidationFactor:         EthersBigNumber.from(10).pow(15).mul(900 + assetIndex),
  supplyCap:                 EthersBigNumber.from(10).pow(21).mul(assetIndex + 1),
});

// every collateral token of the snapshot, numbered from one
const TOKENS = [ ...new Set(snapshot.networks.flatMap(network => network.markets.flatMap(entry => (
  entry.collateralAssets.map(asset => asset.token.address.toLowerCase())
)))) ];
const suppliedOf           = (token: string) => (TOKENS.indexOf(token.toLowerCase()) + 1) * 1_000_000;
const collateralReservesOf = (token: string) => (TOKENS.indexOf(token.toLowerCase()) + 1) * 1_000;

// the prices of their own, at eight decimals
const PRICES = new Map<string, number>([
  [ marketOf(WETH).baseAsset.usdPriceFeed!.address, 250_000_000_000 ],   // ETH / USD: 2500.0
  [ marketOf(WBTC).baseAsset.usdPriceFeed!.address, 8_610_669_000_000 ], // BTC / USD: 86106.69
  [ marketOf(AERO).baseAsset.priceFeed.address,     89_531_391 ],        // AERO / USD: 0.89531391
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
        case 'numAssets':             return [ entry!.collateralAssets.length ];
        case 'getAssetInfo': {
          const asset = entry!.collateralAssets[Number(argument)]!;
          return [ {
            offset:    asset.assetIndex,
            asset:     asset.token.address,
            priceFeed: asset.priceFeed.address,
            scale:     EthersBigNumber.from(10).pow(asset.token.decimals),
            ...parametersAt(asset.assetIndex),
          } ];
        }
        case 'baseTokenPriceFeed':    return [ entry!.baseAsset.priceFeed.address ];
        case 'getPrice':              return [ PRICES.get(argument!) ?? EthersBigNumber.from(10).pow(8) ];
        case 'getReserves':           return [ reservesOf(to.toLowerCase()) ];
        case 'totalsCollateral':      return [ suppliedOf(argument!) ];
        case 'getCollateralReserves': return [ collateralReservesOf(argument!) ];
        case 'symbol':                return [ symbols.get(to.toLowerCase()) ?? 'TKN' ];
        case 'totalsBasic': {
          const [ index, base ] = [ EthersBigNumber.from(10).pow(15), EthersBigNumber.from(10).pow(12) ];
          return [ [ index, index, 0, 0, base, base, LATEST.timestamp, 0 ] ];
        }
        default:                      return [ RATES[fragment.name] ?? EthersBigNumber.from(10).pow(8) ];
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
  comet:       { address: string },
  status:      string,
  collaterals: Array<Record<string, string>>,
  [field: string]: unknown,
};

// the summary of every market, as the route answers it from `node`
async function summaryFrom(t: Test, node: ReturnType<typeof fakeNode>): Promise<Summary[]> {
  serving(t, node);
  const response = await marketHandlers.latestSummary(everyMarket(), context());
  t.equal(response.status, 200, 'the summary is answered');
  return await response.json() as Summary[];
}

const entryOf  = (summary: Summary[], comet: string) => summary.find(entry => entry.comet.address.toLowerCase() === comet)!;
const pricesOf = (summary: Summary[], comet: string) => entryOf(summary, comet).collaterals.map(collateral => collateral.price_usd);
const without  = (entry: object, ...fields: string[]) => Object.fromEntries(Object.entries(entry).filter(([ field ]) => !fields.includes(field)));

// `price` for every collateral of a Comet's market
const everyAt = (comet: string, price: string) => marketOf(comet).collateralAssets.map(() => price);

const REVERT = { code: 3, message: 'execution reverted', data: '0x' };

// the warnings the summary logs while a test runs, kept out of its output
function captureWarnings(t: Test): string[] {
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.join(' ')); };
  t.teardown(() => { console.warn = warn; });
  return logged;
}

/*
 * What a Comet stores is answered as it stores it, an integer each, and in
 * snake_case to the deepest key: the reserves of its market, which are
 * signed, its interest rate model, borrow before supply, and for each
 * collateral what accounts supplied of it, the Comet's reserves of it, its
 * supply cap and its factors. The price of each collateral is in USD: as
 * its feed answers it on a market quoted in USD, AERO's among them, and
 * converted with the base asset's USD price on one quoted in its base asset.
 */
t.test('the summary answers the reserves, the rate model and each collateral\'s parameters as the Comet stores them', async t => {
  const summary = await summaryFrom(t, fakeNode());
  t.ok(summary.every(entry => entry.status === 'success'), 'every market is a success');

  const curve = (side: 'borrow' | 'supply') => ({
    kink:       RATES[`${side}Kink`],
    base:       RATES[`${side}PerSecondInterestRateBase`],
    slope_low:  RATES[`${side}PerSecondInterestRateSlopeLow`],
    slope_high: RATES[`${side}PerSecondInterestRateSlopeHigh`],
  });
  for (const { network, deploymentKey, comet } of catalog.markets()) {
    const entry = entryOf(summary, comet.address.toLowerCase());
    const name  = `${network} ${deploymentKey}`;
    t.strictSame(Object.keys(entry), [
      'chain_id', 'comet', 'status', 'borrow_apr', 'supply_apr', 'total_borrow_value', 'total_supply_value', 'total_collateral_value',
      'utilization', 'base_usd_price', 'collateral_asset_symbols', 'reserves', 'rate_model', 'collaterals',
    ], `${name}: every field, in the order the API writes them`);
    t.equal(entry.reserves, String(reservesOf(comet.address.toLowerCase())), `${name}: its reserves`);
    t.strictSame(entry.rate_model, { borrow: curve('borrow'), supply: curve('supply') }, `${name}: each slot of its rate model from its own getter`);
    t.strictSame(entry.collaterals.map(collateral => without(collateral, 'price_usd')), comet.registry.market.collateralAssets.map(asset => {
      const parameters = parametersAt(asset.assetIndex);
      return {
        address:                     checksumAddress(asset.token.address),
        symbol:                      asset.token.symbol,
        status:                      'success',
        total_supply:                String(suppliedOf(asset.token.address)),
        reserves:                    String(collateralReservesOf(asset.token.address)),
        supply_cap:                  parameters.supplyCap.toString(),
        borrow_collateral_factor:    parameters.borrowCollateralFactor.toString(),
        liquidate_collateral_factor: parameters.liquidateCollateralFactor.toString(),
        liquidation_factor:          parameters.liquidationFactor.toString(),
      };
    }), `${name}: each number of each collateral from its own read`);
  }

  const usdc = entryOf(summary, USDC);
  t.equal(JSON.stringify(usdc.rate_model), JSON.stringify({ borrow: curve('borrow'), supply: curve('supply') }),
    'the rate model in the order the API writes it, borrow before supply');
  t.strictSame(Object.keys(usdc.collaterals[0]!), [
    'address', 'symbol', 'status', 'price_usd', 'total_supply', 'reserves', 'supply_cap',
    'borrow_collateral_factor', 'liquidate_collateral_factor', 'liquidation_factor',
  ], 'and a collateral\'s fields in the order the API writes them');

  t.strictSame(pricesOf(summary, USDC), everyAt(USDC, '1.0'), 'USDC\'s collateral in USD, as its feeds answer');
  t.strictSame(pricesOf(summary, WETH), everyAt(WETH, '2500.0'), 'WETH\'s at 1.0 ETH, at 2500 USD per ETH');
  t.strictSame(pricesOf(summary, AERO), everyAt(AERO, '1.0'), 'and AERO\'s as its feeds answer, neither multiplied nor divided by the price of AERO');
});

/*
 * A market whose base asset could not be priced is an error, and answers
 * every field that does not need the price it lacks. The Comet of WBTC's
 * market prices its totals with WBTC / BTC, and the version its base asset
 * in USD with BTC / USD: without the first, it answers all but its totals.
 * One feed prices both on USDC's market, which answers all but its totals
 * and its base asset's USD price, its collateral in USD as its feeds answer.
 */
t.test('a market whose base feed reverts answers every field it can', async t => {
  const reading = await summaryFrom(t, fakeNode());
  captureWarnings(t);
  const feeds = new Map([ WBTC, USDC ].map(comet => [ comet, marketOf(comet).baseAsset.priceFeed.address ]));
  const reverting = await summaryFrom(t, fakeNode((comet, fragment, argument) => (
    fragment === 'getPrice' && argument === feeds.get(comet) ? REVERT : undefined
  )));

  const wbtc = entryOf(reverting, WBTC);
  t.strictSame(wbtc, { ...without(entryOf(reading, WBTC), 'total_borrow_value', 'total_supply_value'), status: 'error', message: 'execution reverted' },
    'WBTC: an error, and every field as read but its totals');
  t.strictSame(Object.keys(wbtc), [
    'chain_id', 'comet', 'status', 'message', 'borrow_apr', 'supply_apr', 'total_collateral_value',
    'utilization', 'base_usd_price', 'collateral_asset_symbols', 'reserves', 'rate_model', 'collaterals',
  ], 'WBTC: its message after its status');
  t.equal(wbtc.base_usd_price, '86106.69', 'WBTC: its USD price, which is the price of BTC');
  t.strictSame(pricesOf(reverting, WBTC), everyAt(WBTC, '86106.69'), 'WBTC: its collateral at 1.0 BTC, in USD');

  const usdc = entryOf(reverting, USDC);
  t.strictSame(usdc, { ...without(entryOf(reading, USDC), 'total_borrow_value', 'total_supply_value', 'base_usd_price'), status: 'error', message: 'execution reverted' },
    'USDC: an error, and every field as read but its totals and its USD price');
  t.strictSame(Object.keys(usdc), [
    'chain_id', 'comet', 'status', 'message', 'borrow_apr', 'supply_apr', 'total_collateral_value',
    'utilization', 'collateral_asset_symbols', 'reserves', 'rate_model', 'collaterals',
  ], 'USDC: its message after its status');
  t.strictSame(pricesOf(reverting, USDC), everyAt(USDC, '1.0'), 'USDC: its collateral in USD, as its feeds answer');

  const others = (summary: Summary[]) => summary.filter(entry => ![ WBTC, USDC ].includes(entry.comet.address.toLowerCase()));
  t.strictSame(others(reverting), others(reading), 'and every other market as read');
});

/*
 * A Comet reads its reserves through the token's balanceOf, so a token that
 * reverts there leaves out those reserves and nothing else: the summary of
 * every network is answered, each market with the status its prices give
 * it, and the log names each revert. WETH is a collateral of USDC's market
 * and of USDT's, and its reserves revert on USDC's alone.
 */
t.test('a token whose reserves revert leaves out only its reserves', async t => {
  const reading = await summaryFrom(t, fakeNode());
  const logged  = captureWarnings(t);
  const weth    = marketOf(USDC).collateralAssets.find(asset => asset.token.symbol === 'WETH')!.token.address;
  const reverting = await summaryFrom(t, fakeNode((comet, fragment, argument) => (
    (comet === USDC && fragment === 'getCollateralReserves' && argument === weth) || (comet === AERO && fragment === 'getReserves')
      ? REVERT
      : undefined
  )));

  t.ok(reverting.every(entry => entry.status === 'success'), 'every market is a success');
  const usdc = entryOf(reading, USDC);
  t.strictSame(entryOf(reverting, USDC), {
    ...usdc,
    collaterals: usdc.collaterals.map(collateral => collateral.address.toLowerCase() === weth ? without(collateral, 'reserves') : collateral),
  }, 'USDC: its WETH without its reserves, and every other field as read');
  t.strictSame(entryOf(reverting, AERO), without(entryOf(reading, AERO), 'reserves'), 'AERO: the market without its reserves, and every other field as read');
  const others = (summary: Summary[]) => summary.filter(entry => ![ USDC, AERO ].includes(entry.comet.address.toLowerCase()));
  t.strictSame(others(reverting), others(reading), 'and every other market as read, USDT\'s WETH with its reserves');

  const reverts = logged.filter(line => line.startsWith('reserves reverted: '));
  const naming  = (prefix: string) => reverts.filter(line => line.startsWith(prefix) && line.endsWith(': execution reverted')).length;
  t.equal(reverts.length, 2, 'the log names each revert once');
  t.equal(naming(`reserves reverted: getCollateralReserves(${checksumAddress(weth)}) of ${usdc.comet.address} on ethereum-mainnet at block `), 1,
    'the token, and the Comet that read it');
  t.equal(naming(`reserves reverted: getReserves() of ${entryOf(reading, AERO).comet.address} on base-mainnet at block `), 1, 'and the Comet');
});
