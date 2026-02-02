import t from 'tap';

import * as fs         from 'node:fs/promises';
import * as streamInto from 'node:stream/consumers';

import C3Api, { Env } from '../../../../entrypoint.js';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as KnownNetwork from '../../../../lib/well-known/networks/network.js';

import { ResponseData } from '../../../../src/v2-handlers/ctokens.js';

import * as mock                from '../../../util/mock/mock.js';
import * as jsonUtil            from '../../../util/json.js';
import { MemoryKv, encodeSeed } from '../../../util/kv.js';

import { setupTestEnvVars } from '../../../util/setupTestEnvVars.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../shim/node-self.js';

/*
 * High-level test suite configuration.
 */
const network: KnownNetwork.Name = 'ethereum-mainnet';
const testBlock: Eth.Block.WithTimestamp = {
  number:       16_750_522,
  timestamp: 1_677_877_427,
  date:       '2023-03-03',
};
const flags = Flags.parseWithDefaults(process.env);
const route = `legacy/mainnet/ctokens`;

const { apiHost, nodeHost, nodeKey } = setupTestEnvVars();

/*
 * Set up a fetch mock for each test and assert it is satisfied by the end
 */
declare var fetch: mock.Fetch;
t.before(() => {
  /*
   * Configure the fetch mock only to allow passing through the cache when
   * test flags are set to explicitly enable it.
   */
  global.fetch = mock.fetch({ passthrough: flags.testAllowFetchPassthrough });
});

t.test(`/${route} @ block=${testBlock.number}`, async t => {
  /*
   * 1. Setup
   */
  /*
   * Load cache seed. Preloading ethGetLogs and ethGetBlock results allows
   * us to skip over 2m of I/O and up to hundreds of Infura calls.
   */
  const v3CacheSeedDumpPath = (
    `./tests/dumps/${route}/ctokens@blockNumber:${testBlock.number}.cache-seed.json`
  );
  // NOTE: Only load the cache seed if test flags configuration says so
  const seedJson = !flags.testShouldLoadCacheSeed ? {} : (
    await jsonUtil.load<{ [_: string]: any }>(v3CacheSeedDumpPath)
  );

  /*
   * Load the expectation dump.
   */
  const v3ExpectationDumpPath = (
    `./tests/dumps/${route}/ctokens@blockNumber:${testBlock.number}.expected.json`
  );
  let v3Dump: ResponseData = { cToken: []};
  if (!flags.testRegenerateDump) {
    v3Dump = await jsonUtil.load<ResponseData>(
      v3ExpectationDumpPath,
      [
        BigNumber.JsonReviver,
        BigFixnum.JsonReviver,
      ]
    );
  }

  /*
   * Set up the test env, seeding in-memory test KVs with the cache seed.
   */
  // pre-encode seed JSON into in-memory KV format so we only encode once.
  const seed = encodeSeed(seedJson);
  const testEnv: Env = Object.assign({
    'TALLY_API_KEY':       'test',
    'V3_API_HOST':         apiHost,
    'NODE_PROXY_HOST':     nodeHost,
    'NODE_PROXY_KEY':      nodeKey,
    'ENVIRONMENT':         'test',
    'MEMORY_CACHE_SEED':   'proposal-vote-receipts',
    'kv_testnet':  MemoryKv({ seed }),
    'kv_mainnet': MemoryKv({ seed }),
  }, process.env);

  /*
   * Expect a fetch for the latest block, mock it to return testBlock so
   * that our test returns consistent results. Since 'latest' requests are
   * never cached, this is the most reliable mechanism by which we can
   * hold the block number constant under test during full e2e testing.
   *
   * NOTE if the seed is not up to date, the fetch mock will start
   * throwing errors when it receives unexpected calls that pass through
   * the cache.
   */
  mock.rpc.expectPost(fetch, Eth.nodeEndpoint(testEnv.NODE_PROXY_HOST, testEnv.NODE_PROXY_KEY, network),
    mock.rpc.ethGetBlock(testBlock, { reference: 'latest' })
  )

  /*
   * 2. Evaluation
   */
  let request  = new Request(`https://test.local/${route}`);
  let response = await C3Api.fetch(request, testEnv);
  if (!response.body) {
    t.bailout(`C3Api.fetch response has no body, test cannot continue.`);
  };
  let responseJson: any = await streamInto.json(response.body as any);
  t.ok(typeof(responseJson) === 'object');
  const actualData = responseJson as ResponseData;

  t.equal(actualData.cToken.length, v3Dump.cToken.length, `cToken.length`);
  for (const expectedCToken of v3Dump.cToken) {
    const actualCtoken = actualData.cToken.find(cToken => cToken.symbol === expectedCToken.symbol);
    if (actualCtoken === undefined) {
      t.ok(false, `expected cToken with symbol ${expectedCToken.symbol} could not be found.`);
    }
    else {
      t.strictSame(actualCtoken, expectedCToken);
    }
  }

  /*
   * If tests passed and we're supposed to regenerate the cache seed,
   * write all the cache entries beginning with 'eth' to the cache seed.
   */
  if (flags.testRegenerateCacheSeed) {
    const newSeedStringEntries: string[] = [];
    for (const [ key, { value: utf8Bytes } ] of seed.entries()) {
      // only add eth* computations to the cache seed
      if (!key.startsWith('eth')) {
        continue;
      }
      // already JSON.stringify-ed, so don't re-parse-stringify it...
      const valueString = Buffer.from(utf8Bytes).toString('utf8');
      newSeedStringEntries.push(`"${key}":${valueString}`);
    }
    const newSeed = `{${newSeedStringEntries.join(',')}}`;
    await fs.writeFile(v3CacheSeedDumpPath, newSeed);
  }
  /*
   * If we're supposed to regenerate the expectation dump, ignore if tests
   * are failing and write the new result to the expectation dump.
   */
  if (flags.testRegenerateDump) {
    await fs.writeFile(v3ExpectationDumpPath, JSON.stringify(actualData));
  }

  /*
   * Assert that all expected mock fetch calls were made.
   */
  fetch.satisfy(t);
});
