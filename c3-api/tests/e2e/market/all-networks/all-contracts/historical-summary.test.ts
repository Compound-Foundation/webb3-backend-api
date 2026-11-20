import t from "tap";
import * as streamInto from "node:stream/consumers";
import * as fs         from 'node:fs/promises';

import * as jsonUtil from "../../../../util/json.js";
import { MemoryKv, encodeSeed } from "../../../../util/kv.js";
import { makeTestEnv } from "../../../../util/test-env.js";

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
import { activeRegistryDatabase } from '../../../../util/registry-database.js';
import { loadRegistrySnapshotFixture, sha256Hex } from '../../../../util/registry-fixture.js';
/*
 * High-level test suite configuration.
 *
 * The block each network's 'latest' is pinned to. The route reads it for the
 * networks the active version serves markets on, and for no other.
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
  // Ronin's replacement USD price feeds (post Chainlink proxy deprecation on
  // 2026-08-26) only exist from block 55_577_500, so the pinned block must be
  // at or after that.
  "ronin-mainnet": {
    number: 58_000_000,
    timestamp: 1_783_468_787,
    date: "2026-07-07",
  },
};
const mainnetBlockNumber = testBlocks["ethereum-mainnet"].number;
const flags = Flags.parseWithDefaults(process.env);
const route = `market/all-networks/all-contracts/historical/summary`;
const debug = Debug.MakeLogger([]).configure(process.env);
const testDebug = debug.scope('test');
const { apiHost, nodeHost, nodeKey } = setupTestEnvVars();

/*
 * The markets come from the registry fixture, activated in a database of its
 * own, so the dumps hold this route's answer for that version's markets (the
 * expectation) and what it read on the way (the cache seed). Both live in R2,
 * outside the repository, in one place every branch shares.
 *
 * So they are named by the SHA-256 of the expectation, which this test pins.
 * Regenerating them writes new files beside the old ones, and makes a change
 * to the line below that is reviewed like any other: no branch replaces the
 * dumps another one compares against, and a dump that changed without this
 * line changing fails the comparison instead of passing on other numbers.
 * Null is an expectation nobody has recorded yet. See "How to Update E2E test
 * dumps" in the README.
 */
const EXPECTATION_SHA256 = null as string | null;

const snapshot = loadRegistrySnapshotFixture();
const dumpName = `${route}@blockNumber:${mainnetBlockNumber}`;
const expectationDumpPath = (sha256: string) => `./tests/dumps/${dumpName}@sha256:${sha256}.json`;
const cacheSeedDumpPath   = (sha256: string) => `./tests/dumps/${dumpName}@sha256:${sha256}.cache-seed.json`;

// the networks the version serves markets on: the route reads the latest block of each
const servedNetworks = snapshot.networks
  .filter(network => network.markets.some(market => market.status !== 'disabled'))
  .map(network => network.key);

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
  if (EXPECTATION_SHA256 === null && !flags.testRegenerateDump) {
    t.fail(`no expectation is pinned for ${dumpName}: regenerate its dumps and pin the SHA-256 of the expectation in EXPECTATION_SHA256`);
    return;
  }
  /*
   * Load cache seed. Preloading ethGetLogs and ethGetBlock results allows
   * us to skip over 2m of I/O and up to hundreds of Infura calls.
   */
  // NOTE: Only load the cache seed if test flags configuration says so, and there is one to load
  const seedJson = !flags.testShouldLoadCacheSeed || EXPECTATION_SHA256 === null
    ? {}
    : await jsonUtil.load<{ [_: string]: any }>(cacheSeedDumpPath(EXPECTATION_SHA256));

  /*
   * Set up the test env, seeding in-memory test KVs with the cache seed.
   */
  // pre-encode seed JSON into in-memory KV format so we only encode once.
  const seed = encodeSeed(seedJson);
  /*
   * Markets come from the activated registry, so this test seeds one: the
   * frozen snapshot fixture, activated in a D1 database of its own. The
   * recorded expectation covers the markets that version describes.
   */
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());

  const testEnv: Env = makeTestEnv(
    {
      V3_API_HOST: apiHost,
      NODE_PROXY_HOST: nodeHost,
      NODE_PROXY_KEY: nodeKey,
      MEMORY_CACHE_SEED: "market-historical-summary",
      kv_testnet: MemoryKv({ seed }),
      kv_mainnet: MemoryKv({ seed }),
      APP_DB: registry.db,
    },
    process.env
  );

  /*
   * Mock fetch setup: each test should make 1 fetch for the 'latest' block
   * on each network the version serves markets on. All other IO should be
   * cached by the cache-seed.
   */
  /*
   * Expect a fetch for the latest block, mock it to return testBlock so
   * that our test returns consistent results.
   */
  for (const network of servedNetworks) {
    const testBlock = testBlocks[network];
    if (testBlock === undefined) {
      t.fail(`no latest block is pinned for ${network}, a network the fixture serves markets on`);
      return;
    }

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

  const historicalSummaries: any[] = await streamInto.json(response.body as any) as any[];
  if (response.status !== 200 || !Array.isArray(historicalSummaries)) {
    t.fail(`the route answered ${response.status}: ${JSON.stringify(historicalSummaries)}`);
    return;
  }
  fetch.satisfy(t);

  // 30 days of each market the version serves, and of nothing else
  const days = new Map<string, number>();
  for (const { chain_id, comet } of historicalSummaries) {
    const market = `${chain_id}:${comet.address.toLowerCase()}`;
    days.set(market, (days.get(market) ?? 0) + 1);
  }
  t.same(
    Object.fromEntries([ ...days ].sort()),
    Object.fromEntries(snapshot.networks
      .flatMap(network => network.markets
        .filter(market => market.status !== 'disabled')
        .map(market => [ `${network.chainId}:${market.contracts.comet}`, 30 ]))
      .sort()),
    'every market the version serves has its 30 days',
  );

  if (!flags.testRegenerateDump && EXPECTATION_SHA256 !== null) {
    testDebug.log(`loading expectation dump from ${expectationDumpPath(EXPECTATION_SHA256)}`);
    const expectation = await fs.readFile(expectationDumpPath(EXPECTATION_SHA256), 'utf8');
    t.equal(sha256Hex(expectation), EXPECTATION_SHA256, 'the expectation dump is the one this test pins');

    /*
     * Check that the result matches the expectation dump.
     */
    t.strictSame(
      historicalSummaries,
      JSON.parse(expectation),
      `historical summary should match dump`,
    );
  }

  /**
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
   * If we're supposed to regenerate the cache seed, write all the cache
   * entries beginning with 'eth' to the cache seed of the expectation. They
   * are read back from the namespaces themselves: each holds a copy of the
   * seed it was given, so the seed never sees what the route wrote.
   */
  if (flags.testRegenerateCacheSeed && pinned !== null) {
    const newSeedStringEntries = new Map<string, string>();
    for (const kv of [ testEnv.kv_mainnet, testEnv.kv_testnet ]) {
      for (const { name } of (await kv.list()).keys) {
        // only add eth* computations to the cache seed
        if (name.startsWith('eth')) {
          // already JSON.stringify-ed, so don't re-parse-stringify it...
          newSeedStringEntries.set(name, `"${name}":${await kv.get(name)}`);
        }
      }
    }
    const newSeed = `{${[ ...newSeedStringEntries.values() ].join(',')}}`;
    await fs.writeFile(cacheSeedDumpPath(pinned), newSeed);
  }
});
