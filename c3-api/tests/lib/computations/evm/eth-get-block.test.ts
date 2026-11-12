import t from 'tap';

import { Env } from '../../../../entrypoint.js';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as KnownNetwork from '../../../../lib/well-known/networks/network.js';

import * as evm from '../../../../lib/computations/evm.js';

import type * as jsonRpc from '../../../../lib/json-rpc.js';

import { consoleLines } from '../../../util/console.js';
import { makeTestEnv } from '../../../util/test-env.js';
import * as mock from '../../../util/mock/mock.js';

import { setupTestEnvVars } from '../../../util/setupTestEnvVars.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../shim/node-self.js';

/*
 * global env
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);
const { apiHost, nodeHost, nodeKey } = setupTestEnvVars();

/*
 * High-level test suite configuration.
 */
const network: KnownNetwork.Name = 'ethereum-mainnet';
const getBlockLatest: evm.EthGetBlock['expects'] = {
  apiHost: apiHost,
  nodeHost: nodeHost,
  nodeKey: nodeKey,
  network,
  blockReference: 'latest',
};
const getBlockNumber: (_: number) => evm.EthGetBlock['expects'] = number => ({
  apiHost: apiHost,
  nodeHost: nodeHost,
  nodeKey: nodeKey,
  network,
  blockReference: number,
});

const testEnv: Env = makeTestEnv({
  V3_API_HOST: apiHost,
  NODE_PROXY_HOST: nodeHost,
  NODE_PROXY_KEY: nodeKey,
  MEMORY_CACHE_SEED: "market-historical-summary",
});

/*
 * Set up a fetch mock for the test suite.
 */
declare var fetch: mock.Fetch;
t.before(() => {
  /*
   * Configure the fetch mock only to allow passing through the cache when
   * test flags are set to explicitly enable it.
   */
  global.fetch = mock.fetch({
    passthrough: flags.testAllowFetchPassthrough,
  });
});

/*
 * Enumerate the blocks used in tests.
 */
const testBlocks = [ // NOTE: leet 0xbeef
  { number:       1337, timestamp: 1_438_272_853, date: '2015-07-30', transactions: [] }, // FIXME: gross
  { number:     48_879, timestamp: 1_438_964_627, date: '2015-08-07', transactions: [] }, // FIXME: gross
  { number: 16_236_698, timestamp: 1_671_669_419, date: '2022-12-22', transactions: [] }, // FIXME: gross
];

t.test(`ethGetBlock of 'latest' should not be cached`, async t => {
  /*
   * Set up the fetch mock to expect two calls for the latest block, and
   * to return different latest blocks on each call.
   */
  for (const testBlock of testBlocks.slice(0, 2)) {
    mock.rpc.expectPost(fetch, Eth.nodeEndpoint(testEnv.NODE_PROXY_HOST, testEnv.NODE_PROXY_KEY, network),
      mock.rpc.ethGetBlock(testBlock, { reference: 'latest' })
    );
  }
  /*
   * Use an empty in-memory cache. It should remain empty for the duration
   * of the test, since the 'latest' block is never cached.
   */
  const cache = new MemoryCache({}, [
    BigNumber.JsonReviver,
    BigFixnum.JsonReviver,
  ]);
  const { pull1, evaluate } = Evaluator.instantiate<evm.EthGetBlock>(
    evm.applyIndexBias(flags.ethComputationIndexBias, evm),
    { cache, debug, flags }
  );
  /*
   * The first call should succeed and leave the cache empty.
   */
  const latestBlock1 = await evaluate(pull1({ ethGetBlock: getBlockLatest }));
  t.strictSame(Object.keys(cache.store), [], `nothing should be cached`);
  /*
   * The second call should succeed and leave the cache empty.
   */
  const latestBlock2 = await evaluate(pull1({ ethGetBlock: getBlockLatest }));
  t.strictSame(Object.keys(cache.store), [], `nothing should be cached`);
  /*
   * The latest block after the second call should not be the same as the
   * earlier latest block.
   */
  t.strictNotSame(
    latestBlock1,
    latestBlock2,
    `latest block should change on subsequent requests (mocked)`
  );
  /*
   * Ensure every expected fetch mock call is satisfied.
   */
  fetch.satisfy(t);
});

