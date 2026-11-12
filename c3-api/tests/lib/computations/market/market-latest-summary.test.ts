import t, { Test } from 'tap';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Fallible from '../../../../lib/fallible/fallible.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as comet  from '../../../../lib/computations/comet.js';
import * as market from '../../../../lib/computations/market.js';

import type { PriceRead } from '../../../../lib/computations/comet.js';
import type { AssetPriceRead } from '../../../../lib/computations/comet/asset-price.js';
import type { Collateral } from '../../../../lib/computations/market/collaterals.js';
import type { CollateralValue } from '../../../../lib/computations/market/market-latest-summary.js';

import type { Address, PriceExceptionV1, RegistryComet } from '../../../../lib/model/comet-registry.js';
import { checksumAddress } from '../../../../lib/model/comet-registry.js';
import { catalogOf } from '../../../../src/registry/catalog.js';

import { consoleLines } from '../../../util/console.js';
import { evaluatorOver, memoryCache, stub } from '../../../util/evaluator.js';
import { fixtureCatalog, loadRegistrySnapshotFixture } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * The summary of a market at the latest block, as the summary route answers
 * it: the computation runs on the real evaluator, over reads that answer
 * from a table instead of a node.
 */
const network = 'ethereum-mainnet' as const;
const block   = { number: 50_000_000, timestamp: 1_790_000_000 };
// the header of that block as the node gives it, its timestamp its own
const HEADER  = { number: block.number, timestamp: block.timestamp - 7 };

const marketOf = (deploymentKey: string) => fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === deploymentKey)!.comet;
const usdt = marketOf('usdt');
const weth = marketOf('weth');

const COMP = '0xc00e94Cb662C3520282E6f5717214004A7f26888';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// a price as a feed of eight decimals answers it: 4217000000 is 42.17
const at8      = (value: number | string) => BigFixnum.from({ decimals: 8, value });
const read     = (price: BigFixnum) => ({ status: 'success' as const, price });
const reverted = (message = 'execution reverted') => ({ status: 'error' as const, message });

/*
 * What the summary of USDT's market reads but its collateral, as the Comet
 * and the feeds answer it: its base asset at 0.99890608 USD, through the
 * one feed that prices it both ways on a market quoted in USD.
 */
const READS = {
  basePrice:         read(at8(99_890_608)),
  baseUsdPrice:      read(at8(99_890_608)),
  borrowApr:         BigFixnum.from({ decimals: 2, value: 5 }),
  supplyApr:         BigFixnum.from({ decimals: 2, value: 3 }),
  totalBorrow:       BigFixnum.from({ decimals: 6, value: 1_000_000_000 }),
  totalSupply:       BigFixnum.from({ decimals: 6, value: 2_000_000_000 }),
  utilization:       BigNumber.from('500000000000000000'),
  ethGetBlockHeader: HEADER as typeof HEADER | null,
};

type Reads = { [Name in keyof typeof READS]?: unknown } & { contract?: RegistryComet, collaterals: Collateral[] };

// the stubbed reads of the summary of one market: those `reads` names, and the rest as READS has them
function readsOf(reads: Reads) {
  const answers: Record<string, unknown> = { ...READS, ...reads };
  return Object.fromEntries(Object.keys(READS).map(name => [ name, stub(() => answers[name]) ]));
}

function contextOf(contract: RegistryComet) {
  return { apiHost: '', nodeHost: '', nodeKey: '', network: contract.network, contract, block };
}

function summaryOf(reads: Reads): Promise<any> {
  const { evaluate, pull1 } = evaluatorOver({
    marketLatestSummary: market.marketLatestSummary,
    ...readsOf(reads),
    collaterals:         stub(() => reads.collaterals),
  });
  return evaluate(pull1({ marketLatestSummary: contextOf(reads.contract ?? usdt) }));
}

/*
 * A collateral of the summary's market as collaterals reports it: `held`
 * whole tokens of eighteen decimals at `price`, priced by `exception`, if any.
 */
function collateral(asset: string, symbol: string, held: number, price: PriceRead, exception: PriceExceptionV1 | null = null): Collateral {
  return {
    asset:           asset as Eth.Address,
    symbol,
    totalCollateral: BigFixnum.from({ multiplier: BigNumber.from(10).pow(18), value: BigNumber.from(10).pow(18).mul(held) }),
    price:           price.status === 'success' ? { ...price, exception } : { ...price, exception: null },
  };
}

// each collateral of a summary by its symbol: its value in USD, written as the computation writes a total, and the exception that priced it
const valuesOf = (summary: any) => Object.fromEntries(summary.collaterals.map(({ symbol, valueUsd, exception }: any) => (
  [ symbol, [ valueUsd === null ? null : valueUsd.toString(), exception ] ]
)));

// a summary without what only the latest summary reports: each collateral's value and exception, and the block it was read at
const asMarketSummary = ({ marketBlock: _block, collaterals, ...summary }: any) => ({
  ...summary,
  collaterals: collaterals.map(({ valueUsd: _value, exception: _exception, ...collateral }: any) => collateral),
});

// USDT's market holds three COMP at 42.17 USD and two WETH at 2514.24289343 USD
const usdtComp = (price: PriceRead = read(at8(4_217_000_000)))   => collateral(COMP, 'COMP', 3, price);
const usdtWeth = (price: PriceRead = read(at8(251_424_289_343))) => collateral(WETH, 'WETH', 2, price);

