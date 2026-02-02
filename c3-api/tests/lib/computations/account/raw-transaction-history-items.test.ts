import t from 'tap';
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

import * as evm     from '../../../../lib/computations/evm.js';
import * as comet   from '../../../../lib/computations/comet.js';
import * as account from '../../../../lib/computations/account.js';

import '../../../../shim/node-self.js';

import { setupTestEnvVars } from '../../../util/setupTestEnvVars.js';

/*
 * High-level test suite configuration.
 */
const network: KnownNetwork.Name = 'ethereum-mainnet';
const accountAddress = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';
const contract = Eth.wellKnownContractsByNetwork[network]['Comet']['cUSDCv3'];
const startBlock: Eth.Block = {
  date: '2023-02-01',
  number: 16_535_586,
  timestamp: 1_675_302_864,
};
/*
 * Global env.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);
const dumpPath = `tests/dumps/computations/account/raw-transaction-history-items`;

const testDebug = debug.scope('test');
testDebug.log({ flags });

let apiHost = '';
let nodeHost = '';
let nodeKey = '';
t.before(() => {
  ({ apiHost, nodeHost, nodeKey } = setupTestEnvVars());
});

/*
 *
 */

t.test(`test rawTransactionHistoryItems`, async t => {
  /*
   * Load cache seed to skip calls to Infura.
   */
  const cacheSeedDumpPath = (
    `./${dumpPath}/${accountAddress}@startBlock:${startBlock.number}.cache-seed.json`
  );
  let seed = {};
  if (flags.testShouldLoadCacheSeed) {
    testDebug.log(`loading cache seed from ${cacheSeedDumpPath}`);
    seed = await jsonUtil.load<{ [_: string]: any }>(cacheSeedDumpPath);
  }
  const cache = new MemoryCache(seed, [
    BigNumber.JsonReviver,
    BigFixnum.JsonReviver,
  ]);
  /*
   * Load expected result dump.
   */
  const expectationDumpPath = (
    `./${dumpPath}/${accountAddress}@startBlock:${startBlock.number}.result.json`
  );
  let expectationDump: account.RawTransactionHistoryItems['returns'] = [];
  if (!flags.testRegenerateDump) {
    testDebug.log(`loading expectation dump from ${expectationDumpPath}`);
    expectationDump = await jsonUtil.load(expectationDumpPath);
  }
  /*
   * Evaluate the comet trnansaction history with no 30 entries loops
   * startBlock on mainnet, cUSDCv3 (02-usdc).
   */
  const evaluator = Evaluator.instantiate<(
    | evm.EthGetBlock
    | account.RawTransactionHistoryItems
  )>(
    {
      ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
      ...comet,
      ...account,
    },
    { cache, flags, debug },
  );
  const rawItems = await evaluator.evaluate(evaluator.pull1({
    rawTransactionHistoryItems: {
      apiHost,
      nodeHost,
      nodeKey,
      accountAddress,
      proxyAddresses: [],
      network: 'ethereum-mainnet',
      marketContracts: [contract],
      rewardsContract: contract.rewards.contract,
      blockNumber: startBlock.number,
    },
  }));

  /*
   * Check that the result matches the expectation dump.
   */
  t.strictSame(
    JSON.parse(JSON.stringify(rawItems)),
    expectationDump,
    `raw transaction items should match dump`,
  );

  /*
   * If tests passed and we're supposed to regenerate the cache seed,
   * write cache entries beginning with 'eth' to the cache seed.
   */
  if (t.passing() && flags.testRegenerateCacheSeed) {
    testDebug.group(`regenerating cache seed: writing new seed...`);
    const newSeed = Object.fromEntries(
      Object.entries(cache.store)
        .filter(([key]) => key.startsWith('eth'))
    );
    await fs.writeFile(cacheSeedDumpPath, JSON.stringify(newSeed));
    testDebug.log(`✓ done`).groupEnd();
  }
  /*
   * If we're supposed to regenerate the expectation dump, ignore if tests
   * are failing and write the new result to the expectation dump.
   */
  if (flags.testRegenerateDump) {
    testDebug.group(`regenerating dump: writing new dump...`);
    await fs.writeFile(expectationDumpPath, JSON.stringify(rawItems));
    testDebug.log(`✓ done`).groupEnd();
  }
});
