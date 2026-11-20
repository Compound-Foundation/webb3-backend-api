import t, { Test } from 'tap';

import { randomUUID } from 'node:crypto';

import C3Api, { Env } from '../../entrypoint.js';

import { MemoryKv } from '../util/kv.js';
import { activeRegistryDatabase } from '../util/registry-database.js';
import { failingDatabase, makeTestEnv } from '../util/test-env.js';

import '../../shim/node-self.js';

/*
 * Testnets are not served. The registry imports mainnets alone, so every
 * route that takes a network or a chain from the request answers one that
 * names a testnet with the same refusal — 400 TESTNET_NOT_SERVED in the error
 * envelope, naming what named it — instead of nothing, mainnet data, or a
 * message about something else. It is refused before anything is read from
 * the registry or the chain. The same route with a mainnet goes on as
 * before: here, where no node answers, as far as asking the node.
 */
const ACCOUNT    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const USDC       = '0xc3d688b66703497daa19211eedff47f25384cdc3';
// the Sepolia markets webb3-frontend's hidden transaction history mode names
const SEPOLIA    = [ '11155111_0x2943ac1216979aD8dB76D9147F64E61adc126e96', '11155111_0xAec1F48e02Cfb822Be958B68C7957156EB3F0b6e' ];
const SEPOLIA_RW = '0x8bf5b658bdf0388e8b482ed51b14aef58f90abfd';

type Envelope = { error: { code: string, message: string, requestId: string, details?: Record<string, unknown> } };

/*
 * A cursor as the history issued it before the registry, keyed by network and
 * with no version: one a request for the Sepolia markets started.
 */
function legacyCursor(network: string, markets: string[], comets: string[], rewards: string) {
  const stream = { network, marketContractAddresses: comets, rewardsContractAddress: rewards };
  return {
    profilesByAddress: {},
    filter: {
      markets,
      actions:           [],
      initiatedBy:       [],
      contractAddresses: [ ...comets, rewards ],
      networks:          [ network ],
    },
    streamEvents: [ stream ],
    cursors:      { [network]: { ...stream, blockNumber: 1, transactionHash: '0x0' } },
  };
}

// under an id of the form every cursor has, the hex SHA-256 of what it holds
const SEPOLIA_CURSOR = '5e90'.repeat(16);

const CURSORS = {
  [SEPOLIA_CURSOR]: legacyCursor('ethereum-sepolia', SEPOLIA, SEPOLIA.map(market => market.split('_')[1]!), SEPOLIA_RW),
};

/*
 * A node that never answers, and remembers being asked, for the whole file.
 * It stays in place from one test to the next: a route can answer before
 * every evaluation it started has ended — /account/{address}/rewards answers
 * once one network has failed — and what is left goes on asking the node
 * after its test is over. Each harness asks it under a key of its own, so it
 * counts what it asked, and nothing a test before it left running.
 */
const requests: string[] = [];
const fetchBefore        = globalThis.fetch;

t.before(() => {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    requests.push(new Request(input, init).url);
    throw new TypeError('fetch failed');
  }) as unknown as typeof globalThis.fetch;
  // the worker logs every request the node fails
  for (const level of [ 'error', 'warn', 'log' ] as const) {
    t.capture(console, level);
  }
});
t.teardown(() => {
  globalThis.fetch = fetchBefore;
});

// a registry with the fixture on — or, with `activate: false`, with nothing on
async function registryOf(t: Test, options: { activate?: boolean } = {}): Promise<D1Database> {
  const registry = await activeRegistryDatabase(options);
  t.teardown(() => registry.dispose());
  return registry.db;
}

// the worker over `db`, the registry fixture unless a test says otherwise, asking the node under a key of its own
async function harness(t: Test, db?: D1Database): Promise<{ get: (path: string) => Promise<Response>, asked: () => number }> {
  const key = randomUUID();
  const env: Env = makeTestEnv({
    DEBUG:             '',
    MEMORY_CACHE_SEED: 'testnets',
    APP_DB:            db ?? await registryOf(t),
    NODE_PROXY_KEY:    key,
    kv_mainnet:        MemoryKv({ seed: CURSORS }),
  });
  return {
    get:   path => C3Api.fetch(new Request(`https://api.test.local${path}`), env),
    asked: () => requests.filter(url => url.endsWith(`/${key}`)).length,
  };
}

async function refuses(t: Test, response: Response, named: string, what: string): Promise<void> {
  t.equal(response.status, 400, `${what} is refused`);
  t.match(response.headers.get('content-type'), /^application\/json/, 'as JSON');
  const { error } = await response.json() as Envelope;
  t.same([ error.code, error.message ], [ 'TESTNET_NOT_SERVED', `testnets are not served: ${named}` ],
    `in the envelope, naming ${named}`);
  t.match(error.requestId, /^[0-9a-f-]{36}$/, 'under a request id');
}

