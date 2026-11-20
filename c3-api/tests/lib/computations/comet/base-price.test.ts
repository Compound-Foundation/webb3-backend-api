import t, { Test } from 'tap';

import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Index from '../../../../lib/symbolic/index.js';

import * as comet from '../../../../lib/computations/comet.js';

import type * as KnownNetwork from '../../../../lib/well-known/networks/network.js';
import type { RegistryComet } from '../../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../../src/registry/catalog.js';

import { consoleLines } from '../../../util/console.js';
import { evaluatorOver, memoryCache, stub } from '../../../util/evaluator.js';
import { COMET } from '../../../util/fake-node.js';
import { fixtureCatalog, loadRegistrySnapshotFixture } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * The price of a market's base asset, on both real evaluators: the working
 * set the routes that read many markets run, and the recursive one the
 * history runs. It is read from the base feed the registry version names,
 * and where that one reverts, from the feed the Comet names at the block.
 * The reads below it answer from a table instead of a node.
 *
 * A feed that reverts is logged once a minute per network and feed, in the
 * memory of the process (get-price.ts), so each test that looks for a line,
 * or for none, prices a market of its own, and each evaluator runs it a
 * minute after the one before it.
 */
const block = 21_000_000;

const catalog  = fixtureCatalog();
const marketOf = (network: KnownNetwork.Name, deploymentKey: string) => catalog.marketsOn(network).find(entry => entry.deploymentKey === deploymentKey)!.comet;

const read     = (price: BigFixnum) => ({ status: 'success' as const, price });
const reverted = (message = 'execution reverted') => ({ status: 'error' as const, message });
// a price as a feed of eight decimals answers it: 99990000 is 0.9999
const at8      = (value: number) => BigFixnum.from({ decimals: 8, value });
const priceOf  = (answer: any) => answer.status === 'success' ? answer.price.toString() : answer;

const frameOf = (contract: RegistryComet) => ({ apiHost: '', nodeHost: '', nodeKey: '', network: contract.network, contract, blockNumber: block });

const ALGORITHMS = [ 'recursive', 'workingset' ] as const;

// a test, on each evaluator in turn, in a subtest whose clock is a minute past the one before it
function onEachEvaluator(test: (t: Test, algorithm: typeof ALGORITHMS[number]) => Promise<void>) {
  return async (t: Test) => {
    for (const [ minutes, algorithm ] of ALGORITHMS.entries()) {
      await t.test(algorithm, async t => {
        const now = Date.now;
        t.capture(Date, 'now', () => now() + minutes * 60_000);
        await test(t, algorithm);
      });
    }
  };
}

/*
 * The node's answer to every call the Comet is made: its feed to
 * baseTokenPriceFeed(), as `named`, where it names one, and a revert to
 * every other call, a price read among them.
 */
function ethCallNaming(named: string | null) {
  const asked = COMET.encodeFunctionData('baseTokenPriceFeed');
  return stub(({ data }) => (
    data === asked && named !== null
      ? COMET.encodeFunctionResult('baseTokenPriceFeed', [ named ])
      : { reverted: { code: 3, message: 'execution reverted' } }
  ));
}

// one market of the fixture, in a version that states its base feed at `decimals`
function rescaled(chainId: number, deploymentKey: string, decimals: number): RegistryComet {
  const snapshot = loadRegistrySnapshotFixture();
  const changed  = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== chainId ? entry : {
      ...entry,
      markets: entry.markets.map(each => each.deploymentKey !== deploymentKey ? each : {
        ...each,
        baseAsset: { ...each.baseAsset, priceFeed: { ...each.baseAsset.priceFeed, decimals } },
      }),
    }),
  });
  return changed.markets().find(entry => entry.comet.registry.chainId === chainId && entry.deploymentKey === deploymentKey)!.comet;
}

t.test('a base feed that answers is the price, and the Comet is not asked for its own', onEachEvaluator(async (t, algorithm) => {
  const usdc  = marketOf('ethereum-mainnet', 'usdc');
  const reads: string[] = [];
  const asked: string[] = [];
  const { evaluate, pull1 } = evaluatorOver({
    basePrice:      comet.basePrice,
    getPrice:       stub(({ priceFeed }) => { reads.push(`${priceFeed.address}/${priceFeed.decimals}`); return read(at8(99_990_000)); }),
    cometBasePrice: stub(() => { asked.push('cometBasePrice'); return read(at8(1)); }),
  }, { algorithm });

  t.equal(priceOf(await evaluate(pull1({ basePrice: frameOf(usdc) }))), '0.9999', 'the price of the feed the version names');
  t.strictSame(reads, [ `${usdc.base.priceFeed.address}/8` ], 'read at the scale the version states for it');
  t.strictSame(asked, [], 'and the Comet is not asked');
}));

