import t from 'tap';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import * as Fallible from '../../../../lib/fallible/fallible.js';

import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as evm    from '../../../../lib/computations/evm.js';
import * as comet  from '../../../../lib/computations/comet.js';
import * as market from '../../../../lib/computations/market.js';

import '../../../../shim/node-self.js';

import { setupTestEnvVars } from '../../../util/setupTestEnvVars.js';

/*
 * Global env.
 */

const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const testDebug = debug.scope('test');
testDebug.log({ flags });

let apiHost = '';
let nodeHost = '';
let nodeKey = '';
t.before(() => {
  ({ apiHost, nodeHost, nodeKey } = setupTestEnvVars());
});

/*
 *
 */

t.test(`market-summary@block:15435126`, async t => {
  const evaluator = Evaluator.instantiate<market.MarketSummary>(
    {
      ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
      ...comet,
      ...market,
    },
    {
      debug,
      flags,
      cache: new MemoryCache({}, [
        BigFixnum.JsonReviver,
        BigNumber.JsonReviver,
      ]),
    },
  );
  const marketSummary: market.MarketSummary['expects'] = {
    apiHost,
    nodeHost,
    nodeKey,
    contract: Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Comet']['cUSDCv3'],
    network: 'ethereum-mainnet',
    block: { number: 15_435_126 },
  };
  const result = await evaluator.evaluate(evaluator.pull1({ marketSummary }));
  t.strictSame(result, {
    chainId: 1,
    comet: {
      address: '0xc3d688b66703497daa19211eedff47f25384cdc3',
    },
    borrowApr: '0.040676825873232',
    supplyApr: '0.023842766908944',
    totalBorrowValue:     '4314230.2466899356248',
    totalCollateralValue: '7926309.21335647434063405362122141',
    totalSupplyValue:     '5880695.9243046279408',
    utilization: '733623598244969371',
    baseUsdPrice: '0.99999196',
    collateralAssetSymbols: [
      'COMP',
      'WBTC',
      'WETH',
      'UNI',
      'LINK'
    ]
  });
});

t.test(`market-day-summary@block:16380543`, async t => {
  const cache = new MemoryCache({}, [
    BigFixnum.JsonReviver,
    BigNumber.JsonReviver,
  ]);
  const evaluator = Evaluator.instantiate<(
    | market.MarketSummary
    | market.MarketDaySummary
  )>(
    { ...evm, ...comet, ...market },
    { cache, debug, flags },
  );
  const context: market.MarketDaySummary['expects'] = {
    apiHost,
    nodeHost,
    nodeKey,
    contract: Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Comet']['cUSDCv3'],
    network: 'ethereum-mainnet',
    block: {
      number:    16_380_543,
      timestamp: 1_673_432_423,
    },
  };

  /*
   * check projection
   */
  const projected = Fallible.must(
    market.marketDaySummary.index.project(context)
  );
  t.strictSame(
    projected,
    { ...context, block: { number: 16_375_778 } },
    `index projects to expected sample block`
  );

  /*
   * check result
   */
  const [ result1, expected ] = await evaluator.evaluate(evaluator.split([
    evaluator.pull1({ marketDaySummary: context }),
    evaluator.pull1({ marketSummary:  projected }),
  ]));
  t.match(result1, expected,
    `market-day-summary is the same as the market-summary at`
    + ` the indexed block for that day`
  );
  t.strictSame(result1, {
    chainId: 1,
    comet: {
      address: '0xc3d688b66703497daa19211eedff47f25384cdc3',
    },
    date: '2023-01-10',
    timestamp: 1_673_374_861,
    borrowApr: '0.033119718020784',
    supplyApr: '0.016825452442992',
    totalBorrowValue: '85848414.109706',
    totalCollateralValue: '205500797.77955724299515861328038964',
    totalSupplyValue: '165824411.75013',
    utilization: '517706230149330789',
    baseUsdPrice: '1.0',
    collateralAssetSymbols: [
      'COMP',
      'WBTC',
      'WETH',
      'UNI',
      'LINK'
    ]
  });

  /*
   * check for select expected cache keys
   */
  const cachedKeys1 = Object.keys(cache.store);
  const expectedKeys = [
    `marketSummary-v5:(block:${projected.block.number};contract:${context.contract.address};network:${context.network})`,
    /*
     * FIXME(jordan): since we project(..) within compute(..), the
     * index.includes(..) check fails on the block unless it happens
     * to be an indexed block, so marketDaySummary does not get cached.
     *
     * This is fine for marketDaySummary, which transparently invokes
     * marketSummary anyway; in the general case, however, this is a bug:
     * if a computation is set up to always project its input onto its
     * index, then it should also properly cache the result at the
     * projection from the input.
     */
    // `marketDaySummary-v2:(contract:${context.contract.address};date:2023-01-10;network:${context.network})`,
  ];
  for (const key of expectedKeys) {
    const similar = cachedKeys1.find(k => k.startsWith(key));
    t.strictSame(similar, key);
  }

  /*
   * verify that requesting another block in the same index window
   * returns the same result from cache.
   */
  const block2 = {
    ...context.block,
    number: 16_380_552,
    timestamp: 1_673_432_531,
  };
  const diff = block2.number - context.block.number;

  const projected2 = Fallible.must(
    market.marketDaySummary.index.project({ ...context, block: block2 })
  );
  t.strictSame(
    projected2,
    { ...context, block: { number: 16_375_778 } },
    `index projects to same sample block still for block + ${diff}`
  );

  const result2 = await evaluator.evaluate(evaluator.pull1({
    marketDaySummary: { ...context, block: block2 },
  }));
  // due to the timeskew fix/hack, we should not compare timestamps
  t.strictSame(result2, result1,
    `block + ${diff} should give the same result`
  );

  /*
   * check that cache is unchanged
   */
  t.strictSame(Object.keys(cache.store), cachedKeys1,
    `cache does not change after computing again at block + ${diff}`,
  );
});