t.test('a market whose every price reads reports every field, in the order the API writes them', async t => {
  const summary = await summaryOf({ collaterals: [ usdtComp(), usdtWeth() ] });
  const expected = {
    chainId: 1,
    comet:   { address: usdt.address },
    status:  'success',
    borrowApr:               '0.05',
    supplyApr:               '0.03',
    totalBorrowValue:        '998.90608',
    totalSupplyValue:        '1997.81216',
    totalCollateralValue:    '5154.99578686',
    // USDT's market is quoted in USD, so its totals in USD are the quoted ones
    totalBorrowValueUsd:     '998.90608',
    totalSupplyValueUsd:     '1997.81216',
    totalCollateralValueUsd: '5154.99578686',
    utilization:             '500000000000000000',
    baseUsdPrice:            '0.99890608',
    basePrice:               '0.99890608',
    collateralAssetSymbols:  [ 'COMP', 'WETH' ],
    collaterals: [
      { address: COMP, symbol: 'COMP', status: 'success', valueUsd: '126.51', exception: null },
      { address: WETH, symbol: 'WETH', status: 'success', valueUsd: '5028.48578686', exception: null },
    ],
    marketBlock: HEADER,
  };
  const written = { ...summary, collaterals: summary.collaterals.map((each: any) => ({ ...each, valueUsd: each.valueUsd.toString() })) };
  t.strictSame(written, expected, 'each total at the base price, each collateral with its status and its value, and the block the market was read at');
  t.equal(JSON.stringify(written), JSON.stringify(expected), 'in the order the API writes them');
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
        collateral(checksumAddress(weth.registry.market.collateralAssets[0]!.token.address), 'cbETH',  4, read(at8(105_000_000))),
        collateral(checksumAddress(weth.registry.market.collateralAssets[1]!.token.address), 'wstETH', 5, reverted()),
      ],
    },
  ];
  for (const { status, ...reads } of answers) {
    const { evaluate, pull1, split } = evaluatorOver({
      marketSummary:       market.marketSummary,
      marketLatestSummary: market.marketLatestSummary,
      ...readsOf(reads),
      collaterals:         stub(() => reads.collaterals),
    });
    const context = contextOf(reads.contract);
    const [ before, { basePrice, ...latest } ] = await evaluate(split([
      pull1({ marketSummary: context }),
      pull1({ marketLatestSummary: context }),
    ])) as [ any, any ];
    // which marketSummary keeps to itself
    t.equal(basePrice, (reads.basePrice ?? READS.basePrice).price.toString(), `${status}: the base price its totals are valued at`);

    t.equal(before.status, status, `marketSummary reports the market as ${status}`);
    t.strictSame(asMarketSummary(latest), before, `${status}: every field as marketSummary reports it`);
    t.equal(JSON.stringify(asMarketSummary(latest)), JSON.stringify(before), `${status}: in its order`);
  }
});

/*
 * On a market quoted in USD, the base price and the base asset's USD price
 * are one read, with one fallback: of the base feed the version names, or,
 * where that reverts, of the feed the Comet names. They fail together, where
 * neither answers (base-price.test.ts). Where one fails alone below, it shows
 * only that each field needs its own reads: a total in USD is the total
 * itself there, and needs what the total needs.
 */
