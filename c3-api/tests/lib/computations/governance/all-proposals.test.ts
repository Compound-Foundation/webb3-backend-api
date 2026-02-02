import t       from 'tap';
import * as fs from 'node:fs/promises';

import * as jsonUtil from '../../../util/json.js';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as KnownNetwork from '../../../../lib/well-known/networks/network.js';

import * as evm        from '../../../../lib/computations/evm.js';
import * as governance from '../../../../lib/computations/governance.js';

import * as proposalModel from '../../../../lib/model/governance/proposal.js';

import '../../../../shim/node-self.js';

import { setupTestEnvVars } from '../../../util/setupTestEnvVars.js';
import * as mock from '../../../util/mock/mock.js';

/*
 * High-level test suite configuration.
 */
const network: KnownNetwork.Name = 'ethereum-mainnet';
const testBlock: Eth.Block = {
  number:    16_221_483,
  timestamp: 1_671_485_975,
  date:      '2022-12-19',
};
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);
const dumpPath = `tests/dumps/computations/governance/all-proposals`;

let apiHost = '';
let nodeHost = '';
let nodeKey = '';
t.before(() => {
  ({ apiHost, nodeHost, nodeKey } = setupTestEnvVars());
});

// prevent fetch from accessing the network
t.beforeEach(() => {
  global.fetch = mock.fetch({ passthrough: flags.testAllowFetchPassthrough });
});

const testDebug = debug.scope('test');
testDebug.log({ flags });

t.test(`allProposals alpha + bravo @ block=${testBlock.number}`, async t => {
  /*
   * 1. Setup.
   */
  /*
   * Load cache seed. Preloading ethGetLogs and ethGetBlock results allows
   * us to skip over 2m of I/O and up to hundreds of Infura calls.
   */
  const v3CacheSeedDumpPath = (
    `./${dumpPath}/alpha-concat-bravo@blockNumber:${testBlock.number}.cache-seed.json`
  );
  let seed = {};
  // NOTE: Only load the cache seed if test flags configuration says so
  if (flags.testShouldLoadCacheSeed) {
    testDebug.log(`loading cache seed from ${v3CacheSeedDumpPath}`);
    seed = await jsonUtil.load<{ [_: string]: any }>(v3CacheSeedDumpPath);
  }
  const cache = new MemoryCache(seed, [
    BigNumber.JsonReviver,
    BigFixnum.JsonReviver,
  ]);
  /*
   * Load the expectation dump.
   */
  const v3ExpectationDumpPath = (
    `./${dumpPath}/alpha-concat-bravo@blockNumber:${testBlock.number}.result.json`
  );
  let v3Dump: proposalModel.Proposal[] = [];
  if (!flags.testRegenerateDump) {
    testDebug.log(`loading expectation dump from ${v3ExpectationDumpPath}`);
    v3Dump = await jsonUtil.load<proposalModel.Proposal[]>(
      v3ExpectationDumpPath,
      [
        BigNumber.JsonReviver,
        BigFixnum.JsonReviver,
      ]
    );
  }
  // TODO(jordan): slightly better validation here, maybe?
  if (!(v3Dump instanceof Array)) {
    throw new Error(
      `invalid all-proposals JSON dump at`
      + ` ${v3ExpectationDumpPath}: not an array`
    );
  }

  /*
   * Constants.
   */
  const wellKnown = Eth.wellKnownContractsByNetwork[network];
  // FIXME(jordan): should not need to specify address here...
  const alphaContract = wellKnown['GovernorAlpha']['0xc0da01a04c3f3e0be433606045bb7017a7323e38'];
  // FIXME(jordan): should not need to specify address here...
  const bravoContract = wellKnown['GovernorBravo']['0xc0da02939e1441f497fd74f78ce7decb17b66529'];

  /*
   * Compute and gather all proposals over governors alpha and bravo, up
   * to the specified testBlock.
   */
  const { evaluate, pull1, join } = Evaluator.instantiate<governance.AllProposals>(
    {
      ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
      ...governance,
    },
    { cache, flags, debug },
  );
  const proposals = await evaluate(join([
    <const>([
      pull1({
        allProposals: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          contract:    alphaContract,
          blockNumber: testBlock.number,
        },
      }),
      pull1({
        allProposals: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          contract:    bravoContract,
          blockNumber: testBlock.number,
        },
      }),
    ]),
    ([ alpha, bravo ]) => alpha.concat(bravo),
  ]));

  /*
   * Test that every proposal matches its counterpart in the dump.
   */
  for (const proposal of proposals) {
    const expected = v3Dump.find(({ id }) => id.eq(proposal.id));
    if (!expected) {
      if (!flags.testRegenerateDump) {
        t.fail(`proposal[${proposal.id}] was not found in dump`);
      } else {
        testDebug.log(`regenerating dump: ignoring missing proposal[${proposal.id}]`);
      }
      continue;
    }
    const prefix = `proposal[${proposal.id}]`;
    // equal: eta, title, endblock, startblock, description
    t.equal(proposal.eta,         expected.eta,           `${prefix}.eta`);
    t.equal(proposal.title,       expected.title,         `${prefix}.title`);
    t.equal(proposal.endBlock,    expected.endBlock,      `${prefix}.endBlock`);
    t.equal(proposal.startBlock,  expected.startBlock,    `${prefix}.startBlock`);
    t.equal(proposal.description, expected.description,   `${prefix}.description`);
    // deeply same: states, actions, proposer, voteEntries
    t.strictSame(proposal.states,      expected.states,      `${prefix}.states`);
    t.strictSame(proposal.actions,     expected.actions,     `${prefix}.actions`);
    t.strictSame(proposal.proposer,    expected.proposer,    `${prefix}.proposer`);
    t.strictSame(proposal.voteEntries, expected.voteEntries, `${prefix}.voteEntries`);
  }

  /*
   * If tests passed and we're supposed to regenerate the cache seed,
   * write all the cache entries beginning with 'eth' to the cache seed.
   */
  if (t.passing() && flags.testRegenerateCacheSeed) {
    testDebug.group(`regenerating cache seed: writing new seed...`);
    const newSeed = Object.fromEntries(
      Object.entries(cache.store)
        .filter(([ key ]) => key.startsWith('eth'))
    );
    await fs.writeFile(v3CacheSeedDumpPath, JSON.stringify(newSeed));
    testDebug.log(`✓ done`).groupEnd();
  }
  /*
   * If tests passed and we're supposed to regenerate the expectation
   * dump, then we should write the new result to the expectation dump.
   */
  if (t.passing() && flags.testRegenerateDump) {
    testDebug.group(`regenerating dump: writing new dump...`);
    await fs.writeFile(v3ExpectationDumpPath, JSON.stringify(proposals));
    testDebug.log(`✓ done`).groupEnd();
  }
});
