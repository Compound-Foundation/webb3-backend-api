import t, { Test } from 'tap';

import { defaultAbiCoder } from '@ethersproject/abi';

import C3Api, { Env } from '../../../entrypoint.js';

import * as Eth from '../../../lib/eth-constants.js';
import * as cometModel from '../../../lib/model/comet.js';
import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { MAX_LOG_RANGES_PER_PAGE } from '../../../src/transaction-history-handler/transaction-history-items-handler.js';

import { makeTestEnv } from '../../util/test-env.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

import '../../../shim/node-self.js';

/*
 * One account's history paged from a node that holds it, against a version
 * that serves the history of mainnet's markets and of Base's AERO market:
 * two streams, mainnet's counted from 15,331,586 in ranges of a million
 * blocks, and Base's from 20,852,405 in ranges of ten million.
 *
 * A page reads each stream on toward its next item, however long the stream
 * has been quiet, within a budget of ranges, and it is done only once every
 * stream is read back to its first block. Before, a page took a stream whose
 * next ten ranges held nothing for ended, and a page without an item for the
 * end of the history: Base was read in ranges of 50,000 blocks, so an account
 * quiet there for ten of them, about a day at five blocks a second, had no
 * history before that.
 */
type Network = 'ethereum-mainnet' | 'base-mainnet' | 'scroll-mainnet';

// lowercase, as a node names the account that sends a transaction
const ACCOUNT = '0x420f253087044b8bcf028dd89f8fe83ba6275e84';
const OTHER   = '0x1111111111111111111111111111111111111111';
const WETH    = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

// the market an item is logged by, unless it names another: mainnet's USDC, Base's AERO and Scroll's USDC
const MARKET: Record<Network, string> = {
  'ethereum-mainnet': '0xc3d688b66703497daa19211eedff47f25384cdc3',
  'base-mainnet':     '0x784efeb622244d2348d4f2522f8860b96fbece89',
  'scroll-mainnet':   '0xb2f97c1bd3bf02f5e74d13f02e3e26f93d77ce44',
};
const FIRST: Record<Network, number> = { 'ethereum-mainnet': 15_331_586, 'base-mainnet': 20_852_405, 'scroll-mainnet': 3_397_674 };
// the blocks of one range of each network
const RANGE: Record<Network, number> = { 'ethereum-mainnet': 1_000_000, 'base-mainnet': 10_000_000, 'scroll-mainnet': 250_000 };
const BASE = RANGE['base-mainnet'];
// the seconds between two blocks, but on Base, which makes five a second
const SECONDS: Record<Exclude<Network, 'base-mainnet'>, number> = { 'ethereum-mainnet': 12, 'scroll-mainnet': 3 };
// the time of the latest block of every network
const NOW = 1_800_000_000;

// mainnet's latest block, eight ranges above its first block
const MAINNET_LATEST = 23_000_000;

/*
 * A log of an item's transaction: the market that logs it, and where the
 * account is in it, as both its addresses, as the first only, or as the
 * second only.
 */
type Log = { market?: string, account?: 'both' | 'first' | 'second' };

/*
 * An item of the account's history: a transaction in which the account
 * supplied collateral, the `n`th of its block, sent by the account or by
 * `from`. It logs its network's market once, unless it names its logs.
 */
type Item = { network: Network, block: number, n?: number, from?: string, logs?: Log[] };

type History = {
  latest: Partial<Record<Network, number>>,
  items:  Item[],
  // what the node was asked, by the page that asked it
  asked:  Map<number, Array<{ network: Network, method: string, fromBlock?: number, toBlock?: number }>>,
};

type Condition = null | string | string[];
type Call = { id: number, method: string, params: any[] };

const CODE: Record<Network, string> = { 'ethereum-mainnet': 'e7e1', 'base-mainnet': 'ba5e', 'scroll-mainnet': '5c01' };

function hashOf({ network, block, n = 0 }: Item): string {
  return `0x${CODE[network]}${n.toString(16).padStart(4, '0')}${block.toString(16).padStart(56, '0')}`;
}