t.test('a market quoted in USD whose base price reverts reports every field it can', async t => {
  const BASE = reverted('execution reverted: read as the base price');
  const USD  = reverted('execution reverted: read as the USD price');
  // the fields up to the utilization, without the totals of the base price and with them
  const unpriced = [ 'totalCollateralValue', 'totalCollateralValueUsd', 'utilization' ];
  const priced   = [ 'totalBorrowValue', 'totalSupplyValue', 'totalCollateralValue', 'totalBorrowValueUsd', 'totalSupplyValueUsd', 'totalCollateralValueUsd', 'utilization' ];
  const after    = [ 'collateralAssetSymbols', 'collaterals', 'marketBlock' ];
  const cases = [
    { reads: { basePrice: BASE, baseUsdPrice: USD }, message: BASE.message, keys: [ ...unpriced, ...after ], name: 'both revert' },
    { reads: { baseUsdPrice: USD },                  message: USD.message,  keys: [ ...priced, 'basePrice', ...after ], name: 'its USD price reverts' },
    { reads: { basePrice: BASE },                    message: BASE.message, keys: [ ...unpriced, 'baseUsdPrice', ...after ], name: 'its base price reverts' },
  ];
  for (const { reads, message, keys, name } of cases) {
    const summary = await summaryOf({ basePrice: READS.basePrice, baseUsdPrice: READS.baseUsdPrice, ...reads, collaterals: [ usdtComp(), usdtWeth() ] });
    t.match(summary, { status: 'error', message }, `${name}: an error, with the message of ${message === BASE.message ? 'the base price' : 'the USD price'}`);
    t.strictSame(Object.keys(summary), [ 'chainId', 'comet', 'status', 'message', 'borrowApr', 'supplyApr', ...keys ], `${name}: every field it can report`);
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
 * turns them into USD.
 */
t.test('a market quoted in its base asset whose base prices revert reports every field it can', async t => {
  const BASE = reverted('execution reverted: WETH / ETH');
  const USD  = reverted('execution reverted: ETH / USD');
  const [ cbETH, wstETH, rETH ] = weth.registry.market.collateralAssets.map(asset => checksumAddress(asset.token.address));
  const collaterals = [
    collateral(cbETH!,  'cbETH',  4, read(at8(105_000_000))),
    collateral(wstETH!, 'wstETH', 5, read(at8(0))),
    collateral(rETH!,   'rETH',   6, reverted()),
  ];

  const unconverted = await summaryOf({ contract: weth, basePrice: read(at8(100_000_000)), baseUsdPrice: USD, collaterals });
  t.match(unconverted, {
    status:               'error',
    message:              USD.message,
    totalBorrowValue:     '1000.0',
    totalSupplyValue:     '2000.0',
    totalCollateralValue: '4.2',
    basePrice:            '1.0',
  }, 'its USD price reverts: an error with its message, the totals in ETH, and the base price');
  t.notOk('baseUsdPrice' in unconverted, 'without the USD price that reverted');
  t.strictSame(unconverted.collaterals.map((each: any) => each.status), [ 'success', 'success', 'error' ], 'each collateral as its price read');

  const unpriced = await summaryOf({ contract: weth, basePrice: BASE, baseUsdPrice: USD, collaterals });
  t.match(unpriced, { status: 'error', message: BASE.message, totalCollateralValue: '4.2' }, 'both revert: the message of the base price');
  t.notOk('totalBorrowValue' in unpriced || 'totalSupplyValue' in unpriced || 'basePrice' in unpriced || 'baseUsdPrice' in unpriced, 'and no totals of the base asset, nor either price');
});

/*
 * The WBTC market's feeds answer in BTC: its base price is WBTC in BTC, and
 * its USD price that of BTC, so only the base price turns a total back into
 * WBTC. Each is written with every digit its feed gives, and not rounded.
 */
t.test('the WBTC market\'s base price is WBTC in BTC, which values its total', async t => {
  // the frontend's example: 29.05271362 WBTC supplied, at 0.9984988 BTC each, and 82731.39 USD per BTC
  const wbtc = await summaryOf({
    contract:     marketOf('wbtc'),
    basePrice:    read(at8(99_849_880)),
    baseUsdPrice: read(at8(8_273_139_000_000)),
    totalSupply:  BigFixnum.from({ decimals: 8, value: 2_905_271_362 }),
    collaterals:  [],
  });
  t.match(wbtc, { status: 'success', totalSupplyValue: '29.009099686313656', baseUsdPrice: '82731.39', basePrice: '0.9984988' },
    'its total in BTC, the price of BTC in USD, and the price of WBTC in BTC its total is valued at');
});

/*
 * While a registry version no longer describes its market — the Comet listed
 * a collateral after the import, and holds another asset at an index the
 * version describes — the summary of the latest block and the history both
 * list the collateral of the version, by the same rules (collaterals.ts). The
 * chain drift check raises the difference, and a
 * new import ends it.
 */
t.test('while the version and the chain differ, the summary and the history both follow the version', async t => {
  const STRANGER  = '0x1111111111111111111111111111111111111111';
  const NEWCOMER  = '0x2222222222222222222222222222222222222222';
  const versioned = usdt.registry.market.collateralAssets;
  t.equal(versioned.length, 16, 'the version describes sixteen collaterals of USDT\'s market');

  // the asset the Comet holds at each of its seventeen indices
  const assetAt = (assetNumber: number) => assetNumber === 3 ? STRANGER : assetNumber === 16 ? NEWCOMER : versioned[assetNumber]!.token.address;
  const { evaluate, pull1, split } = evaluatorOver({
    marketSummary:        market.marketSummary,
    marketLatestSummary:  market.marketLatestSummary,
    collaterals:          market.collaterals,
    ...readsOf({ collaterals: [] }),
    numAssets:            stub(() => 17),
    assetInfo:            stub(({ assetNumber }) => ({
      asset:     checksumAddress(assetAt(assetNumber)),
      priceFeed: checksumAddress(`0x${'f'.repeat(38)}${assetNumber.toString(16).padStart(2, '0')}`),
      scale:     BigNumber.from(10).pow(18),
    })),
    assetTotalCollateral: stub(({ assetNumber }) => BigFixnum.from({ value: assetNumber + 1 })),
    assetPrice:           stub(() => ({ ...read(BigFixnum.from({ value: 2 })), exception: null })),
  });
  const context = contextOf(usdt);
  const [ history, latest ] = await evaluate(split([
    pull1({ marketSummary: context }),
    pull1({ marketLatestSummary: context }),
  ])) as [ any, any ];

  for (const [ name, summary ] of [ [ 'the summary', asMarketSummary(latest) ], [ 'the history', history ] ]) {
    t.equal(summary.status, 'partially', `${name}: partial`);
    t.strictSame(summary.collateralAssetSymbols, versioned.map(asset => asset.token.symbol), `${name}: with the sixteen collaterals of the version`);
    t.strictSame(summary.collaterals.map((each: any) => each.status), versioned.map((_, assetNumber) => assetNumber === 3 ? 'error' : 'success'),
      `${name}: each priced but one`);
    t.strictSame(summary.collaterals[3], {
      address: checksumAddress(versioned[3]!.token.address),
      symbol:  'UNI',
      status:  'error',
      message: `asset 3 of the Comet is ${STRANGER}, not the UNI the registry version describes`,
    }, `${name}: the one at whose index the Comet holds another asset as an error`);
    t.equal(summary.totalCollateralValue, String(2 * (136 - 4)),
      `${name}: and the total leaves it and the seventeenth out: indices 1 to 16 but 4, at two each`);
  }
  t.strictSame(latest.collaterals[3], { ...history.collaterals[3], valueUsd: null, exception: null },
    'the summary: its value not known, since what the Comet holds of it was never read, though the Comet holds something there');
  t.strictSame(latest.collaterals.filter((_: unknown, assetNumber: number) => assetNumber !== 3).map((each: any) => each.valueUsd.toString()),
    versioned.map((_, assetNumber) => String(2 * (assetNumber + 1))).filter((_, assetNumber) => assetNumber !== 3),
    'and every other at what the Comet holds of it, at two each');
});

/*
 * Each total is given in USD beside it, as marketSummary gives it: the same
 * total on a market quoted in USD, and converted at the base asset's USD
 * price on one quoted in its base asset. A total in USD is there where the
 * total is and what converts it was read, in an error as anywhere else.
 */
t.test('a total in USD is reported where the total and what converts it were read', async t => {
  // the totals in USD a summary reports
  const inUsdOf = (summary: any) => Object.fromEntries(Object.entries(summary).filter(([ key ]) => /^total\w+Usd$/.test(key)));

  const usdQuoted = await summaryOf({ collaterals: [ usdtComp(), usdtWeth(reverted()) ] });
  t.match(usdQuoted, { status: 'partially', totalBorrowValue: '998.90608', totalSupplyValue: '1997.81216', totalCollateralValue: '126.51' });
  t.strictSame(inUsdOf(usdQuoted), { totalBorrowValueUsd: '998.90608', totalSupplyValueUsd: '1997.81216', totalCollateralValueUsd: '126.51' },
    'a market quoted in USD: the same totals, leaving out the collateral that could not be priced');
  const unpriced = await summaryOf({ basePrice: reverted(), baseUsdPrice: reverted(), collaterals: [ usdtComp(), usdtWeth(reverted()) ] });
  t.strictSame(inUsdOf(unpriced), { totalCollateralValueUsd: '126.51' }, 'and without its base price, the total of its collateral, which needs none');

  // WETH's market is quoted in ETH: its base asset at 1.0 ETH, and 2500 USD per ETH
  const [ cbETH, wstETH ] = weth.registry.market.collateralAssets.map(asset => checksumAddress(asset.token.address));
  const collaterals = [
    collateral(cbETH!,  'cbETH',  4, read(at8(105_000_000))),
    collateral(wstETH!, 'wstETH', 5, reverted()),
  ];
  const ETH     = read(at8(100_000_000));
  const ETH_USD = read(at8(250_000_000_000));
  const inEth   = (basePrice: PriceRead, baseUsdPrice: PriceRead) => summaryOf({ contract: weth, basePrice, baseUsdPrice, collaterals });

  const converted = await inEth(ETH, ETH_USD);
  t.match(converted, { status: 'partially', totalBorrowValue: '1000.0', totalSupplyValue: '2000.0', totalCollateralValue: '4.2' });
  t.strictSame(inUsdOf(converted), { totalBorrowValueUsd: '2500000.0', totalSupplyValueUsd: '5000000.0', totalCollateralValueUsd: '10500.0' },
    'a market quoted in ETH: each total at 2500 USD per ETH');
  t.strictSame(inUsdOf(await inEth(reverted(), ETH_USD)), { totalCollateralValueUsd: '10500.0' },
    'its base price reverts: the total of its collateral alone, which needs no base price');
  t.strictSame(inUsdOf(await inEth(ETH, reverted())), {}, 'its USD price reverts: none, since nothing converts them');
  t.strictSame(inUsdOf(await inEth(reverted(), reverted())), {}, 'both revert: none');
});

/*
 * What the market holds of each collateral, in USD, as the totals are made:
 * at its price, and on a market quoted in its base asset through the base
 * asset's USD price. The values that are known add up to the total in USD,
 * exactly. Nothing held is worth nothing, whatever its price, read or not; a
 * price of zero is nothing in USD, whatever converts it; and a value is not
 * known where its price could not be read, or, on a market quoted in its base
 * asset, the USD price that converts it.
 */
t.test('each collateral is worth what the market holds of it at its price, in USD, as the totals are made', async t => {
  const usdQuoted = await summaryOf({ collaterals: [ usdtComp(), usdtWeth() ] });
  t.strictSame(valuesOf(usdQuoted), { COMP: [ '126.51', null ], WETH: [ '5028.48578686', null ] },
    'a market quoted in USD: three COMP at 42.17 and two WETH at 2514.24289343');
  t.equal(usdQuoted.totalCollateralValueUsd, '5154.99578686', 'which add up to its total in USD');

  // WETH's market is quoted in ETH, at 2500 USD per ETH
  const [ cbETH, wstETH, rETH, rsETH ] = weth.registry.market.collateralAssets.map(asset => checksumAddress(asset.token.address));
  const collaterals = [
    collateral(cbETH!,  'cbETH',  4, read(at8(105_000_000))),
    collateral(wstETH!, 'wstETH', 5, read(at8(0))),
    collateral(rETH!,   'rETH',   6, reverted()),
    collateral(rsETH!,  'rsETH',  0, reverted()),
  ];
  const ETH_USD = read(at8(250_000_000_000));
  const converted = await summaryOf({ contract: weth, basePrice: read(at8(100_000_000)), baseUsdPrice: ETH_USD, collaterals });
  t.strictSame(valuesOf(converted), {
    cbETH:  [ '10500.0', null ],
    wstETH: [ '0.0', null ],
    rETH:   [ null, null ],
    rsETH:  [ '0', null ],
  }, 'a market quoted in ETH: four cbETH at 1.05 ETH and 2500 USD per ETH, five wstETH at nothing, rETH unpriced, and no rsETH, whose price reverts');
  t.equal(converted.totalCollateralValueUsd, '10500.0', 'and the values that are known add up to its total in USD');
  t.strictSame(converted.collaterals.map((each: any) => each.status), [ 'success', 'success', 'error', 'error' ],
    'each collateral with the status its price read, a holding of nothing among them');

  const unconverted = await summaryOf({ contract: weth, basePrice: read(at8(100_000_000)), baseUsdPrice: reverted(), collaterals });
  t.strictSame(valuesOf(unconverted), {
    cbETH:  [ null, null ],
    wstETH: [ '0.0', null ],
    rETH:   [ null, null ],
    rsETH:  [ '0', null ],
  }, 'its USD price reverts: only what is worth nothing whatever converts it is known');
  t.notOk('totalCollateralValueUsd' in unconverted, 'as no total in USD is');
});

/*
 * A price stated by the registry, or read from the feed a remap names, is
 * named on the collateral by what it does and to which feed, which is all
 * that keys the market's cached summary of an exception (catalog.ts,
 * marketDigest): the route describes it as the version that answers does. A
 * value that is nothing held names none, and so does one not known, but where
 * a remap fell back (below).
 */
t.test('a collateral names the exception that priced it by its kind and its feed, where its value is known and held', async t => {
  const FIXED: PriceExceptionV1 = {
    kind:             'fixed_price',
    priceFeedAddress: '0x351a133fd850ea81ed8a782016e308acbaddec91',
    price:            { value: '102447384', decimals: 8 },
    provenance:       'stated for the test',
    expiresAt:        null,
  };
  const ZERO: PriceExceptionV1 = { kind: 'zero_price', priceFeedAddress: '0xe3a409ed15cd53afdefdd191ad945cec528a2496', provenance: 'stated', expiresAt: null };
  const [ cbETH, wstETH, rETH ] = weth.registry.market.collateralAssets.map(asset => checksumAddress(asset.token.address));
  const priced = await summaryOf({
    contract:     weth,
    basePrice:    read(at8(100_000_000)),
    baseUsdPrice: read(at8(250_000_000_000)),
    collaterals:  [
      collateral(cbETH!,  'cbETH',  2, read(at8(102_447_384)), FIXED),
      collateral(wstETH!, 'wstETH', 5, read(at8(0)), ZERO),
      collateral(rETH!,   'rETH',   0, read(at8(102_447_384)), FIXED),
    ],
  });
  t.strictSame(valuesOf(priced), {
    cbETH:  [ '5122.3692', { kind: 'fixed_price', priceFeedAddress: FIXED.priceFeedAddress } ],
    wstETH: [ '0.0', { kind: 'zero_price', priceFeedAddress: ZERO.priceFeedAddress } ],
    rETH:   [ '0', null ],
  }, 'two cbETH at the price stated, and wstETH at zero, each naming its exception, while nothing held names none');

  const unconverted = await summaryOf({
    contract:     weth,
    basePrice:    read(at8(100_000_000)),
    baseUsdPrice: reverted(),
    collaterals:  [ collateral(cbETH!, 'cbETH', 2, read(at8(102_447_384)), FIXED) ],
  });
  t.strictSame(valuesOf(unconverted), { cbETH: [ null, null ] }, 'and a value not known names none either, though its price was stated');
});

/*
 * What a price, a collateral as it was read and a value can be is in the
 * type of each, so a reader of one never has to rule out what the
 * computations do not make: each one below is a type error the build
 * expects. A collateral as the summary reports it pairs its price's status
 * with its value, and the two are not tied, since nothing reads one by the
 * other: an error beside a value that names an exception compiles, though
 * none is made.
 */
t.test('a price, a collateral or a value the computations do not make does not compile', async () => {
  const FIXED: PriceExceptionV1 = {
    kind:             'fixed_price',
    priceFeedAddress: '0x351a133fd850ea81ed8a782016e308acbaddec91',
    price:            { value: '102447384', decimals: 8 },
    provenance:       'stated for the test',
    expiresAt:        null,
  };
  const APPLIED = { kind: FIXED.kind, priceFeedAddress: FIXED.priceFeedAddress } as const;
  const REVERT  = { feed: '0x5555555555555555555555555555555555555555', message: 'execution reverted' } as const;
  (price: BigFixnum) => [
    // @ts-expect-error a price that could not be read names no exception
    { status: 'error', message: 'execution reverted', exception: FIXED } satisfies AssetPriceRead,
    // @ts-expect-error nor carries a replacement's revert, which only a price the fallback gave does
    { status: 'error', message: 'execution reverted', exception: null, replacementRevert: REVERT } satisfies AssetPriceRead,
    // @ts-expect-error another asset at the collateral's index leaves the collateral unpriced
    { asset: COMP, symbol: 'COMP', totalCollateral: null, price: { status: 'success', price, exception: null } } satisfies Collateral,
    // @ts-expect-error a value that is not known names no exception but the remap that fell back
    { valueUsd: null, exception: APPLIED } satisfies CollateralValue,
  ];
});

/*
 * The value of a collateral is read at the block the summary reads its market
 * at, and dated by that block's header, read beside the rest. A header the
 * node does not give leaves the block null, and fails nothing else.
 */
t.test('the block the market was read at is the header the node gave of it, or null', async t => {
  const reads   = { collaterals: [ usdtComp(), usdtWeth() ] };
  const asked: unknown[] = [];
  const { evaluate, pull1 } = evaluatorOver({
    marketLatestSummary: market.marketLatestSummary,
    ...readsOf(reads),
    collaterals:         stub(() => reads.collaterals),
    ethGetBlockHeader:   stub(context => { asked.push(context.blockNumber); return HEADER; }),
  });
  const summary = await evaluate(pull1({ marketLatestSummary: contextOf(usdt) })) as any;
  t.strictSame(summary.marketBlock, HEADER, 'the number of the block read, with its own timestamp');
  t.strictSame(asked, [ block.number ], 'asked for once, at the block the summary was asked at');

  const headless = await summaryOf({ ...reads, ethGetBlockHeader: null });
  t.equal(headless.marketBlock, null, 'a header the node did not give is null');
  t.strictSame({ ...headless, marketBlock: HEADER }, summary, 'and everything else is as with it');
});

/*
 * A remap whose replacement reverts at the summary's block while the feed it
 * replaces answers: at the latest block, a replacement that has stopped
 * answering. The summary counts the collateral in its totals at the price of
 * the feed it replaces, as though no remap named it, but does not value the
 * collateral by it: its value is not known, and names the remap. It reports
 * the replacement as a price read reports a feed that reverts: as the version
 * names it, read by the Comet on its network at the block, with the
 * replacement's own message, whatever the market holds of the collateral,
 * and what it holds none of is worth nothing all the same. The history reads
 * the same prices, and neither reports nor answers anything of the revert.
 * The reads below assetPrice answer from tables: USDT's market holds its
 * first two collaterals, COMP, priced through COMP / USD, which a version
 * remaps to REPLACEMENT, and WETH, and a feed answers 1.0 unless a test says
 * otherwise.
 *
 * A feed that reverts is logged once a minute per network and feed, in the
 * memory of the process (get-price.ts), so the clock of each test below is a
 * minute later at every reading: every line that is due is written, and none
 * masks another, in its test or in a later one.
 */
const REPLACEMENT   = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a' as Address;
const STOPPED       = 'execution reverted: the replacement stopped answering';
const usdtCompAsset = usdt.registry.market.collateralAssets[0]!;
const usdtWethAsset = usdt.registry.market.collateralAssets[1]!;

// USDT's market in a version that remaps each feed of `remaps` to the replacement beside it
function remappedOf(remaps: [ Address, Address ][]): RegistryComet {
  const snapshot = loadRegistrySnapshotFixture();
  return catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : {
      ...entry,
      priceExceptions: [ ...entry.priceExceptions, ...remaps.map(([ feed, replacement ]) => ({
        kind:                 'deprecated_price_remap' as const,
        priceFeedAddress:     feed,
        replacementPriceFeed: { address: replacement, decimals: 8 },
        provenance:           'the feed retired; its replacement answers the same pair',
        expiresAt:            null,
      })) ],
    }),
  }).marketsOn(network).find(entry => entry.deploymentKey === 'usdt')!.comet;
}

