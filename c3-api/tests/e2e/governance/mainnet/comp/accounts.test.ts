import t from 'tap';

import * as fs         from 'node:fs/promises';
import * as streamInto from 'node:stream/consumers';

import * as jsonUtil from '../../../../util/json.js';
import {
  MemoryKv,
  encodeSeed,
} from '../../../../util/kv.js';

import C3Api, { Env } from '../../../../../entrypoint.js';

import * as Eth      from '../../../../../lib/eth-constants.js';
import * as Flags    from '../../../../../lib/flags.js';
import * as Fallible from '../../../../../lib/fallible/fallible.js';

import * as TallyApi        from '../../../../../lib/model/governance/tally.js';
import * as governanceModel from '../../../../../lib/model/governance.js';

import * as KnownNetwork from '../../../../../lib/well-known/networks/network.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../../shim/node-self.js';

/*
 * High-level test suite configuration.
 */
const network: KnownNetwork.Name = 'ethereum-mainnet';
const testBlock: Eth.Block = {
  number:       16_387_041,
  timestamp: 1_673_482_115,
  date:       '2022-01-11',
};
const flags = Flags.parseWithDefaults(process.env);
const route = `governance/${network}/comp/accounts`;

/*
 * Set up a fetch mock for each test and assert it is satisfied by the end
 */
import * as mock from '../../../../util/mock/mock.js';
declare var fetch: mock.Fetch;
t.before(() => {
  /*
   * Configure the fetch mock only to allow passing through the cache when
   * test flags are set to explicitly enable it.
   */
  global.fetch = mock.fetch({ passthrough: flags.testAllowFetchPassthrough });
});

