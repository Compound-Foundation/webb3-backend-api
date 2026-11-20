import t from 'tap';

import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as comet  from '../../../../lib/computations/comet.js';
import * as market from '../../../../lib/computations/market.js';

import { collateralValue } from '../../../../lib/computations/market/collaterals.js';

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

/*
 * A collateral of the summary's market: `totalCollateral` units held.
 */
const collateral = (asset: string, symbol: string, totalCollateral: number, price: unknown) => (
  { asset, symbol, totalCollateral: BigFixnum.from({ value: totalCollateral }), price }
);

function summaryOf(answers: { basePrice?: unknown, baseUsdPrice?: unknown, collaterals: unknown }) {
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
  return evaluate(pull1({ marketSummary: { apiHost: '', nodeHost: '', nodeKey: '', network, contract: usdt, block } }));
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
 * The base asset's USD price is in USD whatever unit the market quotes in,
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

t.test('every collateral is read once, in one pass', async t => {
  const reads: string[] = [];
  const counted = (name: string, answer: (context: any) => unknown) => stub(context => {
    reads.push(`${name}:${context.assetNumber ?? context.contract.address}`);
    return answer(context);
  });
  const { evaluate, pull1 } = evaluator({
    collaterals:          market.collaterals,
    numAssets:            stub(() => 2),
    assetInfo:            counted('assetInfo', ({ assetNumber }) => ({ asset: assetNumber === 0 ? COMP : WUSDM })),
    assetTotalCollateral: counted('assetTotalCollateral', ({ assetNumber }) => BigFixnum.from({ value: assetNumber === 0 ? 3 : 1_000 })),
    assetPrice:           counted('assetPrice', ({ assetNumber }) => assetNumber === 0 ? read(BigFixnum.from({ value: 2 })) : reverted),
    symbol:               counted('symbol', ({ contract }) => contract.address === COMP ? 'COMP' : 'wUSDM'),
  });
  const collaterals = await evaluate(pull1({
    collaterals: { apiHost: '', nodeHost: '', nodeKey: '', network, contract: usdt, blockNumber: block.number },
  }));

  t.match(collaterals, [
    { asset: COMP,  symbol: 'COMP',  price: { status: 'success' } },
    { asset: WUSDM, symbol: 'wUSDM', price: reverted },
  ]);
  t.equal(collateralValue(collaterals as any).toString(), '6', 'three of the first at two, and none of the second');
  t.strictSame(reads.sort(), [
    'assetInfo:0', 'assetInfo:1',
    'assetPrice:0', 'assetPrice:1',
    'assetTotalCollateral:0', 'assetTotalCollateral:1',
    `symbol:${COMP}`, `symbol:${WUSDM}`,
  ].sort(), 'and each read is made once');
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

  t.strictSame(await evaluate(pull1({ assetPrice: { ...context, assetNumber: 1 } })), reverted, 'any other feed is read');
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
