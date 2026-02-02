import t from "tap";

import * as Eth from "../../../../lib/eth-constants.js";
import * as Debug from "../../../../lib/debug-log.js";
import * as Flags from "../../../../lib/flags.js";
import * as Fallible from "../../../../lib/fallible/fallible.js";

import { BigNumber } from "../../../../lib/bignumber.js";
import { BigFixnum } from "../../../../lib/bigfixnum.js";

import * as Evaluator from "../../../../lib/symbolic/evaluator.js";
import { MemoryCache } from "../../../../lib/symbolic/cache.js";

import * as evm from "../../../../lib/computations/evm.js";
import * as comet from "../../../../lib/computations/comet.js";
import * as market from "../../../../lib/computations/market.js";

import "../../../../shim/node-self.js";

import { setupTestEnvVars } from '../../../util/setupTestEnvVars.js';

/*
 * Global env.
 */

const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const testDebug = debug.scope("test");
testDebug.log({ flags });

let apiHost = '';
let nodeHost = '';
let nodeKey = '';
t.before(() => {
  ({ apiHost, nodeHost, nodeKey } = setupTestEnvVars());
});

t.test(`market-minutely-summary@block:16380543`, async (t) => {
  const cache = new MemoryCache({}, [
    BigFixnum.JsonReviver,
    BigNumber.JsonReviver,
  ]);
  const evaluator = Evaluator.instantiate<
    market.MarketSummary | market.MarketMinutelySummary
  >({ ...evm, ...comet, ...market }, { cache, debug, flags });

  const context: market.MarketMinutelySummary["expects"] = {
    apiHost,
    nodeHost,
    nodeKey,
    contract:
      Eth.wellKnownContractsByNetwork["ethereum-mainnet"]["Comet"]["cUSDCv3"],
    network: "ethereum-mainnet",
    block: {
      number: 16_380_543,
      timestamp: 1_673_432_423,
    },
  };

  const projected = Fallible.must(
    market.marketMinutelySummary.index.project(context)
  );
  t.strictSame(
    projected,
    { ...context, block: { number: 16_380_541 } },
    `index projects to expected sample block`
  );

  /*
   * check result
   */
  const [result1, expected] = await evaluator.evaluate(
    evaluator.split([
      evaluator.pull1({ marketMinutelySummary: context }),
      evaluator.pull1({ marketSummary: projected }),
    ])
  );

  t.match(
    result1,
    expected,
    `market-minutely-summary is the same as the market-summary at` +
      ` the indexed block for that minute`
  );
  t.strictSame(result1, {
    chainId: 1,
    comet: {
      address: "0xc3d688b66703497daa19211eedff47f25384cdc3",
    },
    borrowApr: "0.034456615627104",
    supplyApr: "0.018066857369904",
    totalBorrowValue: "85029209.375671",
    totalSupplyValue: "152956822.280687",
    totalCollateralValue: "198600936.76810451139983159362475978",
    utilization: "555903304895608716",
    baseUsdPrice: "1.0",
    collateralAssetSymbols: ["COMP", "WBTC", "WETH", "UNI", "LINK"],
  });

  /*
   * check for select expected cache keys
   */
  const cachedKeys1 = Object.keys(cache.store);
  const expectedKeys = [
    `marketSummary-v5:(block:${projected.block.number};contract:${context.contract.address};network:${context.network})`,
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
    number: 16_380_542,
    timestamp: 1_673_432_531,
  };

  const diff = block2.number - context.block.number;

  const projected2 = Fallible.must(
    market.marketMinutelySummary.index.project({ ...context, block: block2 })
  );
  t.strictSame(
    projected2,
    { ...context, block: { number: 16_380_541 } },
    `index projects to same sample block still for block + ${diff}`
  );

  const result2 = await evaluator.evaluate(evaluator.pull1({
    marketMinutelySummary: { ...context, block: block2 },
  }));
  // due to the timeskew fix/hack, we should not compare timestamps
  t.strictSame(result2, result1,
    `block + ${diff} should give the same result`
  );
});
