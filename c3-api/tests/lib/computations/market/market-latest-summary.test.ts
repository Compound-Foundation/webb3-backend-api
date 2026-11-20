import t from 'tap';

import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import * as Eth      from '../../../../lib/eth-constants.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Compute    from '../../../../lib/symbolic/computation.js';
import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as market from '../../../../lib/computations/market.js';

import type { PriceRead } from '../../../../lib/computations/comet.js';
import type { Collateral } from '../../../../lib/computations/market/collaterals.js';

import type { RegistryComet } from '../../../../lib/model/comet-registry.js';
import { checksumAddress } from '../../../../lib/model/comet-registry.js';

import { fixtureCatalog } from '../../../util/registry-fixture.js';

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

const marketOf = (deploymentKey: string) => fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === deploymentKey)!.comet;
const usdt = marketOf('usdt');
const weth = marketOf('weth');

const COMP = '0xc00e94Cb662C3520282E6f5717214004A7f26888';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// a price as a feed of eight decimals answers it: 4217000000 is 42.17
const at8      = (value: number | string) => BigFixnum.from({ decimals: 8, value });
const read     = (price: BigFixnum) => ({ status: 'success' as const, price });
const reverted = (message = 'execution reverted') => ({ status: 'error' as const, message });

function stub(answer: (context: any) => unknown) {
  return Compute.Functor<any>({}).implement({ version: 0, compute: context => answer(context) });
}

// on the working set, which the summary route evaluates on
function evaluator(computations: Record<string, unknown>) {
  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  return Evaluator.instantiate<any>(computations as any, { cache, debug, flags: { ...flags, evaluatorAlgorithm: 'workingset', batchingEnabled: true } });
}

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
  const { evaluate, pull1 } = evaluator({
    marketLatestSummary: market.marketLatestSummary,
    ...readsOf(reads),
    versionedCollaterals: stub(() => reads.collaterals),
  });
  return evaluate(pull1({ marketLatestSummary: contextOf(reads.contract ?? usdt) }));
}

// a collateral of the summary's market as versionedCollaterals reports it: `held` whole tokens of eighteen decimals at `price`
function collateral(asset: string, symbol: string, held: number, price: PriceRead): Collateral {
  return {
    asset:           asset as Eth.Address,
    symbol,
    totalCollateral: BigFixnum.from({ multiplier: BigNumber.from(10).pow(18), value: BigNumber.from(10).pow(18).mul(held) }),
    price,
  };
}

// USDT's market holds three COMP at 42.17 USD and two WETH at 2514.24289343 USD
const usdtComp = (price: PriceRead = read(at8(4_217_000_000)))   => collateral(COMP, 'COMP', 3, price);
const usdtWeth = (price: PriceRead = read(at8(251_424_289_343))) => collateral(WETH, 'WETH', 2, price);

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
    basePrice:              '0.99890608',
    collateralAssetSymbols: [ 'COMP', 'WETH' ],
    collaterals: [
      { address: COMP, symbol: 'COMP', status: 'success' },
      { address: WETH, symbol: 'WETH', status: 'success' },
    ],
  };
  t.strictSame(summary, expected, 'each total at the base price, and each collateral with its status');
  t.equal(JSON.stringify(summary), JSON.stringify(expected), 'in the order the API writes them');
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
    const { evaluate, pull1, split } = evaluator({
      marketSummary:       market.marketSummary,
      marketLatestSummary: market.marketLatestSummary,
      ...readsOf(reads),
      collaterals:         stub(() => reads.collaterals),
      versionedCollaterals: stub(() => reads.collaterals),
    });
    const context = contextOf(reads.contract);
    const [ before, { basePrice, ...latest } ] = await evaluate(split([
      pull1({ marketSummary: context }),
      pull1({ marketLatestSummary: context }),
    ])) as [ any, any ];
    // which marketSummary keeps to itself
    t.equal(basePrice, (reads.basePrice ?? READS.basePrice).price.toString(), `${status}: the base price its totals are valued at`);

    t.equal(before.status, status, `marketSummary reports the market as ${status}`);
    t.strictSame(latest, before, `${status}: every field as marketSummary reports it`);
    t.equal(JSON.stringify(latest), JSON.stringify(before), `${status}: in its order`);
  }
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
  const after  = [ 'collateralAssetSymbols', 'collaterals' ];
  const cases = [
    { reads: { basePrice: BASE, baseUsdPrice: USD }, message: BASE.message, keys: [ ...common, ...after ], name: 'both revert' },
    { reads: { baseUsdPrice: USD },                  message: USD.message,  keys: [ 'totalBorrowValue', 'totalSupplyValue', ...common, 'basePrice', ...after ], name: 'its USD price reverts' },
    { reads: { basePrice: BASE },                    message: BASE.message, keys: [ ...common, 'baseUsdPrice', ...after ], name: 'its base price reverts' },
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
    versionedCollaterals: market.versionedCollaterals,
    ...readsOf({ collaterals: [] }),
    numAssets:            stub(() => 17),
    assetInfo:            stub(({ assetNumber }) => ({
      asset:     checksumAddress(assetAt(assetNumber)),
      priceFeed: checksumAddress(`0x${'f'.repeat(38)}${assetNumber.toString(16).padStart(2, '0')}`),
      scale:     BigNumber.from(10).pow(18),
    })),
    assetTotalCollateral: stub(({ assetNumber }) => BigFixnum.from({ value: assetNumber + 1 })),
    assetPrice:           stub(() => read(BigFixnum.from({ value: 2 }))),
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
