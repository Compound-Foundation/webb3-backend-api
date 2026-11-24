import t from 'tap';

import { defaultAbiCoder } from '@ethersproject/abi';

import C3Api from '../../../entrypoint.js';

import * as Eth from '../../../lib/eth-constants.js';
import * as cometModel from '../../../lib/model/comet.js';
import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { makeTestEnv } from '../../util/test-env.js';
import { activeRegistryDatabase, type RegistryDatabase } from '../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

import '../../../shim/node-self.js';

/*
 * The list filters of an account's history, `markets[]`, `actions[]` and
 * `initiated_by[]`, against a version that serves the history of mainnet's
 * markets, read as one stream, and of Base's AERO market, read as another.
 *
 * Each filter takes its values from every time the request repeats it, as
 * well as separated by commas, and the two spellings keep the same items.
 * Action names, and `me` and `other`, are read in any case, and a value a
 * filter does not take is a 400 that names it. Before, only the first of a
 * repeated parameter was read: the others were dropped unread, `supply`
 * matched no action, and a mistyped value answered a history without items.
 */
type Network = 'ethereum-mainnet' | 'base-mainnet';

// lowercase, as a node names the account that sends a transaction
const ACCOUNT = '0x420f253087044b8bcf028dd89f8fe83ba6275e84';
const OTHER   = '0x1111111111111111111111111111111111111111';
// the collateral every item supplies or withdraws
const WETH    = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

// mainnet's USDC and WETH markets, which share a rewards contract, and Base's AERO market
const USDC        = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WETH_MARKET = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
const AERO        = '0x784efeb622244d2348d4f2522f8860b96fbece89';
// an address no market of the version has
const NOT_A_MARKET = '0x00000000000000000000000000000000000000aa';

// the latest block of each network: eight ranges above mainnet's first block, three above Base's
const LATEST: Record<Network, number> = { 'ethereum-mainnet': 23_000_000, 'base-mainnet': 45_852_405 };
// the time of the latest block of every network
const NOW = 1_800_000_000;

/*
 * An item of the account's history, the one transaction of its block: a
 * supply of collateral to the account in `market`, a Supply, unless it is a
 * withdrawal of the account's collateral, a Withdraw. The account sends the
 * transaction, and initiates the item, unless `from` names another sender.
 */
type Item = { network: Network, block: number, market: string, withdraw?: boolean, from?: string };

const usdcSupply:   Item = { network: 'ethereum-mainnet', block: 22_900_000, market: USDC };
const wethWithdraw: Item = { network: 'ethereum-mainnet', block: 22_800_000, market: WETH_MARKET, withdraw: true };
const usdcOther:    Item = { network: 'ethereum-mainnet', block: 22_700_000, market: USDC, from: OTHER };
const aeroSupply:   Item = { network: 'base-mainnet', block: LATEST['base-mainnet'] - 1_000_000, market: AERO };
const aeroOther:    Item = { network: 'base-mainnet', block: LATEST['base-mainnet'] - 2_000_000, market: AERO, from: OTHER };
const ITEMS = [ usdcSupply, wethWithdraw, usdcOther, aeroSupply, aeroOther ];

type Condition = null | string | string[];
type Call = { id: number, method: string, params: any[] };

const CODE: Record<Network, string> = { 'ethereum-mainnet': 'e7e1', 'base-mainnet': 'ba5e' };

function hashOf({ network, block }: Item): string {
  return `0x${CODE[network]}${block.toString(16).padStart(60, '0')}`;
}