function topicOf(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

/*
 * The time of a block. Base's blocks share their second five at a time, as
 * they have since its Denim upgrade, and so does the time of the items in
 * them.
 */
function timestampOf(history: Pick<History, 'latest'>, network: Network, block: number): number {
  const behind = history.latest[network]! - block;
  return NOW - (network === 'base-mainnet' ? Math.floor(behind / 5) : behind * SECONDS[network]);
}

const SUPPLY_COLLATERAL = Eth.Event.Coder.fromSignatures([ cometModel.events.SupplyCollateral ]).topics.SupplyCollateral;

// the logs of an item's transaction, in the order the block holds them
function logsOf(item: Item) {
  return (item.logs ?? [ {} ]).map(({ market = MARKET[item.network], account = 'both' }, index) => ({
    address:          market,
    topics:           [
      SUPPLY_COLLATERAL,
      topicOf(account === 'second' ? OTHER : ACCOUNT),
      topicOf(account === 'first' ? OTHER : ACCOUNT),
      topicOf(WETH),
    ],
    data:             defaultAbiCoder.encode([ 'uint256' ], [ '1000000000000000000' ]),
    blockNumber:      Eth.Hex.fromNumber(item.block),
    blockHash:        `0x${item.block.toString(16).padStart(64, '0')}`,
    transactionHash:  hashOf(item),
    transactionIndex: Eth.Hex.fromNumber(item.n ?? 0),
    logIndex:         Eth.Hex.fromNumber((item.n ?? 0) * 4 + index),
    removed:          false,
  }));
}

/*
 * The node of one history: eth_getLogs answers the logs the range and the
 * topics it is asked for match, in the order of their blocks and of their
 * place in a block, as a node does, and a block names the transactions of
 * the account in it.
 */
function answer(history: History, network: Network, { method, params }: Call): object {
  switch (method) {
    case 'eth_getBlockByNumber': {
      const [ reference ] = params;
      const number = reference === 'latest' ? history.latest[network]! : parseInt(reference, 16);
      return { result: {
        number:       Eth.Hex.fromNumber(number),
        timestamp:    Eth.Hex.fromNumber(timestampOf(history, network, number)),
        transactions: reference === 'latest' ? [] : history.items
          .filter(item => item.network === network && item.block === number)
          .map(item => ({ hash: hashOf(item), from: item.from ?? ACCOUNT, to: item.logs?.[0]?.market ?? MARKET[network] })),
      } };
    }
    case 'eth_getLogs': {
      const [ { address, fromBlock, toBlock, topics } ] = params as [ { address: string[], fromBlock: string, toBlock: string, topics: Condition[] } ];
      const matches = (condition: Condition, topic: string | undefined) => (
        condition === null || [ condition ].flat().some(value => value.toLowerCase() === topic)
      );
      return { result: history.items
        .filter(item => item.network === network && item.block >= parseInt(fromBlock, 16) && item.block <= parseInt(toBlock, 16))
        .flatMap(logsOf)
        .sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16))
        .filter(log => true
          && address.some(contract => contract.toLowerCase() === log.address)
          && topics.every((condition, index) => matches(condition, log.topics[index]))
        ) };
    }
    // getAllProxies: the account has no DeFi Saver proxy
    case 'eth_call': return { result: defaultAbiCoder.encode([ 'address', 'address[]' ], [ Eth.NullAddress, [] ]) };
    default: throw new Error(`the node is not asked ${method}`);
  }
}

/*
 * Every history of this file, by name. A page asks the node under the key
 * `<history>.<page>`, so what a page asks is told apart from what another
 * asks: a page reads ranges ahead of what it answers, and those reads go on
 * after it is answered, which is also why the node answers for as long as
 * the file runs.
 */
const histories = new Map<string, History>();

t.before(() => {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    const [ , network, key ] = new URL(request.url).pathname.split('/') as [ string, Network, string ];
    const [ name, page ] = key.split('.') as [ string, string ];
    const history = histories.get(name)!;
    const calls = await request.json() as Call[];
    const asked = history.asked.get(Number(page)) ?? [];
    history.asked.set(Number(page), asked);
    for (const { method, params } of calls) {
      const range = method === 'eth_getLogs'
        ? { fromBlock: parseInt(params[0].fromBlock, 16), toBlock: parseInt(params[0].toBlock, 16) }
        : {};
      asked.push({ network, method, ...range });
    }
    return new Response(JSON.stringify(calls.map(call => ({ jsonrpc: '2.0', id: call.id, ...answer(history, network, call) }))));
  }) as typeof globalThis.fetch;
});