t.test('a market route that names a testnet is refused', async t => {
  const { get, asked } = await harness(t);

  for (const [ path, named ] of [
    [ '/market/sepolia/all/summary', 'ethereum-sepolia' ],
    [ '/market/ethereum-sepolia/0x2943ac1216979aD8dB76D9147F64E61adc126e96/summary', 'ethereum-sepolia' ],
    [ '/market/polygon-mumbai/all/historical/summary', 'polygon-mumbai' ],
    [ '/market/base-sepolia/0x61490650AbaA31393464C3f34E8B29cd1C44118E/rewards/summary', 'base-sepolia' ],
    [ '/market/arbitrum-goerli/all/rewards/dapp-data', 'arbitrum-goerli' ],
  ] as const) {
    await refuses(t, await get(path), named, path);
  }
  t.equal(asked(), 0, 'before the chain is asked anything');

  const mainnet = await get(`/market/ethereum-mainnet/${USDC}/summary`);
  t.not(mainnet.status, 400, 'the same route with a mainnet is not refused');
  t.ok(asked() > 0, 'and goes on to ask the node, as before');
});

t.test('a route over every network that asks for testnets is refused', async t => {
  const { get, asked } = await harness(t);

  for (const path of [
    '/market/all-networks/all-contracts/summary?testnets=include',
    '/market/all-networks/all-contracts/historical/summary?testnets=include',
    '/market/all-networks/all-contracts/rewards/dapp-data?testnets=include',
    `/account/${ACCOUNT}/rewards?testnets=include`,
  ]) {
    await refuses(t, await get(path), 'testnets=include', path);
  }
  t.equal(asked(), 0, 'before the chain is asked anything');

  for (const path of [ '/market/all-networks/all-contracts/summary', `/account/${ACCOUNT}/rewards?testnets=exclude` ]) {
    const before   = asked();
    const response = await get(path);
    t.not(response.status, 400, `${path} is not refused`);
    t.ok(asked() > before, 'and asks the node for the mainnets, as before');
  }
});

t.test('a transaction history that names a testnet market is refused', async t => {
  const { get, asked } = await harness(t);
  const history = `/account/${ACCOUNT}/transaction_history`;

  await refuses(t, await get(`${history}?markets[]=${SEPOLIA.join(',')}`), 'ethereum-sepolia', 'a Sepolia market');
  await refuses(t, await get(`${history}?markets[]=1_${USDC},${SEPOLIA[0]}`), 'ethereum-sepolia', 'a Sepolia market beside a mainnet one');
  t.equal(asked(), 0, 'before the chain is asked anything');

  /*
   * The same request for a mainnet market goes on to the checks that came
   * after this one, and is answered as it was; reading a history from a node
   * that does not answer is the network tests' to show.
   */
  const unknown = `0x${'9'.repeat(40)}`;
  const market  = await get(`${history}?markets[]=1_${unknown}`);
  t.same([ market.status, await market.text() ], [ 400, `Invalid market address ${unknown}` ],
    'a mainnet market the registry does not serve is refused for that, as before');
});

/*
 * A cursor names no network: what it reads is what the history kept under
 * it. One issued before the registry may read a testnet; it is ended as every
 * cursor issued before the registry is, with the 409 that tells the client to
 * start over, and not refused as a testnet.
 */
t.test('a cursor issued before the registry that reads a testnet is ended, not refused', async t => {
  const { get, asked } = await harness(t);
  const history = `/account/${ACCOUNT}/transaction_history`;

  const ended   = await get(`${history}?cursor=${SEPOLIA_CURSOR}`);
  const version = ended.headers.get('x-registry-version');
  t.equal(ended.status, 409, 'the cursor is ended');
  t.ok(version, 'by the version that is active');
  const { error } = await ended.json() as Envelope;
  t.same([ error.code, error.details ], [
    'REGISTRY_VERSION_CHANGED',
    { cursorRegistryVersionId: null, registryVersionId: version },
  ], 'as every cursor that names no version is');

  await refuses(t, await get(`${history}?cursor=${SEPOLIA_CURSOR}&markets[]=${SEPOLIA.join(',')}`), 'ethereum-sepolia',
    'while sent with its filter, it is refused for the testnet the filter names, as that filter alone is');
  t.equal(asked(), 0, 'before the chain is asked anything');
});

/*
 * A testnet is refused before the registry is read, on every route: the
 * registry has none to answer with, so whether a version is on, and whether
 * the database answers at all, changes nothing about the answer.
 */
t.test('a testnet is refused while no version is on, and while the database does not answer', async t => {
  const history = `/account/${ACCOUNT}/transaction_history`;

  for (const [ db, state ] of [
    [ await registryOf(t, { activate: false }), 'no version is on' ],
    [ failingDatabase('D1_ERROR: Network connection lost.'), 'the database does not answer' ],
  ] as const) {
    const { get, asked } = await harness(t, db);
    for (const [ path, named ] of [
      [ '/market/sepolia/all/summary', 'ethereum-sepolia' ],
      [ '/market/all-networks/all-contracts/summary?testnets=include', 'testnets=include' ],
      [ `/account/${ACCOUNT}/rewards?testnets=include`, 'testnets=include' ],
      [ `${history}?markets[]=${SEPOLIA[0]}`, 'ethereum-sepolia' ],
    ] as const) {
      await refuses(t, await get(path), named, `${path} while ${state}`);
    }
    t.equal(asked(), 0, 'before the chain is asked anything');

    const mainnet = await get(`${history}?markets[]=1_${USDC}`);
    t.equal(mainnet.status, 503, `while ${state}, the history of a mainnet market is what cannot be answered`);
  }
});