/*
 * The feed the Comet names is read at the scale the version states for it,
 * and one the version does not describe at eight decimals: Comet takes no
 * price feed of another scale. Here the version states its own base feed at
 * eighteen, so the two reads are told apart.
 */
t.test('where the base feed reverts, the price is read through the feed the Comet names, and nothing is logged', onEachEvaluator(async (t, algorithm) => {
  const logged = consoleLines(t, [ 'warn' ]);
  const aero   = rescaled(8453, 'aero', 18);
  const own    = aero.base.priceFeed.address;
  const OTHER  = '0x2222222222222222222222222222222222222222';
  const reads: string[] = [];
  const { evaluate, pull1 } = evaluatorOver({
    basePrice:      comet.basePrice,
    cometBasePrice: comet.cometBasePrice,
    ethCall:        ethCallNaming(OTHER),
    // the feed the version names reverts, and any other answers 1.23
    getPrice:       stub(({ priceFeed }) => {
      reads.push(`${priceFeed.address.toLowerCase()}/${priceFeed.decimals}`);
      return priceFeed.address === own ? reverted() : read(BigFixnum.from({ decimals: 2, value: 123 }));
    }),
  }, { algorithm });

  t.equal(priceOf(await evaluate(pull1({ basePrice: frameOf(aero) }))), '1.23', 'the price of the feed the Comet names');
  t.strictSame(reads, [ `${own.toLowerCase()}/18`, `${OTHER}/8` ],
    'after the feed the version names, at the scale it states, the one the Comet names, which the version does not describe, at eight decimals');
  t.strictSame(logged, [], 'and the feed that reverted is not logged, since another answered');
}));

/*
 * The Comet answers its feed as the ABI decodes an address, checksummed, as
 * the version's feeds are. Where it names the very feed that reverts, the
 * read is made under the same key as basePrice's own. Nothing the node is
 * sent shows the difference — a price read is the same call whatever case
 * its address is written in — so the keys a read is computed under do:
 * getPrice is indexed here, which it is not in a route, so each of them is
 * in the cache. The history's recursive evaluator keeps nothing a getPrice
 * computes, and would read it again.
 */
t.test('where the Comet names the very feed that reverts, it is the same read: its error, logged once', onEachEvaluator(async (t, algorithm) => {
  const logged = consoleLines(t, [ 'warn' ]);
  const usdc   = marketOf('ethereum-mainnet', 'usdc');
  const own    = usdc.base.priceFeed.address;
  const cache  = memoryCache();
  const { evaluate, pull1 } = evaluatorOver({
    basePrice:      comet.basePrice,
    cometBasePrice: comet.cometBasePrice,
    getPrice:       { ...comet.getPrice, index: Index.Everything },
    // the Comet names the feed of the version, written in lowercase, and every price read reverts
    ethCall:        ethCallNaming(own.toLowerCase()),
  }, { algorithm, cache });

  t.strictSame(await evaluate(pull1({ basePrice: frameOf(usdc) })), reverted(), 'the error of the feed that reverts');
  const keys = Object.keys(cache.store).filter(key => key.startsWith('getPrice'));
  t.ok(keys.length > 0, 'a price read is cached under its key');
  t.equal(keys.length, 1, 'and the feed the Comet names is that read, under that key');
  t.strictSame(logged, [ `price feed reverted: ${own} read by ${usdc.address} on ethereum-mainnet at block ${block}: execution reverted` ],
    'logged once, naming the feed the version names');
}));

t.test('where both feeds revert, the price is the error of the one the version names, which alone is logged', onEachEvaluator(async (t, algorithm) => {
  const logged = consoleLines(t, [ 'warn' ]);
  const weth   = marketOf('ethereum-mainnet', 'weth');
  const own    = weth.base.priceFeed.address;
  const { evaluate, pull1 } = evaluatorOver({
    basePrice:      comet.basePrice,
    getPrice:       stub(() => reverted('execution reverted: the feed the version names')),
    cometBasePrice: stub(() => reverted('execution reverted: the feed the Comet names')),
  }, { algorithm });

  t.strictSame(await evaluate(pull1({ basePrice: frameOf(weth) })), reverted('execution reverted: the feed the version names'),
    'the error of the feed the version names');
  t.strictSame(logged, [ `price feed reverted: ${own} read by ${weth.address} on ethereum-mainnet at block ${block}: execution reverted: the feed the version names` ],
    'logged once, naming it');
}));

