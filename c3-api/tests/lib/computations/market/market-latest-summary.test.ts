import t from 'tap';

import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import * as Eth      from '../../../../lib/eth-constants.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Compute    from '../../../../lib/symbolic/computation.js';
import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import type * as KnownNetwork from '../../../../lib/well-known/networks/network.js';

import * as comet  from '../../../../lib/computations/comet.js';
import * as market from '../../../../lib/computations/market.js';

import type { PriceRead } from '../../../../lib/computations/comet.js';
import type { CollateralDetail } from '../../../../lib/computations/market/collateral-details.js';

import type { PriceExceptionV1, RegistryComet } from '../../../../lib/model/comet-registry.js';
import { checksumAddress } from '../../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../../src/registry/catalog.js';

import { fixtureCatalog, loadRegistrySnapshotFixture } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * The summary of a market at the latest block, as the summary route answers
 * it: the computation runs on the real evaluator, over reads that answer
 * from a table instead of a node.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network = 'ethereum-mainnet' as const;
const block   = { number: 50_000_000, timestamp: 1_790_000_000 };

const marketOf = (deploymentKey: string, on: KnownNetwork.Name = network) => (
  fixtureCatalog().marketsOn(on).find(entry => entry.deploymentKey === deploymentKey)!.comet
);
const usdt = marketOf('usdt');
const weth = marketOf('weth');
const wbtc = marketOf('wbtc');
const aero = marketOf('aero', 'base-mainnet');

const COMP = '0xc00e94Cb662C3520282E6f5717214004A7f26888';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// a price as a feed of eight decimals answers it: 4217000000 is 42.17
const at8      = (value: number | string) => BigFixnum.from({ decimals: 8, value });
const read     = (price: BigFixnum) => ({ status: 'success' as const, price });
const reverted = (message = 'execution reverted') => ({ status: 'error' as const, message });

function stub(answer: (context: any) => unknown) {
  return Compute.Functor<any>({}).implement({ version: 0, compute: context => answer(context) });
}

// the summary route evaluates on the working set; the recursive evaluator must answer the same
const ALGORITHMS = [ 'recursive', 'workingset' ] as const;

function evaluator(computations: Record<string, unknown>, algorithm: typeof ALGORITHMS[number] = 'workingset') {
  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  return Evaluator.instantiate<any>(computations as any, { cache, debug, flags: { ...flags, evaluatorAlgorithm: algorithm, batchingEnabled: true } });
}

/*
 * The interest rate model of the market, each slot its own, so that one
 * reported in another's place shows. The Comet's read answers supply first.
 */
const RATES = {
  supply: { kink: '850000000000000000', base: '31709791',  slopeLow: '1141552511', slopeHigh: '101344495180' },
  borrow: { kink: '900000000000000000', base: '475646879', slopeLow: '880834601',  slopeHigh: '114155251141' },
};
const curveOf = (curve: typeof RATES['supply']) => Object.fromEntries(
  Object.entries(curve).map(([ slot, value ]) => [ slot, BigNumber.from(value) ]),
);

/*
 * What the summary of USDT's market reads but its collateral, as the Comet
 * and the feeds answer it: its base asset at 0.99890608 USD, through the
 * one feed that prices it both ways on a market quoted in USD.
 */
const READS = {
  basePrice:    read(at8(99_890_608)),
  baseUsdPrice: read(at8(99_890_608)),
  borrowApr:    BigFixnum.from({ decimals: 2, value: 5 }),
  supplyApr:    BigFixnum.from({ decimals: 2, value: 3 }),
  totalBorrow:  BigFixnum.from({ decimals: 6, value: 1_000_000_000 }),
  totalSupply:  BigFixnum.from({ decimals: 6, value: 2_000_000_000 }),
  utilization:  BigNumber.from('500000000000000000'),
  reserves:     BigNumber.from(-5) as BigNumber | null,
  rateModel:    { supply: curveOf(RATES.supply), borrow: curveOf(RATES.borrow) },
};

type Reads = { [Name in keyof typeof READS]?: unknown } & { contract?: RegistryComet, collaterals: CollateralDetail[] };

// the stubbed reads of the summary of one market: those `reads` names, and the rest as READS has them
function readsOf(reads: Reads) {
  const answers: Record<string, unknown> = { ...READS, ...reads };
  return Object.fromEntries(Object.keys(READS).map(name => [ name, stub(() => answers[name]) ]));
}