// USDT's market in a version that remaps COMP / USD to REPLACEMENT
const remapped = remappedOf([ [ usdtCompAsset.priceFeed.address, REPLACEMENT ] ]);

let clock = Date.now();
// a clock a minute later at every reading, for the length of a test
const minuteByMinute = (t: Test) => t.capture(Date, 'now', () => (clock += 60_000));

/*
 * The reads of the summary of USDT's market through the real collaterals and
 * assetPrice: what its Comet holds at its first two indices, `held` COMP and
 * one WETH, each priced 1.0 by its feed unless `prices` answers that feed, by
 * its address, lowercase; and the rest of the market as `reads` names it, or
 * else as READS has it.
 */
function pricedReads(prices: Record<string, PriceRead>, held = 3, reads: Omit<Reads, 'collaterals'> = {}) {
  const assets = [ usdtCompAsset, usdtWethAsset ];
  return {
    ...readsOf({ ...reads, collaterals: [] }),
    collaterals:          market.collaterals,
    assetPrice:           comet.assetPrice,
    numAssets:            stub(() => assets.length),
    assetInfo:            stub(({ assetNumber }) => ({
      asset:     checksumAddress(assets[assetNumber]!.token.address),
      priceFeed: checksumAddress(assets[assetNumber]!.priceFeed.address),
      scale:     BigNumber.from(10).pow(assets[assetNumber]!.token.decimals),
    })),
    assetTotalCollateral: stub(({ assetNumber }) => BigFixnum.from({ value: assetNumber === 0 ? held : 1 })),
    getPrice:             stub(({ priceFeed }) => prices[priceFeed.address.toLowerCase()] ?? read(at8(100_000_000))),
  };
}

