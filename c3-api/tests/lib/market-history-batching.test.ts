import t, { Test } from 'tap';

import { Interface, type FunctionFragment } from '@ethersproject/abi';
import { BigNumber as EthersBigNumber } from '@ethersproject/bignumber';

import * as Debug    from '../../lib/debug-log.js';
import * as Flags    from '../../lib/flags.js';
import * as jsonRpc  from '../../lib/json-rpc.js';
import { BigNumber } from '../../lib/bignumber.js';
import { BigFixnum } from '../../lib/bigfixnum.js';

import * as Cache     from '../../lib/symbolic/cache.js';
import * as Evaluator from '../../lib/symbolic/evaluator.js';

import * as evm    from '../../lib/computations/evm.js';
import * as comet  from '../../lib/computations/comet.js';
import * as market from '../../lib/computations/market.js';

import type { Address, RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';
import type { Catalog } from '../../src/registry/catalog.js';

import * as marketHandlers from '../../src/market.js';
import {
  AllContracts,
  AllNetworks,
  type MarketRouteData,
  type UninstantiatedContext,
} from '../../src/router.js';

import { MemoryKv } from '../util/kv.js';
import { fixtureCatalog, loadRegistrySnapshotFixture } from '../util/registry-fixture.js';

import '../../shim/node-self.js';

/*
 * The history of every market, on the real evaluator against a fake node,
 * counting what reaches the node and KV. Each request to the node provider
 * proxy and each KV operation is a subrequest, of which a Worker invocation
 * has 10,000 (README, "Workers Plan"), and a history reads 30 days of every
 * market: the reads of a market's days have to reach the node in a few
 * requests, not one request a read.
 *
 * The handler is handed what production hands it: the flags of an
 * environment that sets none of its own, which neither batch nor evaluate by
 * working set, the computations with the index bias production has
 * (entrypoint.ts), and a cache laid out as the worker lays it out, memory
 * before KV.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const PRODUCTION = { ...flags, environment: 'production', batchingEnabled: false, evaluatorAlgorithm: 'recursive' } as const;
const DAYS       = 30;

const computations = { ...evm.applyIndexBias('default', evm), ...comet, ...market };
const revivers     = [ BigFixnum.JsonReviver, BigNumber.JsonReviver ];

const snapshot = loadRegistrySnapshotFixture();
const catalog  = fixtureCatalog(snapshot);

const LATEST = { number: 30_000_000, timestamp: 1_790_000_000 };
const USDC   = '0xc3d688b66703497daa19211eedff47f25384cdc3';
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
]);

type Call = { id: number, method: string, params: any[] };

/*
 * The error the node answers a read with instead of its value, if any, by
 * the contract called, the function, its argument where it takes one, and
 * the block. Addresses are lowercase.
 */
type Fault = (read: { contract: string, name: string, argument: string | undefined, block: number }) => { code: number, message: string, data?: string } | undefined;

const REVERT = { code: 3, message: 'execution reverted', data: '0x' };

// the registry version's description of a Comet's market
const marketOf = (address: string) => catalog.markets().find(entry => entry.comet.address.toLowerCase() === address)!.comet.registry.market;

/*
 * A node at LATEST that answers what each Comet is made of as the fixture
 * describes it, and every other read with a value of its own, made of the
 * contract, the call and the block: a value answered for another read, or on
 * another day, changes what the history answers. It records every request it
 * receives: its network and its calls.
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
    const [ { to, data }, tag ] = params;
    const contract = to.toLowerCase();
    const fragment = COMET.getFunction(data.slice(0, 10)) as FunctionFragment;
    const argument: string | undefined = COMET.decodeFunctionData(fragment, data)[0]?.toString().toLowerCase();
    const error = fault({ contract, name: fragment.name, argument, block: Number.parseInt(tag, 16) });
    if (error !== undefined) {
      return { jsonrpc: '2.0', id, error };
    }
    const entry = markets.get(contract);
    const values = ((): unknown[] => {
      switch (fragment.name) {
        case 'numAssets':          return [ entry!.collateralAssets.length ];
        case 'getAssetInfo': {
          const asset = entry!.collateralAssets[Number(argument)]!;
          return [ [ asset.assetIndex, asset.token.address, asset.priceFeed.address, EthersBigNumber.from(10).pow(asset.token.decimals), 0, 0, 0, 0 ] ];
        }
        case 'baseTokenPriceFeed': return [ entry!.baseAsset.priceFeed.address ];
        case 'symbol':             return [ symbols.get(contract) ?? 'TKN' ];
        default: {
          let hash = 0;
          for (const character of `${contract}|${data}|${tag}`) {
            hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
          }
          return [ EthersBigNumber.from(10).pow(6).mul(1 + hash % 997) ];
        }
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
function serving(t: Test, node: Pick<ReturnType<typeof fakeNode>, 'fetch'>) {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = node.fetch as typeof globalThis.fetch;
  t.teardown(() => { globalThis.fetch = fetchBefore; });
}

function everyMarket(from: Catalog = catalog): MarketRouteData {
  return { apiHost: '', nodeHost: 'node.test', nodeKey: 'key', network: AllNetworks, contract: AllContracts, catalog: from, queryParams: new URLSearchParams() };
}

/*
 * What the router hands the history, in `environment`, over a KV of its own
 * that counts what it is asked. Every evaluation the handler starts is kept
 * in `evaluations`: a history that one market fails answers without waiting
 * for the others, and a test waits for them, so none of them asks a node
 * after it ends. `recursive` evaluates as the route did before it batched,
 * whatever flags the handler asks for.
 */
function contextOf({ environment = PRODUCTION.environment, recursive = false }: { environment?: Flags.FullFlags['environment'], recursive?: boolean } = {}) {
  const kv      = MemoryKv({});
  const asked   = { get: 0, put: 0 };
  const counted = new Proxy(kv, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'get' || property === 'put') {
        return (...parameters: unknown[]) => {
          asked[property]++;
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return value;
    },
  });
  const cache = Cache.Layers.of([ new Cache.Memory({}, revivers), new Cache.WorkersKv(counted, revivers) ]);
  const evaluations: Promise<unknown>[] = [];
  const context = {
    flags: { ...PRODUCTION, environment },
    instantiateEvaluator: (_: string, overrides: { flags?: Flags.SomeFlags } = {}) => {
      const evaluator = Evaluator.instantiate(computations as any, {
        cache,
        debug,
        flags: {
          ...PRODUCTION,
          environment,
          ...overrides.flags,
          ...(recursive ? { batchingEnabled: false, evaluatorAlgorithm: 'recursive' } as const : {}),
        },
      });
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
  // what the history left in KV, by key
  const stored = async () => {
    const { keys } = await kv.list();
    return Object.fromEntries(await Promise.all(keys.map(async ({ name }) => [ name, await kv.get(name) ] as const)));
  };
  return { context, asked, evaluations, stored };
}

// how the history of every market failed, once every evaluation it started has ended
async function failureOf(t: Test, node: Pick<ReturnType<typeof fakeNode>, 'fetch'>): Promise<unknown> {
  serving(t, node);
  // a failure needs no more than a day to show: the history of a local run
  const { context, evaluations } = contextOf({ environment: 'local' });
  const failure = await marketHandlers.historicalSummary(everyMarket(), context).then(
    () => null,
    (error: unknown) => error,
  );
  await Promise.allSettled(evaluations);
  return failure;
}

const networks = [ ...new Set(catalog.markets().map(entry => entry.network)) ];
const comets   = new Set(catalog.markets().map(entry => entry.comet.address.toLowerCase()));

t.test('a cold history of every market makes three node requests per market and one per network', async t => {
  const node = fakeNode();
  serving(t, node);
  const { context, asked } = contextOf();

  const response = await marketHandlers.historicalSummary(everyMarket(), context);
  t.equal(response.status, 200);
  const days = await response.json() as Array<{ status: string }>;
  t.equal(days.length, DAYS * catalog.markets().length, 'thirty days of every market');
  t.ok(days.every(day => day.status === 'success'), 'each of them read');

  for (const network of networks) {
    t.equal(node.requests.filter(request => request.network === network).length, 3 * catalog.marketsOn(network).length + 1,
      `${network}: its latest block, then three rounds of reads for each of its markets, whatever its days`);
  }
  const reads    = node.requests.filter(({ calls }) => calls.some(call => call.method === 'eth_call'));
  const cometsOf = (calls: Call[]) => new Set(calls
    .filter(call => call.method === 'eth_call' && comets.has(call.params[0].to.toLowerCase()))
    .map(call => call.params[0].to.toLowerCase()));
  t.strictSame(reads.map(({ calls }) => cometsOf(calls).size), reads.map(() => 1), 'each request reads the days of one market');
  t.strictSame(
    reads.map(({ calls }) => new Set(calls.map(({ method, params }) => JSON.stringify([ method, params ]))).size),
    reads.map(({ calls }) => calls.length),
    'and sends no call twice',
  );

  const kv = asked.get + asked.put;
  t.ok(node.requests.length + kv < 10_000,
    `${node.requests.length} node requests and ${kv} KV operations: inside the subrequests of an invocation`);
});

/*
 * Every round of a batching evaluation asks the node for every read it can,
 * where the recursive one asks for a read once the one before it is in.
 * Neither changes what a day reads, at which block, nor the keys it is kept
 * under, so a history answers as it did, and the days already cached answer
 * it. A version that remaps a feed reads the feed it remaps to, and the
 * Comet's own on a day the other reverts, in rounds of their own, and a feed
 * that reverts makes a day `partially` or `error`.
 */
t.test('the history answers every day as the recursive evaluator does, and keeps it under the same keys', async t => {
  const warn = console.warn;
  console.warn = () => {};
  t.teardown(() => { console.warn = warn; });

  const usdc  = marketOf(USDC);
  const feeds = {
    comp: usdc.collateralAssets.find(asset => asset.token.symbol === 'COMP')!.priceFeed.address,
    wbtc: usdc.collateralAssets.find(asset => asset.token.symbol === 'WBTC')!.priceFeed.address,
    aero: marketOf(AERO).baseAsset.priceFeed.address,
  };
  const REPLACEMENT = '0x00000000000000000000000000000000000000aa' as Address;
  const remapped: RegistrySnapshotV1 = {
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      priceExceptions: [ ...network.priceExceptions, {
        kind:                 'deprecated_price_remap',
        priceFeedAddress:     feeds.comp,
        replacementPriceFeed: { address: REPLACEMENT, decimals: 8 },
        provenance:           'a feed remapped for this test',
        expiresAt:            null,
      } ],
    }),
  };
  // the block before which each feed reverts: mainnet makes 7,200 blocks a day, and Base 43,200
  const revertsBefore = new Map<string, number>([
    [ REPLACEMENT, LATEST.number - 15 * 7_200 ],
    [ feeds.comp,  LATEST.number - 25 * 7_200 ],
    [ feeds.wbtc,  LATEST.number - 5 * 7_200 ],
    [ feeds.aero,  LATEST.number - 20 * 43_200 ],
  ]);
  const reverting: Fault = ({ name, argument, block }) => (
    name === 'getPrice' && block < (revertsBefore.get(argument!) ?? 0) ? REVERT : undefined
  );

  const historyOf = async (recursive: boolean) => {
    const node = fakeNode(reverting);
    serving(t, node);
    const { context, stored } = contextOf({ recursive });
    const response = await marketHandlers.historicalSummary(everyMarket(fixtureCatalog(remapped)), context);
    t.equal(response.status, 200, recursive ? 'the recursive evaluator answers' : 'the history answers');
    const body = await response.text();
    // KV is written as the evaluation goes, not waited for
    await new Promise(resolve => setImmediate(resolve));
    return { body, stored: await stored(), node };
  };
  const batched = await historyOf(false);
  const golden  = await historyOf(true);

  t.ok(golden.node.requests.every(({ calls }) => calls.length === 1), 'which asked the node one read at a time');
  t.equal(batched.body, golden.body, 'the same answer, byte for byte');
  t.strictSame(batched.stored, golden.stored, 'and the same days, kept under the same keys');
  t.ok(Object.keys(batched.stored).length > 0, 'which it keeps in KV');
  t.strictSame([ ...new Set((JSON.parse(batched.body) as Array<{ status: string }>).map(day => day.status)) ].sort(),
    [ 'error', 'partially', 'success' ], 'over days of every status');
});