function contextOf(contract: RegistryComet) {
  return { apiHost: '', nodeHost: '', nodeKey: '', network: contract.network, contract, block };
}

function summaryOf(reads: Reads, algorithm: typeof ALGORITHMS[number] = 'workingset'): Promise<any> {
  const { evaluate, pull1 } = evaluator({
    marketLatestSummary: market.marketLatestSummary,
    ...readsOf(reads),
    collateralDetails:   stub(() => reads.collaterals),
  }, algorithm);
  return evaluate(pull1({ marketLatestSummary: contextOf(reads.contract ?? usdt) }));
}

/*
 * What the Comet keeps for a collateral beyond its asset, its feed and its
 * scale, as it answers it: its reserves, its supply cap, and its factors.
 */
type Kept = {
  reserves:                  string | null,
  supplyCap:                 string,
  borrowCollateralFactor:    string,
  liquidateCollateralFactor: string,
  liquidationFactor:         string,
};

// COMP and WETH of USDT's market, every number of each its own
const COMP_KEPT = {
  reserves:                  '1234567',
  supplyCap:                 '100000000000000000000000',
  borrowCollateralFactor:    '500000000000000000',
  liquidateCollateralFactor: '700000000000000000',
  liquidationFactor:         '750000000000000000',
};
const WETH_KEPT = {
  reserves:                  '7654321',
  supplyCap:                 '5265000000000000000000',
  borrowCollateralFactor:    '830000000000000000',
  liquidateCollateralFactor: '870000000000000000',
  liquidationFactor:         '950000000000000000',
};

// what the Comet keeps for the collateral at an index, where the numbers themselves do not matter
const keptAt = (assetNumber: number): Kept => ({
  reserves:                  String(assetNumber + 1),
  supplyCap:                 BigNumber.from(10).pow(21).mul(assetNumber + 1).toString(),
  borrowCollateralFactor:    BigNumber.from(10).pow(15).mul(700 + assetNumber).toString(),
  liquidateCollateralFactor: BigNumber.from(10).pow(15).mul(800 + assetNumber).toString(),
  liquidationFactor:         BigNumber.from(10).pow(15).mul(900 + assetNumber).toString(),
});

/*
 * A collateral of the summary's market as collateralDetails reports it:
 * `held` whole tokens of eighteen decimals — kept, as assetTotalCollateral
 * reads them, as the integer the Comet answered beside the asset's scale —
 * at `price`, with what the Comet keeps for it.
 */
function collateral(asset: string, symbol: string, held: number, price: PriceRead, kept: Kept): CollateralDetail {
  return {
    asset:           asset as Eth.Address,
    symbol,
    totalCollateral: BigFixnum.from({ multiplier: BigNumber.from(10).pow(18), value: BigNumber.from(10).pow(18).mul(held) }),
    price,
    parameters: {
      reserves:                  kept.reserves === null ? null : BigNumber.from(kept.reserves),
      supplyCap:                 BigNumber.from(kept.supplyCap),
      borrowCollateralFactor:    BigNumber.from(kept.borrowCollateralFactor),
      liquidateCollateralFactor: BigNumber.from(kept.liquidateCollateralFactor),
      liquidationFactor:         BigNumber.from(kept.liquidationFactor),
    },
  };
}

// USDT's market holds three COMP at 42.17 USD and two WETH at 2514.24289343 USD
const usdtComp = (price: PriceRead = read(at8(4_217_000_000)))   => collateral(COMP, 'COMP', 3, price, COMP_KEPT);
const usdtWeth = (price: PriceRead = read(at8(251_424_289_343))) => collateral(WETH, 'WETH', 2, price, WETH_KEPT);

// the USD price of each collateral of a summary, undefined where it has none
const priceUsdOf = (summary: any) => summary.collaterals.map((each: any) => 'priceUsd' in each ? each.priceUsd : undefined);