// the fixture with Base's AERO market serving history too
function withBase(): RegistrySnapshotV1 {
  const fixture = loadRegistrySnapshotFixture();
  return {
    ...fixture,
    networks: fixture.networks.map(network => network.chainId !== 8453 ? network : {
      ...network,
      markets: network.markets.map(market => ({ ...market, capabilities: { ...market.capabilities, transactionHistory: true } })),
    }),
  };
}

type Page = { status: number, done: boolean, cursor: string, itemCount: number, items: string[] };

type Walk = {
  // the version the pages are read against: the fixture with Base's AERO market serving history, unless named
  snapshot?: RegistrySnapshotV1,
  // what the environment sets besides
  vars?:     Partial<Env>,
};

/*
 * A client paging through a history, `query` on every page, until a page is
 * done: what each page answered. Ranges are cached as in production, while
 * the logs of a range are asked of the node every time the range is read.
 */
async function walk(t: Test, name: string, history: Omit<History, 'asked'>, query: string, { snapshot = withBase(), vars = {} }: Walk = {}): Promise<{
  pages: Page[],
  asked: History['asked'],
  env:   Env,
}> {
  const registry = await activeRegistryDatabase({ snapshot });
  t.teardown(() => registry.dispose());
  const asked: History['asked'] = new Map();
  histories.set(name, { ...history, asked });
  const env = makeTestEnv({ MEMORY_CACHE_SEED: 'quiet-spells', APP_DB: registry.db, FLAGS_ETH_COMPUTATION_INDEX_BIAS: 'default', ...vars });

  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= 100; page++) {
    const url = `https://api.test.local/account/${ACCOUNT}/transaction_history?${query}${cursor === undefined ? '' : `&cursor=${cursor}`}`;
    const response = await C3Api.fetch(new Request(url), { ...env, NODE_PROXY_KEY: `${name}.${page}` });
    if (response.status !== 200) {
      pages.push({ status: response.status, done: false, cursor: '', itemCount: 0, items: [ await response.text() ] });
      break;
    }
    const body = await response.json() as { done: boolean, cursor: string, item_count: number, items: Array<{ transaction_hash: string }> };
    pages.push({ status: 200, done: body.done, cursor: body.cursor, itemCount: body.item_count, items: body.items.map(item => item.transaction_hash) });
    if (body.done) {
      break;
    }
    cursor = body.cursor;
  }
  // what the pages read ahead of what they answered reaches the node too
  await new Promise(resolve => setTimeout(resolve, 100));
  return { pages, asked, env };
}

// the ranges of logs a page asked the node for on a network
function rangesAsked(asked: History['asked'], page: number, network: Network): Array<[ number, number ]> {
  return (asked.get(page) ?? [])
    .filter(call => call.network === network && call.method === 'eth_getLogs')
    .map(call => [ call.fromBlock!, call.toBlock! ]);
}

/*
 * Two Base items, both further back than ten ranges of 50,000 blocks, where a
 * page stopped before: one in the newest range, which is 9,000,000 blocks
 * long, and one fifteen ranges below it. Nothing on mainnet.
 */
t.test('a history older than ten ranges of 50,000 blocks is answered, and done once read to the first block', async t => {
  const latest = FIRST['base-mainnet'] + 40 * BASE + 9_000_000;
  const items: Item[] = [
    // about 18 days back, in the newest range
    { network: 'base-mainnet', block: latest - 8_000_000 },
    // fifteen ranges below the newest, about a year back
    { network: 'base-mainnet', block: FIRST['base-mainnet'] + 26 * BASE + 5_000_000 },
  ];
  const { pages } = await walk(t, 'older', { latest: { 'ethereum-mainnet': MAINNET_LATEST, 'base-mainnet': latest }, items }, 'limit=15');

  t.equal(pages.length, 1, 'one page');
  t.same(pages[0]!.items, items.map(hashOf), 'answers both, newest first');
  t.equal(pages[0]!.done, true, 'and is done: it has read every stream to its first block');
});