// the latest summary of `contract`, USDT's market, over those reads
function latestOf(contract: RegistryComet, prices: Record<string, PriceRead>, held = 3, reads: Omit<Reads, 'collaterals'> = {}): Promise<any> {
  const { evaluate, pull1 } = evaluatorOver({ marketLatestSummary: market.marketLatestSummary, ...pricedReads(prices, held, reads) });
  return evaluate(pull1({ marketLatestSummary: contextOf(contract) }));
}

// the line that reports REPLACEMENT, read by USDT's Comet at block `number`
const stoppedAt = (number: number) => `price feed reverted: ${REPLACEMENT} read by ${remapped.address} on ${network} at block ${number}: ${STOPPED}`;

// the remap of COMP / USD as a summary names it on a collateral
const REMAP = { kind: 'deprecated_price_remap', priceFeedAddress: usdtCompAsset.priceFeed.address } as const;

t.test('a remap whose replacement stopped answering is reported by the latest summary, which counts the collateral in its totals and leaves its value unknown', async t => {
  minuteByMinute(t);
  const logged  = consoleLines(t, [ 'warn' ]);
  const summary = await latestOf(remapped, { [REPLACEMENT]: reverted(STOPPED) });
  const plain   = await latestOf(usdt, {});
  t.strictSame(logged, [ stoppedAt(block.number) ],
    'reported once, naming the replacement as the version names it, the Comet, the network and the block, with the replacement\'s own message');
  t.strictSame(summary.collaterals[0], { address: COMP, symbol: 'COMP', status: 'success', valueUsd: null, exception: REMAP },
    'COMP, priced through the feed the remap replaces: of a value not known, naming the remap');
  t.equal(plain.collaterals[0].valueUsd.toString(), '3.0', 'which values the three COMP at 1.0 where no remap names that feed');
  t.match(summary, { totalCollateralValue: '4.0', totalCollateralValueUsd: '4.0' }, 'the totals count them so all the same, beside the one WETH at 1.0');
  t.strictSame({ ...summary, collaterals: summary.collaterals.slice(1) }, { ...plain, collaterals: plain.collaterals.slice(1) },
    'and the market is answered as where no remap names that feed, but for COMP\'s value, with nothing of the revert');

  logged.length = 0;
  const none = await latestOf(remapped, { [REPLACEMENT]: reverted(STOPPED) }, 0);
  t.strictSame(logged, [ stoppedAt(block.number) ], 'no COMP held: reported all the same');
  t.strictSame(none, await latestOf(usdt, {}, 0), 'and worth nothing, naming no exception, as where no remap names that feed');
});

