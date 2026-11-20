import t from 'tap';

import C3Api from '../../entrypoint.js';

import * as Eth from '../../lib/eth-constants.js';

import { consoleLines } from '../util/console.js';
import { MemoryKv, refusingKv } from '../util/kv.js';
import { makeTestEnv } from '../util/test-env.js';

import '../../shim/node-self.js';

/*
 * An account route takes an account that is `0x` and 40 hex digits, in any
 * case, and nothing else. Anything else is answered as a malformed parameter
 * of these routes is, with a 400 and a line of plain text that repeats the
 * segment as it was sent, before the registry, KV or a node is read. Before,
 * a value that only held an address, with more characters around it, went on
 * to the registry and the node and failed with a 500 when the account was
 * encoded for a call.
 *
 * The same check takes the market contract of a URL, an address in history's
 * markets[] and one in comp/accounts?addresses=, so junk around an address is
 * refused there too, before anything is read. In markets[] the address is what
 * follows the chain id's `_`, up to a second `_`: what follows that is not
 * checked, as before.
 *
 * The database never answers here: a request to a route that reads the
 * registry stops there once it is past the checks, with a 503, before a node
 * is asked anything.
 */
const ACCOUNT     = '0x420f253087044b8bcf028dd89f8fe83ba6275e84';
const CHECKSUMMED = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';
const USDC        = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const USDC_SUMMED = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const COMP        = (Eth.wellKnownContractsByNetwork['ethereum-mainnet'] as any)['COMP']['default'].address as string;
// a Sepolia market, which the history refuses as a testnet
const SEPOLIA     = '11155111_0x2943ac1216979aD8dB76D9147F64E61adc126e96';

// what a client can put where an account goes, none of which is one
const MALFORMED: Array<[ string, string ]> = [
  [ '0x123',                           'a short value' ],
  [ ACCOUNT.slice(0, -1),              '39 hex digits' ],
  [ `${ACCOUNT}0`,                     '41 hex digits' ],
  [ `${ACCOUNT}junk`,                  'an address with junk after it' ],
  [ `x${ACCOUNT}`,                     'an address with junk before it' ],
  [ `%20${ACCOUNT}`,                   'an address after a space' ],
  [ `${ACCOUNT}%0A`,                   'an address before a newline' ],
  [ `${ACCOUNT}.`,                     'an address before a dot' ],
  [ `0x${'ab'.repeat(32)}`,            'a 32-byte hash' ],
  [ `0X${ACCOUNT.slice(2)}`,           'a capital X' ],
  [ ACCOUNT.slice(2),                  'no 0x' ],
  [ `0x${'g'.repeat(40)}`,             'no hex digits' ],
  [ `${ACCOUNT}${'a'.repeat(3958)}`,   '4,000 characters that start with an address' ],
  [ `${'z'.repeat(3958)}${ACCOUNT}`,   '4,000 characters that end with one' ],
];

// the forms of one address a client can send, each of which is the account
const FORMS: Array<[ string, string ]> = [
  [ ACCOUNT,                                  'the lowercase form' ],
  [ CHECKSUMMED,                              'the checksummed form' ],
  [ `0x${ACCOUNT.slice(2).toUpperCase()}`,    'the uppercase form' ],
  [ CHECKSUMMED.replace('0x420f', '0x420F'),  'a mixed case whose checksum is wrong' ],
];

/*
 * Every request leaves through a fetch that remembers its URL, for the whole
 * file. Tally is answered with no account, and remembers the accounts it was
 * asked for; anything else, a node above all, fails as a network that cannot
 * be reached does.
 */
const requests: string[]     = [];
const tallyAsked: string[][] = [];
const fetchBefore            = globalThis.fetch;

t.before(() => {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.url);
    if (request.url === Eth.governanceTallyQueryEndpoint) {
      const { variables } = await request.json() as { variables: { accountIds?: string[] } };
      tallyAsked.push(variables.accountIds ?? []);
      return new Response(JSON.stringify({ data: { accounts: [] } }));
    }
    throw new TypeError('fetch failed');
  }) as unknown as typeof globalThis.fetch;
});
t.teardown(() => {
  globalThis.fetch = fetchBefore;
});

type Read = { d1: number, kv: number, fetch: number };

/*
 * The worker over a database that cannot be reached, and KV that counts every
 * call made to it: what a request read, of the database, KV and the network,
 * is counted from here on.
 */
function harness(): { get: (path: string) => Promise<Response>, read: () => Read } {
  const counted = { d1: 0, kv: 0 };
  const fetched = requests.length;
  const fail    = () => { counted.d1 += 1; throw new Error('D1_ERROR: Network connection lost.'); };
  const kv      = () => refusingKv(MemoryKv({}), () => { counted.kv += 1; return false; });
  const env     = makeTestEnv({
    DEBUG:             '',
    MEMORY_CACHE_SEED: 'account-address',
    APP_DB:            { prepare: fail, batch: fail, exec: fail, dump: fail } as unknown as D1Database,
    kv_mainnet:        kv(),
    kv_testnet:        kv(),
    kv_registry:       kv(),
  });
  return {
    get:  path => C3Api.fetch(new Request(`https://api.test.local${path}`), env),
    read: () => ({ ...counted, fetch: requests.length - fetched }),
  };
}

