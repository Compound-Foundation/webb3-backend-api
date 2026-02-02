import t from 'tap';
import * as fs from 'node:fs/promises';

import { setupTestEnvVars } from '../util/setupTestEnvVars.js';
import * as jsonUtil from '../util/json.js';

import * as Eth from '../../lib/eth-constants.js';
import * as Debug    from '../../lib/debug-log.js';
import * as Flags    from '../../lib/flags.js';
import { BigNumber } from '../../lib/bignumber.js';
import { BigFixnum } from '../../lib/bigfixnum.js';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import * as evm        from '../../lib/computations/evm.js';
import * as Evaluator  from '../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../lib/symbolic/cache.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../shim/node-self.js';

/*
 * Global test environment configuration
 */

const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);
const dumpPath = `tests/dumps/lib/timestamp-estimates`;
const cacheSeedDumpPath = `./${dumpPath}/blocks.cache-seed.json`;

const testDebug = debug.scope('test');
testDebug.log({ flags });

let apiHost = '';
let nodeHost = '';
let nodeKey = '';
t.before(() => {
  ({ apiHost, nodeHost, nodeKey } = setupTestEnvVars());
});

/*
 * Load cache seed to skip calls to Infura.
 */
let seed = {};
if (flags.testShouldLoadCacheSeed) {
  testDebug.log(`loading cache seed from ${cacheSeedDumpPath}`);
  seed = await jsonUtil.load<{ [_: string]: any }>(cacheSeedDumpPath);
}
const cache = new MemoryCache(seed, [
  BigFixnum.JsonReviver,
  BigNumber.JsonReviver,
]);
const evaluator = Evaluator.instantiate<evm.EthGetBlock>({
  ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
}, { cache });

async function latestBlock(network: KnownNetwork.Name): Promise<Eth.Block.WithTimestamp> {
  return evaluator.evaluate(evaluator.pull1({
    ethGetBlock: { apiHost, nodeHost, nodeKey, network, blockReference: 'latest' }
  }));
}

t.teardown(async () => {
  /*
   * If we're supposed to regenerate the cache seen, then at the end of
   * the full test run dump the live memory cache into a seed file.
   */
  if (flags.testRegenerateCacheSeed) {
    testDebug.group(`regenerating cache seed: writing new seed...`);
    const newSeed = Object.fromEntries(
      Object.entries(cache.store)
        .filter(([key]) => key.startsWith('eth'))
    );
    await fs.writeFile(cacheSeedDumpPath, JSON.stringify(newSeed));
    testDebug.log(`✓ done`).groupEnd();
  }
});

t.skip(`Eth.estimateBlockTimestamp(..)`, async t => {
  // polygon test blocks
  const polygonMainnetBlocks: Eth.BlockNumber[] = [];
  for (let number = 39_000_000; number < 42_700_000; number += 100_000) {
    polygonMainnetBlocks.push(number);
  }
  // arbitrum test blocks
  const arbitrumMainnetBlocks: Eth.BlockNumber[] = [];
  for (let number = 87_000_000; number < 90_000_000; number += 100_000) {
    arbitrumMainnetBlocks.push(number);
  }
  // ethereum test blocks
  const ethereumMainnetBlocks: Eth.BlockNumber[] = [
    17_227_817, 17_130_500, 17_000_000,
    16_700_000, 16_000_000, 15_800_500,
    15_600_000, // 14_500_000, 13_500_000,
    // NOTE(jordan): don't bother with pre-merge estimates
  ];
  const cases: [ KnownNetwork.Name, number, Eth.BlockReference[] ][] = [
    [ 'ethereum-mainnet', 3600,   [ 'latest', ...ethereumMainnetBlocks           ]],
    [ 'polygon-mainnet',  10_800, [ /*'latest',*/ ...polygonMainnetBlocks.reverse()  ]],
    [ 'arbitrum-mainnet', 3600,   [ /*'latest',*/ ...arbitrumMainnetBlocks.reverse() ]],
  ];

  // TODO: base-mainnet test blocks
  for (const [ network, epsilon, testBlockReferences ] of cases) {
    const fullBlocks = (await evaluator.evaluate(
      evaluator.split(testBlockReferences.map(blockReference => (
        evaluator.pull1({ ethGetBlock: { apiHost, nodeHost, nodeKey, network, blockReference } })
      ))
    )));

    for (const block of fullBlocks) {
      const estimate = Eth.estimateBlockTimestamp(network, block);
      const actual = block.timestamp;
      const error  = estimate - actual;
      t.ok(
        Math.abs(error) <= epsilon,
        `[${network}] estimate @ ${block.number} not within ${epsilon}s of actual;`
          + ` ${JSON.stringify({ estimate, actual, error })}`,
      );
      const estimateDate = Eth.Timestamp.toDateString(estimate);
      const actualDate   = Eth.Timestamp.toDateString(actual);
      // don't enforce same-day for polygon-mainnet, it's a crapshoot
      if (network === 'polygon-mainnet') {
        continue;
      }
      t.equal(
        estimateDate, actualDate,
        `[${network}] estimate @ ${block.number} is on the wrong day`,
      );
    }
  }
});

t.skip(`Eth.estimateBlockTimestampRelative(..)`, async t => {
  //
  const polygonLatest = await latestBlock('polygon-mainnet');
  const polygonMainnetBlocks: Eth.BlockNumber[] = [];
  for (let distance = 5_000; distance < 50_000; distance += 5_000) {
    polygonMainnetBlocks.push(polygonLatest.number - distance);
  }
  //
  const arbitrumLatest = await latestBlock('arbitrum-mainnet');
  const arbitrumMainnetBlocks: Eth.BlockNumber[] = [];
  for (let distance = 50_000; distance < 425_000; distance += 50_000) {
    arbitrumMainnetBlocks.push(arbitrumLatest.number - distance);
  }

  // TODO: add base-mainnet once comet base-mainnet is deployed
  const cases: [ KnownNetwork.Name, Eth.Block.WithTimestamp, number, Eth.BlockReference[] ][] = [
    [ 'polygon-mainnet',  polygonLatest,  3600, polygonMainnetBlocks.reverse()  ],
    [ 'arbitrum-mainnet', arbitrumLatest, 3600, arbitrumMainnetBlocks.reverse() ],
  ];

  for (const [ network, latest, epsilon, blockReferences ] of cases) {
    // XXX disable polygon-mainnet relative timestamp estimate tests
    if (network === 'polygon-mainnet') {
      continue;
    }
    const fullBlocks = (await evaluator.evaluate(
      evaluator.split(blockReferences.map(blockReference => (
        evaluator.pull1({ ethGetBlock: { apiHost, nodeHost, nodeKey, network, blockReference } })
      ))
    )));

    for (const block of fullBlocks) {
      const estimate = Eth.estimateBlockTimestampRelative(network, block, latest);
      const actual = block.timestamp;
      const error  = estimate - actual;
      t.ok(
        Math.abs(error) <= epsilon,
        `[${network}] relative estimate @ ${block.number} is within ${epsilon}s of actual;`
          + ` ${JSON.stringify({ estimate, actual, error, distance: (latest.number - block.number) })}`,
      );
      const estimateDate = Eth.Timestamp.toDateString(estimate);
      const actualDate   = Eth.Timestamp.toDateString(actual);
      t.equal(
        estimateDate, actualDate,
        `[${network}] relative estimate @ ${block.number} is on the correct day`,
      );
    }
  }
});