/*
 * Each such replacement of a market is reported, however the rest of the
 * market reads: where its base price or its USD price could not be read,
 * which makes the market an error, and where a version remaps the feeds of
 * both its collaterals, COMP / USD to REPLACEMENT and WETH / USD to SECOND,
 * and both replacements have stopped answering.
 */
t.test('the latest summary reports each replacement that stopped answering, however the rest of its market reads', async t => {
  minuteByMinute(t);
  const logged  = consoleLines(t, [ 'warn' ]);
  const SECOND  = '0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b' as Address;
  const RETIRED = 'execution reverted: the second replacement stopped answering';
  // USDT's market in a version that remaps WETH / USD to SECOND as well
  const twice = remappedOf([ [ usdtCompAsset.priceFeed.address, REPLACEMENT ], [ usdtWethAsset.priceFeed.address, SECOND ] ]);

  for (const [ price, reads ] of [ [ 'base price', { basePrice: reverted() } ], [ 'USD price', { baseUsdPrice: reverted() } ] ] as const) {
    logged.length = 0;
    const summary = await latestOf(remapped, { [REPLACEMENT]: reverted(STOPPED) }, 3, reads);
    t.equal(summary.status, 'error', `its ${price} reverts: the market is an error`);
    t.match(summary.collaterals[0], { symbol: 'COMP', status: 'success', valueUsd: null, exception: REMAP },
      `its ${price} reverts: COMP priced through the feed the remap replaces, of a value not known, naming the remap`);
    t.strictSame(logged, [ stoppedAt(block.number) ], `its ${price} reverts: and the replacement reported all the same`);
  }

  logged.length = 0;
  const both = await latestOf(twice, { [REPLACEMENT]: reverted(STOPPED), [SECOND]: reverted(RETIRED) });
  t.strictSame(both.collaterals.map(({ symbol, status, valueUsd, exception }: any) => [ symbol, status, valueUsd, exception ]), [
    [ 'COMP', 'success', null, REMAP ],
    [ 'WETH', 'success', null, { kind: 'deprecated_price_remap', priceFeedAddress: usdtWethAsset.priceFeed.address } ],
  ], 'both feeds remapped: each collateral priced through the feed its remap replaces, of a value not known, naming its own remap');
  t.strictSame([ ...logged ].sort(), [
    stoppedAt(block.number),
    `price feed reverted: ${SECOND} read by ${twice.address} on ${network} at block ${block.number}: ${RETIRED}`,
  ].sort(), 'and each replacement reported once, with its own message');
});

