import t, { Test } from 'tap';

import { createHash, randomUUID } from 'node:crypto';

import { defaultAbiCoder } from '@ethersproject/abi';

import C3Api, { Env } from '../../../entrypoint.js';

import * as Eth from '../../../lib/eth-constants.js';
import * as cometModel from '../../../lib/model/comet.js';
import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { makeTestEnv } from '../../util/test-env.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { activateSeeded, loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

import '../../../shim/node-self.js';

/*
 * One account's history paged across registry versions, from a node that
 * holds it: a page answers what the ranges of blocks it reads hold, and the
 * version decides those ranges.
 *
 * Mainnet's markets share one rewards contract, so they are read as one
 * stream, in ranges of a million blocks counted from the earliest creation
 * block among them: USDC's, 15,331,586, in the fixture. With the latest block
 * at 16,500,000, the newest range is [16,331,586, 16,500,000], and the one
 * below it [15,331,586, 16,331,586].
 */
const ACCOUNT = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WETH    = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const LATEST  = 16_500_000;
// the blocks of the account's transactions: one in the newest range, two in the range below it
const HISTORY = [ 16_400_000, 16_000_000, 15_500_000 ];

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

// the fixture with the creation block of one of mainnet's markets moved
function moving(fixture: RegistrySnapshotV1, deploymentKey: string, by: number): RegistrySnapshotV1 {
  return {
    ...fixture,
    networks: fixture.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets.map(market => market.deploymentKey !== deploymentKey ? market : {
        ...market,
        creationBlock: market.creationBlock + by,
      }),
    }),
  };
}

function page(env: Env, cursor?: string): Promise<Response> {
  const query = cursor === undefined ? 'limit=1' : `limit=1&cursor=${cursor}`;
  return C3Api.fetch(new Request(`https://api.test.local/account/${ACCOUNT}/transaction_history?${query}`), env);
}

async function read(response: Response): Promise<{ cursor: string, transactions: string[] }> {
  const { cursor, items } = await response.json() as { cursor: string, items: Array<{ transaction_hash: string }> };
  return { cursor, transactions: items.map(item => item.transaction_hash) };
}

/*
 * The first two pages, one transaction each, against the fixture: the cursor
 * they leave holds the range below the newest, [15,331,586, 16,331,586], at
 * its transaction in block 16,000,000.
 */
async function twoPages(t: Test, env: Env): Promise<string> {
  const first = await page(env);
  t.equal(first.status, 200);
  const newest = await read(first);
  t.same(newest.transactions, [ transactionIn(16_400_000) ], 'the first page answers the newest transaction');

  const second = await page(env, newest.cursor);
  t.equal(second.status, 200);
  const next = await read(second);
  t.same(next.transactions, [ transactionIn(16_000_000) ], 'and the next page the one below it, in the range below');
  return next.cursor;
}

/*
 * Only the earliest creation block of the markets a stream reads is where its
 * ranges are counted from. A version that moves another market's block reads
 * a cursor's ranges where they were, and the cursor goes on.
 */
t.test('a version that moves no stream\'s first block keeps its cursors going', async t => {
  const fixture  = loadRegistrySnapshotFixture();
  const registry = await activeRegistryDatabase({ snapshot: fixture });
  t.teardown(() => registry.dispose());
  const env = makeTestEnv({ MEMORY_CACHE_SEED: 'cursor-across-versions', APP_DB: registry.db });

  const cursor = await twoPages(t, env);

  const { versionId } = await seedCandidate(registry.db, moving(fixture, 'weth', 1), { versionId: randomUUID(), attempt: 2 });
  await activateSeeded(registry.db, versionId);

  const third = await page(env, cursor);
  t.equal(third.status, 200, 'the cursor is read against the new version');
  t.equal(third.headers.get('x-registry-version'), versionId);
  t.same((await read(third)).transactions, [ transactionIn(15_500_000) ], 'and answers the transaction after the last one it answered');
});