/*
 * Between two Base items, fifteen ranges hold nothing, and mainnet holds an
 * item older than both. The page after the first reads on through the quiet
 * ranges to the second Base item, which is newer than mainnet's, before it
 * answers either.
 */
t.test('a quiet spell longer than ten ranges between two items neither ends the history nor reorders it', async t => {
  const latest = FIRST['base-mainnet'] + 30 * BASE + 5_000_000;
  const items: Item[] = [
    { network: 'base-mainnet', block: latest - 1_000_000 },
    // about 354 days back
    { network: 'base-mainnet', block: latest - 1_000_000 - 152_000_000 },
    // about 463 days back
    { network: 'ethereum-mainnet', block: MAINNET_LATEST - 3_333_333 },
  ];
  const { pages } = await walk(t, 'spell', { latest: { 'ethereum-mainnet': MAINNET_LATEST, 'base-mainnet': latest }, items }, 'limit=1');

  t.same(pages.map(page => page.items), [ ...items.map(item => [ hashOf(item) ]), [] ], 'all three are answered, newest first');
  t.same(pages.map(page => page.done), [ false, false, false, true ],
    'and the history is done only once a page has read both streams to their first blocks');
});

/*
 * Base's latest block is 50 ranges more than a page's budget above its first
 * block, and its one item is 30 ranges past the budget. A page answers what
 * it has read when the budget is spent, which can be nothing, and the next
 * page reads on from where it stopped.
 */
t.test('a page whose budget is spent answers what it has, done: false, and the next reads on from where it stopped', async t => {
  const latest = FIRST['base-mainnet'] + (MAX_LOG_RANGES_PER_PAGE + 50) * BASE - 1;
  const item: Item = { network: 'base-mainnet', block: latest - (MAX_LOG_RANGES_PER_PAGE + 30) * BASE + 5_000_000 };
  const { pages, asked } = await walk(t, 'budget', { latest: { 'ethereum-mainnet': MAINNET_LATEST, 'base-mainnet': latest }, items: [ item ] }, 'limit=15');

  t.equal(pages.length, 2, 'two pages');
  const [ first, second ] = pages as [ Page, Page ];
  t.same([ first.status, first.itemCount, first.items, first.done ], [ 200, 0, [], false ],
    'the first holds no item, and is not done');
  t.match(first.cursor, /^[0-9a-f]{64}$/, 'and hands out a cursor');
  const firstRanges = [ ...rangesAsked(asked, 1, 'ethereum-mainnet'), ...rangesAsked(asked, 1, 'base-mainnet') ];
  t.ok(firstRanges.length <= 2 * MAX_LOG_RANGES_PER_PAGE, `which read at most ${MAX_LOG_RANGES_PER_PAGE} ranges, two reads each`,
    { asked: firstRanges.length });

  t.same([ second.status, second.items, second.done ], [ 200, [ hashOf(item) ], true ],
    'the second, read with that cursor, answers the item, and is done');
  const lowest = Math.min(...rangesAsked(asked, 1, 'base-mainnet').map(([ from ]) => from));
  const below  = rangesAsked(asked, 2, 'base-mainnet');
  t.ok(below.length > 0 && below.every(([ , to ]) => to < lowest), 'it read Base only below what the first page read');
});

/*
 * Mainnet's items, among them two transactions of one block and the items
 * either side of a block that ends a range, and Base's, some of them in the
 * newest ranges and the rest more ranges below than a page's budget. Paged
 * with a limit of seven, and of one, the pages answer every item once,
 * newest first.
 */