t.test('the latest summary reports nothing more where the replacement answers, where neither feed answers, or where no remap names the feed', async t => {
  minuteByMinute(t);
  const logged = consoleLines(t, [ 'warn' ]);

  const replaced = await latestOf(remapped, { [REPLACEMENT]: read(at8(200_000_000)) });
  t.match(replaced.collaterals[0], { symbol: 'COMP', status: 'success', exception: { kind: 'deprecated_price_remap' } }, 'a replacement that answers prices COMP, naming the remap');
  t.strictSame(logged, [], 'and nothing is reported');

  const neither = await latestOf(remapped, {
    [REPLACEMENT]:                     reverted(STOPPED),
    [usdtCompAsset.priceFeed.address]: reverted('execution reverted: the feed it replaces'),
  });
  t.match(neither.collaterals[0], { symbol: 'COMP', status: 'error', message: STOPPED, valueUsd: null, exception: null },
    'where neither answers, COMP is an error, with the revert of its replacement, and its value, not known, names nothing');
  t.strictSame(logged, [ stoppedAt(block.number) ], 'reported once, by the price read, and not again by the summary');

  logged.length = 0;
  const unmapped = await latestOf(usdt, { [usdtWethAsset.priceFeed.address]: reverted('execution reverted: WETH / USD') });
  t.match(unmapped.collaterals[1], { symbol: 'WETH', status: 'error' }, 'a feed no remap names that reverts makes its collateral an error');
  t.strictSame(logged, [], 'which the summary does not report: the read of the feed does, and here that read is a table');
});

