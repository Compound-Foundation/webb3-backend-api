import t from 'tap';

import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as comet  from '../../../../lib/computations/comet.js';
import * as market from '../../../../lib/computations/market.js';

import { collateralValue } from '../../../../lib/computations/market/collaterals.js';

import { checksumAddress } from '../../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../../src/registry/catalog.js';

import { evaluatorOver, stub } from '../../../util/evaluator.js';
import { fixtureCatalog, loadRegistrySnapshotFixture } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * What a market summary reports when the price feeds it reads revert: the
 * summary computations run on the real evaluator, over dependencies that
 * answer from a table instead of a node.
 */
const flags = Flags.parseWithDefaults(process.env);

const network = 'ethereum-mainnet' as const;
const usdt    = fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === 'usdt')!.comet;
const block   = { number: 50_000_000, timestamp: 1_790_000_000 };

const COMP  = '0xc00e94Cb662C3520282E6f5717214004A7f26888';
const WETH  = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const WUSDM = '0x57F5E098CaD7A3D1Eed53991D4d66C45C9AF7812';
// the retired wUSDM / USD feed the fixture's network prices at zero
const ZERO_PRICED_FEED = '0xe3a409ed15cd53afdefdd191ad945cec528a2496';

const one = (decimals = 8) => BigFixnum.from({ decimals, value: BigNumber.from(10).pow(decimals) });
const read     = (price: BigFixnum) => ({ status: 'success' as const, price });
const reverted = { status: 'error' as const, message: 'execution reverted' };

// on the algorithm the environment sets, unless a test names one
function evaluator(computations: Record<string, unknown>, algorithm: 'recursive' | 'workingset' = flags.evaluatorAlgorithm) {
  return evaluatorOver(computations, { algorithm });
}

// the market routes evaluate on the working set; tests that build a summary's collateral run on both
const ALGORITHMS = [ 'recursive', 'workingset' ] as const;

/*
 * A collateral of the summary's market: `totalCollateral` units held.
 */
const collateral = (asset: string, symbol: string, totalCollateral: number, price: unknown) => (
  { asset, symbol, totalCollateral: BigFixnum.from({ value: totalCollateral }), price }
);

function summaryOf(answers: { basePrice?: unknown, baseUsdPrice?: unknown, collaterals: unknown, contract?: typeof usdt }) {
  const { evaluate, pull1 } = evaluator({
    marketSummary: market.marketSummary,
    basePrice:     stub(() => answers.basePrice ?? read(one())),
    baseUsdPrice:  stub(() => answers.baseUsdPrice ?? read(one())),
    borrowApr:     stub(() => BigFixnum.from({ decimals: 2, value: 5 })),
    supplyApr:     stub(() => BigFixnum.from({ decimals: 2, value: 3 })),
    totalBorrow:   stub(() => BigFixnum.from({ value: 10 })),
    totalSupply:   stub(() => BigFixnum.from({ value: 20 })),
    collaterals:   stub(() => answers.collaterals),
    utilization:   stub(() => BigFixnum.from({ decimals: 2, value: 50 })),
  });
  return evaluate(pull1({ marketSummary: { apiHost: '', nodeHost: '', nodeKey: '', network, contract: answers.contract ?? usdt, block } }));
}

t.test('a market whose every price reads is a success', async t => {
  const summary = await summaryOf({
    collaterals: [ collateral(COMP, 'COMP', 3, read(one())), collateral(WUSDM, 'wUSDM', 4, read(one())) ],
  });
  t.match(summary, {
    chainId: 1,
    status:  'success',
    totalBorrowValue:       '10.0',
    totalCollateralValue:   '7.0',
    collateralAssetSymbols: [ 'COMP', 'wUSDM' ],
    collaterals: [
      { address: COMP,  symbol: 'COMP',  status: 'success' },
      { address: WUSDM, symbol: 'wUSDM', status: 'success' },
    ],
  });
  t.notOk('message' in (summary as any).collaterals[1], 'a collateral that reads carries no message');
});

