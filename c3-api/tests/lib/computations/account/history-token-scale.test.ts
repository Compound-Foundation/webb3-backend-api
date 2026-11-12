import t from 'tap';
import { Interface } from '@ethersproject/abi';

import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as account from '../../../../lib/computations/account.js';

import { checksumAddress } from '../../../../lib/model/comet-registry.js';

import { evaluatorOver, stub } from '../../../util/evaluator.js';
import { fixtureCatalog } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * The scale an item of transaction history reads an amount at, on the real
 * computation over logs and reads that answer from tables instead of a node:
 * the version's for a token it describes, and the token's own for one it
 * does not — a collateral a market listed, or a reward token it started
 * paying, after the version's import.
 */
// the history route evaluates recursively, the market routes on the working set; it must not matter which
const ALGORITHMS = [ 'recursive', 'workingset' ] as const;

const network = 'ethereum-mainnet' as const;
const catalog = fixtureCatalog();
const usdc    = catalog.marketAt(network, '0xc3d688b66703497daa19211eedff47f25384cdc3')!.comet;
const BLOCK   = 23_500_000;

const ACCOUNT = '0x1111111111111111111111111111111111111111';
// digits only, so that checksumming leaves them as they are: two tokens the version does not describe
const LISTED  = '0x5555555555555555555555555555555555555555';
const PAID    = '0x6666666666666666666666666666666666666666';
// a collateral the version describes, at 8 decimals
const WBTC    = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';

const events = new Interface([
  'event SupplyCollateral(address indexed from, address indexed dst, address indexed asset, uint amount)',
  'event RewardClaimed(address indexed src, address indexed recipient, address indexed token, uint256 amount)',
]);

// one log, as eth_getLogs answers it, in a transaction of its own
function logOf(address: string, event: string, values: unknown[], index: number) {
  const { data, topics } = events.encodeEventLog(events.getEvent(event), values);
  return {
    address,
    data,
    topics,
    removed:          false,
    logIndex:         `0x${index.toString(16)}`,
    blockHash:        `0x${'00'.repeat(32)}`,
    blockNumber:      `0x${(BLOCK - 10).toString(16)}`,
    transactionIndex: '0x0',
    transactionHash:  `0x${index.toString(16).padStart(64, '0')}`,
  };
}

/*
 * The actions of one page of history over `logs`, with every token whose
 * decimals were asked of the chain. Both queries the computation makes are
 * answered with every log, which it merges by transaction and log index.
 */
async function pageOf(algorithm: typeof ALGORITHMS[number], logs: unknown[], decimals: Record<string, number>) {
  const asked: string[] = [];
  const { evaluate, pull1 } = evaluatorOver({
    rawTransactionHistoryItems: account.rawTransactionHistoryItems,
    ethGetLogs:    stub(() => logs),
    erc20Decimals: stub(({ contract }) => { asked.push(contract.address); return decimals[contract.address.toLowerCase()]; }),
  }, { algorithm });

  const items = await evaluate(pull1({ rawTransactionHistoryItems: {
    apiHost: '', nodeHost: '', nodeKey: '', network, accountAddress: ACCOUNT, proxyAddresses: [],
    blockNumber: BLOCK, marketContracts: [ usdc ], rewardsContract: usdc.rewards!.contract, catalog,
  } })) as Array<{ actions: Array<{ token: { address: string, symbol: string }, amount: BigFixnum }> }>;
  const actions = items.flatMap(item => item.actions).map(action => [ action.token.address, action.token.symbol, action.amount.toString() ]);
  return { actions, asked };
}

t.test('a token the version does not describe is read at the decimals it reports', async t => {
  for (const algorithm of ALGORITHMS) {
    const { actions, asked } = await pageOf(algorithm, [
      logOf(usdc.address, 'SupplyCollateral', [ ACCOUNT, ACCOUNT, WBTC, 150_000_000 ], 1),
      logOf(usdc.address, 'SupplyCollateral', [ ACCOUNT, ACCOUNT, LISTED, 2_500_000 ], 2),
      logOf(usdc.address, 'SupplyCollateral', [ ACCOUNT, ACCOUNT, LISTED, 500_000 ], 3),
      logOf(usdc.rewards!.contract.address, 'RewardClaimed', [ ACCOUNT, ACCOUNT, PAID, 3_000_000_000n ], 4),
    ], { [LISTED]: 6, [PAID]: 9 });

    t.same(actions, [
      [ WBTC, 'WBTC', '1.5' ],
      [ checksumAddress(LISTED), '', '2.5' ],
      [ checksumAddress(LISTED), '', '0.5' ],
      [ checksumAddress(PAID), '', '3.0' ],
    ], `${algorithm}: a described token at the version's scale, an undescribed one at its own, still without a symbol`);
    t.same(asked.sort(), [ LISTED, PAID ], `${algorithm}: only the tokens the version does not describe are asked, each once`);
  }
});

t.test('a page of tokens the version describes asks the chain nothing', async t => {
  for (const algorithm of ALGORITHMS) {
    const { actions, asked } = await pageOf(algorithm, [
      logOf(usdc.address, 'SupplyCollateral', [ ACCOUNT, ACCOUNT, WBTC, 150_000_000 ], 1),
    ], {});
    t.same(actions, [ [ WBTC, 'WBTC', '1.5' ] ], algorithm);
    t.same(asked, [], algorithm);
  }
});
