import t from 'tap';

import { defaultAbiCoder } from '@ethersproject/abi';

import C3Api from '../../entrypoint.js';

import * as Eth from '../../lib/eth-constants.js';
import * as Compute from '../../lib/symbolic/computation.js';
import * as cometModel from '../../lib/model/comet.js';
import { checksumAddress } from '../../lib/model/comet-registry.js';
import { accountRewards } from '../../lib/computations/account/account-rewards.js';
import { enrichTransactionHistoryItem } from '../../lib/computations/account/enrich-transaction-history-items.js';
import { rawTransactionHistoryItems } from '../../lib/computations/account/raw-transaction-history-items.js';

import { consoleLines } from '../util/console.js';
import { fakeNode, serve } from '../util/fake-node.js';
import { MemoryKv } from '../util/kv.js';
import { activeRegistryDatabase } from '../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../util/registry-fixture.js';
import { makeTestEnv } from '../util/test-env.js';

import '../../shim/node-self.js';

/*
 * An address in any case is one account. The account routes hand their
 * handlers the account in lowercase, and the history and the rewards cache
 * what they compute by it, so every form of an address is answered from one
 * set of entries: a client that sends another form than the one before reads
 * what is cached, and adds nothing to KV. Before, each form had entries of its
 * own, and the first page in a new one read the whole history again from the
 * node; a mixed case with a wrong checksum failed with a 500.
 */
const ACCOUNT     = '0x420f253087044b8bcf028dd89f8fe83ba6275e84';
// the form the app sends, as a wallet gives it
const CHECKSUMMED = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';
const WRONG_SUM   = CHECKSUMMED.replace('0x420f', '0x420F');
// the other forms of the address a client can send, each asked for after the checksummed one
const OTHER_FORMS: Array<[ string, string ]> = [
  [ ACCOUNT,                                'the lowercase form' ],
  [ `0x${ACCOUNT.slice(2).toUpperCase()}`,  'the uppercase form' ],
  [ WRONG_SUM,                              'a mixed case whose checksum is wrong' ],
];

const USDC = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

// what the cache keys of a computation start with, at the version it is at
const RAW_ITEMS = Compute.versionedName('rawTransactionHistoryItems', rawTransactionHistoryItems.version);
const ENRICHED  = Compute.versionedName('enrichTransactionHistoryItem', enrichTransactionHistoryItem.version);
const OWED      = Compute.versionedName('accountRewards', accountRewards.version);

t.test('the forms are of one address, and an account is encoded only with the right checksum', async t => {
  t.equal(checksumAddress(ACCOUNT), CHECKSUMMED, 'the checksummed form is the EIP-55 one');
  t.ok(OTHER_FORMS.every(([ form ]) => form !== CHECKSUMMED && form.toLowerCase() === ACCOUNT),
    'and every other form is another spelling of the same address');
  t.doesNotThrow(() => defaultAbiCoder.encode([ 'address' ], [ CHECKSUMMED ]), 'the ABI coder takes the checksummed form');
  t.throws(() => defaultAbiCoder.encode([ 'address' ], [ WRONG_SUM ]), 'and refuses the wrong checksum, which the route lowercases first');
});

async function namesIn(kv: KVNamespace): Promise<string[]> {
  return (await kv.list()).keys.map(key => key.name).sort();
}

/*
 * The history: in each of three blocks, the account supplied itself
 * collateral to the USDC market, in a transaction it sent, which the node
 * names in lowercase. Mainnet's markets are read as one stream, in ranges of
 * a million blocks from USDC's creation block, 15,331,586, in the fixture:
 * with the latest block at 16,500,000, the first block is in the newest
 * range, and the other two in the range below it. A first page holds all
 * three and is done: it has read and enriched everything it started before
 * it answers, so what it caches is in KV by then, and nothing it started is
 * left running to write more.
 */
const LATEST  = 16_500_000;
const HISTORY = [ 16_400_000, 16_000_000, 15_500_000 ];

// the account's transaction in a block, named after the block
function transactionIn(block: number): string {
  return `0x${block.toString(16).padStart(64, '0')}`;
}

function topicOf(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

const SUPPLY_COLLATERAL = Eth.Event.Coder.fromSignatures([ cometModel.events.SupplyCollateral ]).topics.SupplyCollateral;
const LOGS = HISTORY.map(block => ({
  address:          USDC,
  topics:           [ SUPPLY_COLLATERAL, topicOf(ACCOUNT), topicOf(ACCOUNT), topicOf(WETH) ],
  data:             defaultAbiCoder.encode([ 'uint256' ], [ '1000000000000000000' ]),
  blockNumber:      Eth.Hex.fromNumber(block),
  blockHash:        transactionIn(block),
  transactionHash:  transactionIn(block),
  transactionIndex: '0x0',
  logIndex:         '0x0',
  removed:          false,
}));

type Condition = null | string | string[];
type Call = { id: number, method: string, params: any[] };

function answer({ method, params }: Call): object {
  switch (method) {
    case 'eth_getBlockByNumber': {
      const [ reference ] = params;
      const number = reference === 'latest' ? LATEST : parseInt(reference, 16);
      return { result: {
        number:       Eth.Hex.fromNumber(number),
        timestamp:    Eth.Hex.fromNumber(1_600_000_000 + number),
        transactions: reference === 'latest' ? [] : HISTORY
          .filter(block => block === number)
          .map(block => ({ hash: transactionIn(block), from: ACCOUNT, to: USDC })),
      } };
    }
    case 'eth_getLogs': {
      const [ { address, fromBlock, toBlock, topics } ] = params as [ { address: string[], fromBlock: string, toBlock: string, topics: Condition[] } ];
      const matches = (condition: Condition, topic: string | undefined) => (
        condition === null || [ condition ].flat().some(value => value.toLowerCase() === topic)
      );
      return { result: LOGS.filter(log => true
        && address.some(contract => contract.toLowerCase() === log.address)
        && parseInt(log.blockNumber, 16) >= parseInt(fromBlock, 16)
        && parseInt(log.blockNumber, 16) <= parseInt(toBlock, 16)
        && topics.every((condition, index) => matches(condition, log.topics[index]))
      ) };
    }
    // getAllProxies: the account has no DeFi Saver proxy
    default: return { result: defaultAbiCoder.encode([ 'address', 'address[]' ], [ Eth.NullAddress, [] ]) };
  }
}

/*
 * The node of the history, for as long as the file runs; the rewards test
 * puts the fake node of the Comet reads in its place for its own length.
 */
const fetchBefore = globalThis.fetch;

t.before(() => {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const body    = await new Request(input, init).json() as Call | Call[];
    const calls   = body instanceof Array ? body : [ body ];
    const answers = calls.map(call => ({ jsonrpc: '2.0', id: call.id, ...answer(call) }));
    return new Response(JSON.stringify(body instanceof Array ? answers : answers[0]));
  }) as typeof globalThis.fetch;
});
t.teardown(() => {
  globalThis.fetch = fetchBefore;
});