t.test('a collateral that reverts makes the market partial', async t => {
  const summary = await summaryOf({
    collaterals: [ collateral(COMP, 'COMP', 3, read(one())), collateral(WUSDM, 'wUSDM', 4, reverted) ],
  });
  t.match(summary, {
    status: 'partially',
    totalBorrowValue:     '10.0',
    totalCollateralValue: '3.0',
    collaterals: [
      { address: COMP,  status: 'success' },
      { address: WUSDM, status: 'error', message: 'execution reverted' },
    ],
  }, 'the rest of the market is reported in full, and its value leaves the collateral out');
  t.notOk('message' in (summary as any), 'the market itself carries no message');
});

/*
 * The totals stay in the unit the market's own feeds answer in, as they
 * always were, and each is given in USD beside it: as it is for a market the
 * version quotes in USD, and through the base asset's USD price for one it
 * quotes in its base asset.
 */
t.test('a summary gives its totals in USD beside the quoted ones', async t => {
  const usdQuoted = await summaryOf({
    basePrice:    read(BigFixnum.from({ decimals: 2, value: 99 })),
    baseUsdPrice: read(BigFixnum.from({ decimals: 2, value: 99 })),
    collaterals:  [ collateral(COMP, 'COMP', 3, read(one())) ],
  });
  t.equal(usdt.registry.market.collateralValueQuote, 'usd');
  t.match(usdQuoted, {
    totalBorrowValue:     '9.9',  totalBorrowValueUsd:     '9.9',
    totalSupplyValue:     '19.8', totalSupplyValueUsd:     '19.8',
    totalCollateralValue: '3.0',  totalCollateralValueUsd: '3.0',
    baseUsdPrice:         '0.99',
  }, 'a market quoted in USD: the same totals, not converted a second time');

  const weth = fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === 'weth')!.comet;
  t.equal(weth.registry.market.collateralValueQuote, 'base');
  const baseQuoted = await summaryOf({
    contract:     weth,
    basePrice:    read(one()),
    baseUsdPrice: read(BigFixnum.from({ value: 2000 })),
    collaterals:  [
      collateral(COMP, 'cbETH', 3, read(BigFixnum.from({ decimals: 2, value: 105 }))),
      collateral(WUSDM, 'rETH', 4, reverted),
    ],
  });
  t.match(baseQuoted, {
    status:               'partially',
    totalBorrowValue:     '10.0',  totalBorrowValueUsd:     '20000.0',
    totalSupplyValue:     '20.0',  totalSupplyValueUsd:     '40000.0',
    totalCollateralValue: '3.15',  totalCollateralValueUsd: '6300.0',
  }, 'a market quoted in ETH: in ETH, and at 2000 USD per ETH, leaving out the collateral that could not be priced');
});

/*
 * The base asset's USD price is the conversion the USD totals are made with,
 * so it is read from the feed the version's quote calls for, at the scale
 * the version states, and never from whichever feed happens to be there. On
 * a market quoted in USD it is the base price, whose feed answers here, so
 * the Comet is not asked for its own.
 */
t.test('the base asset\'s USD price is read from the feed the quote calls for', async t => {
  const feeds: string[] = [];
  const { evaluate, pull1 } = evaluator({
    baseUsdPrice:   comet.baseUsdPrice,
    basePrice:      comet.basePrice,
    getPrice:       stub(({ priceFeed }) => { feeds.push(`${priceFeed.address.toLowerCase()}/${priceFeed.decimals}`); return read(one()); }),
    cometBasePrice: stub(() => { feeds.push('the Comet\'s feed'); return read(one()); }),
  });
  const priceOf = (contract: typeof usdt) => evaluate(pull1({
    baseUsdPrice: { apiHost: '', nodeHost: '', nodeKey: '', network, contract, blockNumber: block.number },
  }));
  const snapshot = loadRegistrySnapshotFixture();
  const marketOf = (key: string) => snapshot.networks.find(entry => entry.chainId === 1)!.markets.find(each => each.deploymentKey === key)!;
  const comets   = fixtureCatalog();
  const cometOf  = (key: string) => comets.marketsOn(network).find(entry => entry.deploymentKey === key)!.comet;

  await priceOf(cometOf('usdt'));
  await priceOf(cometOf('weth'));
  await priceOf(cometOf('wbtc'));
  t.strictSame(feeds, [
    `${marketOf('usdt').baseAsset.priceFeed.address}/8`,
    `${marketOf('weth').baseAsset.usdPriceFeed!.address}/8`,
    `${marketOf('wbtc').baseAsset.usdPriceFeed!.address}/8`,
  ], 'USDT through its own USD feed; WETH through ETH / USD and WBTC through BTC / USD, the units their own feeds answer in');

  const unconverted = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : {
      ...entry,
      markets: entry.markets.map(each => each.deploymentKey !== 'weth' ? each : { ...each, baseAsset: { ...each.baseAsset, usdPriceFeed: null } }),
    }),
  }).marketsOn(network).find(entry => entry.deploymentKey === 'weth')!.comet;
  await t.rejects(priceOf(unconverted), /quoted in its base asset without a USD feed/,
    'a market quoted in its base asset without one, which validation refuses, is not priced through its own feed instead');
});