t.test('a market whose every price reads reports every field, in the order the API writes them', async t => {
  const summary = await summaryOf({ collaterals: [ usdtComp(), usdtWeth() ] });
  const expected = {
    chainId: 1,
    comet:   { address: usdt.address },
    status:  'success',
    borrowApr:              '0.05',
    supplyApr:              '0.03',
    totalBorrowValue:       '998.90608',
    totalSupplyValue:       '1997.81216',
    totalCollateralValue:   '5154.99578686',
    utilization:            '500000000000000000',
    baseUsdPrice:           '0.99890608',
    collateralAssetSymbols: [ 'COMP', 'WETH' ],
    reserves:               '-5',
    rateModel: {
      borrow: { kink: '900000000000000000', base: '475646879', slopeLow: '880834601',  slopeHigh: '114155251141' },
      supply: { kink: '850000000000000000', base: '31709791',  slopeLow: '1141552511', slopeHigh: '101344495180' },
    },
    collaterals: [
      { address: COMP, symbol: 'COMP', status: 'success', priceUsd: '42.17',         totalSupply: '3000000000000000000', ...COMP_KEPT },
      { address: WETH, symbol: 'WETH', status: 'success', priceUsd: '2514.24289343', totalSupply: '2000000000000000000', ...WETH_KEPT },
    ],
  };
  t.strictSame(summary, expected, 'each number as the Comet answered it, the reserves signed, and each price in USD');
  t.equal(JSON.stringify(summary), JSON.stringify(expected),
    'in the order the API writes them: the fields marketSummary reports, the reserves and the rate model, borrow before supply, after them');
});

t.test('a market reports what marketSummary reports of it, as it reports it', async t => {
  const answers = [
    { status: 'success', contract: usdt, collaterals: [ usdtComp(), usdtWeth() ] },
    {
      status:       'partially',
      contract:     weth,
      basePrice:    read(at8(100_000_000)),
      baseUsdPrice: read(at8(250_000_000_000)),
      collaterals:  [
        collateral(checksumAddress(weth.registry.market.collateralAssets[0]!.token.address), 'cbETH',  4, read(at8(105_000_000)), keptAt(0)),
        collateral(checksumAddress(weth.registry.market.collateralAssets[1]!.token.address), 'wstETH', 5, reverted(),             keptAt(1)),
      ],
    },
  ];
  for (const { status, ...reads } of answers) {
    const { evaluate, pull1, split } = evaluator({
      marketSummary:       market.marketSummary,
      marketLatestSummary: market.marketLatestSummary,
      ...readsOf(reads),
      collaterals:         stub(() => reads.collaterals),
      collateralDetails:   stub(() => reads.collaterals),
    });
    const context = contextOf(reads.contract);
    const [ before, latest ] = await evaluate(split([
      pull1({ marketSummary: context }),
      pull1({ marketLatestSummary: context }),
    ])) as [ any, any ];

    t.equal(before.status, status, `marketSummary reports the market as ${status}`);
    const { collaterals, ...fields } = before;
    t.strictSame(Object.keys(latest).filter(key => key in before), Object.keys(before),
      `${status}: every field marketSummary reports, in its order`);
    for (const [ key, value ] of Object.entries(fields)) {
      t.strictSame(latest[key], value, `${status}: ${key} as marketSummary reports it`);
    }
    t.equal(latest.collaterals.length, collaterals.length, `${status}: every collateral it reports`);
    collaterals.forEach((each: object, index: number) => t.match(latest.collaterals[index], each, `${status}: collateral ${index} as it reports it`));
  }
});

t.test('a collateral whose price reverts reports what the Comet keeps for it, and no USD price', async t => {
  const summary = await summaryOf({ collaterals: [ usdtComp(), usdtWeth(reverted()) ] });
  t.match(summary, { status: 'partially', totalCollateralValue: '126.51' }, 'the market is partial, and its value leaves the collateral out');
  t.notOk('message' in summary, 'the market itself carries no message');
  t.strictSame(summary.collaterals[1], {
    address: WETH,
    symbol:  'WETH',
    status:  'error',
    message: 'execution reverted',
    totalSupply: '2000000000000000000',
    ...WETH_KEPT,
  }, 'the collateral says why, and reports what the market holds of it and what the Comet keeps for it');
  t.strictSame(Object.keys(summary.collaterals[1]), [ 'address', 'symbol', 'status', 'message', 'totalSupply', ...Object.keys(WETH_KEPT) ],
    'its message where a price would be');
});

/*
 * On a market quoted in USD, the base price and the base asset's USD price
 * read the same feed, unless the Comet moved off the feed the version names
 * (drift.ts): either can fail alone. Each field needs only its own reads.
 */