/*
 * A cursor holds its place in a stream as the block that ends the range it
 * was reading, and the last transaction it answered there; the range below a
 * block is counted from the stream's first block. A version that corrects
 * that block by one reads the cursor's block as the end of a range two blocks
 * long, [16,331,585, 16,331,586], which does not hold the transaction the
 * cursor answered last. Resumed there, the cursor would answer that
 * transaction again, and everything it answered before it in the range below.
 * It is ended instead, as a cursor of a version that reads other streams is.
 */
t.test('a version that moves a stream\'s first block ends its cursors', async t => {
  const fixture  = loadRegistrySnapshotFixture();
  const registry = await activeRegistryDatabase({ snapshot: fixture });
  t.teardown(() => registry.dispose());
  const env = makeTestEnv({ MEMORY_CACHE_SEED: 'cursor-across-versions', APP_DB: registry.db });

  const cursor = await twoPages(t, env);

  const { versionId } = await seedCandidate(registry.db, moving(fixture, 'usdc', -1), { versionId: randomUUID(), attempt: 2 });
  await activateSeeded(registry.db, versionId);

  const third    = await page(env, cursor);
  const answered = third.status === 200 ? (await read(third.clone())).transactions : [];
  t.notOk(answered.includes(transactionIn(16_000_000)), 'no transaction a page answered is answered again',
    { answered });
  t.equal(third.status, 409, 'the cursor is ended');
  const body = await third.json() as { error?: { code: string, details?: unknown } };
  t.equal(body.error?.code, 'REGISTRY_VERSION_CHANGED', 'with the code that tells the client to restart pagination');
  t.same(body.error?.details, { cursorRegistryVersionId: registry.versionId, registryVersionId: versionId },
    'naming the version the cursor was issued against, and the one that ended it');
});

/*
 * A cursor kept before its streams named the block their ranges are counted
 * from cannot be compared with any version, so it is ended as one of a
 * version that reads other streams is: by its own version too, and by one
 * that counts the ranges from where they were. The client starts over once.
 */
t.test('a cursor whose streams name no first block is ended', async t => {
  const fixture  = loadRegistrySnapshotFixture();
  const registry = await activeRegistryDatabase({ snapshot: fixture });
  t.teardown(() => registry.dispose());
  const env = makeTestEnv({ MEMORY_CACHE_SEED: 'cursor-across-versions', APP_DB: registry.db });

  const cursor = await twoPages(t, env);
  const kept   = await env.kv_mainnet.get(cursor, 'json') as { streamEvents: Array<{ firstBlock?: number }> };
  t.same(kept.streamEvents.map(stream => stream.firstBlock), [ 15_331_586 ], 'a cursor names the block its stream is counted from');

  // the same position, as a cursor was kept before
  const before = createHash('sha256').update('a cursor kept before streams named their first block').digest('hex');
  await env.kv_mainnet.put(before, JSON.stringify({
    ...kept,
    streamEvents: kept.streamEvents.map(({ firstBlock: _firstBlock, ...stream }) => stream),
  }));

  const own = await page(env, before);
  t.equal(own.status, 409, 'its own version ends it');
  const body = await own.json() as { error?: { code: string, details?: unknown } };
  t.equal(body.error?.code, 'REGISTRY_VERSION_CHANGED', 'with the code that tells the client to restart pagination');
  t.same(body.error?.details, { cursorRegistryVersionId: registry.versionId, registryVersionId: registry.versionId });

  const { versionId } = await seedCandidate(registry.db, moving(fixture, 'weth', 1), { versionId: randomUUID(), attempt: 2 });
  await activateSeeded(registry.db, versionId);
  t.equal((await page(env, before)).status, 409, 'and so does a version that counts its ranges from where they were');
  t.equal((await page(env, cursor)).status, 200, 'which goes on with the cursor that names its block');
});
