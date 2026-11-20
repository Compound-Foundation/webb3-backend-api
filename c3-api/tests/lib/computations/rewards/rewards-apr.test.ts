import t from 'tap';

import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as comet   from '../../../../lib/computations/comet.js';
import * as rewards from '../../../../lib/computations/rewards.js';
import { basePriceLookup, basePriceOf, rewardsAprOf } from '../../../../lib/computations/rewards/rewards-apr.js';

import { catalogOf } from '../../../../src/registry/catalog.js';

import { evaluatorOver, stub } from '../../../util/evaluator.js';
import { fixtureCatalog, loadRegistrySnapshotFixture } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * A rewards APR is the annual value of the rewards one side of a market pays
 * over the value of that side, both in the unit of the reward feed. The two
 * APRs differ only in the side they read.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network  = 'ethereum-mainnet' as const;
const catalog  = fixtureCatalog();
const marketOf = (deploymentKey: string) => catalog.marketsOn(network).find(entry => entry.deploymentKey === deploymentKey)!.comet;
const usdc = marketOf('usdc');
const usdt = marketOf('usdt');
const weth = marketOf('weth');
const wbtc = marketOf('wbtc');

// a price as a feed of 8 decimals answers it
const read     = (value: number) => ({ status: 'success' as const, price: BigFixnum.from({ value: value * 10 ** 8, decimals: 8 }) });
const reverted = (message: string) => ({ status: 'error' as const, message });

// 50 a reward token, paid at 0.000001 a second: 1576.8 a year
const side = {
  rewardPrice:   read(50),
  basePrice:     read(1),
  principal:     BigNumber.from(2_000),
  total:         BigFixnum.from({ value: 1_000_000 }),
  baseMin:       BigNumber.from(500),
  ratePerSecond: BigFixnum.from({ value: 1, decimals: 6 }),
};

const aprOf = (answer: ReturnType<typeof rewardsAprOf>) => answer.status === 'success' ? answer.apr.toString() : answer;

t.test('a rewards APR is the annual value of the rewards over the value of the side', async t => {
  t.equal(aprOf(rewardsAprOf(side)), '0.0015768', '1576.8 a year over 1,000,000 at 1');
  t.equal(aprOf(rewardsAprOf({ ...side, basePrice: read(4) })), '0.0003942', 'over 1,000,000 at 4');
  t.equal(aprOf(rewardsAprOf({ ...side, rewardPrice: read(100) })), '0.0031536', 'the rewards valued at their price');
});

/*
 * baseMinForRewards is held against the side's principal, not against the
 * amount that is valued.
 */
t.test('a side whose principal is not above baseMinForRewards has a rate of 0', async t => {
  t.equal(aprOf(rewardsAprOf({ ...side, baseMin: BigNumber.from(2_000) })), '0', 'a principal at baseMinForRewards, however much is valued');
  t.equal(aprOf(rewardsAprOf({ ...side, baseMin: BigNumber.from(1_999) })), '0.0015768', 'one above it has its rate');
  t.equal(aprOf(rewardsAprOf({ ...side, baseMin: BigNumber.from(1_999), total: BigFixnum.from({ value: 1_000 }) })), '1.5768',
    'however little is valued: 1576.8 a year over 1,000');
});

t.test('a price that could not be read is the answer, the reward price first', async t => {
  t.strictSame(rewardsAprOf({ ...side, rewardPrice: reverted('reward'), basePrice: reverted('base') }), reverted('reward'),
    'the reward price, where neither could be read');
  t.strictSame(rewardsAprOf({ ...side, basePrice: reverted('base') }), reverted('base'), 'then the base price');
  t.strictSame(rewardsAprOf({ ...side, rewardPrice: reverted('reward'), baseMin: BigNumber.from(2_000) }), reverted('reward'),
    'even where the rate would be 0');
  t.strictSame(rewardsAprOf({ ...side, basePrice: reverted('base'), baseMin: BigNumber.from(2_000) }), reverted('base'),
    'the base price too');
});

