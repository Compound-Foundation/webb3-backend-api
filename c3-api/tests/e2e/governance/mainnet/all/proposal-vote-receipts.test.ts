import t from 'tap';

import * as fs         from 'node:fs/promises';
import * as streamInto from 'node:stream/consumers';

import * as jsonUtil            from '../../../../util/json.js';
import { MemoryKv, encodeSeed } from '../../../../util/kv.js';

import * as Eth   from '../../../../../lib/eth-constants.js';
import * as Json  from '../../../../../lib/json-types.js';
import * as Flags from '../../../../../lib/flags.js';

import * as TallyApi from '../../../../../lib/model/governance/tally.js';
import * as voteReceiptsModel from '../../../../../lib/model/governance/proposal-vote-receipt.js';

import C3Api, { Env } from '../../../../../entrypoint.js';
import { VoteReceiptsResponseData } from '../../../../../src/governance-handlers/proposal-vote-receipts.js';

import * as KnownNetwork from '../../../../../lib/well-known/networks/network.js';

import * as mock from '../../../../util/mock/mock.js';

import { setupTestEnvVars } from '../../../../util/setupTestEnvVars.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../../shim/node-self.js';

/*
 * High-level test suite configuration.
 */
const network: KnownNetwork.Name = 'ethereum-mainnet';
const testBlock: Eth.Block.WithTimestamp = {
  number:       15_898_536,
  timestamp: 1_667_587_595,
  date:       '2022-11-04',
};
const flags = Flags.parseWithDefaults(process.env);
const route = `governance/${network}/all/proposal_vote_receipts`;

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