/*
 * A market's base price is read from the feed the version names for its base
 * asset, at the scale the version states. The Comet is asked for its own feed
 * only where that one reverts, and here it answers, so the evaluator below
 * has nothing to answer such a call with. A market quoted in USD prices its
 * base asset in USD with that same read, which the summary route's evaluator
 * then makes once for both.
 */
t.test('the base price is read from the feed the version names', async t => {
  const reads: string[] = [];
  const { evaluate, pull1 } = evaluator({
    marketSummary: market.marketSummary,
    basePrice:     comet.basePrice,
    baseUsdPrice:  comet.baseUsdPrice,
    getPrice:      stub(({ priceFeed }) => { reads.push(`${priceFeed.address.toLowerCase()}/${priceFeed.decimals}`); return read(one()); }),
    borrowApr:     stub(() => BigFixnum.from({ decimals: 2, value: 5 })),
    supplyApr:     stub(() => BigFixnum.from({ decimals: 2, value: 3 })),
    totalBorrow:   stub(() => BigFixnum.from({ value: 10 })),
    totalSupply:   stub(() => BigFixnum.from({ value: 20 })),
    collaterals:   stub(() => []),
    utilization:   stub(() => BigFixnum.from({ decimals: 2, value: 50 })),
  }, 'workingset');
  const summaryAt = (contract: typeof usdt) => evaluate(pull1({
    marketSummary: { apiHost: '', nodeHost: '', nodeKey: '', network, contract, block },
  }));

  const snapshot = loadRegistrySnapshotFixture();
  const marketOf = (key: string) => snapshot.networks.find(entry => entry.chainId === 1)!.markets.find(each => each.deploymentKey === key)!;
  t.match(await summaryAt(usdt), { status: 'success' });
  t.strictSame(reads, [ `${marketOf('usdt').baseAsset.priceFeed.address}/8` ],
    'USDT: its base feed, read once for its base price and its USD price');

  reads.length = 0;
  const weth = fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === 'weth')!.comet;
  await summaryAt(weth);
  t.strictSame(reads.sort(), [ `${marketOf('weth').baseAsset.priceFeed.address}/8`, `${marketOf('weth').baseAsset.usdPriceFeed!.address}/8` ].sort(),
    'WETH: its own feed, which answers in ETH, and ETH / USD');

  const MOVED = '0x2222222222222222222222222222222222222222';
  const moved = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : {
      ...entry,
      markets: entry.markets.map(each => each.deploymentKey !== 'usdt' ? each : {
        ...each,
        baseAsset: { ...each.baseAsset, priceFeed: { address: MOVED as `0x${string}`, decimals: 18 } },
      }),
    }),
  }).marketsOn(network).find(entry => entry.deploymentKey === 'usdt')!.comet;
  reads.length = 0;
  await summaryAt(moved);
  t.strictSame(reads, [ `${MOVED}/18` ], 'a version that names another feed is priced through it, at the scale it states');
});