t.test('a market quoted in USD whose base price reverts reports every field it can', async t => {
  const BASE = reverted('execution reverted: the feed the Comet names');
  const USD  = reverted('execution reverted: the feed the version names');
  const common = [ 'totalCollateralValue', 'utilization' ];
  const after  = [ 'collateralAssetSymbols', 'reserves', 'rateModel', 'collaterals' ];
  const cases = [
    { reads: { basePrice: BASE, baseUsdPrice: USD }, message: BASE.message, keys: [ ...common, ...after ], name: 'both revert' },
    { reads: { baseUsdPrice: USD },                  message: USD.message,  keys: [ 'totalBorrowValue', 'totalSupplyValue', ...common, ...after ], name: 'its USD price reverts' },
    { reads: { basePrice: BASE },                    message: BASE.message, keys: [ ...common, 'baseUsdPrice', ...after ], name: 'its base price reverts' },
  ];
  for (const { reads, message, keys, name } of cases) {
    const summary = await summaryOf({ basePrice: READS.basePrice, baseUsdPrice: READS.baseUsdPrice, ...reads, collaterals: [ usdtComp(), usdtWeth() ] });
    t.match(summary, { status: 'error', message }, `${name}: an error, with the message of ${message === BASE.message ? 'the base price' : 'the USD price'}`);
    t.strictSame(Object.keys(summary), [ 'chainId', 'comet', 'status', 'message', 'borrowApr', 'supplyApr', ...keys ], `${name}: every field it can report`);
    t.strictSame(priceUsdOf(summary), [ '42.17', '2514.24289343' ], `${name}: each collateral in USD, as its feeds answer`);
  }
  const totals = await summaryOf({ baseUsdPrice: USD, collaterals: [ usdtComp(), usdtWeth() ] });
  t.match(totals, { totalBorrowValue: '998.90608', totalSupplyValue: '1997.81216', totalCollateralValue: '5154.99578686' },
    'the totals at the base price that was read');
  const usd = await summaryOf({ basePrice: BASE, collaterals: [ usdtComp(), usdtWeth() ] });
  t.equal(usd.baseUsdPrice, '0.99890608', 'and the USD price that was read');
});

/*
 * On a market quoted in its base asset, the totals and the collateral are in
 * that asset, ETH for a WETH market, and only the base asset's USD price
 * turns them into USD. Without it nothing but a zero price is in USD.
 */
t.test('a market quoted in its base asset whose base prices revert reports every field it can', async t => {
  const BASE = reverted('execution reverted: WETH / ETH');
  const USD  = reverted('execution reverted: ETH / USD');
  const [ cbETH, wstETH, rETH ] = weth.registry.market.collateralAssets.map(asset => checksumAddress(asset.token.address));
  const collaterals = [
    collateral(cbETH!,  'cbETH',  4, read(at8(105_000_000)), keptAt(0)),
    collateral(wstETH!, 'wstETH', 5, read(at8(0)),           keptAt(1)),
    collateral(rETH!,   'rETH',   6, reverted(),             keptAt(2)),
  ];

  const unconverted = await summaryOf({ contract: weth, basePrice: read(at8(100_000_000)), baseUsdPrice: USD, collaterals });
  t.match(unconverted, {
    status:               'error',
    message:              USD.message,
    totalBorrowValue:     '1000.0',
    totalSupplyValue:     '2000.0',
    totalCollateralValue: '4.2',
  }, 'its USD price reverts: an error with its message, and the totals in ETH');
  t.notOk('baseUsdPrice' in unconverted, 'without the USD price that reverted');
  t.strictSame(priceUsdOf(unconverted), [ undefined, '0.0', undefined ], 'nothing in USD but the price of zero, which is zero in any unit');
  t.strictSame(unconverted.collaterals.map((each: any) => each.status), [ 'success', 'success', 'error' ], 'each collateral as its price read');

  const unpriced = await summaryOf({ contract: weth, basePrice: BASE, baseUsdPrice: USD, collaterals });
  t.match(unpriced, { status: 'error', message: BASE.message, totalCollateralValue: '4.2' }, 'both revert: the message of the base price');
  t.notOk('totalBorrowValue' in unpriced || 'totalSupplyValue' in unpriced || 'baseUsdPrice' in unpriced, 'and no totals of the base asset, nor its USD price');
  t.strictSame(priceUsdOf(unpriced), [ undefined, '0.0', undefined ], 'and again nothing in USD but zero');
});

