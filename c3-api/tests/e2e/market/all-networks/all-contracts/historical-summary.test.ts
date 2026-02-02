import t from "tap";
import * as streamInto from "node:stream/consumers";
import * as fs         from 'node:fs/promises';

import * as jsonUtil from "../../../../util/json.js";
import { MemoryKv, encodeSeed } from "../../../../util/kv.js";

import * as Eth from "../../../../../lib/eth-constants.js";
import * as Flags from "../../../../../lib/flags.js";

import C3Api, { Env } from "../../../../../entrypoint.js";

import * as KnownNetwork from "../../../../../lib/well-known/networks/network.js";

import * as mock from "../../../../util/mock/mock.js";
import * as Debug    from '../../../../../lib/debug-log.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import "../../../../../shim/node-self.js";

import { setupTestEnvVars } from '../../../../util/setupTestEnvVars.js';
/*
 * High-level test suite configuration.
 */
const testBlocks: { [key in string]: Eth.Block.WithTimestamp } = {
  "ethereum-mainnet": {
    number: 21_820_087,
    timestamp: 1_739_238_359,
    date: "2025-02-11",
  },
  "polygon-mainnet": {
    number: 58_479_907,
    timestamp: 1_719_081_789,
    date: "2024-06-22",
  },
  "arbitrum-mainnet": {
    number: 223_796_350,
    timestamp: 1_718_876_435,
    date: "2024-06-20",
  },
  "base-mainnet": {
    number: 26_046_502,
    timestamp: 1_738_882_351,
    date: "2025-02-06",
  },
  "scroll-mainnet": {
    number: 4_597_597,
    timestamp: 1_712_087_693,
    date: "2024-04-02",
  },
  "optimism-mainnet": {
    number: 122_730_232,
    timestamp: 1_721_059_241,
    date: "2024-05-20",
  },
  "mantle-mainnet": {
    number: 70_789_050,
    timestamp: 1_729_708_412,
    date: "2024-10-23",
  },
  "linea-mainnet": {
    number: 20_601_032,
    timestamp: 1_738_189_859,
    date: "2025-01-29",
  },
  "unichain-mainnet": {
    number: 15_416_769,
    timestamp: 1_746_139_928,
    date: "2025-02-18",
  },
  "ronin-mainnet": {
    number: 44_084_652,
    timestamp: 1_744_106_923,
    date: "2025-04-08",
  },
};
const mainnetBlockNumber = testBlocks["ethereum-mainnet"].number;
const flags = Flags.parseWithDefaults(process.env);
const route = `market/all-networks/all-contracts/historical/summary`;
const debug = Debug.MakeLogger([]).configure(process.env);
const testDebug = debug.scope('test');
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
  global.fetch = mock.fetch({
    passthrough: flags.testAllowFetchPassthrough,
  });
});

t.test(`/${route} @ block=${mainnetBlockNumber}`, async (t) => {
  /*
   * 1. Setup
   */
  /*
   * Load cache seed. Preloading ethGetLogs and ethGetBlock results allows
   * us to skip over 2m of I/O and up to hundreds of Infura calls.
   */
  const v3CacheSeedDumpPath = `./tests/dumps/${route}@blockNumber:${mainnetBlockNumber}.cache-seed.json`;
  // NOTE: Only load the cache seed if test flags configuration says so
  const seedJson = !flags.testShouldLoadCacheSeed
    ? {}
    : await jsonUtil.load<{ [_: string]: any }>(v3CacheSeedDumpPath);

  /*
   * Set up the test env, seeding in-memory test KVs with the cache seed.
   */
  // pre-encode seed JSON into in-memory KV format so we only encode once.
  const seed = encodeSeed(seedJson);
  const testEnv: Env = Object.assign(
    {
      TALLY_API_KEY: "test",
      V3_API_HOST: apiHost,
      NODE_PROXY_HOST: nodeHost,
      NODE_PROXY_KEY: nodeKey,
      ENVIRONMENT: "test",
      MEMORY_CACHE_SEED: "market-historical-summary",
      kv_testnet: MemoryKv({ seed }),
      kv_mainnet: MemoryKv({ seed }),
    },
    process.env
  );

  /*
   * Mock fetch setup: each test should make 1 fetch for the 'latest' block
   * on each network. All other IO should be cached by the cache-seed.
   */
  /*
   * Expect a fetch for the latest block, mock it to return testBlock so
   * that our test returns consistent results.
   */
  for (const network in testBlocks) {
    const testBlock = testBlocks[network];

    mock.rpc.expectPost(
      fetch,
      Eth.nodeEndpoint(testEnv.NODE_PROXY_HOST, testEnv.NODE_PROXY_KEY, network as KnownNetwork.Name),
      mock.rpc.ethGetBlock(testBlock, { reference: "latest" })
    );
  }

  let request = new Request(`https://test.local/${route}`);
  let response = await C3Api.fetch(request, testEnv);
  if (!response.body) {
    t.bailout(`C3Api.fetch response has no body, test cannot continue.`);
  };

  const expectationDumpPath = (
    `./tests/dumps/${route}@blockNumber:${mainnetBlockNumber}.json`
  );
  let expectationDump: any[] = [];
  const historicalSummaries: any = await streamInto.json(response.body as any);

  if (!flags.testRegenerateDump) {
    testDebug.log(`loading expectation dump from ${expectationDumpPath}`);
    expectationDump = await jsonUtil.load(expectationDumpPath);

    /*
     * Check that the result matches the expectation dump.
     */
    t.strictSame(
      historicalSummaries,
      expectationDump,
      `historical summary should match dump`,
    );
  }

  /*
   * If we're supposed to regenerate the cache seed, write all the cache
   * entries beginning with 'eth' to the cache seed.
   */
  if (flags.testRegenerateCacheSeed) {
    const newSeedStringEntries: string[] = [];
    for (const [key, { value: utf8Bytes }] of seed.entries()) {
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

  /**
   * If we're supposed to regenerate the expectation dump, ignore if tests
   * are failing and write the new result to the expectation dump.
   */
  if (flags.testRegenerateDump) {
    testDebug.group(`regenerating dump: writing new dump...`);
    await fs.writeFile(expectationDumpPath, JSON.stringify(historicalSummaries));
    testDebug.log(`✓ done`).groupEnd();
  }
});