type Page = { done: boolean, cursor: string, items: Array<{ transaction_hash: string }> };

t.test('every form of an account reads one history, from one set of entries', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const kv = MemoryKv({});

  // a page of the history, with the node's answers uncached, as in production: only what the history caches is
  const pageOf = async (account: string, query = ''): Promise<Page> => {
    const env = makeTestEnv({
      MEMORY_CACHE_SEED:                'account-casing-history',
      APP_DB:                           registry.db,
      kv_mainnet:                       kv,
      FLAGS_ETH_COMPUTATION_INDEX_BIAS: 'default',
    });
    const response = await C3Api.fetch(new Request(`https://api.test.local/account/${account}/transaction_history${query}`), env);
    t.equal(response.status, 200, `the history of ${account}${query} is answered`);
    return await response.json() as Page;
  };

  const first = await pageOf(CHECKSUMMED);
  t.same(first.items.map(item => item.transaction_hash), HISTORY.map(transactionIn), 'the history of the account, on one page');
  t.equal(first.done, true, 'which is all of it');

  /*
   * initiated_by[]=me keeps an item whose sender, as the node names it, is
   * the account. The node names it in lowercase, the form the account is now
   * handed on in, so a checksummed path finds the account's own items; an
   * item sent through a DeFi Saver proxy or a migrator would be the other's,
   * and this history has none.
   */
  const mine   = await pageOf(CHECKSUMMED, '?initiated_by[]=me');
  const others = await pageOf(CHECKSUMMED, '?initiated_by[]=other');
  t.same(mine.items.map(item => item.transaction_hash), HISTORY.map(transactionIn), 'initiated_by[]=me keeps what the account sent');
  t.same(others.items, [], 'and initiated_by[]=other none of it');

  // what the checksummed form left: the ranges and items it read, and the cursors of its pages
  const stored = await namesIn(kv);
  const keyed  = stored.filter(name => name.startsWith(`${RAW_ITEMS}:`) || name.startsWith(`${ENRICHED}:`));
  t.ok(keyed.some(name => name.startsWith(`${RAW_ITEMS}:`)) && keyed.some(name => name.startsWith(`${ENRICHED}:`)),
    'its ranges and its items are cached');
  t.ok(keyed.every(name => name.includes(`accountAddress:${ACCOUNT}`)), 'under the lowercase account');

  for (const [ account, what ] of OTHER_FORMS) {
    t.same(await pageOf(account), first, `${what} reads the same page, its cursor too`);
    t.same(await namesIn(kv), stored, 'from the entries the checksummed form left, adding none');
  }
});

t.test('every form of an account is answered its rewards from one set of entries', async t => {
  consoleLines(t, [ 'warn' ]);
  const fixture  = loadRegistrySnapshotFixture();
  const registry = await activeRegistryDatabase({ snapshot: fixture });
  t.teardown(() => registry.dispose());
  serve(t, fakeNode(fixture, { number: 30_000_000, timestamp: 1_790_000_000 }));
  const kv = MemoryKv({});

  /*
   * Each request as an isolate of its own would make it: what answers it is
   * KV, not the memory cache of the request before. The node's answers are
   * uncached, as in production.
   */
  const rewardsOf = async (account: string, isolate: string): Promise<unknown> => {
    const env = makeTestEnv({
      MEMORY_CACHE_SEED:                `account-casing-rewards-${isolate}`,
      APP_DB:                           registry.db,
      kv_mainnet:                       kv,
      FLAGS_ETH_COMPUTATION_INDEX_BIAS: 'default',
    });
    const response = await C3Api.fetch(new Request(`https://api.test.local/account/${account}/rewards`), env);
    t.equal(response.status, 200, `the rewards of ${account} are answered`);
    return await response.json();
  };

  const first  = await rewardsOf(CHECKSUMMED, 'checksummed');
  t.ok(Array.isArray(first) && first.length > 0, 'for the markets the account can claim rewards on');
  const stored = await namesIn(kv);
  const owed   = stored.filter(name => name.startsWith(`${OWED}:`));
  t.ok(owed.length > 0, 'what the account is owed is cached');
  t.ok(owed.every(name => name.includes(`account:${ACCOUNT}`)), 'under the lowercase account');

  for (const [ index, [ account, what ] ] of OTHER_FORMS.entries()) {
    t.same(await rewardsOf(account, `form-${index}`), first, `${what} is answered the same`);
    t.same(await namesIn(kv), stored, 'from the entries the checksummed form left, adding none');
  }
});