/*
 * A history reads each market in a request of its own, which the node
 * provider proxy can fail alone: the history fails as a request the node did
 * not serve, which a route answers 503 with the seconds the proxy asked to
 * wait, as it does when the node answers one read of a market with an error.
 */
t.test('a market whose reads the node did not serve fails the history, as a request the node did not serve', async t => {
  const node = fakeNode();
  const failure = await failureOf(t, {
    fetch: async (input: string | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const calls   = [ await request.clone().json() as Call | Call[] ].flat();
      return calls.some(call => call.params[0]?.to?.toLowerCase() === WBTC)
        ? new Response('upstream error', { status: 503, headers: { 'Retry-After': '5' } })
        : node.fetch(request);
    },
  });
  t.ok(jsonRpc.isNotServed(failure), 'the request of one market failed');
  t.same([ (failure as jsonRpc.NotServed).status, (failure as jsonRpc.NotServed).retryAfter ], [ 503, 5 ],
    'with the status the proxy answered, and the seconds it asked to wait, for a route to pass on');
  t.ok(node.requests.some(({ calls }) => calls.some(call => call.method === 'eth_call')), 'while the other markets were read');

  const read = await failureOf(t, fakeNode(({ contract, name }) => (
    contract === WBTC && name === 'totalSupply' ? { code: -32000, message: 'header not found' } : undefined
  )));
  t.match((read as Error | null)?.message, /header not found/);
  t.ok(jsonRpc.isNotServed(read), 'and so did one read of it');
});

t.test('a read of one market that reverts fails the history, as a fault', async t => {
  const failure = await failureOf(t, fakeNode(({ contract, name }) => (
    contract === WBTC && name === 'totalSupply' ? REVERT : undefined
  )));
  t.match((failure as Error | null)?.message, /execution reverted/);
  t.notOk(jsonRpc.isNotServed(failure), 'not as a request the node did not serve: a route answers it 500');
});