t.test('a market quoted in its base asset converts the price of each collateral to USD', async t => {
  t.same([ weth.registry.market.collateralValueQuote, wbtc.registry.market.collateralValueQuote ], [ 'base', 'base' ]);

  const [ cbETH ] = weth.registry.market.collateralAssets.map(asset => checksumAddress(asset.token.address));
  const inEth = await summaryOf({
    contract:     weth,
    basePrice:    read(at8(100_000_000)),
    baseUsdPrice: read(at8(250_000_000_000)),
    collaterals:  [ collateral(cbETH!, 'cbETH', 4, read(at8(105_000_000)), keptAt(0)) ],
  });
  t.match(inEth, { status: 'success', baseUsdPrice: '2500.0' });
  t.strictSame(priceUsdOf(inEth), [ '2625.0' ], 'cbETH at 1.05 ETH, at 2500 USD per ETH');

  // the WBTC market's feeds answer in BTC, and its base asset's USD price is BTC / USD
  const [ LBTC, , USDC ] = wbtc.registry.market.collateralAssets.map(asset => checksumAddress(asset.token.address));
  const inBtc = await summaryOf({
    contract:     wbtc,
    basePrice:    read(at8(100_000_000)),
    baseUsdPrice: read(at8(8_610_669_000_000)),
    collaterals:  [
      collateral(LBTC!, 'LBTC', 1, read(at8(99_712_345)), keptAt(0)),
      collateral(USDC!, 'USDC', 1, read(at8(1_196)),      keptAt(2)),
    ],
  });
  t.match(inBtc, { status: 'success', baseUsdPrice: '86106.69' });
  t.strictSame(priceUsdOf(inBtc), [ '85858.9998008805', '1.0298360124' ],
    'LBTC at 0.99712345 BTC and USDC at 0.00001196 BTC, at 86106.69 USD per BTC, as precise as the Comet reads them');
});

t.test('AERO\'s market is quoted in USD, so its collateral is in USD as read', async t => {
  t.equal(aero.registry.market.collateralValueQuote, 'usd');
  const [ baseWeth ] = aero.registry.market.collateralAssets.map(asset => checksumAddress(asset.token.address));
  const summary = await summaryOf({
    contract:     aero,
    basePrice:    read(at8(89_531_391)),
    baseUsdPrice: read(at8(89_531_391)),
    collaterals:  [ collateral(baseWeth!, 'WETH', 1, read(at8(251_424_289_343)), keptAt(0)) ],
  });
  t.match(summary, { chainId: 8453, status: 'success', baseUsdPrice: '0.89531391' });
  t.strictSame(priceUsdOf(summary), [ '2514.24289343' ], 'WETH at the USD price its feed answers, neither multiplied nor divided by AERO\'s');
});

/*
 * The summary of a market through the real collateralDetails and assetPrice,
 * whose Comet reads `feeds` in place of those the version describes at their
 * indices, and whose every feed read answers 1.0.
 */
async function summaryAt(contract: RegistryComet, feeds: Record<number, string>, reads: Omit<Reads, 'collaterals'> = {}) {
  const asked: string[] = [];
  const { evaluate, pull1 } = evaluator({
    marketLatestSummary:  market.marketLatestSummary,
    collateralDetails:    market.collateralDetails,
    assetPrice:           comet.assetPrice,
    ...readsOf({ ...reads, collaterals: [] }),
    numAssets:            stub(() => contract.registry.market.collateralAssets.length),
    assetInfo:            stub(({ assetNumber }) => {
      const own = contract.registry.market.collateralAssets[assetNumber]!;
      const { reserves: _, ...kept } = keptAt(assetNumber);
      return {
        asset:     checksumAddress(own.token.address),
        priceFeed: checksumAddress(feeds[assetNumber] ?? own.priceFeed.address),
        scale:     BigNumber.from(10).pow(own.token.decimals),
        ...Object.fromEntries(Object.entries(kept).map(([ name, value ]) => [ name, BigNumber.from(value) ])),
      };
    }),
    assetTotalCollateral: stub(() => BigFixnum.from({ value: 1 })),
    collateralReserves:   stub(() => BigNumber.from(0)),
    getPrice:             stub(({ priceFeed }) => { asked.push(priceFeed.address.toLowerCase()); return read(at8(100_000_000)); }),
  });
  const summary = await evaluate(pull1({ marketLatestSummary: contextOf(contract) })) as any;
  const priceUsd = (symbol: string) => priceUsdOf(summary)[summary.collaterals.findIndex((each: any) => each.symbol === symbol)];
  return { summary, priceUsd, asked };
}

