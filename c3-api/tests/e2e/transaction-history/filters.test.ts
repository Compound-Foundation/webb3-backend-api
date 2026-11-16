import t from 'tap';

import { defaultAbiCoder } from '@ethersproject/abi';

import C3Api from '../../../entrypoint.js';

import * as Eth from '../../../lib/eth-constants.js';
import * as cometModel from '../../../lib/model/comet.js';
import { checksumAddress } from '../../../lib/model/comet-registry.js';

import { makeTestEnv } from '../../util/test-env.js';
import { activeRegistryDatabase, type RegistryDatabase } from '../../util/registry-database.js';

import '../../../shim/node-self.js';

/*
 * The filters of an account's history, paged against the fixture's version,
 * which serves the history of mainnet's markets as one stream.
 *
 * initiated_by[] keeps the items the account initiated, `me`, and the items
 * another address initiated, `other`, whatever the casing of the account in
 * the path and of the initiator. Before, the two were compared as they were
 * spelled, so an account named in another casing than its initiator was never
 * `me`, and always `other`. A filter drops items after a page has enriched
 * them, and a page enriches a bounded number of items, so a page whose filter
 * drops every item it enriches holds none, is not done, and the next page
 * goes on from where it stopped.
 */

// lowercase, as a node names the account that sends a transaction
const ACCOUNT     = '0x420f253087044b8bcf028dd89f8fe83ba6275e84';
const CHECKSUMMED = checksumAddress(ACCOUNT);
const UPPERCASE   = `0x${ACCOUNT.slice(2).toUpperCase()}`;
// the forms of the account a path can name it in
const FORMS: Array<[ string, string ]> = [
  [ ACCOUNT,     'a lowercase path' ],
  [ CHECKSUMMED, 'a checksummed path' ],
  [ UPPERCASE,   'an uppercase path' ],
];

const OTHER    = '0x1111111111111111111111111111111111111111';
// the account's DeFi Saver proxy, as the proxy registry names it
const PROXY    = '0x5a5b2d1c6f3e4a7b8c9d0e1f2a3b4c5d6e7f8091';
const MIGRATOR = Eth.wellKnownContractsByNetwork['ethereum-mainnet']['CompoundMigrator']['V2'].address;
const USDC     = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WETH     = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

// mainnet's latest block, and its time
const LATEST = 23_000_000;
const NOW    = 1_800_000_000;

/*
 * An item of the account's history, the one transaction of its block: a
 * supply of collateral to the account in mainnet's USDC market, a Supply,
 * unless it is a withdrawal of the account's collateral, a Withdraw. The
 * account sends the transaction, unless `sender` names who does, as the node
 * names it, and supplies the collateral itself, unless `supplier` names who
 * does: another address, the migrator, or the account's DeFi Saver proxy.
 */
type Item = { block: number, withdraw?: boolean, sender?: string, supplier?: string };

type Condition = null | string | string[];
type Call = { id: number, method: string, params: any[] };

function hashOf({ block }: Item): string {
  return `0x${block.toString(16).padStart(64, '0')}`;
}