t.test(`/${route}`, async t => {
  /*
   * 1. Setup
   */
  /*
   * Load cache seed. Preloading ethGetLogs and ethGetBlock results allows
   * us to skip over 2m of I/O and up to hundreds of Infura calls.
   */
  const v3CacheSeedDumpPath = (
    `./tests/dumps/${route}/accounts@blockNumber:${testBlock.number}?page_size=100.cache-seed.json`
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
    'TALLY_API_KEY':     'test',
    'V3_API_HOST':         'test',
    'NODE_PROXY_HOST':     'test',
    'NODE_PROXY_KEY':      'test',
    'ENVIRONMENT':       'test',
    'MEMORY_CACHE_SEED': 'governance-accounts',
    'kv_testnet': MemoryKv({ seed }),
    'kv_mainnet': MemoryKv({ seed }),
  }, process.env);

  /*
   * Assert that all expected mock fetch calls were made after each test.
   */
  t.afterEach((t) => fetch.satisfy(t));

  /*
   * 2. Evaluation
   */
  const { chainId } = Fallible.must(KnownNetwork.lookup({ name: network }));
  const governorBravo = Eth.wellKnownContractsByNetwork[network]['GovernorBravo']['default'];
  const governanceId: TallyApi.CAIP10 = `eip155:${chainId}:${governorBravo.address}`

  t.test(`/?page_size=5`, async t => {
    const expectationDumpPath = `./tests/dumps/${route}/accounts?page_size=5.json`;

    // if tally api response should be updated, update it
    const tallyResponseDumpPath = `./tests/dumps/${route}/delegates-query-response.json`;
    const tallyQueryVariables: TallyApi.Delegates.Variables = { governanceId };
    if (flags.testRegenerateTallyDumps) {
      if (testEnv.TALLY_API_KEY.length == 0) {
        t.bailout(`ERROR: no TALLY_API_KEY provided: cannot regenerate tally dumps`);
      }
      const result = await TallyApi.Delegates.query(testEnv.TALLY_API_KEY, tallyQueryVariables);
      await fs.writeFile(tallyResponseDumpPath, JSON.stringify(result));
    }
    // mock tally api response
    const tallyResponse = await jsonUtil.load<TallyApi.Result<TallyApi.Delegates.Data>>(tallyResponseDumpPath);
    fetch.expect(Eth.governanceTallyQueryEndpoint, {
      method: 'POST',
      body: JSON.stringify({
        query: TallyApi.Delegates.Query,
        variables: tallyQueryVariables,
      }),
    })
      .returns(new Response(JSON.stringify(tallyResponse)));

    let request  = new Request(`https://test.local/${route}/?page_size=5&page_number=1`);
    let response = await C3Api.fetch(request, testEnv);
    if (!response.body) {
      t.bailout(`C3Api.fetch response has no body, test cannot continue.`);
    };
    let responseJson: any = await streamInto.json(response.body as any);
    t.ok(typeof(responseJson) === 'object');
    // regenerate expectation dump
    if (flags.testRegenerateDump) {
      await fs.writeFile(expectationDumpPath, JSON.stringify(responseJson));
    }
    const governanceAccountsData = responseJson as { accounts: governanceModel.Account[] };
    const expectedResponse = await jsonUtil.load<{ accounts: governanceModel.Account[] }>(expectationDumpPath);
    assertGovernanceAccountsEquivalent(governanceAccountsData.accounts, expectedResponse.accounts);
  });

  t.test(`?addresses=0xea6c3db2e7fca00ea9d7211a03e83f568fc13bf7`, async t => {
    const expectationDumpPath = `./tests/dumps/${route}/accounts?addresses=0xea6C3Db2e7FCA00Ea9d7211a03e83f568Fc13BF7.json`;

    // if tally api response should be updated, update it
    const tallyResponseDumpPath = `./tests/dumps/${route}/polychain-query-response.json`;
    const tallyQueryVariables: TallyApi.AccountProfiles.Variables = {
      accountIds: [ `eip155:1:0xea6c3db2e7fca00ea9d7211a03e83f568fc13bf7` ],
      governanceIds: [ governanceId ],
    };
    if (flags.testRegenerateTallyDumps) {
      if (testEnv.TALLY_API_KEY.length == 0) {
        t.bailout(`ERROR: no TALLY_API_KEY provided: cannot regenerate tally dumps`);
      }
      const result = await TallyApi.AccountProfiles.query(
        testEnv.TALLY_API_KEY,
        tallyQueryVariables,
      );
      await fs.writeFile(tallyResponseDumpPath, JSON.stringify(result));
    }
    // mock tally api response
    const tallyResponse = await jsonUtil.load<TallyApi.Result<TallyApi.AccountProfiles.Data>>(tallyResponseDumpPath)
    fetch.expect(Eth.governanceTallyQueryEndpoint, {
        method: 'POST',
        body: JSON.stringify({
          query: TallyApi.AccountProfiles.Query,
          variables: tallyQueryVariables,
        }),
      })
      .returns(new Response(JSON.stringify(tallyResponse)));

    // actually perform the request
    let request  = new Request(`https://test.local/${route}/?addresses=0xea6c3db2e7fca00ea9d7211a03e83f568fc13bf7`);
    let response = await C3Api.fetch(request, testEnv);
    if (!response.body) {
      t.bailout(`C3Api.fetch response has no body, test cannot continue.`);
    };
    let responseJson: any = await streamInto.json(response.body as any);
    t.ok(typeof(responseJson) === 'object');
    // regenerate expectation dump
    if (flags.testRegenerateDump) {
      await fs.writeFile(expectationDumpPath, JSON.stringify(responseJson));
    }
    const governanceAccountsData = responseJson as { accounts: governanceModel.Account[] };
    const expectedResponse = await jsonUtil.load<{ accounts: governanceModel.Account[] }>(expectationDumpPath);
    assertGovernanceAccountsEquivalent(governanceAccountsData.accounts, expectedResponse.accounts);
  });

  /*
   * If we're supposed to regenerate the cache seed, write all the cache
   * entries beginning with 'eth' to the cache seed.
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
});

function assertGovernanceAccountsEquivalent(
  actualAccounts:   governanceModel.Account[],
  expectedAccounts: governanceModel.Account[],
) {
  t.equal(actualAccounts.length, expectedAccounts.length, `governance_accounts.length`);
  for (let idx = 0; idx < actualAccounts.length; ++idx) {
    const prefix = `governance_accounts[${idx}]`;
    const actualAccount = actualAccounts[idx];
    const expectedAccount = expectedAccounts[idx];

    t.equal(actualAccount['address'],             expectedAccount['address'],            `${prefix}.address`);
    t.equal(actualAccount['proposals_voted'],     expectedAccount['proposals_voted'],    `${prefix}.proposals_voted.${actualAccount.address}`);
    t.equal(actualAccount['total_delegates'],     expectedAccount['total_delegates'],    `${prefix}.total_delegates.${actualAccount.address}`);
    t.equal(actualAccount['rank'] || null,        expectedAccount['rank'] || null,       `${prefix}.rank.${actualAccount.address}`);
    t.equal(actualAccount['votes'].slice(0, 15),  expectedAccount['votes'].slice(0, 15), `${prefix}.votes`);
    t.equal(actualAccount['vote_weight'].slice(0, 15), expectedAccount['vote_weight'].slice(0, 15), `${prefix}.vote_weight.${actualAccount.address}`);
  }
}