// a market of mainnet as described by a version that adds `exceptions` to the network's
function withExceptions(deploymentKey: string, exceptions: PriceExceptionV1[]): RegistryComet {
  const snapshot = loadRegistrySnapshotFixture();
  return catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : {
      ...entry,
      priceExceptions: [ ...entry.priceExceptions, ...exceptions ],
    }),
  }).marketsOn(network).find(entry => entry.deploymentKey === deploymentKey)!.comet;
}

/*
 * The price exceptions the registry seeded (bootstrap.ts) name the feeds
 * wUSDM and pumpBTC read before governance delisted them: wUSDM's at zero,
 * pumpBTC's at its last answer, 1.02447384 BTC. A collateral is priced with
 * the feed its Comet reads at the block summarized, through assetPrice, so
 * an exception gives its price in the unit of the market's feeds, and the
 * summary converts it as it converts any other.
 */
t.test('a price exception prices a collateral in USD as any other price', async t => {
  const WUSDM_FEED   = '0xe3a409ed15cd53afdefdd191ad945cec528a2496';
  const PUMPBTC_FEED = '0x351a133fd850ea81ed8a782016e308acbaddec91';
  const CONSTANT     = '0x7badab7109afbbf48ecd8d6498caacd2630b45b9';

  const indexOf = (contract: RegistryComet, symbol: string) => contract.registry.market.collateralAssets.find(asset => asset.token.symbol === symbol)!.assetIndex;

  const usdtBefore = await summaryAt(usdt, { [indexOf(usdt, 'wUSDM')]: WUSDM_FEED });
  t.equal(usdtBefore.priceUsd('wUSDM'), '0.0', 'wUSDM, on the feed priced at zero: zero');
  t.match(usdtBefore.summary.collaterals[indexOf(usdt, 'wUSDM')], { status: 'success' }, 'a price, not an error');
  t.notOk(usdtBefore.asked.includes(WUSDM_FEED), 'and the feed is not read');
  t.equal(usdtBefore.summary.status, 'success');

  const btcUsd = { baseUsdPrice: read(at8(8_610_669_000_000)) };
  const wbtcBefore = await summaryAt(wbtc, { [indexOf(wbtc, 'pumpBTC')]: PUMPBTC_FEED }, btcUsd);
  t.equal(wbtcBefore.priceUsd('pumpBTC'), '88214.0513539896', 'pumpBTC, on the feed priced at its last answer: 1.02447384 BTC, at 86106.69 USD per BTC');
  t.notOk(wbtcBefore.asked.includes(PUMPBTC_FEED), 'and the feed is not read');
  t.equal(wbtcBefore.summary.status, 'success');

  const zeroed = withExceptions('wbtc', [ {
    kind:             'zero_price',
    priceFeedAddress: CONSTANT,
    provenance:       'the constant feed delisted collateral was moved onto',
    expiresAt:        null,
  } ]);
  const wbtcZeroed = await summaryAt(zeroed, {}, { baseUsdPrice: reverted() });
  t.equal(wbtcZeroed.summary.status, 'error', 'a WBTC market whose BTC / USD reverts is an error');
  t.strictSame(wbtcZeroed.summary.collateralAssetSymbols, [ 'LBTC', 'pumpBTC', 'USDC', 'USDT' ]);
  t.strictSame(priceUsdOf(wbtcZeroed.summary), [ undefined, '0.0', undefined, undefined ],
    'and of its collateral, only pumpBTC, on the feed priced at zero, is in USD: zero');
  t.notOk(wbtcZeroed.asked.includes(CONSTANT), 'the feed priced at zero is not read');
});