t.test(`ethGetBlock of a specific block should be cached`, async t => {
  /*
   * TestStep
   *
   * The test is performed in steps. Every step has a string description.
   *
   * A step must not depend on its order relative to any other step (steps
   * will be shuffled before they are run).
   *
   * Every test step is associated with an Eth.Block, which is used to
   * construct the Redex.Lookup of the ethGetBlock computation which will
   * be evaluated during the test step.
   *
   * A step may either expect a successful result, or an expected error.
   */
  type TestStep = (
    | TestStepOk
    | TestStepError
  );
  interface TestStepBase {
    block:       Eth.Block.WithTimestamp,
    description: string,
    request?: {
      reference:              Eth.BlockReference,
      showTransactionDetails: boolean,
    },
  }
  /*
   * A successful TestStep names the cacheKey it expects will be added to
   * the cache upon completion of the step.
   */
  interface TestStepOk extends TestStepBase {
    cacheKeys: string[],
  };
  /*
   * An error TestStep expects an Error with a message that matches a
   * RegExp pattern. The expected Error is produced either by a malformed
   * result, or by an injected jsonRpc error.
   */
  interface TestStepError extends TestStepBase {
    except: RegExp,
    inject?: (
      | { error:  jsonRpc.Error }
      | { result: any           }
    ),
  };
  /*
   * Compute the set of test steps.
   */
  const testSteps: TestStep[] = [];
  /*
   * Add a successful test step for each configured test block.
   */
  for (let i = 0; i < testBlocks.length; i++) {
    const testBlock = testBlocks[i];
    const context = getBlockNumber(testBlock.number);
    testSteps.push({
      block:  testBlock,
      cacheKeys: [ await evm.ethGetBlock.key('ethGetBlock-v1', context) ],
      description: `get block @ ${testBlock.number}`,
    });
  }
  /*
   * Add test steps that inject jsonRpc errors.
   */
  const badbadBlock: Eth.Block.WithTimestamp = {
    number:       12_245_933, // 0xbadbad
    timestamp: 1_618_506_539, // 0x6078732b
    date:       '2021-04-15',
  };
  testSteps.push({ // mock jsonRpc error
    block: badbadBlock,
    except: /^eth_getBlockByNumber:.+jsonRpc error:.+$/,
    description: 'jsonRpc error code=-10000 (mocked)',
    inject: {
      error: { code: -10000, message: 'mock jsonRpc error' },
    },
  });
  /*
   * Add test steps that inject malformed results.
   */
  const malformed = (result: any) => ({
    inject: { result },
    block: badbadBlock,
    except: /^eth_getBlockByNumber:.+malformed.+$/,
    description: `malformed result of ${JSON.stringify(result) ?? result}`,
  });
  testSteps.push(...[
    '',
    NaN,
    null,
    // missing timestamp
    { number:    '0xbadbad' },
    // missing number
    { timestamp: '0x6078732b' },
    { // bad number
      number:    'notanumberlol',
      timestamp: '0x6078732b',
    },
    { // bad timestamp
      number:    '0xbadbad',
      timestamp: 'notatimestamp',
    },
  ].map(malformed));
  /*
   * Shuffle the order of the test steps; test results should not depend
   * on order in any way.
   *
   * NOTE: this is a BAD shuffle algorithm, but it's OK for a quick hack.
   */
  testSteps.sort(() => [ -1, 1 ][(Math.random() * 2 | 0)]);
  /*
   * Use an empty in-memory cache. It will slowly grow to include every
   * block requested across all test steps.
   */
  const cache = new MemoryCache({}, [
    BigNumber.JsonReviver,
    BigFixnum.JsonReviver,
  ]);
  const { pull1, evaluate } = Evaluator.instantiate<evm.EthGetBlock>(
    evm.applyIndexBias(flags.ethComputationIndexBias, evm),
    { cache, debug, flags }
  );
  /*
   * Track the expected cache keys over the course of the full test suite,
   * adding new keys for every expected-successful test step.
   */
  let expectedCacheKeys: string[] = [];
  /*
   * Iterate over the shuffled test steps and assert each step's expected
   * result or error.
   */
  for (let i = 0; i < testSteps.length; i++) {
    const expected = testSteps[i];
    const prefix = `testStep[${expected.description}]`;
    const lookup = { ethGetBlock: getBlockNumber(expected.block.number) };
    /*
     * Error steps have an `except` RegExp.
     */
    if ('except' in expected) {
      /*
       * Set up the fetch mock to expect a JSON-RPC call for this step,
       * with an injected jsonRpc error or malformed result.
       */
      mock.rpc.expectPost(fetch, Eth.nodeEndpoint(testEnv.NODE_PROXY_HOST, testEnv.NODE_PROXY_KEY, network),
        mock.rpc.ethGetBlock(expected.block, expected.inject)
      );

      /*
       * Expect the test step to throw and reject during evaluation.
       */
      try {
        await evaluate(pull1(lookup));
        /*
         * Cancel the remainder of the stateful test suite run if any
         * error test does not reject; the state (e.g. cache) must be
         * assumed corrupt and any future test steps are invalid.
         */
        return t.fail(`${prefix}: injected a fault but did not reject?`);
      } catch (e: unknown) {
        /*
         * Expect the error message to match the except RegExp.
         */
        t.ok(
          expected.except.test((e as Error).message),
          `${prefix}: error message matches ${expected.except}`
        );
        /*
         * Ensure every expected fetch mock call is satisfied.
         */
        fetch.satisfy(t);
      }
      continue;
    }
    /*
     * There is no expected exception. The test step should succeed.
     *
     * Set up the fetch mock to expect a JSON-RPC call for this step.
     */
    mock.rpc.expectPost(fetch, Eth.nodeEndpoint(testEnv.NODE_PROXY_HOST, testEnv.NODE_PROXY_KEY, network),
      mock.rpc.ethGetBlock(expected.block)
    );
    expectedCacheKeys.push(...expected.cacheKeys);
    /*
     * Evaluate the test step for the first time and assert expectations.
     */
    const result1 = await evaluate(pull1(lookup));
    t.strictSame(
      result1,
      expected.block,
      `${prefix}: result matches expected`
    );
    t.strictSame(
      Object.keys(cache.store),
      expectedCacheKeys,
      `${prefix}: cache includes exactly the expected keys`
    );
    /*
     * Ensure every expected fetch mock call is satisfied.
     */
    fetch.satisfy(t);
    /*
     * Perform the evaluation again, and assert the result is the same,
     * and the cache has the same keys (no more or fewer than before).
     *
     * NOTE: there should be no additional fetches; we already asserted
     * that the fetch mock is satisfied, so any additional fetches will
     * be unexpected and will raise an exception.
     *
     * NOTE: if the test is already failing, don't re-evaluate successful
     * test steps; we are likely to get the same failures.
     */
    if (!t.passing()) {
      continue;
    }
    const result2 = await evaluate(pull1(lookup));
    t.strictSame(
      result2,
      expected.block,
      `${prefix}: 2nd evaluate result matches the first`
    );
    t.strictSame(
      Object.keys(cache.store),
      expectedCacheKeys,
      `${prefix}: 2nd evaluate does not change cached keys`
    );
  }
});