/*
 * A Comet always answers baseTokenPriceFeed(). One that reverts it is
 * answered as a price that could not be read: the market keeps the answer
 * of the feed the version names, rather than failing the request.
 */
t.test('a Comet that reverts baseTokenPriceFeed() leaves the error of the feed the version names', onEachEvaluator(async (t, algorithm) => {
  const logged = consoleLines(t, [ 'warn' ]);
  const wbtc   = marketOf('ethereum-mainnet', 'wbtc');
  const { evaluate, pull1 } = evaluatorOver({
    basePrice:      comet.basePrice,
    cometBasePrice: comet.cometBasePrice,
    ethCall:        ethCallNaming(null),
    getPrice:       stub(() => reverted('execution reverted: the feed the version names')),
  }, { algorithm });

  t.strictSame(await evaluate(pull1({ basePrice: frameOf(wbtc) })), reverted('execution reverted: the feed the version names'),
    'the error of the feed the version names, as before the Comet was asked');
  t.equal(logged.length, 1, 'logged once');
  t.match(logged[0], `price feed reverted: ${wbtc.base.priceFeed.address} `, 'naming it');
}));

/*
 * A market quoted in USD prices its base asset in USD with its base price:
 * the same read of the feed the version names, and where it reverts, of the
 * feed the Comet names, which both prices answer with, or both fail with.
 * The working set makes each read once for both prices; the recursive
 * evaluator keeps nothing a read computes, and makes them for each.
 */
t.test('on a market quoted in USD, the base price and its USD price are the same read, and fall back together', onEachEvaluator(async (t, algorithm) => {
  consoleLines(t, [ 'warn' ]);
  const usdt  = marketOf('ethereum-mainnet', 'usdt');
  const own   = usdt.base.priceFeed.address;
  t.equal(usdt.registry.market.collateralValueQuote, 'usd');
  const once  = [ `${own} unreported`, 'the feed the Comet names' ];
  const made  = algorithm === 'workingset' ? once : [ ...once, ...once ];

  const pricesOf = async (fallback: unknown) => {
    const reads: string[] = [];
    const { evaluate, pull } = evaluatorOver({
      basePrice:      comet.basePrice,
      baseUsdPrice:   comet.baseUsdPrice,
      getPrice:       stub(({ priceFeed, unreported }) => { reads.push(`${priceFeed.address}${unreported ? ' unreported' : ''}`); return reverted(); }),
      cometBasePrice: stub(() => { reads.push('the feed the Comet names'); return fallback; }),
    }, { algorithm });
    const { basePrice, baseUsdPrice } = await evaluate(pull({ basePrice: frameOf(usdt), baseUsdPrice: frameOf(usdt) })) as any;
    return { basePrice: priceOf(basePrice), baseUsdPrice: priceOf(baseUsdPrice), reads };
  };

  t.strictSame(await pricesOf(read(at8(99_990_000))), {
    basePrice:    '0.9999',
    baseUsdPrice: '0.9999',
    reads:        made,
  }, 'both at the price of the feed the Comet names, read after the feed the version names');
  t.strictSame(await pricesOf(reverted('execution reverted: the feed the Comet names')), {
    basePrice:    reverted(),
    baseUsdPrice: reverted(),
    reads:        made,
  }, 'and both the error of the feed the version names where neither answers');
}));

/*
 * A market quoted in its base asset converts it to USD through the USD feed
 * the version names. Its Comet names no such feed, so there is nothing to
 * fall back on, and the read reports its own revert.
 */
t.test('on a market quoted in its base asset, the USD price is read from its USD feed alone', onEachEvaluator(async (t, algorithm) => {
  const wbtc  = marketOf('ethereum-mainnet', 'wbtc');
  const reads: string[] = [];
  const { evaluate, pull1 } = evaluatorOver({
    baseUsdPrice:   comet.baseUsdPrice,
    basePrice:      comet.basePrice,
    getPrice:       stub(({ priceFeed, unreported }) => { reads.push(`${priceFeed.address}${unreported ? ' unreported' : ''}`); return reverted('execution reverted: BTC / USD'); }),
    cometBasePrice: stub(() => { reads.push('the feed the Comet names'); return read(at8(1)); }),
  }, { algorithm });
  t.equal(wbtc.registry.market.collateralValueQuote, 'base');

  t.strictSame(await evaluate(pull1({ baseUsdPrice: frameOf(wbtc) })), reverted('execution reverted: BTC / USD'), 'the error of its USD feed');
  t.strictSame(reads, [ wbtc.base.usdPriceFeed!.address ], 'read from that feed alone, its revert reported by the read');
}));