t.test('a collateral at whose index the Comet holds another asset reports only why', async t => {
  const UNI     = checksumAddress(usdt.registry.market.collateralAssets[3]!.token.address);
  const message = 'asset 3 of the Comet is 0x1111111111111111111111111111111111111111, not the UNI the registry version describes';
  // as collateralDetails reports it: none of the stranger's numbers, and nothing held
  const stranger: CollateralDetail = {
    asset:           UNI,
    symbol:          'UNI',
    totalCollateral: BigFixnum.from({ value: 0 }),
    price:           reverted(message),
    parameters:      null,
  };
  const summary = await summaryOf({ collaterals: [ usdtComp(), stranger ] });
  t.equal(summary.status, 'partially', 'the market is partial');
  t.strictSame(summary.collaterals[1], { address: UNI, symbol: 'UNI', status: 'error', message },
    'the collateral the version describes there says why, and nothing of what the Comet keeps for the other asset');
  t.equal(summary.totalCollateralValue, '126.51', 'nor counts it');
});

/*
 * getReserves and getCollateralReserves read the token's balance, and a
 * revert there answers null (reserves.ts). The summary leaves out those
 * reserves, and only them: the status says what could be priced.
 */
t.test('reserves the Comet could not read are left out, and nothing else', async t => {
  for (const algorithm of ALGORITHMS) {
    const summary = await summaryOf({
      reserves:    null,
      collaterals: [ collateral(COMP, 'COMP', 3, read(at8(4_217_000_000)), { ...COMP_KEPT, reserves: null }), usdtWeth() ],
    }, algorithm);
    t.equal(summary.status, 'success', `${algorithm}: the market is a success`);
    t.strictSame(Object.keys(summary), [
      'chainId', 'comet', 'status', 'borrowApr', 'supplyApr', 'totalBorrowValue', 'totalSupplyValue', 'totalCollateralValue',
      'utilization', 'baseUsdPrice', 'collateralAssetSymbols', 'rateModel', 'collaterals',
    ], `${algorithm}: without its reserves`);
    const { reserves: _, ...kept } = COMP_KEPT;
    t.strictSame(summary.collaterals[0], {
      address: COMP, symbol: 'COMP', status: 'success', priceUsd: '42.17', totalSupply: '3000000000000000000', ...kept,
    }, `${algorithm}: a collateral whose reserves reverted reports the rest`);
    t.strictSame(summary.collaterals[1], {
      address: WETH, symbol: 'WETH', status: 'success', priceUsd: '2514.24289343', totalSupply: '2000000000000000000', ...WETH_KEPT,
    }, `${algorithm}: and the other its own`);
  }
});

/*
 * While a registry version no longer describes its market — the Comet listed
 * a collateral after the import, and holds another asset at an index the
 * version describes — the summary of the latest block lists the collateral
 * of the version, and the history that of the chain. The two differ on
 * purpose: the chain drift check raises it, and a new import ends it.
 */