/*
 * The header of a block of a known number is its number and its timestamp,
 * or null where the node did not give it: a provider that does not have the
 * block yet answers null, a call can err on every provider, and an answer can
 * be no block or another block. None of them fails the read, each is said in
 * the log once a minute for its network, and none is cached, whatever the
 * index bias, the header given included: a header nobody gave is an answer of
 * the moment, and is asked for again. What a reader keeps of it is its own,
 * as the summary keeps it with its minute (market-minutely-summary.ts).
 */
t.test('ethGetBlockHeader answers a block\'s header, or null where the node does not give it, and caches neither', async t => {
  const logged = consoleLines(t, [ 'warn' ]);
  const cache  = new MemoryCache({}, [
    BigNumber.JsonReviver,
    BigFixnum.JsonReviver,
  ]);
  const { pull1, evaluate } = Evaluator.instantiate<evm.EthGetBlockHeader>(
    evm.applyIndexBias('Everything', evm),
    { cache, debug, flags }
  );
  const block    = testBlocks[2]!;
  const endpoint = (on: KnownNetwork.Name) => Eth.nodeEndpoint(testEnv.NODE_PROXY_HOST, testEnv.NODE_PROXY_KEY, on);
  const header   = (on: KnownNetwork.Name) => evaluate(pull1({ ethGetBlockHeader: { apiHost, nodeHost, nodeKey, network: on, blockNumber: block.number } }));

  mock.rpc.expectPost(fetch, endpoint(network), mock.rpc.ethGetBlock(block));
  t.strictSame(await header(network), { number: block.number, timestamp: block.timestamp }, 'its number and timestamp, and nothing else of the block');
  fetch.satisfy(t);
  t.strictSame(logged, [], 'which says nothing in the log');

  // each on a network of its own, which the log names once a minute
  const missing: Array<[ string, KnownNetwork.Name, Partial<mock.rpc.ethGetBlock.Options>, RegExp ]> = [
    [ 'a block the provider does not have yet', 'ethereum-mainnet', { result: null }, /: no such block$/ ],
    [ 'a call that erred on every provider', 'base-mainnet', { error: { code: -32000, message: 'header not found' } }, /: call error: .*header not found/ ],
    [ 'another block than the one asked for', 'arbitrum-mainnet', { result: { number: '0x1', timestamp: '0x6078732b', transactions: [] } }, /: malformed result$/ ],
    [ 'a malformed answer', 'optimism-mainnet', { result: { number: `0x${block.number.toString(16)}` } }, /: malformed result$/ ],
  ];
  for (const [ what, on, answer, said ] of missing) {
    logged.length = 0;
    mock.rpc.expectPost(fetch, endpoint(on), mock.rpc.ethGetBlock(block, answer));
    t.equal(await header(on), null, `${what}: null`);
    fetch.satisfy(t);
    t.equal(logged.length, 1, `${what}: said in the log`);
    t.match(logged[0], `block header not read: block ${block.number} on ${on}`, `${what}: naming the block and the network`);
    t.match(logged[0], said, `${what}: and why`);
  }

  logged.length = 0;
  mock.rpc.expectPost(fetch, endpoint(network), mock.rpc.ethGetBlock(block, { result: null }));
  t.equal(await header(network), null, 'a header asked for again is read again');
  fetch.satisfy(t);
  t.strictSame(logged, [], 'and not said again for its network within the minute');
  t.strictSame(Object.keys(cache.store), [], 'and nothing is cached, though the bias indexes every other read of the chain');
});