function topicOf(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

const TOPICS = Eth.Event.Coder.fromSignatures([ cometModel.events.SupplyCollateral, cometModel.events.WithdrawCollateral ]).topics;

function logOf(item: Item) {
  return {
    address:          USDC,
    topics:           item.withdraw === true
      ? [ TOPICS.WithdrawCollateral, topicOf(ACCOUNT), topicOf(ACCOUNT), topicOf(WETH) ]
      : [ TOPICS.SupplyCollateral, topicOf(item.supplier ?? ACCOUNT), topicOf(ACCOUNT), topicOf(WETH) ],
    data:             defaultAbiCoder.encode([ 'uint256' ], [ '1000000000000000000' ]),
    blockNumber:      Eth.Hex.fromNumber(item.block),
    blockHash:        hashOf(item),
    transactionHash:  hashOf(item),
    transactionIndex: '0x0',
    logIndex:         '0x0',
    removed:          false,
  };
}

/*
 * The node of one history: eth_getLogs answers the logs the range and the
 * topics it is asked for match, oldest first, as a node does, a block names
 * the transaction in it, and the proxy registry names the account's one
 * DeFi Saver proxy.
 */
function answer(items: Item[], network: string, { method, params }: Call): object {
  if (network !== 'ethereum-mainnet') {
    throw new Error(`the node is not asked of ${network}`);
  }
  switch (method) {
    case 'eth_getBlockByNumber': {
      const [ reference ] = params;
      const number = reference === 'latest' ? LATEST : parseInt(reference, 16);
      return { result: {
        number:       Eth.Hex.fromNumber(number),
        timestamp:    Eth.Hex.fromNumber(NOW - (LATEST - number) * 12),
        transactions: reference === 'latest' ? [] : items
          .filter(item => item.block === number)
          .map(item => ({ hash: hashOf(item), from: item.sender ?? ACCOUNT, to: USDC })),
      } };
    }
    case 'eth_getLogs': {
      const [ { address, fromBlock, toBlock, topics } ] = params as [ { address: string[], fromBlock: string, toBlock: string, topics: Condition[] } ];
      const matches = (condition: Condition, topic: string | undefined) => (
        condition === null || [ condition ].flat().some(value => value.toLowerCase() === topic)
      );
      return { result: items
        .filter(item => item.block >= parseInt(fromBlock, 16) && item.block <= parseInt(toBlock, 16))
        .sort((a, b) => a.block - b.block)
        .map(logOf)
        .filter(log => true
          && address.some(contract => contract.toLowerCase() === log.address)
          && topics.every((condition, index) => matches(condition, log.topics[index]))
        ) };
    }
    // getAllProxies
    case 'eth_call': return { result: defaultAbiCoder.encode([ 'address', 'address[]' ], [ Eth.NullAddress, [ PROXY ] ]) };
    default: throw new Error(`the node is not asked ${method}`);
  }
}

/*
 * Every history of this file, by the name a client pages through it under,
 * which it sends as its node key. A page reads items ahead of what it
 * answers, and those reads go on after it is answered, which is why the node
 * answers for as long as the file runs.
 */
const histories = new Map<string, Item[]>();

t.before(() => {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    const [ , network, name ] = new URL(request.url).pathname.split('/') as [ string, string, string ];
    const items   = histories.get(name)!;
    const body    = await request.json() as Call | Call[];
    const calls   = body instanceof Array ? body : [ body ];
    const answers = calls.map(call => ({ jsonrpc: '2.0', id: call.id, ...answer(items, network, call) }));
    return new Response(JSON.stringify(body instanceof Array ? answers : answers[0]));
  }) as typeof globalThis.fetch;
});

type Page = { status: number, done: boolean, items: string[], initiators: string[] };

/*
 * A client paging through a history from a path that names the account in a
 * form, `query` on every page, until a page is done: what each page answered,
 * its items by their transactions and by who initiated them, in lowercase.
 */
async function walk(registry: RegistryDatabase, name: string, items: Item[], account: string, query: string): Promise<Page[]> {
  histories.set(name, items);
  const env = makeTestEnv({
    MEMORY_CACHE_SEED:                'history-filters',
    APP_DB:                           registry.db,
    FLAGS_ETH_COMPUTATION_INDEX_BIAS: 'default',
    NODE_PROXY_KEY:                   name,
  });

  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= 20; page++) {
    const url = `https://api.test.local/account/${account}/transaction_history?${query}${cursor === undefined ? '' : `&cursor=${cursor}`}`;
    const response = await C3Api.fetch(new Request(url), env);
    if (response.status !== 200) {
      pages.push({ status: response.status, done: false, items: [ await response.text() ], initiators: [] });
      break;
    }
    const body = await response.json() as { done: boolean, cursor: string, items: Array<{ transaction_hash: string, initiated_by: { address: string } }> };
    pages.push({
      status:     200,
      done:       body.done,
      items:      body.items.map(item => item.transaction_hash),
      initiators: body.items.map(item => item.initiated_by.address.toLowerCase()),
    });
    if (body.done) {
      break;
    }
    cursor = body.cursor;
  }
  // what the pages read ahead of what they answered reaches the node too
  await new Promise(resolve => setTimeout(resolve, 100));
  return pages;
}

/*
 * Five items, the node naming every sender in lowercase: two the account
 * sent, one another address sent, and two the account sent through the
 * migrator and through its DeFi Saver proxy, which those initiated. `me` keeps
 * the two the account sent, and `other` the other three.
 */