t.test('while the version and the chain differ, the summary follows the version and the history the chain', async t => {
  const STRANGER  = '0x1111111111111111111111111111111111111111';
  const NEWCOMER  = '0x2222222222222222222222222222222222222222';
  const versioned = usdt.registry.market.collateralAssets;
  t.equal(versioned.length, 16, 'the version describes sixteen collaterals of USDT\'s market');

  // the asset the Comet holds at each of its seventeen indices, and what its token answers to symbol()
  const assetAt  = (assetNumber: number) => assetNumber === 3 ? STRANGER : assetNumber === 16 ? NEWCOMER : versioned[assetNumber]!.token.address;
  const symbolOf = (address: string) => (
    { [STRANGER]: 'STR', [NEWCOMER]: 'NEW' }[address.toLowerCase()] ?? versioned.find(asset => asset.token.address === address.toLowerCase())!.token.symbol
  );
  const { evaluate, pull1, split } = evaluator({
    marketSummary:        market.marketSummary,
    marketLatestSummary:  market.marketLatestSummary,
    collaterals:          market.collaterals,
    collateralDetails:    market.collateralDetails,
    ...readsOf({ collaterals: [] }),
    numAssets:            stub(() => 17),
    assetInfo:            stub(({ assetNumber }) => ({
      asset:                     checksumAddress(assetAt(assetNumber)),
      priceFeed:                 checksumAddress(`0x${'f'.repeat(38)}${assetNumber.toString(16).padStart(2, '0')}`),
      scale:                     BigNumber.from(10).pow(18),
      borrowCollateralFactor:    BigNumber.from(10).pow(17).mul(5),
      liquidateCollateralFactor: BigNumber.from(10).pow(17).mul(7),
      liquidationFactor:         BigNumber.from(10).pow(17).mul(9),
      supplyCap:                 BigNumber.from(10).pow(24),
    })),
    assetTotalCollateral: stub(({ assetNumber }) => BigFixnum.from({ value: assetNumber + 1 })),
    assetPrice:           stub(() => read(BigFixnum.from({ value: 2 }))),
    collateralReserves:   stub(() => BigNumber.from(0)),
    symbol:               stub(({ contract }) => symbolOf(contract.address)),
  });
  const context = contextOf(usdt);
  const [ history, latest ] = await evaluate(split([
    pull1({ marketSummary: context }),
    pull1({ marketLatestSummary: context }),
  ])) as [ any, any ];

  t.equal(latest.status, 'partially', 'the summary: partial');
  t.strictSame(latest.collateralAssetSymbols, versioned.map(asset => asset.token.symbol), 'with the sixteen collaterals of the version');
  t.strictSame(latest.collaterals.map((each: any) => each.status), versioned.map((_, assetNumber) => assetNumber === 3 ? 'error' : 'success'),
    'each priced but one');
  t.strictSame(latest.collaterals[3], {
    address: checksumAddress(versioned[3]!.token.address),
    symbol:  'UNI',
    status:  'error',
    message: `asset 3 of the Comet is ${STRANGER}, not the UNI the registry version describes`,
  }, 'the one at whose index the Comet holds another asset as an error');
  t.equal(latest.totalCollateralValue, String(2 * (136 - 4)), 'and the total leaves it and the seventeenth out: indices 1 to 16 but 4, at two each');

  const symbols = versioned.map(asset => asset.token.symbol);
  t.equal(history.status, 'success', 'the history: a success');
  t.strictSame(history.collateralAssetSymbols, [ ...symbols.slice(0, 3), 'STR', ...symbols.slice(4), 'NEW' ],
    'with the seventeen the chain lists, named by their tokens');
  t.strictSame(history.collaterals.map((each: any) => each.status), Array(17).fill('success'), 'each priced');
  t.equal(history.totalCollateralValue, String(2 * 153), 'and every one in the total: indices 1 to 17, at two each');
});

/*
 * A price is a decimal however the version states it. An operator can write
 * a fixed_price at no decimals, and where it is not converted — on a market
 * quoted in USD, or at zero on any market — it is written with a decimal
 * point all the same. Converted, it has the decimals of what converts it.
 */
t.test('a price the version states at no decimals is written with a decimal point', async t => {
  const fixed = (contract: RegistryComet, symbol: string, value: string): PriceExceptionV1 => ({
    kind:             'fixed_price',
    priceFeedAddress: contract.registry.market.collateralAssets.find(asset => asset.token.symbol === symbol)!.priceFeed.address,
    price:            { value, decimals: 0 },
    provenance:       'a price an operator stated at no decimals',
    expiresAt:        null,
  });

  const inUsd = await summaryAt(withExceptions('usdt', [ fixed(usdt, 'COMP', '42'), fixed(usdt, 'WETH', '0') ]), {});
  t.equal(inUsd.priceUsd('COMP'), '42.0', 'on a market quoted in USD, 42 as "42.0"');
  t.equal(inUsd.priceUsd('WETH'), '0.0', 'and zero as "0.0"');

  const inBtc     = withExceptions('wbtc', [ fixed(wbtc, 'LBTC', '0'), fixed(wbtc, 'USDC', '2') ]);
  const converted = await summaryAt(inBtc, {}, { baseUsdPrice: read(at8(8_610_669_000_000)) });
  t.equal(converted.priceUsd('LBTC'), '0.0', 'on a market quoted in its base asset, zero as "0.0"');
  t.equal(converted.priceUsd('USDC'), '172213.38', 'and 2 BTC at 86106.69 USD per BTC, converted as any other price');
  const unconverted = await summaryAt(inBtc, {}, { baseUsdPrice: reverted() });
  t.strictSame(priceUsdOf(unconverted.summary), [ '0.0', undefined, undefined, undefined ], 'zero as "0.0" even where nothing converts it');
});
