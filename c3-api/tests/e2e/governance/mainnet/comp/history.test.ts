import t from 'tap';

import * as fs         from 'node:fs/promises';
import * as streamInto from 'node:stream/consumers';

import * as jsonUtil            from '../../../../util/json.js';
import { MemoryKv, encodeSeed } from '../../../../util/kv.js';

import C3Api, { Env } from '../../../../../entrypoint.js';

import * as Eth   from '../../../../../lib/eth-constants.js';
import * as Flags from '../../../../../lib/flags.js';

import * as KnownNetwork from '../../../../../lib/well-known/networks/network.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../../shim/node-self.js';
import * as mock from '../../../../util/mock/mock.js';

/*
 * High-level test suite configuration.
 */
const network: KnownNetwork.Name = 'ethereum-mainnet';
const testBlock: Eth.Block.WithTimestamp = {
  number:       16_537_355,
  timestamp: 1_675_295_387,
  date:       '2022-02-01',
};
const flags = Flags.parseWithDefaults(process.env);
const route = `governance/${network}/comp/history`;

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

t.test(`/${route} @ block=${testBlock.number}`, async t => {
  /*
   * 1. Setup
   */
  /*
   * Load cache seed. Preloading ethGetLogs and ethGetBlock results allows
   * us to skip over 2m of I/O and up to hundreds of Infura calls.
   */
  const v3CacheSeedDumpPath = (
    `tests/dumps/${route}/accounts@blockNumber:16387041.cache-seed.json`
  );
  // NOTE: Only load the cache seed if test flags configuration says so
  const seedJson = !flags.testShouldLoadCacheSeed ? {} : (
    await jsonUtil.load<{ [_: string]: any }>(v3CacheSeedDumpPath)
  );
  /*
   * Set up the test env, seeding in-memory test KVs with the cache seed.
   */
  // pre-encode seed JSON into in-memory KV format so we only encode once.
  const seed = encodeSeed(seedJson);
  const testEnv: Env = Object.assign({
    'TALLY_API_KEY':       'test',
    'V3_API_HOST':         'test',
    'NODE_PROXY_HOST':     'test',
    'NODE_PROXY_KEY':      'test',
    'ENVIRONMENT':         'test',
    'MEMORY_CACHE_SEED':   'governance-history',
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
  );

  /*
   * 2. Evaluation
   */
  await t.test(`/`, async t => {
    let request  = new Request(`https://test.local/${route}/`);
    let response = await C3Api.fetch(request, testEnv);
    if (!response.body) {
      t.bailout(`C3Api.fetch response has no body, test cannot continue.`);
    };
    let responseJson: any = await streamInto.json(response.body as any);
    t.ok(typeof(responseJson) === 'object');
    t.same(responseJson, {
      votes_delegated: '2649756.603949650754462612',
      voting_addresses: 4824,
      proposals_created: 147,
      comp_remaining: '2481940.263123554206402576',
    })
  });

  /*
   * If tests passed and we're supposed to regenerate the cache seed,
   * write all the cache entries beginning with 'eth' to the cache seed.
   */
  if (t.passing() && flags.testRegenerateCacheSeed) {
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
   * Assert that all expected mock fetch calls were made.
   */
  fetch.satisfy(t);
});