t.test('initiated_by[] keeps the same items whatever the casing of the path', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const items: Item[] = [
    { block: 22_900_000 },
    { block: 22_800_000, sender: OTHER, supplier: OTHER },
    { block: 22_700_000, supplier: MIGRATOR },
    { block: 22_600_000, supplier: PROXY },
    { block: 22_500_000 },
  ];
  const [ own1, other, migrated, proxied, own2 ] = items as [ Item, Item, Item, Item, Item ];

  for (const [ index, [ account, what ] ] of FORMS.entries()) {
    const all = await walk(registry, `path${index}-all`, items, account, 'limit=15&initiated_by[]=me,other');
    t.same(all.map(page => [ page.status, page.done ]), [ [ 200, true ] ], `${what}, both: one page, done`);
    t.same(all[0]!.items, items.map(hashOf), 'which holds every item, newest first');
    t.same(all[0]!.initiators, [ ACCOUNT, OTHER, MIGRATOR.toLowerCase(), PROXY, ACCOUNT ],
      'initiated by the account, another sender, the migrator, the DeFi Saver proxy and the account');

    for (const [ filter, kept ] of [ [ 'me', [ own1, own2 ] ], [ 'other', [ other, migrated, proxied ] ] ] as const) {
      const pages = await walk(registry, `path${index}-${filter}`, items, account, `limit=15&initiated_by[]=${filter}`);
      t.same(pages.map(page => [ page.status, page.done ]), [ [ 200, true ] ], `${what}, ${filter}: one page, done`);
      t.same(pages[0]!.items, kept.map(hashOf), `which holds the items ${filter === 'me' ? 'the account' : 'another address'} initiated`);
    }
  }
});

/*
 * A node names a sender in lowercase, and the filter does not rely on it: the
 * account's own items, whose sender the node names checksummed and in
 * uppercase, are `me` too.
 */
t.test('initiated_by[] keeps the same items whatever the casing of the initiator', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const items: Item[] = [
    { block: 22_900_000, sender: CHECKSUMMED },
    { block: 22_800_000, sender: OTHER, supplier: OTHER },
    { block: 22_700_000, sender: UPPERCASE },
  ];

  for (const [ index, [ account, what ] ] of FORMS.entries()) {
    for (const [ filter, kept ] of [ [ 'me', [ items[0]!, items[2]! ] ], [ 'other', [ items[1]! ] ] ] as const) {
      const pages = await walk(registry, `sender${index}-${filter}`, items, account, `limit=15&initiated_by[]=${filter}`);
      t.same(pages.map(page => [ page.status, page.done, page.items ]), [ [ 200, true, kept.map(hashOf) ] ],
        `${what}, ${filter}: one page, done, with the items ${filter === 'me' ? 'the account' : 'another address'} sent`);
    }
  }
});

/*
 * 55 transactions the account sent, and below them 5 another address sent.
 * The first page enriches its share of the account's own, drops them all,
 * and is not done; the next reaches the five.
 */
t.test('a page whose initiator filter drops every item it enriches is not done, and the next goes on', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const items: Item[] = [
    ...Array.from({ length: 55 }, (_, index): Item => ({ block: 22_900_000 - index * 10 })),
    ...Array.from({ length: 5 }, (_, index): Item => ({ block: 22_800_000 - index * 10, sender: OTHER, supplier: OTHER })),
  ];

  for (const [ index, [ account, what ] ] of FORMS.entries()) {
    const pages = await walk(registry, `budget${index}`, items, account, 'limit=15&initiated_by[]=other');
    t.same(pages.map(page => [ page.status, page.items.length, page.done ]), [ [ 200, 0, false ], [ 200, 5, true ] ],
      `${what}: the first page holds none of them and is not done; the next holds the five, and is done`);
    t.same(pages[1]?.items, items.slice(55).map(hashOf), 'newest first');
  }
});

/*
 * 55 supplies of collateral, and below them 5 withdrawals. Filtered to
 * withdrawals, the first page drops every item it enriches and is not done;
 * the next reaches the five.
 */
t.test('a page whose actions filter drops every item it enriches is not done, and the next goes on', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const items: Item[] = [
    ...Array.from({ length: 55 }, (_, index): Item => ({ block: 22_900_000 - index * 10 })),
    ...Array.from({ length: 5 }, (_, index): Item => ({ block: 22_800_000 - index * 10, withdraw: true })),
  ];

  const pages = await walk(registry, 'actions', items, CHECKSUMMED, 'limit=15&actions[]=Withdraw');
  t.same(pages.map(page => [ page.status, page.items.length, page.done ]), [ [ 200, 0, false ], [ 200, 5, true ] ],
    'the first page holds none of them and is not done; the next holds the five, and is done');
  t.same(pages[1]?.items, items.slice(55).map(hashOf), 'newest first');
});