function topicOf(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

// the time of a block: twelve seconds a block on mainnet, five blocks a second on Base
function timestampOf(network: Network, block: number): number {
  const behind = LATEST[network] - block;
  return NOW - (network === 'base-mainnet' ? Math.floor(behind / 5) : behind * 12);
}

const TOPICS = Eth.Event.Coder.fromSignatures([ cometModel.events.SupplyCollateral, cometModel.events.WithdrawCollateral ]).topics;

function logOf(item: Item) {
  return {
    address:          item.market,
    topics:           [
      item.withdraw === true ? TOPICS.WithdrawCollateral : TOPICS.SupplyCollateral,
      topicOf(ACCOUNT),
      topicOf(ACCOUNT),
      topicOf(WETH),
    ],
    data:             defaultAbiCoder.encode([ 'uint256' ], [ '1000000000000000000' ]),
    blockNumber:      Eth.Hex.fromNumber(item.block),
    blockHash:        `0x${item.block.toString(16).padStart(64, '0')}`,
    transactionHash:  hashOf(item),
    transactionIndex: '0x0',
    logIndex:         '0x0',
    removed:          false,
  };
}

/*
 * The node of the history: eth_getLogs answers the logs the range, the
 * contracts and the topics it is asked for match, oldest first, as a node
 * does, a block names the transaction in it, and the account has no DeFi
 * Saver proxy.
 */
function answer(network: Network, { method, params }: Call): object {
  switch (method) {
    case 'eth_getBlockByNumber': {
      const [ reference ] = params;
      const number = reference === 'latest' ? LATEST[network] : parseInt(reference, 16);
      return { result: {
        number:       Eth.Hex.fromNumber(number),
        timestamp:    Eth.Hex.fromNumber(timestampOf(network, number)),
        transactions: reference === 'latest' ? [] : ITEMS
          .filter(item => item.network === network && item.block === number)
          .map(item => ({ hash: hashOf(item), from: item.from ?? ACCOUNT, to: item.market })),
      } };
    }
    case 'eth_getLogs': {
      const [ { address, fromBlock, toBlock, topics } ] = params as [ { address: string[], fromBlock: string, toBlock: string, topics: Condition[] } ];
      const matches = (condition: Condition, topic: string | undefined) => (
        condition === null || [ condition ].flat().some(value => value.toLowerCase() === topic)
      );
      return { result: ITEMS
        .filter(item => item.network === network && item.block >= parseInt(fromBlock, 16) && item.block <= parseInt(toBlock, 16))
        .sort((a, b) => a.block - b.block)
        .map(logOf)
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
 * What the node was asked, by the name of the walk that asked it, which it
 * sends as its node key. A page reads items ahead of what it answers, and
 * those reads go on after it is answered, which is why the node answers for
 * as long as the file runs.
 */
const asked = new Map<string, Array<{ network: Network, method: string }>>();

t.before(() => {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    const [ , network, name ] = new URL(request.url).pathname.split('/') as [ string, Network, string ];
    const body  = await request.json() as Call | Call[];
    const calls = body instanceof Array ? body : [ body ];
    asked.get(name)?.push(...calls.map(({ method }) => ({ network, method })));
    const answers = calls.map(call => ({ jsonrpc: '2.0', id: call.id, ...answer(network, call) }));
    return new Response(JSON.stringify(body instanceof Array ? answers : answers[0]));
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

// a page as a client reads it: its status, whether it is done, its items, and the type of each of their actions
type Page = { status: number, done: boolean, items: string[], actionTypes: string[] };

/*
 * A client paging through the history, `query` on every page, or on each
 * page as `query` says, until a page is done or refused: what each page
 * answered, the text of a refusal among them, and what the node was asked
 * for all of them. Each walk has a memory cache of its own, so what it asks
 * of the node is not read from another walk's ranges.
 */
async function walk(registry: RegistryDatabase, name: string, query: string | ((page: number) => string)): Promise<{
  pages: Page[],
  asked: Array<{ network: Network, method: string }>,
}> {
  asked.set(name, []);
  const env = makeTestEnv({
    MEMORY_CACHE_SEED:                `list-filters-${name}`,
    APP_DB:                           registry.db,
    FLAGS_ETH_COMPUTATION_INDEX_BIAS: 'default',
    NODE_PROXY_KEY:                   name,
  });

  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= 20; page++) {
    const sent = typeof query === 'string' ? query : query(page);
    const url = `https://api.test.local/account/${ACCOUNT}/transaction_history?${sent}${cursor === undefined ? '' : `&cursor=${cursor}`}`;
    const response = await C3Api.fetch(new Request(url), env);
    if (response.status !== 200) {
      pages.push({ status: response.status, done: false, items: [ await response.text() ], actionTypes: [] });
      break;
    }
    const body = await response.json() as {
      done:   boolean,
      cursor: string,
      items:  Array<{ transaction_hash: string, actions: Array<{ action_type: string }> }>,
    };
    pages.push({
      status:      200,
      done:        body.done,
      items:       body.items.map(item => item.transaction_hash),
      actionTypes: body.items.flatMap(item => item.actions.map(action => action.action_type)),
    });
    if (body.done) {
      break;
    }
    cursor = body.cursor;
  }
  // what the pages read ahead of what they answered reaches the node too
  await new Promise(resolve => setTimeout(resolve, 100));
  return { pages, asked: asked.get(name)! };
}

// the items of every page, in no particular order, for a comparison with the items a filter keeps
function itemsOf(pages: Page[]): string[] {
  return pages.flatMap(page => page.items).sort();
}

function hashesOf(items: readonly Item[]): string[] {
  return items.map(hashOf).sort();
}

// how many times the node was asked for logs of a network
function logsAskedOf(calls: Array<{ network: Network, method: string }>, network: Network): number {
  return calls.filter(call => call.network === network && call.method === 'eth_getLogs').length;
}

const usdc = `1_${USDC}`;
const weth = `1_${WETH_MARKET}`;
const aero = `8453_${AERO}`;

t.test('a filter repeated keeps the same items as one with its values separated by commas', async t => {
  const registry = await activeRegistryDatabase({ snapshot: withBase() });
  t.teardown(() => registry.dispose());

  for (const [ name, comma, repeated, kept ] of [
    [ 'markets', `markets[]=${usdc},${aero}`, `markets[]=${usdc}&markets[]=${aero}`, [ usdcSupply, usdcOther, aeroSupply, aeroOther ] ],
    [ 'actions', 'actions[]=Supply,Withdraw', 'actions[]=Supply&actions[]=Withdraw', ITEMS ],
    [ 'initiators', 'initiated_by[]=me,other', 'initiated_by[]=me&initiated_by[]=other', ITEMS ],
  ] as const) {
    const byComma = await walk(registry, `${name}-comma`, `limit=15&${comma}`);
    t.same(byComma.pages.map(page => [ page.status, page.done ]), [ [ 200, true ] ], `${name}, separated by commas: one page, done`);
    t.same(itemsOf(byComma.pages), hashesOf(kept), 'which holds the items of every value');
    const byRepeat = await walk(registry, `${name}-repeated`, `limit=15&${repeated}`);
    t.same(byRepeat.pages, byComma.pages, `${name}, repeated: the same page`);
  }

  const mixed = await walk(registry, 'mixed', `limit=15&markets[]=${aero}&markets[]=${usdc},${weth}`);
  t.same(mixed.pages.map(page => [ page.status, page.done ]), [ [ 200, true ] ], 'both spellings in one request: one page, done');
  t.same(itemsOf(mixed.pages), hashesOf(ITEMS), 'which holds the items of every market it names');
});

t.test('spaces around a value, empty values and repeated values are dropped', async t => {
  const registry = await activeRegistryDatabase({ snapshot: withBase() });
  t.teardown(() => registry.dispose());

  for (const [ name, query, kept ] of [
    [ 'spaced-markets', `markets[]=${usdc},+${aero},&markets[]=`, [ usdcSupply, usdcOther, aeroSupply, aeroOther ] ],
    [ 'spaced-actions', 'actions[]=Withdraw,,Withdraw&actions[]=%20Withdraw%20', [ wethWithdraw ] ],
    [ 'spaced-initiators', 'initiated_by[]=other,&initiated_by[]=+other', [ usdcOther, aeroOther ] ],
  ] as const) {
    const { pages } = await walk(registry, name, `limit=15&${query}`);
    t.same(pages.map(page => [ page.status, page.done ]), [ [ 200, true ] ], `${query}: one page, done`);
    t.same(itemsOf(pages), hashesOf(kept), 'which holds the items of the values it names');
  }
});

t.test('action names are read in any case, and answered as the history names them', async t => {
  const registry = await activeRegistryDatabase({ snapshot: withBase() });
  t.teardown(() => registry.dispose());

  for (const [ index, spelling ] of [ 'withdraw', 'WITHDRAW', 'wItHdRaW' ].entries()) {
    const { pages } = await walk(registry, `case${index}`, `limit=15&actions[]=${spelling}`);
    t.same(pages.map(page => [ page.status, page.done, page.items, page.actionTypes ]), [ [ 200, true, [ hashOf(wethWithdraw) ], [ 'Withdraw' ] ] ],
      `actions[]=${spelling}: one page, done, with the one withdrawal, a Withdraw`);
  }
  const both = await walk(registry, 'case-both', 'limit=15&actions[]=supply&actions[]=WITHDRAW');
  t.same(itemsOf(both.pages), hashesOf(ITEMS), 'supply and WITHDRAW together keep every item');
  t.same([ ...new Set(both.pages.flatMap(page => page.actionTypes)) ].sort(), [ 'Supply', 'Withdraw' ], 'named Supply and Withdraw');
});

/*
 * `me` and `other` are read in any case too, as action names are, so that
 * one rule holds for every value the filters take: the addresses of
 * `markets[]` are read in any case already.
 */
t.test('initiated_by[] is read in any case', async t => {
  const registry = await activeRegistryDatabase({ snapshot: withBase() });
  t.teardown(() => registry.dispose());

  for (const [ name, query, kept ] of [
    [ 'me-upper', 'initiated_by[]=ME', [ usdcSupply, wethWithdraw, aeroSupply ] ],
    [ 'other-mixed', 'initiated_by[]=Other', [ usdcOther, aeroOther ] ],
  ] as const) {
    const { pages } = await walk(registry, name, `limit=15&${query}`);
    t.same(pages.map(page => [ page.status, page.done ]), [ [ 200, true ] ], `${query}: one page, done`);
    t.same(itemsOf(pages), hashesOf(kept), 'which holds the items the value keeps in lowercase');
  }
});

t.test('a value a filter does not take is a 400 that names it, whichever spelling carries it', async t => {
  const registry = await activeRegistryDatabase({ snapshot: withBase() });
  t.teardown(() => registry.dispose());

  for (const [ index, [ query, text ] ] of ([
    [ 'actions[]=Supply,Borow', 'Invalid action Borow' ],
    [ 'actions[]=Supply&actions[]=Borow', 'Invalid action Borow' ],
    [ 'initiated_by[]=me,someone', 'Invalid initiated by someone' ],
    [ 'initiated_by[]=me&initiated_by[]=someone', 'Invalid initiated by someone' ],
    [ `markets[]=${usdc},1_${NOT_A_MARKET}`, `Invalid market address ${NOT_A_MARKET}` ],
    [ `markets[]=${usdc}&markets[]=1_${NOT_A_MARKET}`, `Invalid market address ${NOT_A_MARKET}` ],
  ] as const).entries()) {
    const { pages } = await walk(registry, `unknown${index}`, `limit=15&${query}`);
    t.same(pages.map(page => [ page.status, page.items ]), [ [ 400, [ text ] ] ], `${query}: 400, ${text}`);
  }
});

t.test('a filter of one value keeps the items it kept', async t => {
  const registry = await activeRegistryDatabase({ snapshot: withBase() });
  t.teardown(() => registry.dispose());

  for (const [ name, query, kept ] of [
    [ 'none', '', ITEMS ],
    [ 'usdc', `markets[]=${usdc}`, [ usdcSupply, usdcOther ] ],
    [ 'aero', `markets[]=${aero}`, [ aeroSupply, aeroOther ] ],
    [ 'withdraw', 'actions[]=Withdraw', [ wethWithdraw ] ],
    [ 'me', 'initiated_by[]=me', [ usdcSupply, wethWithdraw, aeroSupply ] ],
    [ 'other', 'initiated_by[]=other', [ usdcOther, aeroOther ] ],
    [ 'all', `markets[]=${usdc}&actions[]=Supply&initiated_by[]=me`, [ usdcSupply ] ],
  ] as const) {
    const { pages } = await walk(registry, `one-${name}`, `limit=15&${query}`);
    t.same(pages.map(page => [ page.status, page.done ]), [ [ 200, true ] ], `${query === '' ? 'no filter' : query}: one page, done`);
    t.same(itemsOf(pages), hashesOf(kept), 'which holds the items it keeps');
  }
});

/*
 * A cursor keeps the filters of the page that handed it out, and a page that
 * resumes it with other filters is refused. The filters are compared as the
 * lists they read as, so a page may spell them otherwise, in another order,
 * and without the values the first page named twice: one at a time, the
 * pages answer the four supplies on the two markets, each once.
 */
t.test('a cursor is resumed with its filters in either spelling', async t => {
  const registry = await activeRegistryDatabase({ snapshot: withBase() });
  t.teardown(() => registry.dispose());

  const { pages } = await walk(registry, 'resumed', page => page === 1
    ? `limit=1&markets[]=${usdc},${aero},${usdc}&actions[]=Supply,supply`
    : `limit=1&markets[]=${aero}&markets[]=${usdc}&actions[]=supply`);
  t.ok(pages.length >= 4, 'one item a page', { pages });
  t.ok(pages.every(page => page.status === 200), 'every page is answered', { pages });
  t.same(pages.map(page => page.done), pages.map((_, index) => index === pages.length - 1), 'and only the last is done');
  t.same(itemsOf(pages), hashesOf([ usdcSupply, usdcOther, aeroSupply, aeroOther ]), 'the pages answer the supplies on both markets, each once');
});

/*
 * A page reads only the streams that hold a market `markets[]` names, as it
 * did before the filters were read from every repeated parameter: for
 * mainnet's markets the node is asked nothing about Base, and for Base's
 * market no log of mainnet is read.
 */
t.test('a markets filter reads the logs of the networks of the markets it names only', async t => {
  const registry = await activeRegistryDatabase({ snapshot: withBase() });
  t.teardown(() => registry.dispose());

  const all = await walk(registry, 'streams-all', 'limit=15');
  t.ok(logsAskedOf(all.asked, 'ethereum-mainnet') > 0 && logsAskedOf(all.asked, 'base-mainnet') > 0, 'without a filter, the logs of both networks are read');

  for (const [ name, query ] of [ [ 'streams-usdc', `markets[]=${usdc}` ], [ 'streams-mainnet', `markets[]=${usdc},${weth}` ] ] as const) {
    const filtered = await walk(registry, name, `limit=15&${query}`);
    t.same(itemsOf(filtered.pages), hashesOf(ITEMS.filter(item => item.network === 'ethereum-mainnet' && query.includes(item.market))), `${query}: the items of the markets it names`);
    t.ok(logsAskedOf(filtered.asked, 'ethereum-mainnet') > 0, 'mainnet\'s logs are read');
    t.same(filtered.asked.filter(call => call.network === 'base-mainnet'), [], 'and the node is asked nothing about Base');
  }

  const base = await walk(registry, 'streams-aero', `limit=15&markets[]=${aero}`);
  t.same(itemsOf(base.pages), hashesOf([ aeroSupply, aeroOther ]), `markets[]=${aero}: the items of Base's market`);
  t.equal(logsAskedOf(base.asked, 'ethereum-mainnet'), 0, 'and no log of mainnet is read');
});

// repeated, a filter of both networks' markets reads the streams of both
t.test('a markets filter repeated reads the logs of the networks of every market it names', async t => {
  const registry = await activeRegistryDatabase({ snapshot: withBase() });
  t.teardown(() => registry.dispose());

  const both = await walk(registry, 'streams-both', `limit=15&markets[]=${usdc}&markets[]=${aero}`);
  t.same(itemsOf(both.pages), hashesOf([ usdcSupply, usdcOther, aeroSupply, aeroOther ]), 'the items of both markets');
  t.ok(logsAskedOf(both.asked, 'ethereum-mainnet') > 0 && logsAskedOf(both.asked, 'base-mainnet') > 0, 'read from the logs of both networks');
});