t.test('pages answer every item once, newest first, whatever the limit', async t => {
  const latest: Record<'ethereum-mainnet' | 'base-mainnet', number> = {
    'ethereum-mainnet': MAINNET_LATEST,
    'base-mainnet':     FIRST['base-mainnet'] + (MAX_LOG_RANGES_PER_PAGE + 50) * BASE - 1,
  };
  const mainnetGrid = FIRST['ethereum-mainnet'] + 5 * RANGE['ethereum-mainnet'];
  const baseGrid    = FIRST['base-mainnet'] + (MAX_LOG_RANGES_PER_PAGE + 40) * BASE;
  const items: Item[] = [
    { network: 'ethereum-mainnet', block: 22_500_000, n: 0 },
    { network: 'ethereum-mainnet', block: 22_500_000, n: 1 },
    { network: 'ethereum-mainnet', block: mainnetGrid },
    { network: 'ethereum-mainnet', block: mainnetGrid + 1 },
    ...Array.from({ length: 36 }, (_, index): Item => ({ network: 'ethereum-mainnet', block: 22_950_000 - index * 190_000 })),
    { network: 'base-mainnet', block: latest['base-mainnet'] - 10_000 },
    { network: 'base-mainnet', block: latest['base-mainnet'] - 30_000_010 },
    { network: 'base-mainnet', block: baseGrid },
    { network: 'base-mainnet', block: baseGrid + 1 },
    ...[ 39.5, 29.5, 20.25, 9.5, 4.5, 0 ].map((ranges): Item => ({ network: 'base-mainnet', block: FIRST['base-mainnet'] + ranges * BASE })),
  ];
  const history = { latest, items };
  const timestamp = (item: Item) => timestampOf(history, item.network, item.block);
  /*
   * Newest first. On one network, a later block comes before an earlier one
   * of the same second, and a later transaction of a block before an earlier
   * one, as a stream answers them.
   */
  const expected = [ ...items ]
    .sort((a, b) => timestamp(b) - timestamp(a) || b.block - a.block || (b.n ?? 0) - (a.n ?? 0))
    .map(hashOf);
  const times = (network: Network) => new Set(items.filter(item => item.network === network).map(timestamp));
  t.notOk([ ...times('ethereum-mainnet') ].some(time => times('base-mainnet').has(time)), 'no item of one network shares its time with one of the other');
  t.equal(timestamp(items.find(item => item.block === baseGrid)!), timestamp(items.find(item => item.block === baseGrid + 1)!),
    'while the Base items either side of the end of a range share their second');
  t.ok(items.some(item => item.network === 'base-mainnet' && latest['base-mainnet'] - item.block > MAX_LOG_RANGES_PER_PAGE * BASE),
    'and some items are further down than one page reads');

  for (const limit of [ 7, 1 ]) {
    const { pages } = await walk(t, `stitch${limit}`, history, `limit=${limit}`);
    const answered = pages.flatMap(page => page.items);
    t.same(answered, expected, `with a limit of ${limit}, the pages answer every item once, newest first`);
    t.ok(pages.every(page => page.status === 200 && page.items.length <= limit), 'none answers more than the limit');
    t.same(pages.map(page => page.done), pages.map((_, index) => index === pages.length - 1),
      'and only the last is done');
  }
});

/*
 * An initiator filter that drops every item a page enriches: 55 transactions
 * the account sent, and below them 5 that another address sent. A page stops
 * once it has enriched its share of items, and says it is not done.
 */
t.test('a page whose filter drops every item it enriches is not done, and the next goes on', async t => {
  const latest = { 'ethereum-mainnet': MAINNET_LATEST, 'base-mainnet': FIRST['base-mainnet'] + 55_000_000 };
  const items: Item[] = [
    ...Array.from({ length: 55 }, (_, index): Item => ({ network: 'ethereum-mainnet', block: 22_900_000 - index * 10 })),
    ...Array.from({ length: 5 }, (_, index): Item => ({ network: 'ethereum-mainnet', block: 22_800_000 - index * 10, from: OTHER })),
  ];
  const { pages } = await walk(t, 'filter', { latest, items }, 'limit=15&initiated_by[]=other');

  t.same(pages.map(page => [ page.status, page.items.length, page.done ]), [ [ 200, 0, false ], [ 200, 5, true ] ],
    'the first page holds none of them and is not done; the next holds the five, and is done');
  t.same(pages[1]!.items, items.slice(55).map(hashOf), 'newest first');
});

/*
 * Mainnet holds nothing, so the first page reads it to its first block: the
 * pages after it ask the node nothing of mainnet, not even its latest block.
 */