t.test('a base price that reverts makes the market an error', async t => {
  for (const answers of [ { basePrice: reverted }, { baseUsdPrice: reverted } ]) {
    const summary = await summaryOf({ ...answers, collaterals: [ collateral(COMP, 'COMP', 3, read(one())) ] });
    t.strictSame(summary, {
      chainId: 1,
      comet:   { address: usdt.address },
      status:  'error',
      message: 'execution reverted',
    }, 'nothing of the market can be valued, so only what identifies it is reported');
  }
});

/*
 * The collaterals of a Comet as the chain answers at a block: how many it had
 * listed, and the asset at each index — by default the one the version
 * describes there — with every read recorded. There is no symbol() among the
 * reads to stub, and no ethCall: a computation that read either would fail.
 */
function collateralsAt(
  contract: typeof usdt,
  chain: { numAssets: number, assetAt?: Record<number, string>, price?: (assetNumber: number) => unknown },
  algorithm: typeof ALGORITHMS[number] = 'workingset',
) {
  const reads: string[] = [];
  const counted = (name: string, answer: (context: any) => unknown) => stub(context => {
    reads.push(`${name}:${context.assetNumber}`);
    return answer(context);
  });
  const described = (assetNumber: number) => contract.registry.market.collateralAssets[assetNumber]?.token.address ?? `0x${'9'.repeat(40)}`;
  const { evaluate, pull1 } = evaluator({
    collaterals:          market.collaterals,
    numAssets:            stub(() => chain.numAssets),
    assetInfo:            counted('assetInfo', ({ assetNumber }) => ({ asset: checksumAddress(chain.assetAt?.[assetNumber] ?? described(assetNumber)) })),
    assetTotalCollateral: counted('assetTotalCollateral', ({ assetNumber }) => BigFixnum.from({ value: assetNumber + 1 })),
    assetPrice:           counted('assetPrice', ({ assetNumber }) => chain.price?.(assetNumber) ?? read(BigFixnum.from({ value: 2 }))),
  }, algorithm);
  const collaterals = evaluate(pull1({
    collaterals: { apiHost: '', nodeHost: '', nodeKey: '', network, contract, blockNumber: block.number },
  })) as Promise<Array<{ asset: string, symbol: string, totalCollateral: BigFixnum, price: any }>>;
  return { collaterals, reads };
}

t.test('every collateral is read once, in one pass', async t => {
  for (const algorithm of ALGORITHMS) {
    const { collaterals, reads } = collateralsAt(usdt, {
      numAssets: 2,
      price:     assetNumber => assetNumber === 0 ? read(BigFixnum.from({ value: 2 })) : reverted,
    }, algorithm);
    const read2 = await collaterals;

    t.match(read2, [
      { asset: COMP, symbol: 'COMP', price: { status: 'success' } },
      { asset: WETH, symbol: 'WETH', price: reverted },
    ]);
    t.equal(collateralValue(read2 as any).toString(), '2', 'one of the first at two, and none of the second');
    t.strictSame(reads.sort(), [
      'assetInfo:0', 'assetInfo:1',
      'assetPrice:0', 'assetPrice:1',
      'assetTotalCollateral:0', 'assetTotalCollateral:1',
    ].sort(), `${algorithm}: each read is made once, and no token is asked its symbol`);
  }
});

/*
 * What a collateral is, is the version's: its address, written as the API
 * writes addresses, and its symbol, which the import read once — as a string,
 * or as the bytes32 MKR answers with, which a summary reading symbol() itself
 * as a string could not decode, failing every market of its network.
 */
t.test('a collateral is named as the version names it, never by its token', async t => {
  const MKR = '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2';
  const snapshot = loadRegistrySnapshotFixture();
  const withMkr  = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : {
      ...entry,
      markets: entry.markets.map(each => each.deploymentKey !== 'usdt' ? each : {
        ...each,
        collateralAssets: each.collateralAssets.map(asset => asset.assetIndex !== 0 ? asset : {
          ...asset,
          token: { address: MKR as `0x${string}`, symbol: 'MKR', name: 'Maker', decimals: 18 },
        }),
      }),
    }),
  }).marketsOn(network).find(entry => entry.deploymentKey === 'usdt')!.comet;

  const { collaterals } = collateralsAt(withMkr, { numAssets: 16 });
  const named = await collaterals;
  t.match(named[0], { asset: checksumAddress(MKR), symbol: 'MKR', price: { status: 'success' } },
    'a token whose symbol() answers a bytes32 is named by the version');
  t.same(named.map(collateral => collateral.symbol), withMkr.registry.market.collateralAssets.map(asset => asset.token.symbol),
    'every collateral, in the order the Comet numbers them');
  t.same(named.map(collateral => collateral.asset), withMkr.registry.market.collateralAssets.map(asset => checksumAddress(asset.token.address)),
    'at the checksummed addresses the summary always answered with');
});