t.test('the history reads the same prices, and neither reports nor answers anything of a replacement that reverts', async t => {
  minuteByMinute(t);
  const logged = consoleLines(t, [ 'warn' ]);
  // what `asked` answers, on an evaluator of its own, over the reads of a replacement that reverts
  const historyOf = (asked: object): Promise<any> => {
    const { evaluate, pull1 } = evaluatorOver({
      marketSummary:    market.marketSummary,
      marketDaySummary: market.marketDaySummary,
      ...pricedReads({ [REPLACEMENT]: reverted(STOPPED) }),
    });
    return evaluate(pull1(asked as any));
  };
  const summary = await historyOf({ marketSummary: contextOf(remapped) });
  const day     = await historyOf({ marketDaySummary: contextOf(remapped) });

  for (const [ what, answer ] of [ [ 'marketSummary', summary ], [ 'a day of the history', day ] ] as const) {
    t.equal(answer.status, 'success', `${what}: a success`);
    t.strictSame(answer.collaterals.map(({ symbol, status }: any) => [ symbol, status ]), [ [ 'COMP', 'success' ], [ 'WETH', 'success' ] ],
      `${what}: COMP priced through the feed the remap replaces`);
    t.strictSame(answer.collaterals.map((collateral: object) => Object.keys(collateral)), [ [ 'address', 'symbol', 'status' ], [ 'address', 'symbol', 'status' ] ],
      `${what}: each collateral with its address, its symbol and its status alone`);
    t.notOk(JSON.stringify(answer).includes(REPLACEMENT) || JSON.stringify(answer).includes(STOPPED), `${what}: and nothing of the replacement or of its revert`);
  }
  t.strictSame(logged, [], 'and neither reports the replacement');
});

t.test('the minutely summary caches nothing of the revert, and a minute it has cached reports nothing', async t => {
  minuteByMinute(t);
  const logged = consoleLines(t, [ 'warn' ]);
  const cache  = memoryCache();
  // the minute at its own block, as the route asks for it, which is what is cached (market-minutely-summary.ts)
  const projected = Fallible.must(market.marketMinutelySummary.index.project(contextOf(remapped)));
  const minute = () => {
    const { evaluate, pull1 } = evaluatorOver({
      marketMinutelySummary: market.marketMinutelySummary,
      marketLatestSummary:   market.marketLatestSummary,
      ...pricedReads({ [REPLACEMENT]: reverted(STOPPED) }),
    }, { cache });
    return evaluate(pull1({ marketMinutelySummary: { ...projected, block: { ...projected.block, timestamp: block.timestamp } } })) as Promise<any>;
  };

  const first = await minute();
  t.strictSame(logged, [ stoppedAt(projected.block.number) ], 'a minute nobody read reports the replacement, at the block of the minute');
  const cached = Object.entries(cache.store).filter(([ key ]) => key.startsWith('marketMinutelySummary-'));
  t.equal(cached.length, 1, 'which it caches');
  const value = (cached[0]?.[1] ?? null) as any;
  t.strictSame(value?.collaterals?.map((collateral: object) => Object.keys(collateral)), [
    [ 'address', 'symbol', 'status', 'valueUsd', 'exception' ],
    [ 'address', 'symbol', 'status', 'valueUsd', 'exception' ],
  ], 'each collateral with its status, its value and its exception alone');
  t.strictSame(value?.collaterals?.[0], { address: COMP, symbol: 'COMP', status: 'success', valueUsd: null, exception: REMAP },
    'COMP of a value not known, naming the remap');
  t.notOk(JSON.stringify(value).includes(STOPPED) || JSON.stringify(value).includes(REPLACEMENT), 'and nothing of the replacement or of its revert');

  logged.length = 0;
  t.equal(JSON.stringify(await minute()), JSON.stringify(first), 'the same minute is answered from the cache, as it was');
  t.strictSame(logged, [], 'and reports nothing');
});
