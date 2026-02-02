import t from 'tap';

import * as fs from 'node:fs/promises';
import * as streamInto from 'node:stream/consumers';

import * as jsonUtil from '../../../../util/json.js';
import { MemoryKv, encodeSeed } from '../../../../util/kv.js';

import C3Api, { Env } from '../../../../../entrypoint.js';

import * as Eth from '../../../../../lib/eth-constants.js';
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
  number: 16_771_239,
  timestamp: 1_678_129_079,
};
const flags = Flags.parseWithDefaults(process.env);
const route = `governance/${network}/comp/distribution`;

/*
 * Set up a fetch mock for each test and assert it is satisfied by the end
 */
import { CompDistributionResponseData } from '../../../../../src/governance-handlers/comp-distribution.js';
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

t.test(`/${route} @ block=${testBlock.number}`, async (t) => {
  /*
   * 1. Setup
   */
  /*
   * Load cache seed. Preloading ethGetLogs and ethGetBlock results allows
   * us to skip over 2m of I/O and up to hundreds of Infura calls.
   */
  const v3CacheSeedDumpPath = `tests/dumps/${route}/data@blockNumber:16580035.cache-seed.json`;
  // NOTE: Only load the cache seed if test flags configuration says so
  const seedJson = !flags.testShouldLoadCacheSeed
    ? {}
    : await jsonUtil.load<{ [_: string]: any }>(v3CacheSeedDumpPath);
  /*
   * Set up the test env, seeding in-memory test KVs with the cache seed.
   */
  // pre-encode seed JSON into in-memory KV format so we only encode once.
  const seed = encodeSeed(seedJson);
  const mainnetMemoryCache = MemoryKv({ seed });
  const testEnv: Env = Object.assign(
    {
      TALLY_API_KEY: 'test',
      V3_API_HOST:         'test',
      NODE_PROXY_HOST:     'test',
      NODE_PROXY_KEY:      'test',
      ENVIRONMENT: 'test',
      MEMORY_CACHE_SEED: 'governance-comp-distribution',
      'kv_testnet': MemoryKv({ seed }),
      'kv_mainnet': mainnetMemoryCache,
    },
    process.env
  );

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
  await t.test(`/`, async (t) => {
    let request = new Request(`https://test.local/${route}/`);
    let response = await C3Api.fetch(request, testEnv);
    if (!response.body) {
      t.bailout(`C3Api.fetch response has no body, test cannot continue.`);
    }
    let responseJson: any = await streamInto.json(response.body as any);
    t.ok(typeof responseJson === 'object');
    const actualResponseData = responseJson as CompDistributionResponseData;
    const testPrefix = `governance_comp_distribution`;
    t.equal(actualResponseData.comp_rate, EXPECTED_V3_DATA.comp_rate, `${testPrefix}.comp_rate`);
    t.equal(actualResponseData.daily_comp, EXPECTED_V3_DATA.daily_comp, `${testPrefix}.daily_comp`);
    t.equal(actualResponseData.markets.length, EXPECTED_V3_DATA.markets.length, `${testPrefix}.markets.length`);

    // Sort both market distribution data arrays to ensure same order when comparing.
    actualResponseData.markets.sort((a, b) => a.address.localeCompare(b.address));
    EXPECTED_V3_DATA.markets.sort((a, b) => a.address.localeCompare(b.address));

    for (let i = 0; i < actualResponseData.markets.length; ++i) {
      t.same(actualResponseData.markets[i], EXPECTED_V3_DATA.markets[i],  `${testPrefix}.markets[${i}]`);
    }

    const cachedKeys = [];
    let cursor; do {
      cursor = await mainnetMemoryCache.list();
      cachedKeys.push(...cursor.keys.map(({ name }) => name));
    } while (!cursor.list_complete);
    // Make sure we're computing and caching on the indexed block.
    for (const key of cachedKeys) {
      t.match(key, /blockNumber:16771071/, `${key} contains blockNumber:16771071`);
    }
  });

  /*
   * If tests passed and we're supposed to regenerate the cache seed,
   * write all the cache entries beginning with 'eth' to the cache seed.
   */
  if (t.passing() && flags.testRegenerateCacheSeed) {
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

  /*
   * Assert that all expected mock fetch calls were made.
   */
  fetch.satisfy(t);
});


const EXPECTED_V3_DATA = {
  comp_rate: '0.176',
  daily_comp: '1267.20',
  markets: [
    {
      address: '0xb3319f5d18bc0d84dd1b4825dcde5d5f7266d407',
      symbol: 'cZRX',
      underlying_address: '0xe41d2489571d322189246dafa5ebde1f4699f498',
      underlying_name: '0x',
      underlying_symbol: 'ZRX',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x5d3a536e4d6dbd6114cc1ead35777bab948e3643',
      symbol: 'cDAI',
      underlying_address: '0x6b175474e89094c44da98b954eedeac495271d0f',
      underlying_name: 'DAI',
      underlying_symbol: 'DAI',
      supplier_daily_comp: '211.20',
      borrower_daily_comp: '211.20',
    },
    {
      address: '0x6c8c6b02e7b2be14d4fa6022dfd6d75921d90e4e',
      symbol: 'cBAT',
      underlying_address: '0x0d8775f648430679a709e98d2b0cb6250d2887ef',
      underlying_name: 'Basic Attention Token',
      underlying_symbol: 'BAT',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0xf5dce57282a584d2746faf1593d3121fcac444dc',
      symbol: 'cSAI',
      underlying_address: '0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359',
      underlying_name: 'Sai (Legacy Dai)',
      underlying_symbol: 'SAI',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x158079ee67fce2f58472a96584a73c7ab9ac95c1',
      symbol: 'cREP',
      underlying_address: '0x1985365e9f78359a9b6ad760e32412f4a445e862',
      underlying_name: 'Augur',
      underlying_symbol: 'REP',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x35a18000230da775cac24873d00ff85bccded550',
      symbol: 'cUNI',
      underlying_address: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
      underlying_name: 'Uniswap',
      underlying_symbol: 'UNI',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5',
      symbol: 'cETH',
      underlying_address: '0x0000000000000000000000000000000000000000',
      underlying_name: 'Ether',
      underlying_symbol: 'ETH',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x80a2ae356fc9ef4305676f7a3e2ed04e12c33946',
      symbol: 'cYFI',
      underlying_address: '0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e',
      underlying_name: 'yearn.finance',
      underlying_symbol: 'YFI',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x95b4ef2869ebd94beb4eee400a99824bf5dc325b',
      symbol: 'cMKR',
      underlying_address: '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2',
      underlying_name: 'Maker',
      underlying_symbol: 'MKR',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x7713dd9ca933848f6819f38b8352d9a15ea73f67',
      symbol: 'cFEI',
      underlying_address: '0x956f47f50a910163d8bf957cf5846d573e7f87ca',
      underlying_name: 'Fei USD',
      underlying_symbol: 'FEI',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x70e36f6bf80a52b3b46b3af8e106cc0ed743e8e4',
      symbol: 'cCOMP',
      underlying_address: '0xc00e94cb662c3520282e6f5717214004a7f26888',
      underlying_name: 'Compound Governance Token',
      underlying_symbol: 'COMP',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0xc11b1268c1a384e55c48c2391d8d480264a3a7f4',
      symbol: 'cWBTC',
      underlying_address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
      underlying_name: 'Wrapped BTC',
      underlying_symbol: 'WBTC',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x39aa39c021dfbae8fac545936693ac917d5e7563',
      symbol: 'cUSDC',
      underlying_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      underlying_name: 'USD Coin',
      underlying_symbol: 'USDC',
      supplier_daily_comp: '211.20',
      borrower_daily_comp: '211.20',
    },
    {
      address: '0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9',
      symbol: 'cUSDT',
      underlying_address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      underlying_name: 'USDT',
      underlying_symbol: 'USDT',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '34.74',
    },
    {
      address: '0xe65cdb6479bac1e22340e4e755fae7e509ecd06c',
      symbol: 'cAAVE',
      underlying_address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
      underlying_name: 'Aave Token',
      underlying_symbol: 'AAVE',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0xface851a4921ce59e912d19329929ce6da6eb0c7',
      symbol: 'cLINK',
      underlying_address: '0x514910771af9ca656af840dff83e8264ecf986ca',
      underlying_name: 'ChainLink Token',
      underlying_symbol: 'LINK',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x12392f67bdf24fae0af363c24ac620a2f67dad86',
      symbol: 'cTUSD',
      underlying_address: '0x0000000000085d4780b73119b644ae5ecd22b376',
      underlying_name: 'TrueUSD',
      underlying_symbol: 'TUSD',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x041171993284df560249b57358f931d9eb7b925d',
      symbol: 'cUSDP',
      underlying_address: '0x8e870d67f660d95d5be530380d0ec0bd388289e1',
      underlying_name: 'Pax Dollar',
      underlying_symbol: 'USDP',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0x4b0181102a0112a2ef11abee5563bb4a3176c9d7',
      symbol: 'cSUSHI',
      underlying_address: '0x6b3595068778dd592e39a122f4f5a5cf09c90fe2',
      underlying_name: 'SushiToken',
      underlying_symbol: 'SUSHI',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
    {
      address: '0xccf4429db6322d5c611ee964527d42e5d685dd6a',
      symbol: 'cWBTC2',
      underlying_address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
      underlying_name: 'Wrapped BTC',
      underlying_symbol: 'WBTC',
      supplier_daily_comp: '0.00',
      borrower_daily_comp: '0.00',
    },
  ],
};