t.test('a stream read back to its first block is not read again', async t => {
  const latest = FIRST['base-mainnet'] + 30 * BASE + 5_000_000;
  const items: Item[] = [
    { network: 'base-mainnet', block: latest - 1_000_000 },
    { network: 'base-mainnet', block: latest - 12 * BASE },
  ];
  const { pages, asked, env } = await walk(t, 'ended', { latest: { 'ethereum-mainnet': MAINNET_LATEST, 'base-mainnet': latest }, items }, 'limit=1');

  t.equal(pages.length, 3, 'three pages');
  const kept = await env.kv_mainnet.get(pages[0]!.cursor, 'json') as { cursors: Record<string, { network: Network, ended?: boolean }> };
  t.same(Object.values(kept.cursors).map(cursor => [ cursor.network, cursor.ended === true ]),
    [ [ 'ethereum-mainnet', true ], [ 'base-mainnet', false ] ], 'the first page\'s cursor holds mainnet\'s stream ended');
  t.ok(rangesAsked(asked, 1, 'ethereum-mainnet').length > 0, 'once the first page has read it');
  for (const page of [ 2, 3 ]) {
    t.same((asked.get(page) ?? []).filter(call => call.network === 'ethereum-mainnet'), [], `page ${page} asks the node nothing of mainnet`);
  }
});

/*
 * An environment can lower the ranges a page reads, as in the hours after a
 * release in which every account reads its ranges from the node again, but
 * not raise them: a value above the default, or one that is no whole number,
 * leaves the default. An account without history, on mainnet's eight ranges
 * and Base's 70, or 250.
 */
t.test('an environment can lower the ranges a page reads, and only lower them', async t => {
  const short = { 'ethereum-mainnet': MAINNET_LATEST, 'base-mainnet': FIRST['base-mainnet'] + 70 * BASE - 1 };
  const long  = { 'ethereum-mainnet': MAINNET_LATEST, 'base-mainnet': FIRST['base-mainnet'] + (MAX_LOG_RANGES_PER_PAGE + 50) * BASE - 1 };

  const lowered = await walk(t, 'lowered', { latest: short, items: [] }, 'limit=15', { vars: { TRANSACTION_HISTORY_RANGES_PER_PAGE: '20' } });
  t.same(lowered.pages.map(page => [ page.status, page.items.length ]), [ [ 200, 0 ], [ 200, 0 ], [ 200, 0 ], [ 200, 0 ] ],
    'set to 20, the 78 ranges take four pages, each empty');
  t.same(lowered.pages.map(page => page.done), lowered.pages.map((_, index) => index === lowered.pages.length - 1), 'only the last of them done');
  const firstRanges = [ ...rangesAsked(lowered.asked, 1, 'ethereum-mainnet'), ...rangesAsked(lowered.asked, 1, 'base-mainnet') ];
  t.ok(firstRanges.length <= 2 * 20, 'the first reads at most 20 ranges, two reads each', { asked: firstRanges.length });

  const unread = await walk(t, 'unread', { latest: short, items: [] }, 'limit=15', { vars: { TRANSACTION_HISTORY_RANGES_PER_PAGE: 'twenty' } });
  t.same(unread.pages.map(page => [ page.status, page.done ]), [ [ 200, true ] ], 'set to what is no whole number, one page reads them all');

  const raised = await walk(t, 'raised', { latest: long, items: [] }, 'limit=15', { vars: { TRANSACTION_HISTORY_RANGES_PER_PAGE: '500' } });
  t.same(raised.pages.map(page => [ page.status, page.done ]), [ [ 200, false ], [ 200, true ] ],
    `set above ${MAX_LOG_RANGES_PER_PAGE}, a page still reads no more than that`);
});

/*
 * Four streams: mainnet's WBTC market on a rewards contract of its own, so
 * read apart from mainnet's other markets, Base's, and Scroll's, in ranges of
 * 250,000 blocks. Each holds an item in a block that ends one of its ranges
 * and one in the block after. One block holds a transaction in which the
 * account is only the second address, logged before one in which it is the
 * first; another a transaction that logs two of mainnet's markets; and
 * another a transaction of each mainnet stream. Paged two at a time, with no
 * filter and with mainnet's USDC market alone, which drops items before they
 * are enriched, the pages answer every item they keep once, newest first.
 */
