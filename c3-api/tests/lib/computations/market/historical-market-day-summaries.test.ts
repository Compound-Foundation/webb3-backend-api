import t       from 'tap';
import * as fs from 'node:fs/promises';

import * as jsonUtil from '../../../util/json.js';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import * as Fallible from '../../../../lib/fallible/fallible.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Index      from '../../../../lib/symbolic/index.js';
import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as KnownNetwork from '../../../../lib/well-known/networks/network.js';

import * as evm    from '../../../../lib/computations/evm.js';
import * as comet  from '../../../../lib/computations/comet.js';
import * as market from '../../../../lib/computations/market.js';

import { setupTestEnvVars } from '../../../util/setupTestEnvVars.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../shim/node-self.js';

/*
 * High-level test suite configuration.
 */
const network: KnownNetwork.Name = 'ethereum-mainnet';
const contract = Eth.wellKnownContractsByNetwork[network]['Comet']['cUSDCv3'];
const startBlock: Eth.Block.WithTimestamp = {
  number: 16_034_576,
  timestamp: 1_669_229_219,
};

/*
 * Global env.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);
const dumpPath = `tests/dumps/computations/market/historical-market-day-summaries`;

const testDebug = debug.scope('test');
testDebug.log({ flags });

let apiHost = '';
let nodeHost = '';
let nodeKey = '';

/*
 * block Fetch calls unless they`re explicitly expected
 */
import * as mock from '../../../util/mock/mock.js';
import RequestCountingFetch from '../../../../lib/request-counting-fetch.js';
RequestCountingFetch.debug.configure(process.env);
t.before(() => {
  ({ apiHost, nodeHost, nodeKey } = setupTestEnvVars());

  /*
   * Configure the fetch mock only to allow passing through the cache when
   * test flags are set to explicitly enable it.
   */
  global.fetch = mock.fetch({
    passthrough: flags.testAllowFetchPassthrough,
  });
});

/*
 *
 */

t.test(`historical-market-day-summaries@startBlock:${startBlock.number}`, async t => {
  /*
   * Load cache seed to skip calls to Infura.
   */
  const cacheSeedDumpPath = (
    `./${dumpPath}/01-usdc@startBlock:${startBlock.number}.cache-seed.json`
  );
  let seed = {};
  if (flags.testShouldLoadCacheSeed) {
    testDebug.log(`loading cache seed from ${cacheSeedDumpPath}`);
    seed = await jsonUtil.load<{ [_: string]: any }>(cacheSeedDumpPath);
  }
  const cache = new MemoryCache(seed, [
    BigFixnum.JsonReviver,
    BigNumber.JsonReviver,
  ]);
  /*
   * Load expected result dump.
   */
  const expectationDumpPath = (
    `./${dumpPath}/01-usdc@startBlock:${startBlock.number}.result.json`
  );
  let expectationDump: market.HistoricalMarketDaySummaries['returns'] = [];
  if (!flags.testRegenerateDump) {
    testDebug.log(`loading expectation dump from ${expectationDumpPath}`);
    expectationDump = await jsonUtil.load(expectationDumpPath);
  }
  /*
   * Evaluate the historical-market-day-summaries for 30 days from the
   * startBlock on mainnet, cUSDCv3 (01-usdc).
   */
  const evaluator = Evaluator.instantiate<market.HistoricalMarketDaySummaries>(
    {
      ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
      ...comet,
      ...market,
    },
    { cache, flags, debug },
  );
  const historicalSummaries = await evaluator.evaluate(evaluator.pull1({
    historicalMarketDaySummaries: {
      apiHost,
      nodeHost,
      nodeKey,
      network,
      contract,
      startBlock,
      daysBack: 30,
    }
  }));

  /*
   * Check that the result matches the expectation dump.
   */
  t.strictSame(
    historicalSummaries,
    expectationDump,
    `historical summary should match dump`,
  );

  /*
   * Check salient cache entries.
   */
  const enumerated = Fallible.must(Index.DailyBlockIndex.enumerate(
    { network, contract, block: startBlock },
    -30,
  ));
  const cachedKeys1 = Object.keys(cache.store);
  const expectedKeys = enumerated.flatMap(({ contract, network, block }) => [
    `marketSummary-v5:(block:${block.number};`
      + `contract:${contract.address};network:${network})`,
    `marketDaySummary-v5:(contract:${contract.address};`
      + `date:${Eth.Timestamp.toDateString(Eth.estimateBlockTimestamp(network, block))};`
      + `network:${network})`,
  ])
  .concat([
    `historicalMarketDaySummaries-v5:(contract:${contract.address};`
      + `daysBack:30;`
      + `network:${network};`
      + `startDate:${Eth.Timestamp.toDateString(startBlock.timestamp)})`,
  ]);

  for (const key of expectedKeys) {
    const similar = cachedKeys1.find(k => k.startsWith(key));
    t.strictSame(similar, key);
  }

  /*
   * check that re-running with an already-projected startBlock (so,
   * already included in the index) actually persists to cache properly.
   */
  const historicalSummaries2 = await evaluator.evaluate(evaluator.pull1({
    historicalMarketDaySummaries: {
      apiHost,
      nodeHost,
      nodeKey,
      network,
      contract,
      startBlock,
      daysBack: 30,
    }
  }));
  t.strictSame(historicalSummaries2, historicalSummaries,
    `re-running with projected startBlock yields the same result`
  );
  const cachedKeys2 = Object.keys(cache.store);
  t.strictSame(cachedKeys2, cachedKeys1, `cached keys do not change`);

  /*
   * If tests passed and we're supposed to regenerate the cache seed,
   * write cache entries beginning with 'eth' to the cache seed.
   */
  if (t.passing() && flags.testRegenerateCacheSeed) {
    testDebug.group(`regenerating cache seed: writing new seed...`);
    const newSeed = Object.fromEntries(
      Object.entries(cache.store)
        .filter(([ key ]) => key.startsWith('eth'))
    );
    await fs.writeFile(cacheSeedDumpPath, JSON.stringify(newSeed));
    testDebug.log(`✓ done`).groupEnd();
  }
  /*
   * If we're supposed to regenerate the expectation dump, ignore if tests
   * are failing and write the new result to the expectation dump.
   */
  if (flags.testRegenerateDump) {
    testDebug.group(`regenerating dump: writing new dump...`);
    await fs.writeFile(expectationDumpPath, JSON.stringify(historicalSummaries));
    testDebug.log(`✓ done`).groupEnd();
  }
});
