import t, { Test } from 'tap';

import * as fs         from 'node:fs/promises';
import * as streamInto from 'node:stream/consumers';

import * as jsonUtil            from '../../../../util/json.js';
import { MemoryKv, encodeSeed } from '../../../../util/kv.js';

import C3Api, { Env } from '../../../../../entrypoint.js';

import * as Eth   from '../../../../../lib/eth-constants.js';
import * as Flags from '../../../../../lib/flags.js';

import * as KnownNetwork from '../../../../../lib/well-known/networks/network.js';

import * as TallyApi        from '../../../../../lib/model/governance/tally.js';
import * as governanceModel from '../../../../../lib/model/governance.js';

import type {
  ProposalsPage,
} from '../../../../../src/governance-handlers/proposals.js';

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

const globalEnv = {
  TALLY_API_KEY:     'test',
  ENVIRONMENT:       'test',
  MEMORY_CACHE_SEED: 'proposals',
  FLAGS_ETH_GET_LOGS_IMPLEMENTATION: 'cached',
  ...process.env,
};

const flags = Flags.parseWithDefaults(globalEnv);
const route = `governance/${network}/all/proposals`;

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
   * Set up the test env, seeding in-memory test KVs with the cache seed.
   */
  // pre-encode seed JSON into in-memory KV format so we only encode once.
  const seed = encodeSeed(seedJson);
  const testEnv: Env = {
    'V3_API_HOST':         'test',
    'NODE_PROXY_HOST':     'test',
    'NODE_PROXY_KEY':      'test',
    'kv_testnet':  MemoryKv({ seed }),
    'kv_mainnet': MemoryKv({ seed }),
    ...globalEnv,
  };

  /*
   * Mock fetch setup: each test should make 1 fetch for Tally governance
   * profiles, and 1 fetch for the 'latest' block. All other IO should be
   * cached by the cache-seed.
   */
  /*
   * Mock Tally API governance profiles response from a dump file.
   */
  const tallyProfilesDumpPath = (
    `./tests/dumps/tally-governance-profiles-input-data.json`
  );
  const tallyProfilesJson = await jsonUtil.load<TallyApi.Result.Data<TallyApi.Profiles.Data>>(tallyProfilesDumpPath);
  const profilesByAddress = TallyApi.formatProfilesByAddress(tallyProfilesJson);
  for (let i = 0; i < 2; i++) {
    fetch.expect(Eth.governanceTallyQueryEndpoint, {
      method: 'POST',
      body: {
        type: 'json',
        value: {
          query: TallyApi.Profiles.Query,
          variables: {},
        },
      },
    })
      .returns(JSON.stringify(tallyProfilesJson));
  }

  /*
   * Expect a fetch for the latest block, mock it to return testBlock so
   * that our test returns consistent results.
   */
  const [ latestBlockRpcRequest, latestBlockRpcResponse ] = (
    mock.rpc.ethGetBlock(testBlock, { reference: 'latest' })
  );
  for (let i = 0; i < 2; i++) {
    fetch.expect(Eth.nodeEndpoint(testEnv.NODE_PROXY_HOST, testEnv.NODE_PROXY_KEY, network), {
        method: 'POST',
        body: {
          type: 'json',
          value: [ latestBlockRpcRequest ], // rpc will be batched
        },
      })
      .returns(JSON.stringify([ latestBlockRpcResponse ]));
  }

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
  let page = responseJson as ProposalsPage;

  /*
   * 3. Assertions
   */
  t.ok(page.proposals,          `page has proposals`);
  t.ok(page.pagination_summary, `page has pagination summary`);
  if (!t.passing()) {
    t.bailout(`page is completely broken, test cannot continue.`);
  }
  // pagination summary
  // TODO: test pagination with different page_sizes, page_numbers
  t.test('pagination summary defaults', async t => {
    const summary = page.pagination_summary;
    t.equal(summary.page_size,   100, `page_size defaults to 100`);
    t.equal(summary.page_number,   1, `page_number defaults to 1`);
    validatePaginationSummary(t, page);
    t.end();
  });

  /*
   * Request again, this time with a page_size that will get all the
   * proposals at once.
   */
  const totalEntries = page.pagination_summary.total_entries;
  request  = new Request(`https://test.local/${route}?page_size=${totalEntries}`);
  response = await C3Api.fetch(request, testEnv);
  if (!response.body) {
    t.bailout(`C3Api.fetch response has no body, test cannot continue.`);
  };
  responseJson = await streamInto.json(response.body as any);
  t.ok(typeof(responseJson) === 'object');
  page = responseJson as ProposalsPage;

  /*
   * Check that the pagination_summary agrees that we got all the
   * proposals in a single page.
   */
  t.test(`pagination summary, all in one page with page_size=${totalEntries}`, async t => {
    const summary = page.pagination_summary;
    t.equal(summary.total_entries, totalEntries);
    t.equal(summary.page_number, 1, `page_number is 1`);
    t.equal(summary.total_pages, 1, `total_pages is only 1`);
    t.equal(
      summary.page_size,
      summary.total_entries,
      `page_size is total_entries when requesting all in one page`,
    );
    validatePaginationSummary(t, page);
    t.end();
  });

  /*
   * Now that we have all the proposals, test that every proposal is valid
   * and has an equivalent in the v2 proposals dump.
   */
  for (const proposal of page.proposals) {
    t.test(
      `proposal[${proposal.id}]`,
      t => validateProposal(t, proposal, profilesByAddress),
    );
  }
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

  /*
   * Assert that all expected mock fetch calls were made.
   */
  fetch.satisfy(t);
});

