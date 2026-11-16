import t, { Test } from 'tap';

import { createHash } from 'node:crypto';

import { defaultAbiCoder } from '@ethersproject/abi';

import C3Api, { Env } from '../../../entrypoint.js';

import * as Eth from '../../../lib/eth-constants.js';
import * as cometModel from '../../../lib/model/comet.js';

import { MemoryKv } from '../../util/kv.js';
import { makeTestEnv } from '../../util/test-env.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';

import '../../../shim/node-self.js';

/*
 * How long a transaction history cursor lasts: KV keeps one for 30 days from
 * the page that wrote it, and a cursor of the form the history hands out that
 * KV does not hold is answered with 409 CURSOR_EXPIRED, which tells the client
 * to start over without one. A value of any other form is still a 400.
 *
 * The node holds one account's history, as in the suite of cursors across
 * registry versions: mainnet's markets are read as one stream, in ranges of a
 * million blocks counted from 15,331,586, the latest block is 16,500,000, and
 * the account supplied collateral in three blocks, one a page.
 */
const ACCOUNT = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WETH    = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const LATEST  = 16_500_000;
const HISTORY = [ 16_400_000, 16_000_000, 15_500_000 ];

// the lifetime of a cursor, in seconds: 30 days
const LIFETIME = 30 * 24 * 60 * 60;

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

// a page reads ranges ahead of what it answers, so the node answers for as long as the file runs
t.before(() => {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const calls = await new Request(input, init).json() as Call[];
    return new Response(JSON.stringify(calls.map(call => ({ jsonrpc: '2.0', id: call.id, ...answer(call) }))));
  }) as typeof globalThis.fetch;
});

type Write = { key: string, options: KVNamespacePutOptions | undefined };

/*
 * KV as Workers KV keeps entries, on a clock the test moves: an entry written
 * with an expirationTtl is gone once that many seconds have passed since it
 * was written. Every write is recorded with the options it was given.
 */
function clockedKv(): { kv: KVNamespace, writes: Write[], pass: (seconds: number) => void } {
  const memory = MemoryKv({}) as unknown as {
    get(key: string, type?: unknown): Promise<unknown>,
    put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void>,
  };
  const writes: Write[] = [];
  const expiries = new Map<string, number>();
  let now = 0;
  const kv = new Proxy(memory, {
    get(target, property, receiver) {
      if (property === 'get') {
        return async (key: string, type?: unknown) => (expiries.get(key) ?? Infinity) <= now ? null : target.get(key, type);
      }
      if (property === 'put') {
        return async (key: string, value: string, options?: KVNamespacePutOptions) => {
          writes.push({ key, options });
          if (options?.expirationTtl === undefined) {
            expiries.delete(key);
          } else {
            expiries.set(key, now + options.expirationTtl);
          }
          await target.put(key, value, options);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { kv: kv as unknown as KVNamespace, writes, pass: seconds => { now += seconds; } };
}

function envWith(kv: KVNamespace, db: Env['APP_DB']): Env {
  return makeTestEnv({ MEMORY_CACHE_SEED: 'cursor-lifetime', APP_DB: db, kv_mainnet: kv });
}

function page(env: Env, cursor?: string): Promise<Response> {
  const query = cursor === undefined ? 'limit=1' : `limit=1&cursor=${cursor}`;
  return C3Api.fetch(new Request(`https://api.test.local/account/${ACCOUNT}/transaction_history?${query}`), env);
}

async function read(t: Test, response: Response): Promise<{ cursor: string, transactions: string[] }> {
  t.equal(response.status, 200, 'the page is answered');
  const { cursor, items } = await response.json() as { cursor: string, items: Array<{ transaction_hash: string }> };
  return { cursor, transactions: items.map(item => item.transaction_hash) };
}

type Envelope = { error?: { code: string, message: string, requestId: string } };

// the answer to a cursor KV does not hold: the envelope and headers of every 409 that ends a cursor
async function expired(t: Test, response: Response, versionId: string, what: string): Promise<void> {
  t.equal(response.status, 409, what);
  const json = /^application\/json/.test(response.headers.get('content-type') ?? '');
  t.ok(json, 'answered as JSON');
  t.equal(response.headers.get('x-registry-version'), versionId, 'naming the version that answered');
  const { error }: Envelope = json ? await response.json() as Envelope : {};
  t.equal(error?.code, 'CURSOR_EXPIRED', 'with the code that tells the client to restart pagination');
  t.equal(error?.message, 'the cursor has expired or was never issued; restart pagination without a cursor',
    'and a message that says so');
  t.match(error?.requestId, /^[0-9a-f-]{36}$/, 'with a request id');
  t.same(Object.keys(error ?? {}).sort(), [ 'code', 'message', 'requestId' ], 'and nothing more to say');
}

t.test('a page writes its cursor to expire 30 days later, and keeps what else it reads as before', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const { kv, writes } = clockedKv();

  const { cursor } = await read(t, await page(envWith(kv, registry.db)));
  t.same(writes.filter(write => write.key === cursor).map(write => write.options), [ { expirationTtl: LIFETIME } ],
    'the cursor is written once, with the lifetime of a cursor');

  const others = writes.filter(write => write.key !== cursor);
  t.ok(others.length > 0, 'the page keeps what it read besides');
  t.same(others.filter(write => write.options?.expirationTtl !== undefined || write.options?.expiration !== undefined), [],
    'without an expiry, as before');
});

t.test('a cursor goes on for 30 days from the page that wrote it, and is expired after', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const clock = clockedKv();
  const env   = envWith(clock.kv, registry.db);

  const first = await read(t, await page(env));
  t.same(first.transactions, [ transactionIn(16_400_000) ], 'the first page answers the newest transaction');

  clock.pass(LIFETIME - 1);
  const second = await read(t, await page(env, first.cursor));
  t.same(second.transactions, [ transactionIn(16_000_000) ],
    'a cursor a second short of 30 days old goes on, with the transaction after the last one it answered');

  clock.pass(1);
  await expired(t, await page(env, first.cursor), registry.versionId,
    'at 30 days KV no longer holds it, and it is expired, though this isolate read it a second before');

  const third = await read(t, await page(env, second.cursor));
  t.same(third.transactions, [ transactionIn(15_500_000) ],
    'while the cursor the next page wrote goes on, 30 days from its own write');

  clock.pass(LIFETIME);
  await expired(t, await page(env, second.cursor), registry.versionId, 'until it is 30 days old too');
});

t.test('a cursor KV never held is expired, and a value of another form is invalid', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env = envWith(MemoryKv({}), registry.db);

  const never = createHash('sha256').update('a cursor nobody was given').digest('hex');
  await expired(t, await page(env, never), registry.versionId,
    'a cursor of the form the history hands out that KV does not hold is expired: KV cannot tell one never issued from one it dropped');

  for (const [ cursor, what ] of [
    [ never.toUpperCase(), 'one in upper case' ],
    [ never.slice(1), 'one a digit short' ],
    [ 'not-a-cursor', 'a name' ],
  ] as const) {
    const response = await page(env, cursor);
    t.same([ response.status, await response.text() ], [ 400, 'Cursor is invalid' ], `while ${what} is invalid, as before`);
    t.equal(response.headers.get('x-registry-version'), null, 'answered before the registry is read');
  }
});