/*
 * The base price is read in the unit of the reward feed (base-price-feed.ts):
 * the market's own, or the USD price of its base asset where the reward price
 * is in USD and the market quotes its base asset.
 */
t.test('the base price of an APR is the one the unit of its reward feed calls for', async t => {
  const frameOf = (contract: typeof usdc) => ({ apiHost: '', nodeHost: '', nodeKey: '', network, contract, blockNumber: 1 });
  for (const contract of [ usdc, weth ]) {
    const frame = frameOf(contract);
    t.strictSame(basePriceLookup(frame), { basePrice: frame }, `${contract.registry.deploymentKey}: the market's own`);
  }
  const frame = frameOf(wbtc);
  t.strictSame(basePriceLookup(frame), { baseUsdPrice: frame }, 'wbtc: the USD price of its base asset');

  t.strictSame(basePriceOf({ basePrice: reverted('own') }), reverted('own'), 'and the price is the one of the two that was read');
  t.strictSame(basePriceOf({ baseUsdPrice: reverted('usd') }), reverted('usd'));
});

/*
 * The APRs on the real evaluator, over reads that answer from a table instead
 * of a node: each side measures its own principal, amount and rate, against
 * the base price its market's units call for, and reads nothing else.
 */
t.test('each APR measures its own side', async t => {
  const rewardFeedOf = (contract: typeof usdt) => contract.registry.market.rewardAsset!.priceFeed!;
  const reads: string[] = [];
  const aprsOf = async (contract: typeof usdt, baseMin: number) => {
    const { evaluate, pull } = Evaluator.instantiate<any>({
      supplyRewardsApr:           rewards.supplyRewardsApr,
      borrowRewardsApr:           rewards.borrowRewardsApr,
      totalsBasic:                stub(() => ({ totalSupplyBase: BigNumber.from(2_000), totalBorrowBase: BigNumber.from(1_000) })),
      baseMinForRewards:          stub(() => BigNumber.from(baseMin)),
      totalSupply:                stub(() => BigFixnum.from({ value: 1_000_000 })),
      totalBorrow:                stub(() => BigFixnum.from({ value: 500_000 })),
      supplyRewardsRatePerSecond: stub(() => BigFixnum.from({ value: 1, decimals: 6 })),
      borrowRewardsRatePerSecond: stub(() => BigFixnum.from({ value: 2, decimals: 6 })),
      getPrice:                   stub(({ priceFeed }) => { reads.push(`getPrice ${priceFeed.address}`); return read(50); }),
      // a market quoted in its base asset answers its own base price in that asset
      basePrice:                  stub(() => { reads.push('basePrice'); return read(1); }),
      baseUsdPrice:               stub(() => { reads.push('baseUsdPrice'); return read(60_000); }),
    } as any, { cache: new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]), debug, flags });
    const apr = { apiHost: '', nodeHost: '', nodeKey: '', network, contract, blockNumber: 1, rewardsTokenPriceFeed: rewardFeedOf(contract) };
    const { supplyRewardsApr, borrowRewardsApr } = await evaluate(pull({ supplyRewardsApr: apr, borrowRewardsApr: apr })) as any;
    return { supply: aprOf(supplyRewardsApr), borrow: aprOf(borrowRewardsApr) };
  };

  t.strictSame(await aprsOf(usdt, 500), { supply: '0.0015768', borrow: '0.0063072' },
    'supply: 1576.8 a year over 1,000,000; borrow: 3153.6 a year over 500,000');
  t.strictSame([ ...new Set(reads) ].sort(), [ 'basePrice', `getPrice ${rewardFeedOf(usdt).address}` ], 'at the market\'s own base price');

  reads.length = 0;
  t.strictSame(await aprsOf(usdt, 1_500), { supply: '0.0015768', borrow: '0' },
    'each against its own principal: 2,000 supplied, 1,000 borrowed');

  reads.length = 0;
  t.strictSame(await aprsOf(wbtc, 500), { supply: '0.00000002628', borrow: '0.00000010512' },
    'a USD reward price against a market quoted in its base asset: over the USD value of the side');
  t.strictSame([ ...new Set(reads) ].sort(), [ 'baseUsdPrice', `getPrice ${rewardFeedOf(wbtc).address}` ],
    'at the USD price of its base asset, and not its own');
});

