import t from 'tap';
import * as fs from 'node:fs/promises';

import * as jsonUtil from '../../../util/json.js';

import fetch         from '../../../../lib/request-counting-fetch.js';
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
import * as market  from '../../../../lib/computations/market.js';
import * as account from '../../../../lib/computations/account.js';

import '../../../../shim/node-self.js';

import { setupTestEnvVars } from '../../../util/setupTestEnvVars.js';

/*
 * Global env.
 */
const flags = Flags.parseWithDefaults(process.env);
const dumpPath = `tests/dumps/computations/account/enrich-transaction-history-items`;
fetch.debug.configure(process.env);

const debug = Debug.MakeLogger([]).configure(process.env);
const testDebug = debug.scope('test');
testDebug.log({ flags });

let apiHost = '';
let nodeHost = '';
let nodeKey = '';
t.before(() => {
  ({ apiHost, nodeHost, nodeKey } = setupTestEnvVars());
});

t.test(`Test enrichment market history items with proper balanceOf info`, async t => {
  const network: KnownNetwork.Name = 'ethereum-mainnet';
  const contract = Eth.wellKnownContractsByNetwork[network]['Comet']['cWETHv3'];
  const accountAddress = '0xcfc50541c3dEaf725ce738EF87Ace2Ad778Ba0C5';
  const startBlock: Eth.Block = {
    date: '2023-03-17',
    number: 16844803,
    timestamp: 1679048212,
  };

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

  const evaluator = Evaluator.instantiate<(
    | evm.EthGetBlock
    | account.RawTransactionHistoryItems
    | account.EnrichTransactionHistoryItem
  )>(
    {
      ...comet,
      ...market,
      ...account,
      ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
    },
    { cache, flags, debug },
  );

  const enrich1 = await evaluator.evaluate(evaluator.pipe1([
    {
      rawTransactionHistoryItems: {
        apiHost,
        nodeHost,
        nodeKey,
        network,
        marketContracts: [ contract ],
        rewardsContract: contract.rewards.contract,
        accountAddress,
        proxyAddresses: [],
        blockNumber: startBlock.number,
      },
    },
    rawItems => evaluator.split(rawItems.map(item => evaluator.pull1({
      enrichTransactionHistoryItem: {
        apiHost,
        nodeHost,
        nodeKey,
        item,
        network,
        contract,
        accountAddress,
      },
    }))),
  ]));

  /*
   * Additional regression tests to ensure the balanceOf and borrowBalanceOf is correct
   */
  const itemToVerify = enrich1.find(item => item.transactionHash === '0xd1a2c3ac1666d1aa5b29ab74da824bc2a269be1f1e6b6ef27c65a71de28c5eed');
  t.ok(itemToVerify !== undefined, 'item should be found');
  t.equal(itemToVerify?.actions.length, 1, 'item should only have one action');
  t.equal(itemToVerify?.actions[0].actionType, 'Repay');
  t.equal(itemToVerify?.actions[0].eventType, 'Supply');
  t.equal(itemToVerify?.actions[0].token.address, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  t.equal(itemToVerify?.actions[0].token.symbol, 'WETH');
  t.equal(itemToVerify?.actions[0].amount.toString(), '850.28');

  /*
   * Check that the result matches the expectation dump.
   */
  t.strictSame(
    JSON.parse(JSON.stringify(enrich1)),
    expectationDump,
    `enriched transaction history items should match dump`,
  );

  /*
   * If tests passed and we're supposed to regenerate the cache seed,
   * write cache entries beginning with 'eth' to the cache seed.
   */
  if (t.passing() && flags.testRegenerateCacheSeed) {
    testDebug.group(`regenerating cache seed: writing new seed...`);
    const newSeed = Object.fromEntries(
      Object.entries(cache.store)
        .filter(([ key ]) => key.startsWith('eth'))
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
    await fs.writeFile(expectationDumpPath, JSON.stringify(enrich1));
    testDebug.log(`✓ done`).groupEnd();
  }
});

t.test(`Test enrichment market history items with proper actions split function account for dusty accrual balance`, async t => {
  const network: KnownNetwork.Name = 'ethereum-mainnet';
  const contract = Eth.wellKnownContractsByNetwork[network]['Comet']['cWETHv3'];
  const accountAddress = '0xcfc50541c3dEaf725ce738EF87Ace2Ad778Ba0C5';
  const startBlock: Eth.Block = {
    date: '2023-03-17',
    number: 16844803,
    timestamp: 1679048212,
  };

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
    | account.EnrichTransactionHistoryItem
  )>(
    {
      ...comet,
      ...market,
      ...account,
      ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
    },
    { cache, flags, debug },
  );
  const enrich1 = await evaluator.evaluate(evaluator.pipe1([
    {
      rawTransactionHistoryItems: {
        apiHost,
        nodeHost,
        nodeKey,
        network,
        marketContracts: [ contract ],
        rewardsContract: contract.rewards.contract,
        accountAddress,
        proxyAddresses: [],
        blockNumber: startBlock.number,
      },
    },
    rawItems => evaluator.split(rawItems.map(item => evaluator.pull1({
      enrichTransactionHistoryItem: {
        apiHost,
        nodeHost,
        nodeKey,
        item,
        network,
        contract,
        accountAddress,
      },
    }))),
  ]));

  /*
  * Additional regression tests to ensure the balanceOf and borrowBalanceOf is correct
  */
  const itemToVerify = enrich1.find(item => item.transactionHash === '0xe12ab2365b2645b6311fcca41b7cc0502c4b2f28f64f63fc999bff63b0cbf03b');
  t.ok(itemToVerify !== undefined, 'item should be found');
  t.equal(itemToVerify?.actions.length, 1, 'item should only have one action');
  t.equal(itemToVerify?.actions[0].actionType, 'Withdraw');
  t.equal(itemToVerify?.actions[0].eventType, 'Withdraw');
  t.equal(itemToVerify?.actions[0].contract.address, '0xa17581a9e3356d9a858b789d68b4d866e593ae94');
  t.equal(itemToVerify?.actions[0].token.symbol, 'WETH', 'item should be WETH');
  t.equal(itemToVerify?.actions[0].token.address, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  t.equal(itemToVerify?.actions[0].amount.toString(), '2771.851745062982117427');

  /*
   * Check that the result matches the expectation dump.
   */
  t.strictSame(
    JSON.parse(JSON.stringify(enrich1)),
    expectationDump,
    `enriched transaction history items should match dump`,
  );

  /*
   * If tests passed and we're supposed to regenerate the cache seed,
   * write cache entries beginning with 'eth' to the cache seed.
   */
  if (t.passing() && flags.testRegenerateCacheSeed) {
    testDebug.group(`regenerating cache seed: writing new seed...`);
    const newSeed = Object.fromEntries(
      Object.entries(cache.store)
        .filter(([ key ]) => key.startsWith('eth'))
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
    await fs.writeFile(expectationDumpPath, JSON.stringify(enrich1));
    testDebug.log(`✓ done`).groupEnd();
  }
});

t.test(`Test enrichment market history items`, async t => {
  const network: KnownNetwork.Name = 'ethereum-mainnet';
  const contract = Eth.wellKnownContractsByNetwork[network]['Comet']['cUSDCv3'];
  const accountAddress = '0x5bD458485d40ca6232b8c96AA88A1D69264Ad36D';
  const startBlock: Eth.Block = {
    date: '2023-01-23',
    number: 16467789,
    timestamp: 1674485063,
  };

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
    | account.EnrichTransactionHistoryItem
  )>(
    {
      ...comet,
      ...market,
      ...account,
      ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
    },
    { cache, flags, debug },
  );
  const enrich1 = await evaluator.evaluate(evaluator.pipe1([
    {
      rawTransactionHistoryItems: {
        apiHost,
        nodeHost,
        nodeKey,
        network,
        marketContracts: [contract],
        rewardsContract: contract.rewards.contract,
        accountAddress,
        proxyAddresses: [],
        blockNumber: startBlock.number,
      },
    },
    rawItems => evaluator.split(rawItems.map(item => evaluator.pull1({
      enrichTransactionHistoryItem: {
        apiHost,
        nodeHost,
        nodeKey,
        item,
        network,
        contract,
        accountAddress,
      },
    }))),
  ]));

  /*
   * Check that the result matches the expectation dump.
   */
  t.strictSame(
    JSON.parse(JSON.stringify(enrich1)),
    expectationDump,
    `enriched transaction history items should match dump`,
  );

  /*
   * If tests passed and we're supposed to regenerate the cache seed,
   * write cache entries beginning with 'eth' to the cache seed.
   */
  if (t.passing() && flags.testRegenerateCacheSeed) {
    testDebug.group(`regenerating cache seed: writing new seed...`);
    const newSeed = Object.fromEntries(
      Object.entries(cache.store)
        .filter(([ key ]) => key.startsWith('eth'))
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
    await fs.writeFile(expectationDumpPath, JSON.stringify(enrich1));
    testDebug.log(`✓ done`).groupEnd();
  }
});
