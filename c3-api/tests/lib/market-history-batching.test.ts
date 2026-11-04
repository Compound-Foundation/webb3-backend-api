import t from 'tap';

import * as Debug    from '../../lib/debug-log.js';
import * as Flags    from '../../lib/flags.js';
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
  type Context,
  type MarketRouteData,
} from '../../src/router.js';

import { consoleLines } from '../util/console.js';
import { type Call, type Read, fakeNode, serve } from '../util/fake-node.js';
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
 * working set, and the evaluator the router makes over them, which does both
 * (ROUTE_EVALUATOR_FLAGS), over the computations with the index bias
 * production has (entrypoint.ts) and a cache laid out as the worker lays it
 * out, memory before KV.
 *
 * How a read the node failed fails the history is tested with the summary's
 * (market-summary-batching.test.ts).
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
const AERO   = '0x784efeb622244d2348d4f2522f8860b96fbece89';

// the registry version's description of a Comet's market
const marketOf = (address: string) => catalog.markets().find(entry => entry.comet.address.toLowerCase() === address)!.comet.registry.market;

// the reads the fake node answers as the fixture describes each Comet (fake-node.ts)
const DESCRIBED = new Set([ 'numAssets', 'getAssetInfo', 'baseTokenPriceFeed', 'symbol' ]);

/*
 * The node of the fixture at LATEST, which answers what each Comet is made
 * of as the fixture describes it, and every other read with a value of its
 * own, made of the contract, the call and the block: a value answered for
 * another read, or on another day, changes what the history answers. A read
 * `reverts` names reverts instead.
 */
function nodeOf(reverts: (read: Read) => boolean = () => false) {
  return fakeNode(snapshot, LATEST, {
    answer: read => {
      if (reverts(read)) {
        return 'revert';
      }
      if (DESCRIBED.has(read.name)) {
        return undefined;
      }
      let hash = 0;
      for (const character of `${read.comet}|${read.name}|${read.argument}|${read.block}`) {
        hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
      }
      return [ 1_000_000 * (1 + hash % 997) ];
    },
  });
}

function everyMarket(from: Catalog = catalog): MarketRouteData {
  return { apiHost: '', nodeHost: 'node.test', nodeKey: 'key', network: AllNetworks, contract: AllContracts, catalog: from, queryParams: new URLSearchParams() };
}

/*
 * What the router hands the history in production: the evaluator it makes
 * for a market route, over a KV of its own that counts what it is asked.
 * `recursive` evaluates as the route did before it batched, whatever flags
 * the router sets.
 */
function contextOf({ recursive = false }: { recursive?: boolean } = {}) {
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
  const cache     = Cache.Layers.of([ new Cache.Memory({}, revivers), new Cache.WorkersKv(counted, revivers) ]);
  const evaluator = Evaluator.instantiate(computations as any, {
    cache,
    debug,
    flags: {
      ...PRODUCTION,
      ...Flags.ROUTE_EVALUATOR_FLAGS,
      ...(recursive ? { batchingEnabled: false, evaluatorAlgorithm: 'recursive' } as const : {}),
    },
  });
  const context = { flags: PRODUCTION, evaluator } as unknown as Context;
  // what the history left in KV, by key
  const stored = async () => {
    const { keys } = await kv.list();
    return Object.fromEntries(await Promise.all(keys.map(async ({ name }) => [ name, await kv.get(name) ] as const)));
  };
  return { context, asked, stored };
}

const networks = [ ...new Set(catalog.markets().map(entry => entry.network)) ];
const comets   = new Set(catalog.markets().map(entry => entry.comet.address.toLowerCase()));

t.test('a cold history of every market makes three node requests per market and one per network', async t => {
  const node = nodeOf();
  serve(t, node);
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
  consoleLines(t, [ 'warn' ]);

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
  const reverting = ({ name, argument, block }: Read) => name === 'getPrice' && block < (revertsBefore.get(argument!) ?? 0);

  const historyOf = async (recursive: boolean) => {
    const node = nodeOf(reverting);
    serve(t, node);
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
