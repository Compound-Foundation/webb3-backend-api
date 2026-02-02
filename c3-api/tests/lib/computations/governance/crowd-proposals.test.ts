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

import * as governanceModel from '../../../../lib/model/governance.js';

import '../../../../shim/node-self.js';

import { setupTestEnvVars } from '../../../util/setupTestEnvVars.js';

/*
 * High-level test suite configuration.
 */
const network: KnownNetwork.Name = 'ethereum-mainnet';
const testBlock: Eth.Block = {
  number:       14_385_557,
  timestamp: 1_647_271_959,
  date:       '2022-03-14',
};
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);
const dumpPath = `tests/dumps/computations/governance/crowd_proposals`;

const testDebug = debug.scope('test');
testDebug.log({ flags });

let apiHost = '';
let nodeHost = '';
let nodeKey = '';
t.before(() => {
  ({ apiHost, nodeHost, nodeKey } = setupTestEnvVars());
});

t.test(`crowd proposals @ block=${testBlock.number}`, async t => {
  /*
   * 1. Setup.
   */
  /*
   * Load cache seed. Preloading ethGetLogs and ethGetBlock results allows
   * us to skip over 2m of I/O and up to hundreds of Infura calls.
   */
  const v3CacheSeedDumpPath = (
    `./${dumpPath}/all@blockNumber:${testBlock.number}.cache-seed.json`
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
    `./${dumpPath}/all@blockNumber:${testBlock.number}.result.json`
  );
  let v3Dump: governanceModel.crowdProposal.CrowdProposal[] = [];
  if (!flags.testRegenerateDump) {
    testDebug.log(`loading expectation dump from ${v3ExpectationDumpPath}`);
    v3Dump = await jsonUtil.load<governanceModel.crowdProposal.CrowdProposal[]>(
      v3ExpectationDumpPath,
      [
        BigNumber.JsonReviver,
        BigFixnum.JsonReviver,
      ]
    );
  }
  if (!(v3Dump instanceof Array)) {
    throw new Error(
      `invalid crowd-proposals JSON dump at`
      + ` ${v3ExpectationDumpPath}: not an array`
    );
  }

  const wellKnownContracts = Eth.wellKnownContractsByNetwork[network];

  const { evaluate, pull1 } = Evaluator.instantiate<governance.CrowdProposals>(
    {
      ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
      ...governance,
    },
    { cache, flags, debug },
  );
  const crowdProposals = await evaluate(pull1({
    crowdProposals: {
      apiHost,
      nodeHost,
      nodeKey,
      network: 'ethereum-mainnet',
      contract: wellKnownContracts['CrowdProposalFactory']['default'],
      blockNumber: testBlock.number,
    }
  }));

  /*
   * Test that every crowd proposal matches its counterpart in the dump.
   */
  for (const crowdProposal of crowdProposals) {
    const expected = v3Dump.find(({ proposalAddress }) => proposalAddress === crowdProposal.proposalAddress);
    if (!expected) {
      if (!flags.testRegenerateDump) {
        t.fail(`crowd_proposal[${crowdProposal.proposalAddress}] was not found in dump`);
      } else {
        testDebug.log(`regenerating dump: ignoring missing crowd_proposal[${crowdProposal.proposalAddress}]`);
      }
      continue;
    }
    const prefix = `crowd_proposal[${crowdProposal.proposalAddress}]`;
    // equal: eta, title, endblock, startblock, description
    t.equal(crowdProposal.proposalAddress, expected.proposalAddress, `${prefix}.proposalAddress`);
    t.equal(crowdProposal.description,     expected.description,     `${prefix}.description`);
    t.equal(crowdProposal.author.address,  expected.author.address,  `${prefix}.author.address`);
    t.equal(crowdProposal.createBlock,     expected.createBlock,     `${prefix}.createBlock`);
    t.equal(crowdProposal.proposeBlock,    expected.proposeBlock,    `${prefix}.proposeBlock`);
    t.equal(crowdProposal.terminateBlock,  expected.terminateBlock,  `${prefix}.terminateBlock`);
    t.equal(crowdProposal.createTime,      expected.createTime,      `${prefix}.createTime`);
    t.equal(crowdProposal.proposeTime,     expected.proposeTime,     `${prefix}.proposeTime`);
    t.equal(crowdProposal.terminateTime,   expected.terminateTime,   `${prefix}.terminateTime`);
    t.equal(crowdProposal.state,           expected.state,           `${prefix}.state`);
    t.strictSame(crowdProposal.actions,    expected.actions,         `${prefix}.actions`);
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
    await fs.writeFile(v3ExpectationDumpPath, JSON.stringify(crowdProposals));
    testDebug.log(`✓ done`).groupEnd();
  }
});
