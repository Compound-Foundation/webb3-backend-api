import t from 'tap';

import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Compute    from '../../../../lib/symbolic/computation.js';
import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as comet  from '../../../../lib/computations/comet.js';
import * as market from '../../../../lib/computations/market.js';

import { type Collateral, collateralValue } from '../../../../lib/computations/market/collaterals.js';

import type { RegistryComet } from '../../../../lib/model/comet-registry.js';
import { checksumAddress } from '../../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../../src/registry/catalog.js';

import { fixtureCatalog, loadRegistrySnapshotFixture } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * The collateral the summary of the latest block reports, as the registry
 * version describes it: the computation runs on the real evaluator, over
 * reads of the Comet that answer from a table instead of a node.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network     = 'ethereum-mainnet' as const;
const usdt        = fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === 'usdt')!.comet;
const blockNumber = 50_000_000;

const COMP = '0xc00e94Cb662C3520282E6f5717214004A7f26888';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const one = (decimals = 8) => BigFixnum.from({ decimals, value: BigNumber.from(10).pow(decimals) });
const read     = (price: BigFixnum) => ({ status: 'success' as const, price });
const reverted = { status: 'error' as const, message: 'execution reverted' };

function stub(answer: (context: any) => unknown) {
  return Compute.Functor<any>({}).implement({ version: 0, compute: context => answer(context) });
}

// the market routes evaluate on the working set; the recursive evaluator must answer the same
const ALGORITHMS = [ 'recursive', 'workingset' ] as const;

function evaluator(computations: Record<string, unknown>, algorithm: typeof ALGORITHMS[number]) {
  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  return Evaluator.instantiate<any>(computations as any, { cache, debug, flags: { ...flags, evaluatorAlgorithm: algorithm, batchingEnabled: true } });
}

/*
 * The collaterals of a Comet as the chain answers at a block: how many it had
 * listed, and the asset at each index — by default the one the version
 * describes there — with every read recorded. There is no symbol() among the
 * reads to stub, and no ethCall: a computation that read either would fail.
 */
function collateralsAt(
  contract: RegistryComet,
  chain: {
    numAssets: number,
    assetAt?:  Record<number, string>,
    price?:    (assetNumber: number) => unknown,
  },
  algorithm: typeof ALGORITHMS[number] = 'workingset',
) {
  const reads: string[] = [];
  const counted = (name: string, answer: (context: any) => unknown) => stub(context => {
    reads.push(`${name}:${context.assetNumber}`);
    return answer(context);
  });
  const described = (assetNumber: number) => contract.registry.market.collateralAssets[assetNumber]?.token.address ?? `0x${'9'.repeat(40)}`;
  const { evaluate, pull1 } = evaluator({
    versionedCollaterals:    market.versionedCollaterals,
    numAssets:            stub(() => chain.numAssets),
    assetInfo:            counted('assetInfo', ({ assetNumber }) => ({ asset: checksumAddress(chain.assetAt?.[assetNumber] ?? described(assetNumber)) })),
    assetTotalCollateral: counted('assetTotalCollateral', ({ assetNumber }) => BigFixnum.from({ value: assetNumber + 1 })),
    assetPrice:           counted('assetPrice', ({ assetNumber }) => chain.price?.(assetNumber) ?? read(BigFixnum.from({ value: 2 }))),
  }, algorithm);
  const collaterals = evaluate(pull1({
    versionedCollaterals: { apiHost: '', nodeHost: '', nodeKey: '', network, contract, blockNumber },
  })) as Promise<Collateral[]>;
  return { collaterals, reads };
}

// every read of the collaterals at these indices: once each at its index
const readsOf = (assetNumbers: number[]) => assetNumbers.flatMap(assetNumber => [
  `assetInfo:${assetNumber}`,
  `assetPrice:${assetNumber}`,
  `assetTotalCollateral:${assetNumber}`,
]).sort();

const indices = (length: number) => Array.from({ length }, (_, assetNumber) => assetNumber);

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
    ], `${algorithm}: each collateral with its price, or why it could not be read`);
    t.equal(collateralValue(read2).toString(), '2', 'one of the first at two, and none of the second');
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
 * A Comet may not have listed every collateral the version describes yet,
 * and it may have listed one the version does not describe yet. Neither is
 * summarized: the first is not a collateral at that block, and nothing says
 * what the second is until a version does.
 */
t.test('a summary holds the collateral the version describes that the Comet had listed', async t => {
  const earlier = collateralsAt(usdt, { numAssets: 14 });
  t.same((await earlier.collaterals).map(collateral => collateral.symbol), usdt.registry.market.collateralAssets.slice(0, 14).map(asset => asset.token.symbol),
    'a block before the last two were listed summarizes the first fourteen');
  t.strictSame(earlier.reads.sort(), readsOf(indices(14)), 'and reads nothing of the others');

  const later = collateralsAt(usdt, { numAssets: 17 });
  t.equal((await later.collaterals).length, 16, 'a seventeenth the Comet listed after the import is left out');
  t.strictSame(later.reads.sort(), readsOf(indices(16)), 'and never read');
});