function validateProposal(
  t: Test,
  proposal: governanceModel.proposal.FormattedProposal,
  profilesByAddress: { [address: Eth.Address]: governanceModel.Profile },
) {
  // top-level scalar fields
  t.ok(typeof(proposal.id)  === 'number');
  t.ok(typeof(proposal.eta) === 'number');
  t.ok(typeof(proposal.title)       === 'string');
  t.ok(typeof(proposal.description) === 'string');
  t.ok(typeof(proposal.  end_block) === 'number');
  t.ok(typeof(proposal.start_block) === 'number');
  // for_votes and against_votes are formatted decimals with one `.`
  t.match(proposal.for_votes,     /\d+\.\d+/);
  t.match(proposal.against_votes, /\d+\.\d+/);
  // proposal end block has to be after start block
  t.ok(
    proposal.end_block > proposal.start_block,
    `property: proposal.end_block > proposal.start_block`,
  );
  // states
  for (let i = 0; i < proposal.states.length; i++) {
    const state = proposal.states[i];
    const statePath = `proposal[${proposal.id}].states[${i}]`;
    // state
    t.ok(
      governanceModel.proposal.StateTypes.includes(state.state),
      `${statePath}.state is a valid state type`
    );
    // end_time, if any
    if (!!state.end_time) {
      t.ok(
        typeof(state.end_time) === 'number',
        `${statePath}.end_time has type 'number'`
      );
    }
    // start_time, if any
    if (!!state.start_time) {
      t.ok(
        typeof(state.start_time) === 'number',
        `${statePath}.start_time has type 'number'`
      );
    }
    // property: end_time > start_time
    if (!!(state.start_time && state.end_time)) {
      t.ok(
        state.end_time > state.start_time,
        `property: end_time > start_time (${statePath})`
      );
    }
    // transaction_hash, if any
    if (!!state.transaction_hash) {
      t.match(
        state.transaction_hash,
        /0x[0-9A-Fa-f]+/,
        `${statePath}.transaction_hash is a hexadecimal value`
      );
    }
  }
  // actions
  for (let i = 0; i < proposal.actions.length; i++) {
    const action = proposal.actions[i];
    const actionPath = `proposal[${proposal.id}].actions[${i}]`;
    // data
    t.match(
      action.data,
      /0x[0-9A-Fa-f]+/,
      `${actionPath}.data is a hexadecimal value`
    );
    // value
    t.match(
      action.value,
      /\d+\.\d+/,
      `${actionPath}.value is a decimal value`
    );
    // title
    t.ok(
      typeof(action.title) === 'string',
      `${actionPath}.title has type 'string'`
    );
    t.ok(
      action.title.length > 0,
      `${actionPath}.title is a non-empty string`
    );
    // target
    t.match(
      action.target,
      /0x[0-9A-Fa-f]+/,
      `${actionPath}.target is a hexadecimal value`
    );
    // signature
    t.ok(
      typeof(action.signature) === 'string',
      `${actionPath}.signature has type 'string'`
    );
    t.ok(
      action.signature.length > 0,
      `${actionPath}.signature is a non-empty string`
    );
  }
  // proposer addresses look like hexadecimal addresses
  t.match(
    proposal.proposer.address,
    /0x[0-9A-Fa-f]+/,
    `proposal[${proposal.id}].proposer.address is a hexadecimal value`,
  );
  /*
   * proposer profile hydration MUST happen if a governance profile exists
   * for the proposal.proposer.address in question.
   */
  const profile = profilesByAddress[proposal.proposer.address.toLowerCase() as Eth.Address];
  if (!!profile) {
    const path = `proposal[${proposal.id}].proposer`;
    t.equal(
      proposal.proposer.display_name,
      profile.display_name || null,
      `${path}.display_name must match profile[${profile.display_name}]`
    );
    t.equal(
      proposal.proposer.image_url,
      profile.image_url || null,
      `${path}.image_url must match profile[${profile.display_name}]`
    );
  } else {
    // not hydrated: all profile fields should be set to null
    t.match(
      proposal.proposer,
      {
        image_url:    null,
        account_url:  null,
        display_name: null,
      },
      `property: proposal[${proposal.id}]:`
      + ` profile not found: all fields MUST be null`
    );
  }
  t.end();
}

function validatePaginationSummary(
  t:    Test,
  page: ProposalsPage,
) {
  const summary = page.pagination_summary;
  t.equal(
    summary.total_pages,
    Math.ceil(summary.total_entries / summary.page_size),
    `property: total_pages = total_entries / page_size rounded up`,
  );
  t.ok(
    page.proposals.length <= summary.page_size,
    `property: page has at most page_size proposals`,
  );
}
