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

import { setupTestEnvVars }        from '../../../util/setupTestEnvVars.js';
import { fixtureComet, sha256Hex } from '../../../util/registry-fixture.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../shim/node-self.js';

/*
 * High-level test suite configuration.
 */
const network: KnownNetwork.Name = 'ethereum-mainnet';
const contract = fixtureComet(network, '0xc3d688b66703497daa19211eedff47f25384cdc3');
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

/*
 * The dumps hold this computation's result for cUSDCv3 (the expectation) and
 * what it read on the way (the cache seed). Both live in R2, outside the
 * repository, in one place every branch shares, while the result changes
 * with the computation: since version 6 a day summary reports the status of
 * its price reads.
 *
 * So they are named by the SHA-256 of the expectation, which this test pins,
 * as the all-networks historical summary pins its own. Regenerating them
 * writes new files beside the old ones, and makes a change to the line below
 * that is reviewed like any other. Null is an expectation nobody has recorded
 * yet. See "How to Update E2E test dumps" in the README.
 */
const EXPECTATION_SHA256 = null as string | null;

const dumpName = `${dumpPath}/01-usdc@startBlock:${startBlock.number}`;
const expectationDumpPath = (sha256: string) => `./${dumpName}@sha256:${sha256}.result.json`;
const cacheSeedDumpPath   = (sha256: string) => `./${dumpName}@sha256:${sha256}.cache-seed.json`;

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
  if (EXPECTATION_SHA256 === null && !flags.testRegenerateDump) {
    t.fail(`no expectation is pinned for ${dumpName}: regenerate its dumps and pin the SHA-256 of the expectation in EXPECTATION_SHA256`);
    return;
  }
  /*
   * Load cache seed to skip calls to Infura, when there is one to load.
   */
  let seed = {};
  if (flags.testShouldLoadCacheSeed && EXPECTATION_SHA256 !== null) {
    testDebug.log(`loading cache seed from ${cacheSeedDumpPath(EXPECTATION_SHA256)}`);
    seed = await jsonUtil.load<{ [_: string]: any }>(cacheSeedDumpPath(EXPECTATION_SHA256));
  }
  const cache = new MemoryCache(seed, [
    BigFixnum.JsonReviver,
    BigNumber.JsonReviver,
  ]);
  /*
   * Load expected result dump, the one this test pins.
   */
  let expectationDump: market.HistoricalMarketDaySummaries['returns'] | null = null;
  if (!flags.testRegenerateDump && EXPECTATION_SHA256 !== null) {
    testDebug.log(`loading expectation dump from ${expectationDumpPath(EXPECTATION_SHA256)}`);
    const expectation = await fs.readFile(expectationDumpPath(EXPECTATION_SHA256), 'utf8');
    t.equal(sha256Hex(expectation), EXPECTATION_SHA256, 'the expectation dump is the one this test pins');
    expectationDump = JSON.parse(expectation);
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
  if (expectationDump !== null) {
    t.strictSame(
      historicalSummaries,
      expectationDump,
      `historical summary should match dump`,
    );
  }

  /*
   * Check salient cache entries.
   */
  const enumerated = Fallible.must(Index.DailyBlockIndex.enumerate(
    { network, contract, block: startBlock },
    -30,
  ));
  const cachedKeys1 = Object.keys(cache.store);
  const expectedKeys = enumerated.flatMap(({ contract, network, block }) => [
    `marketSummary-v6:(block:${block.number};`
      + `contract:${contract.key()};network:${network})`,
    `marketDaySummary-v6:(contract:${contract.key()};`
      + `date:${Eth.Timestamp.toDateString(Eth.estimateBlockTimestamp(network, block))};`
      + `network:${network})`,
  ])
  .concat([
    `historicalMarketDaySummaries-v6:(contract:${contract.key()};`
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
   * If we're supposed to regenerate the expectation dump, ignore if tests
   * are failing and write the new result to a dump named by its SHA-256,
   * which is then pinned in EXPECTATION_SHA256.
   */
  let pinned = EXPECTATION_SHA256;
  if (flags.testRegenerateDump) {
    testDebug.group(`regenerating dump: writing new dump...`);
    const expectation = JSON.stringify(historicalSummaries);
    pinned = sha256Hex(expectation);
    await fs.writeFile(expectationDumpPath(pinned), expectation);
    t.comment(`regenerated ${expectationDumpPath(pinned)}: pin it with EXPECTATION_SHA256 = '${pinned}'`);
    testDebug.log(`✓ done`).groupEnd();
  }
  /*
   * If tests passed and we're supposed to regenerate the cache seed,
   * write cache entries beginning with 'eth' to the cache seed of the
   * expectation.
   */
  if (t.passing() && flags.testRegenerateCacheSeed && pinned !== null) {
    testDebug.group(`regenerating cache seed: writing new seed...`);
    const newSeed = Object.fromEntries(
      Object.entries(cache.store)
        .filter(([ key ]) => key.startsWith('eth'))
    );
    await fs.writeFile(cacheSeedDumpPath(pinned), JSON.stringify(newSeed));
    testDebug.log(`✓ done`).groupEnd();
  }
});