t.test('a malformed account is refused before the registry, KV or a node is read', async t => {
  const logs = consoleLines(t, [ 'error', 'warn', 'log' ]);
  const { get, read } = harness();

  for (const route of [ 'rewards', 'transaction_history' ]) {
    for (const [ value, what ] of MALFORMED) {
      const response = await get(`/account/${value}/${route}`);
      t.same([ response.status, await response.text() ], [ 400, `Error: Bad account address: ${value}` ],
        `${what} is refused on /${route}, named as it was sent`);
      t.match(response.headers.get('content-type'), /^text\/plain/, 'in a line of plain text');
    }
  }

  // the account is checked first, whatever else the request asks for
  for (const path of [
    `/account/${ACCOUNT}junk/rewards?testnets=include`,
    `/account/${ACCOUNT}junk/transaction_history?markets[]=${SEPOLIA}`,
    `/account/${ACCOUNT}junk/transaction_history?markets[]=1_${USDC}junk`,
    `/account/${ACCOUNT}junk/transaction_history?cursor=..`,
  ]) {
    const response = await get(path);
    t.same([ response.status, await response.text() ], [ 400, `Error: Bad account address: ${ACCOUNT}junk` ],
      `${path} is refused for its account`);
  }
  t.same(read(), { d1: 0, kv: 0, fetch: 0 }, 'and none of them read the database, KV or the network');
  t.same(logs, [], 'or wrote a line to the log');
});

/*
 * Each form of an address is the account, a mixed case with a wrong checksum
 * among them: it goes on past the checks to the registry, which is where the
 * request stops here.
 */
t.test('an account in any case goes on to the registry', async t => {
  consoleLines(t, [ 'error', 'warn', 'log' ]);
  const { get, read } = harness();

  for (const route of [ 'rewards', 'transaction_history' ]) {
    for (const [ value, what ] of FORMS) {
      const before   = read().d1;
      const response = await get(`/account/${value}/${route}`);
      t.equal(response.status, 503, `${what} is taken on /${route}, which then reads the registry, which cannot be read`);
      t.ok(read().d1 > before, 'so the database was asked');
    }
  }
  t.equal(read().fetch, 0, 'and the node was not');
});

t.test('junk around an address is refused in a market contract, in markets[] and in addresses=', async t => {
  consoleLines(t, [ 'error', 'warn', 'log' ]);
  const { get, read } = harness();

  for (const [ path, message ] of [
    [ `/market/ethereum-mainnet/${USDC}junk/summary`, `Error: Bad contract address: ${USDC}junk` ],
    [ `/market/mainnet/x${USDC}/rewards/summary`, `Error: Bad contract address: x${USDC}` ],
    [ `/market/all-networks/${USDC}junk/summary`, `Error: Bad contract address: ${USDC}junk` ],
    [ `/governance/mainnet/${COMP}junk/accounts`, `Error: Bad contract address: ${COMP}junk` ],
    [ `/account/${ACCOUNT}/transaction_history?markets[]=1_${USDC}junk`, `Invalid address ${USDC}junk` ],
    [ `/account/${ACCOUNT}/transaction_history?markets[]=1_x${USDC}`, `Invalid address x${USDC}` ],
    // comp/accounts names the address as it lowercased it
    [ `/governance/mainnet/comp/accounts?addresses=${CHECKSUMMED}junk`, `Error: address ${ACCOUNT}junk is not a valid address` ],
    [ `/governance/mainnet/comp/accounts?addresses=${ACCOUNT},${USDC}junk`, `Error: address ${USDC}junk is not a valid address` ],
    [ `/governance/mainnet/comp/accounts?addresses=${ACCOUNT},%20x${USDC}`, `Error: address x${USDC} is not a valid address` ],
  ] as const) {
    const response = await get(path);
    t.same([ response.status, await response.text() ], [ 400, message ], `${path} is refused`);
  }
  t.same(read(), { d1: 0, kv: 0, fetch: 0 }, 'before the database, KV, the node or Tally is asked anything');
});

/*
 * An address in any case is still an address in those places: it goes on to
 * the registry, or to Tally. A list of addresses may have a space after a
 * comma, as `0xA, 0xB`, which a query string can also write `0xA,+0xB`: each
 * address is taken without the space, and Tally is asked for it so.
 */
t.test('an address in any case is still taken there, and a list may have spaces after its commas', async t => {
  consoleLines(t, [ 'error', 'warn', 'log' ]);
  const { get, read } = harness();

  for (const path of [
    `/market/ethereum-mainnet/${USDC_SUMMED}/summary`,
    `/market/ethereum-mainnet/0x${USDC.slice(2).toUpperCase()}/summary`,
    `/account/${CHECKSUMMED}/transaction_history?markets[]=1_${USDC_SUMMED}`,
  ]) {
    const before   = read().d1;
    const response = await get(path);
    t.equal(response.status, 503, `${path} is taken, and reads the registry, which cannot be read`);
    t.ok(read().d1 > before, 'so the database was asked');
  }
  t.equal(read().fetch, 0, 'and the node was not');

  const ids = [ ACCOUNT, USDC ].map(address => `eip155:1:${address}`);
  const { d1, kv } = read();
  for (const addresses of [ `${CHECKSUMMED},${USDC_SUMMED}`, `${CHECKSUMMED},%20${USDC_SUMMED}`, `${CHECKSUMMED},+${USDC_SUMMED}` ]) {
    const asked    = tallyAsked.length;
    const response = await get(`/governance/mainnet/comp/accounts?addresses=${addresses}`);
    t.same([ response.status, await response.text() ], [ 200, '{"accounts":[]}' ], `addresses=${addresses} is taken`);
    t.same(tallyAsked.slice(asked), [ ids ], 'and Tally is asked for each address, in lowercase and without the space');
  }
  t.same([ read().d1 - d1, read().kv - kv ], [ 0, 0 ], 'which reads neither the database nor KV');
});