/*
 * At a past block a Comet may not have listed every collateral the version
 * describes yet, and at the latest one it may have listed one the version
 * does not describe yet. Neither is summarized: the first was not a
 * collateral then, and nothing says what the second is until a version does.
 */
t.test('a summary holds the collateral the version describes that the Comet had listed', async t => {
  const earlier = collateralsAt(usdt, { numAssets: 14 });
  t.same((await earlier.collaterals).map(collateral => collateral.symbol), usdt.registry.market.collateralAssets.slice(0, 14).map(asset => asset.token.symbol),
    'a block before the last two were listed summarizes the first fourteen');
  t.notOk(earlier.reads.includes('assetInfo:14'), 'and reads nothing of the others');

  const later = collateralsAt(usdt, { numAssets: 17 });
  t.equal((await later.collaterals).length, 16, 'a seventeenth the Comet listed after the import is left out');
  t.notOk(later.reads.some(entry => entry.endsWith(':16')), 'and never read');
});

/*
 * A Comet keeps an asset at its index, so a different asset there means the
 * version no longer describes the market (the chain drift check raises it).
 * What the Comet holds there is reported as the collateral that could not be
 * read, and is neither named after it nor counted in the total.
 */
t.test('an asset the Comet holds where the version describes another is reported, not valued', async t => {
  const STRANGER = '0x1111111111111111111111111111111111111111';
  const recursive = await collateralsAt(usdt, { numAssets: 16, assetAt: { 3: STRANGER } }, 'recursive').collaterals;
  const { collaterals, reads } = collateralsAt(usdt, { numAssets: 16, assetAt: { 3: STRANGER } });
  const all = await collaterals;
  t.same(all, recursive, 'the working set and the recursive evaluator agree');

  t.match(all[3], {
    asset:  checksumAddress(usdt.registry.market.collateralAssets[3]!.token.address),
    symbol: 'UNI',
    price:  { status: 'error', message: `asset 3 of the Comet is ${STRANGER}, not the UNI the registry version describes` },
  });
  t.notOk(reads.includes('assetTotalCollateral:3') || reads.includes('assetPrice:3'), 'what the stranger is worth is not read');
  t.equal(collateralValue(all as any).toString(), String(2 * (136 - 4)), 'and the total leaves it out: indices 1 to 16 but 4, at two each');

  const summary = await (async () => {
    const { evaluate, pull1 } = evaluator({
      marketSummary: market.marketSummary,
      basePrice:     stub(() => read(one())),
      baseUsdPrice:  stub(() => read(one())),
      borrowApr:     stub(() => BigFixnum.from({ decimals: 2, value: 5 })),
      supplyApr:     stub(() => BigFixnum.from({ decimals: 2, value: 3 })),
      totalBorrow:   stub(() => BigFixnum.from({ value: 10 })),
      totalSupply:   stub(() => BigFixnum.from({ value: 20 })),
      collaterals:   stub(() => all),
      utilization:   stub(() => BigFixnum.from({ decimals: 2, value: 50 })),
    });
    return evaluate(pull1({ marketSummary: { apiHost: '', nodeHost: '', nodeKey: '', network, contract: usdt, block } }));
  })();
  t.equal((summary as any).status, 'partially', 'the market is partial');
  t.match((summary as any).collaterals[3], { symbol: 'UNI', status: 'error' }, 'naming what could not be read');
});