/*
 * A Comet keeps an asset at its index, so a different asset there means the
 * version no longer describes the market (the chain drift check raises it).
 * What the Comet holds there is reported as the collateral that could not be
 * read, and is neither named after it nor counted in the total.
 */
t.test('an asset the Comet holds where the version describes another is reported, not valued', async t => {
  const STRANGER = '0x1111111111111111111111111111111111111111';
  const answers: Collateral[][] = [];
  for (const algorithm of ALGORITHMS) {
    const { collaterals, reads } = collateralsAt(usdt, { numAssets: 16, assetAt: { 3: STRANGER } }, algorithm);
    answers.push(await collaterals);
    t.strictSame(reads.sort(), [ 'assetInfo:3', ...readsOf(indices(16).filter(assetNumber => assetNumber !== 3)) ].sort(),
      `${algorithm}: of the stranger, only the asset at its index is read — neither its total nor its price`);
  }
  const [ recursive, all ] = answers as [ Collateral[], Collateral[] ];
  t.same(all, recursive, 'the working set and the recursive evaluator agree');

  t.match(all[3], {
    asset:  checksumAddress(usdt.registry.market.collateralAssets[3]!.token.address),
    symbol: 'UNI',
    price:  { status: 'error', message: `asset 3 of the Comet is ${STRANGER}, not the UNI the registry version describes` },
  }, 'the collateral the version describes there is reported as one that could not be read');
  t.equal(all[3]!.totalCollateral.toString(), '0', 'nothing of what the Comet holds there is reported as the token\'s');
  t.equal(collateralValue(all).toString(), String(2 * (136 - 4)), 'and the total leaves it out: indices 1 to 16 but 4, at two each');
});

/*
 * The price exceptions the registry seeded (registry/seed/production.json)
 * name the feeds wUSDM and pumpBTC had before governance delisted them,
 * moving both onto a "Constant price feed" that answers 1 at 8 decimals. A
 * collateral is priced with the feed its Comet reads at the block
 * summarized, so a block before the move applies the exceptions — wUSDM at
 * zero, pumpBTC at its feed's last answer, 1.02447384 BTC — without reading
 * either feed; the latest block reads the constant feed, at 10^-8, like any
 * other, and applies nothing.
 */
t.test('the seeded exceptions price wUSDM and pumpBTC where their Comet still reads the feed they name', async t => {
  const CONSTANT     = '0x7badab7109afbbf48ecd8d6498caacd2630b45b9';
  const WUSDM_FEED   = '0xe3a409ed15cd53afdefdd191ad945cec528a2496';
  const PUMPBTC_FEED = '0x351a133fd850ea81ed8a782016e308acbaddec91';
  const wbtc = fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === 'wbtc')!.comet;
  const position = (contract: RegistryComet, symbol: string) => contract.registry.market.collateralAssets.find(asset => asset.token.symbol === symbol)!;
  t.same([ position(usdt, 'wUSDM').priceFeed.address, position(wbtc, 'pumpBTC').priceFeed.address ], [ CONSTANT, CONSTANT ],
    'the version describes both on the constant feed they read now');

  // what one market's collaterals are priced at, when the Comet reads `feeds` in place of the ones the version describes
  const pricedAt = async (contract: RegistryComet, feeds: Record<number, string>) => {
    const asked: string[] = [];
    const { evaluate, pull1 } = evaluator({
      versionedCollaterals:    market.versionedCollaterals,
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
      versionedCollaterals: { apiHost: '', nodeHost: '', nodeKey: '', network, contract, blockNumber },
    })) as Collateral[];
    // the price of a collateral written out, or why it could not be read
    const priceOf = (symbol: string) => {
      const { price } = collaterals.find(entry => entry.symbol === symbol)!;
      return price.status === 'success' ? price.price.toString() : price;
    };
    return { priceOf, asked };
  };

  const usdtBefore = await pricedAt(usdt, { [position(usdt, 'wUSDM').assetIndex]: WUSDM_FEED });
  t.equal(usdtBefore.priceOf('wUSDM'), '0.0', 'before the move: wUSDM at zero');
  t.notOk(usdtBefore.asked.includes(WUSDM_FEED), 'without reading the feed that reverts');

  const wbtcBefore = await pricedAt(wbtc, { [position(wbtc, 'pumpBTC').assetIndex]: PUMPBTC_FEED });
  t.equal(wbtcBefore.priceOf('pumpBTC'), '1.02447384', 'pumpBTC at the last answer of its exchange-rate feed');
  t.notOk(wbtcBefore.asked.includes(PUMPBTC_FEED), 'which is not read either');

  const usdtNow = await pricedAt(usdt, {});
  const wbtcNow = await pricedAt(wbtc, {});
  t.same([ usdtNow.priceOf('wUSDM'), wbtcNow.priceOf('pumpBTC') ], [ '0.00000001', '0.00000001' ],
    'at the latest block both are read through the constant feed, at 10^-8');
  t.ok(usdtNow.asked.includes(CONSTANT) && wbtcNow.asked.includes(CONSTANT), 'which is read like any other feed');
});