t.test('several streams, two on one network and one in ranges of another size, page every item once, newest first', async t => {
  const WBTC         = '0xe85dc543813b8c2cfeaac371517b925a166a9293';
  const WBTC_REWARDS = '0x2222222222222222222222222222222222222222';
  const WETH_MARKET  = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
  const fixture = loadRegistrySnapshotFixture();
  const snapshot: RegistrySnapshotV1 = {
    ...fixture,
    networks: fixture.networks.map(network => ({
      ...network,
      markets: network.markets.map(market => ({
        ...market,
        capabilities: { ...market.capabilities, transactionHistory: true },
        contracts:    market.contracts.comet === WBTC ? { ...market.contracts, rewards: WBTC_REWARDS } : market.contracts,
      })),
    })),
  };
  const wbtcFirst = 21_820_087;
  const latest = {
    'ethereum-mainnet': MAINNET_LATEST,
    'base-mainnet':     FIRST['base-mainnet'] + 12 * BASE + 3_000_000,
    'scroll-mainnet':   FIRST['scroll-mainnet'] + 30 * RANGE['scroll-mainnet'] + 100_000,
  };
  const grid = (network: Network, ranges: number, first = FIRST[network]) => first + ranges * RANGE[network];
  const wbtc = (block: number, n = 0): Item => ({ network: 'ethereum-mainnet', block, n, logs: [ { market: WBTC } ] });
  const items: Item[] = [
    { network: 'ethereum-mainnet', block: grid('ethereum-mainnet', 5) },
    { network: 'ethereum-mainnet', block: grid('ethereum-mainnet', 5) + 1 },
    { network: 'ethereum-mainnet', block: 22_400_000, n: 0, logs: [ { account: 'second' } ] },
    { network: 'ethereum-mainnet', block: 22_400_000, n: 1 },
    { network: 'ethereum-mainnet', block: 22_100_000, logs: [ {}, { market: WETH_MARKET, account: 'first' } ] },
    { network: 'ethereum-mainnet', block: 21_700_000, logs: [ { market: WETH_MARKET } ] },
    { network: 'ethereum-mainnet', block: 22_800_000, n: 0 },
    wbtc(22_800_000, 1),
    wbtc(grid('ethereum-mainnet', 1, wbtcFirst)),
    wbtc(grid('ethereum-mainnet', 1, wbtcFirst) + 1),
    wbtc(wbtcFirst),
    { network: 'base-mainnet', block: grid('base-mainnet', 7) },
    { network: 'base-mainnet', block: grid('base-mainnet', 7) + 1 },
    { network: 'base-mainnet', block: latest['base-mainnet'] },
    { network: 'scroll-mainnet', block: grid('scroll-mainnet', 20) },
    { network: 'scroll-mainnet', block: grid('scroll-mainnet', 20) + 1 },
    { network: 'scroll-mainnet', block: FIRST['scroll-mainnet'] },
  ];
  const history = { latest, items };
  const byHash = new Map(items.map(item => [ hashOf(item), item ]));
  // the items that log mainnet's USDC market, which a filter to that market keeps
  const usdc = (item: Item) => item.network === 'ethereum-mainnet'
    && (item.logs ?? [ {} ]).some(log => (log.market ?? MARKET['ethereum-mainnet']) === MARKET['ethereum-mainnet']);

  for (const [ name, query, kept, what ] of [
    [ 'streams', 'limit=2', items, 'with no filter' ],
    [ 'usdc', `limit=2&markets[]=1_${MARKET['ethereum-mainnet']}`, items.filter(usdc), 'with mainnet\'s USDC market alone' ],
  ] as const) {
    const { pages } = await walk(t, name, history, query, { snapshot });
    const answered = pages.flatMap(page => page.items);
    t.same([ ...answered ].sort(), kept.map(hashOf).sort(), `${what}, the pages answer every item kept, once each`);
    const order = answered.map(hash => byHash.get(hash)!);
    t.ok(order.every((item, index) => index === 0 || (true
      && timestampOf(history, order[index - 1]!.network, order[index - 1]!.block) >= timestampOf(history, item.network, item.block)
      && (order[index - 1]!.network !== item.network || order[index - 1]!.block >= item.block)
    )), 'newest first', { answered });
    t.ok(pages.every(page => page.status === 200 && page.items.length <= 2), 'none answers more than the limit');
    t.same(pages.map(page => page.done), pages.map((_, index) => index === pages.length - 1), 'and only the last is done');
  }
});