t.test(`/${route} @ block=${testBlock.number}`, async t => {
  /*
   * 1. Setup
   */
  /*
   * Load cache seed. Preloading ethGetLogs and ethGetBlock results allows
   * us to skip over 2m of I/O and up to hundreds of Infura calls.
   */
  const v3CacheSeedDumpPath = (
    `./tests/dumps/${route}@blockNumber:${testBlock.number}.cache-seed.json`
  );
  // NOTE: Only load the cache seed if test flags configuration says so
  const seedJson = !flags.testShouldLoadCacheSeed ? {} : (
    await jsonUtil.load<{ [_: string]: any }>(v3CacheSeedDumpPath)
  );

  /*
   * Load Tally profiles seed.
   */
  const tallyProfilesDumpPath = (
    `./tests/dumps/tally-governance-profiles-input-data.json`
  );
  const tallyProfilesJson = await jsonUtil.load<Json.Value>(tallyProfilesDumpPath);

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
    'kv_testnet': MemoryKv({ seed }),
    'kv_mainnet': MemoryKv({ seed }),
  }, process.env);

  /*
   * Mock fetch setup: each test should make 1 fetch for Tally governance
   * profiles, and 1 fetch for the 'latest' block. All other IO should be
   * cached by the cache-seed.
   */
  t.afterEach((t) => fetch.satisfy(t));
  t.beforeEach(async () => {
    /*
     * Mock Tally API governance profiles response from a dump file.
     */
    mock.json.expectPost(fetch, Eth.governanceTallyQueryEndpoint, [
      { query: TallyApi.Profiles.Query, variables: {} },
      tallyProfilesJson,
    ]);

    /*
     * Expect a fetch for the latest block, mock it to return testBlock so
     * that our test returns consistent results.
     */
    mock.rpc.expectPost(fetch, Eth.nodeEndpoint(testEnv.NODE_PROXY_HOST, testEnv.NODE_PROXY_KEY, network),
      mock.rpc.ethGetBlock(testBlock, { reference: 'latest' })
    );
  });

  t.test(`?account=0x683a4f9915d6216f73d6df50151725036bd26c02`, async t => {
    // Test on gauntlet's vote receipts
    const expectationDumpPath = (
      `./tests/dumps/${route}@blockNumber:${testBlock.number}?account=0x683a4f9915d6216f73d6df50151725036bd26c02.json`
    );
    const expectedResult = await jsonUtil.load<VoteReceiptsResponseData>(expectationDumpPath);

    let request  = new Request(`https://test.local/${route}?account=0x683a4f9915d6216f73d6df50151725036bd26c02`);
    let response = await C3Api.fetch(request, testEnv);
    if (!response.body) {
      t.bailout(`C3Api.fetch response has no body, test cannot continue.`);
    };
    let responseJson: any = await streamInto.json(response.body as any);
    t.ok(typeof(responseJson) === 'object');
    const voteReceiptsData = responseJson as VoteReceiptsResponseData;

    const actual = voteReceiptsData.proposal_vote_receipts.sort((a, b) => a.proposal_id - b.proposal_id);
    const expected = expectedResult.proposal_vote_receipts.sort((a, b) => a.proposal_id - b.proposal_id);
    assertVoteReceiptsEquivalent(actual, expected);
    /*
     * If we're supposed to regenerate the expectation dump, write the new
     * result to the expectation dump.
     */
    if (flags.testRegenerateDump) {
      await fs.writeFile(expectationDumpPath, JSON.stringify(voteReceiptsData));
    }
  });

  t.test(`?proposal=133`, async t => {
    const expectationDumpPath = (
      `./tests/dumps/${route}@blockNumber:${testBlock.number}?proposal_id=133.json`
    );
    const expectedResult = await jsonUtil.load<VoteReceiptsResponseData>(expectationDumpPath);

    let request  = new Request(`https://test.local/${route}?proposal_id=133`);
    let response = await C3Api.fetch(request, testEnv);
    if (!response.body) {
      t.bailout(`C3Api.fetch response has no body, test cannot continue.`);
    };
    let responseJson: any = await streamInto.json(response.body as any);
    t.ok(typeof(responseJson) === 'object');
    const voteReceiptsData = responseJson as VoteReceiptsResponseData;

    const actual = voteReceiptsData.proposal_vote_receipts.sort((a, b) => a.proposal_id - b.proposal_id);
    const expected = expectedResult.proposal_vote_receipts.sort((a, b) => a.proposal_id - b.proposal_id);
    assertVoteReceiptsEquivalent(actual, expected);
    /*
     * If we're supposed to regenerate the expectation dump, write the new
     * result to the expectation dump.
     */
    if (flags.testRegenerateDump) {
      await fs.writeFile(expectationDumpPath, JSON.stringify(voteReceiptsData));
    }
  });

  /*
   * If we're supposed to regenerate the cache seed, write all the cache
   * entries beginning with 'eth' to the cache seed.
   */
  t.teardown(async () => {
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
});

function assertVoteReceiptsEquivalent(
  actualReceipts:   voteReceiptsModel.ProposalVoteReceipt[],
  expectedReceipts: voteReceiptsModel.ProposalVoteReceipt[],
) {
  t.equal(actualReceipts.length, expectedReceipts.length, `proposal_vote_receipt.length`);
  for (let idx = 0; idx < actualReceipts.length; ++idx) {
    const prefix = `proposal_vote_receipt[${idx}]`
    const actualReceipt = actualReceipts[idx];
    const expectedReceipt = expectedReceipts[idx];

    t.equal(actualReceipt['votes'],         expectedReceipt['votes'],       `${prefix}.votes`);
    t.equal(actualReceipt['proposal_id'],   expectedReceipt['proposal_id'], `${prefix}.proposal_id`);
    t.equal(actualReceipt['support'],       expectedReceipt['support'],     `${prefix}.support`);
    t.strictSame(actualReceipt['proposal'], expectedReceipt['proposal'],    `${prefix}.proposal`);
    t.strictSame(
      {...actualReceipt['voter'], address: actualReceipt['voter']['address'].toLowerCase()},
      {...expectedReceipt['voter'], address: actualReceipt['voter']['address'].toLowerCase()},
      `${prefix}.voter`
    );
  }
}