t.test('a collateral the registry prices is never read', async t => {
  const reads: string[] = [];
  const { evaluate, pull1 } = evaluator({
    assetPrice: comet.assetPrice,
    assetInfo:  stub(({ assetNumber }) => ({ asset: COMP, scale: 1, priceFeed: assetNumber === 0 ? ZERO_PRICED_FEED : COMP })),
    getPrice:   stub(({ priceFeed }) => { reads.push(priceFeed.address); return reverted; }),
  });
  const context = { apiHost: '', nodeHost: '', nodeKey: '', network, contract: usdt, blockNumber: block.number };

  const priced = await evaluate(pull1({ assetPrice: { ...context, assetNumber: 0 } }));
  t.match(priced, { status: 'success' }, 'its exception answers for it');
  t.equal((priced as any).price.toString(), '0.0');

  t.strictSame(await evaluate(pull1({ assetPrice: { ...context, assetNumber: 1 } })), { ...reverted, exception: null },
    'any other feed is read, and its price names no exception');
  t.strictSame(reads, [ COMP ]);
});

/*
 * A price is read at the scale the version states for its feed. At a
 * historical block a Comet may report a feed its market has since moved off,
 * which the version does not describe: that one is read at eight decimals,
 * the only scale Comet takes a price feed at. A contract the registry did not
 * materialize has no version to state either, and the computation's type
 * refuses one (tests/lib/registry/consumers.test.ts).
 */
t.test('a price is read at the scale the version states for its feed', async t => {
  const snapshot = loadRegistrySnapshotFixture();
  const DESCRIBED = '0x69b50ff403e995d9c4441a303438d9049dac8ccd';
  const RETIRED   = '0x4444444444444444444444444444444444444444';
  const rescaled  = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : {
      ...entry,
      markets: entry.markets.map(market => market.deploymentKey !== 'usdt' ? market : {
        ...market,
        collateralAssets: market.collateralAssets.map(asset => asset.priceFeed.address !== DESCRIBED ? asset : {
          ...asset,
          priceFeed: { ...asset.priceFeed, decimals: 18 },
        }),
      }),
    }),
  }).marketsOn(network).find(entry => entry.deploymentKey === 'usdt')!.comet;

  const scales: Array<[ string, number ]> = [];
  const { evaluate, pull1 } = evaluator({
    assetPrice: comet.assetPrice,
    assetInfo:  stub(({ assetNumber }) => ({ asset: COMP, scale: 1, priceFeed: assetNumber === 0 ? DESCRIBED : RETIRED })),
    getPrice:   stub(({ priceFeed }) => { scales.push([ priceFeed.address, priceFeed.decimals ]); return read(one()); }),
  });
  const context = { apiHost: '', nodeHost: '', nodeKey: '', network, contract: rescaled, blockNumber: block.number };

  await evaluate(pull1({ assetPrice: { ...context, assetNumber: 0 } }));
  await evaluate(pull1({ assetPrice: { ...context, assetNumber: 1 } }));
  t.strictSame(scales, [ [ DESCRIBED, 18 ], [ RETIRED, 8 ] ],
    'a feed the version describes at its scale, and one it does not at eight decimals');
});

/*
 * The price exceptions the registry seeded (registry/seed/production.json)
 * name the feeds wUSDM and pumpBTC had before governance delisted them,
 * moving both onto a "Constant price feed" that answers 1 at 8 decimals.
 * A summary prices a collateral with the feed its Comet reads at the block
 * summarized, so a day before the move applies the exceptions — wUSDM at
 * zero, pumpBTC at its feed's last answer, 1.02447384 BTC — without reading
 * either feed; the latest block reads the constant feed, at 10^-8, like any
 * other, and applies nothing.
 */
