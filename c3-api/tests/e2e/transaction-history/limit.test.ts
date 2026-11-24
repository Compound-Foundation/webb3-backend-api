import t from 'tap';

import { defaultAbiCoder } from '@ethersproject/abi';

import C3Api, { Env } from '../../../entrypoint.js';

import * as Eth from '../../../lib/eth-constants.js';
import * as cometModel from '../../../lib/model/comet.js';

import { makeTestEnv } from '../../util/test-env.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';

import '../../../shim/node-self.js';

/*
 * How many items a page of one account's history holds, as `limit` asks: a
 * number of 1 or more in decimal digits alone, 15 when it is left out, and at
 * most 15 whatever it asks. Any other value is a 400 that names it, answered
 * before the registry is read. Before, parseInt read every value: 0, a
 * negative number or text made a page of no items that was not done, whose
 * cursor stayed where it was, so a client that paged until the history was
 * done never got there; 1.5 and 1e3 were read as 1, and 0x10 as 16.
 *
 * The node holds 20 transactions of the account, all in the newest of the two
 * ranges mainnet's markets are read in: [16,331,587, 16,500,000], above
 * [15,331,586, 16,331,586], counted from USDC's creation block in the fixture.
 */
const ACCOUNT = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WETH    = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const LATEST  = 16_500_000;
// the blocks of the account's transactions, newest first
const HISTORY = Array.from({ length: 20 }, (_, index) => 16_400_000 - index * 1_000);

// the account's transaction in a block, named after the block
function transactionIn(block: number): string {
  return `0x${block.toString(16).padStart(64, '0')}`;
}

function topicOf(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

/*
 * The node: in each block of HISTORY, the account supplied itself collateral
 * to the USDC market. eth_getLogs answers the logs that the range and the
 * topics it is asked for match, as a node does.
 */
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
 * A page reads ranges ahead of what it answers, and those reads go on after
 * it is answered, so the node answers for as long as the file runs.
 */
t.before(() => {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const calls = await new Request(input, init).json() as Call[];
    return new Response(JSON.stringify(calls.map(call => ({ jsonrpc: '2.0', id: call.id, ...answer(call) }))));
  }) as typeof globalThis.fetch;
});

type Page = { done: boolean, cursor: string, item_limit: number, items: Array<{ transaction_hash: string }> };

// a page asked with these query parameters, each sent as it is written here
function page(env: Env, query: Record<string, string>): Promise<Response> {
  const search = new URLSearchParams(query).toString();
  return C3Api.fetch(new Request(`https://api.test.local/account/${ACCOUNT}/transaction_history?${search}`), env);
}

t.test('a limit of 1 or more answers up to that many items, and never more than 15', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env = makeTestEnv({ MEMORY_CACHE_SEED: 'history-limit', APP_DB: registry.db });

  for (const [ limit, count, what ] of [
    [ null,            15, 'without a limit, a page holds 15 items' ],
    [ '1',              1, 'a limit of 1 holds one' ],
    [ '15',            15, 'a limit of 15 holds 15' ],
    [ '30',            15, 'a limit of 30, which the app sends, holds 15' ],
    [ '05',             5, 'leading zeros are read in decimal' ],
    [ '9'.repeat(400), 15, 'and a limit of any number of digits holds 15' ],
  ] as const) {
    const response = await page(env, limit === null ? {} : { limit });
    t.equal(response.status, 200, `${what}: the page is answered`);
    const { item_limit, items } = await response.json() as Page;
    t.same([ item_limit, items.map(item => item.transaction_hash) ], [ count, HISTORY.slice(0, count).map(transactionIn) ],
      `${what}, the newest, and says so`);
  }
});

t.test('the cursor of a page goes on with the items after it, and an invalid limit is refused with it too', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env = makeTestEnv({ MEMORY_CACHE_SEED: 'history-limit', APP_DB: registry.db });

  const first = await page(env, { limit: '15' });
  t.equal(first.status, 200, 'the first page is answered');
  const { cursor, done } = await first.json() as Page;
  t.equal(done, false, 'and is not done');

  const refused = await page(env, { limit: '0', cursor });
  t.same([ refused.status, await refused.text() ], [ 400, 'Invalid limit 0' ], 'a limit of 0 with its cursor is refused');

  const next = await page(env, { limit: '15', cursor });
  t.equal(next.status, 200, 'while the cursor goes on with a valid limit');
  const rest = await next.json() as Page;
  t.same(rest.items.map(item => item.transaction_hash), HISTORY.slice(15).map(transactionIn),
    'with the five items after the first fifteen');
  t.equal(rest.done, true, 'which end the history');
});

t.test('any other limit is a 400 that names it, answered before the registry is read', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env = makeTestEnv({ MEMORY_CACHE_SEED: 'history-limit', APP_DB: registry.db });

  for (const [ limit, what ] of [
    [ '0',     'zero' ],
    [ '000',   'zero in three digits' ],
    [ '-1',    'a negative number' ],
    [ '+1',    'a number with a sign' ],
    [ ' 1',    'a number after a space' ],
    [ '1 ',    'a number before a space' ],
    [ '1.5',   'a fraction' ],
    [ '1e3',   'an exponent' ],
    [ '0x10',  'hexadecimal' ],
    [ '10abc', 'digits followed by text' ],
    [ 'ten',   'text' ],
    [ '',      'an empty value' ],
  ] as const) {
    const response = await page(env, { limit });
    t.same([ response.status, await response.text() ], [ 400, `Invalid limit ${limit}` ], `${what} is refused, as sent`);
    t.equal(response.headers.get('x-registry-version'), null, `${what} is refused before the registry is read`);
  }
});