/*
 * The same APRs over the real BaseUsdPrice: the USD price of a base asset an
 * APR divides by is read from the feed the version names to convert its
 * market to USD, as the summary converts it. A market quoted in its base asset
 * without that feed, which validation refuses, fails as its summary does,
 * rather than being measured in its base asset.
 */
t.test('the APR of a market quoted in its base asset reads the USD feed its version names', async t => {
  // BTC / USD, the USD feed of the fixture's WBTC market, whose own feeds answer in BTC
  const BTC_USD    = '0xf4030086522a5beea4988f8ca5b36dbc97bee88c';
  const rewardFeed = wbtc.registry.market.rewardAsset!.priceFeed!;
  const prices: Record<string, unknown> = { [rewardFeed.address]: read(50), [BTC_USD]: read(60_000) };

  const reads: string[] = [];
  const aprsOf = async (contract: typeof wbtc) => {
    const { evaluate, pull } = evaluatorOver({
      supplyRewardsApr:           rewards.supplyRewardsApr,
      borrowRewardsApr:           rewards.borrowRewardsApr,
      baseUsdPrice:               comet.baseUsdPrice,
      totalsBasic:                stub(() => ({ totalSupplyBase: BigNumber.from(2_000), totalBorrowBase: BigNumber.from(1_000) })),
      baseMinForRewards:          stub(() => BigNumber.from(500)),
      totalSupply:                stub(() => BigFixnum.from({ value: 1_000_000 })),
      totalBorrow:                stub(() => BigFixnum.from({ value: 500_000 })),
      supplyRewardsRatePerSecond: stub(() => BigFixnum.from({ value: 1, decimals: 6 })),
      borrowRewardsRatePerSecond: stub(() => BigFixnum.from({ value: 2, decimals: 6 })),
      getPrice:                   stub(({ priceFeed }) => {
        const address = priceFeed.address.toLowerCase();
        reads.push(address);
        return prices[address] ?? reverted('no feed answers at that address');
      }),
      basePrice:                  stub(() => { reads.push('basePrice'); return read(1); }),
    });
    const apr = { apiHost: '', nodeHost: '', nodeKey: '', network, contract, blockNumber: 1, rewardsTokenPriceFeed: rewardFeed };
    const { supplyRewardsApr, borrowRewardsApr } = await evaluate(pull({ supplyRewardsApr: apr, borrowRewardsApr: apr })) as any;
    return { supply: aprOf(supplyRewardsApr), borrow: aprOf(borrowRewardsApr) };
  };

  t.strictSame(await aprsOf(wbtc), { supply: '0.00000002628', borrow: '0.00000010512' },
    'over the side at 60,000 USD per BTC');
  t.strictSame([ ...new Set(reads) ].sort(), [ rewardFeed.address, BTC_USD ].sort(), 'read from BTC / USD, and not from its own base price');

  const snapshot    = loadRegistrySnapshotFixture();
  const unconverted = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : {
      ...entry,
      markets: entry.markets.map(each => each.deploymentKey !== 'wbtc' ? each : { ...each, baseAsset: { ...each.baseAsset, usdPriceFeed: null } }),
    }),
  }).marketsOn(network).find(entry => entry.deploymentKey === 'wbtc')!.comet;
  reads.length = 0;
  await t.rejects(aprsOf(unconverted), /quoted in its base asset without a USD feed/,
    'a market quoted in its base asset without one fails, as its summary does');
  t.notOk(reads.includes('basePrice'), 'rather than dividing by its base price in BTC');
});