t.test('the seeded exceptions price wUSDM and pumpBTC where their Comet still reads the feed they name', async t => {
  const CONSTANT     = '0x7badab7109afbbf48ecd8d6498caacd2630b45b9';
  const WUSDM_FEED   = '0xe3a409ed15cd53afdefdd191ad945cec528a2496';
  const PUMPBTC_FEED = '0x351a133fd850ea81ed8a782016e308acbaddec91';
  const wbtc = fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === 'wbtc')!.comet;
  const position = (contract: typeof usdt, symbol: string) => contract.registry.market.collateralAssets.find(asset => asset.token.symbol === symbol)!;
  t.same([ position(usdt, 'wUSDM').priceFeed.address, position(wbtc, 'pumpBTC').priceFeed.address ], [ CONSTANT, CONSTANT ],
    'the version describes both on the constant feed they read now');

  // what one market's collaterals are priced at, when the Comet reads `feeds` in place of the ones the version describes
  const pricedAt = async (contract: typeof usdt, feeds: Record<number, string>) => {
    const asked: string[] = [];
    const { evaluate, pull1 } = evaluator({
      collaterals:          market.collaterals,
      assetPrice:           comet.assetPrice,
      numAssets:            stub(() => contract.registry.market.collateralAssets.length),
      assetInfo:            stub(({ assetNumber }) => {
        const own = contract.registry.market.collateralAssets[assetNumber]!;
        return {
          asset:     checksumAddress(own.token.address),
          priceFeed: checksumAddress(feeds[assetNumber] ?? own.priceFeed.address),
          scale:     BigNumber.from(10).pow(own.token.decimals),
        };
      }),
      assetTotalCollateral: stub(() => BigFixnum.from({ value: 1 })),
      getPrice:             stub(({ priceFeed }) => {
        asked.push(priceFeed.address.toLowerCase());
        return priceFeed.address.toLowerCase() === CONSTANT ? read(BigFixnum.from({ value: 1, decimals: 8 })) : read(one());
      }),
    }, 'workingset');
    const collaterals = await evaluate(pull1({
      collaterals: { apiHost: '', nodeHost: '', nodeKey: '', network, contract, blockNumber: block.number },
    })) as Array<{ symbol: string, price: any }>;
    return { price: (symbol: string) => collaterals.find(entry => entry.symbol === symbol)!.price, asked };
  };

  const usdtBefore = await pricedAt(usdt, { [position(usdt, 'wUSDM').assetIndex]: WUSDM_FEED });
  t.match(usdtBefore.price('wUSDM'), { status: 'success' });
  t.equal(usdtBefore.price('wUSDM').price.toString(), '0.0', 'before the move: wUSDM at zero');
  t.notOk(usdtBefore.asked.includes(WUSDM_FEED), 'without reading the feed that reverts');

  const wbtcBefore = await pricedAt(wbtc, { [position(wbtc, 'pumpBTC').assetIndex]: PUMPBTC_FEED });
  t.equal(wbtcBefore.price('pumpBTC').price.toString(), '1.02447384', 'pumpBTC at the last answer of its exchange-rate feed');
  t.notOk(wbtcBefore.asked.includes(PUMPBTC_FEED), 'which is not read either');

  const usdtNow = await pricedAt(usdt, {});
  const wbtcNow = await pricedAt(wbtc, {});
  t.same([ usdtNow.price('wUSDM').price.toString(), wbtcNow.price('pumpBTC').price.toString() ], [ '0.00000001', '0.00000001' ],
    'at the latest block both are read through the constant feed, at 10^-8');
  t.ok(usdtNow.asked.includes(CONSTANT) && wbtcNow.asked.includes(CONSTANT), 'which is read like any other feed');
});

/*
 * A summary that could not read a price is cached like any other, since the
 * revert is a fact about that block. What makes it read again is the price
 * exception an operator adds: it changes the key every summary of the network
 * is cached under.
 */
t.test('a price exception retires the summaries cached before it', async t => {
  const snapshot = loadRegistrySnapshotFixture();
  const excepted = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : {
      ...entry,
      priceExceptions: [ ...entry.priceExceptions, {
        kind:             'zero_price',
        priceFeedAddress: '0x4444444444444444444444444444444444444444',
        provenance:       'a feed that reverts',
        expiresAt:        null,
      } ],
    }),
  }).marketsOn(network).find(entry => entry.deploymentKey === 'usdt')!.comet;

  const keyOf = (contract: typeof usdt) => market.marketSummary.key(
    'marketSummary',
    { apiHost: '', nodeHost: '', nodeKey: '', network, contract, block },
  );
  t.not(await keyOf(excepted), await keyOf(usdt));
});
