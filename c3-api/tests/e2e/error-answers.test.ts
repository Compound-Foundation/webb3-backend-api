import t from 'tap';

import C3Api, { Env } from '../../entrypoint.js';

import { consoleLines } from '../util/console.js';
import { makeTestEnv } from '../util/test-env.js';

import '../../shim/node-self.js';

/*
 * What the routes outside the registry answer when a request fails, through
 * the worker's own entry point and without a network.
 *
 * A failure is answered in the envelope every route answers with, under a
 * request id the log has: a path no route matches, and an upstream API that
 * fails, which is never echoed back. A malformed parameter is the exception,
 * answered as these routes always have, with a 400 and a line of plain text,
 * and so is a path the market and governance routes take as theirs.
 */
const testEnv: Env = makeTestEnv({ MEMORY_CACHE_SEED: 'error-answers' });

const ADDRESS = '0xc3d688b66703497daa19211eedff47f25384cdc3';

type Envelope = { error: { code: string, message: string, requestId: string } };

async function get(path: string): Promise<Response> {
  return C3Api.fetch(new Request(`https://api.test.local${path}`), testEnv);
}

t.test('a path no route matches is a 404 in the envelope', async t => {
  const response = await get('/nothing/here');
  t.equal(response.status, 404);
  t.match(response.headers.get('content-type'), /^application\/json/, 'answered as JSON');
  const { error } = await response.json() as Envelope;
  t.equal(error.code, 'NOT_FOUND');
  t.match(error.requestId, /^[0-9a-f-]{36}$/, 'with a request id');
});

/*
 * A path of four segments or more is taken by the pattern of the market and
 * governance routes, /{resource}/{network}/{contract}/{endpoint}, whatever
 * its first segment, and one they do not serve is answered as a malformed
 * parameter of theirs is, as it always has been (API.md, "Errors"). A market
 * endpoint that does not exist is that before it is a testnet.
 */
t.test('a path of four segments no route matches is a 400 in plain text', async t => {
  for (const [ path, message ] of [
    [ '/nothing/here/at/all', 'Error: Bad network here' ],
    [ '/nothing/mainnet/all/summary', 'Error: Not a valid resource API' ],
    [ '/market/mainnet/all/nothing', 'Error: Not a valid market API endpoint' ],
    [ '/market/sepolia/all/nothing', 'Error: Not a valid market API endpoint' ],
    [ '/market/all-networks/all-contracts/nothing?testnets=include', 'Error: Not a valid market API endpoint' ],
    [ `/account/${ADDRESS}/rewards/more`, `Error: Bad network ${ADDRESS}` ],
  ] as const) {
    const response = await get(path);
    t.equal(response.status, 400, `${path} is refused`);
    t.equal(await response.text(), message, 'with a line of plain text');
  }
  t.equal((await get('/nothing/here/at')).status, 404, 'while a path of three segments is not found');
  t.equal((await get(`/account/${ADDRESS}/nothing`)).status, 404, 'and neither is an account path no route takes');
});

t.test('a malformed parameter of the governance accounts is a 400', async t => {
  for (const query of [ 'page_size=50', 'page_number=2', 'addresses=not-an-address' ]) {
    const response = await get(`/governance/mainnet/comp/accounts?${query}`);
    t.equal(response.status, 400, `${query} is refused, not answered as a success`);
    t.match(await response.text(), /^Error: /, 'with a line of plain text');
  }
});

/*
 * Tally answers a failure with a body of its own, which may say anything. The
 * client is told the request id and nothing else; the log has what Tally said.
 */
t.test('a Tally API that fails is a 500 that says nothing of what Tally answered', async t => {
  const logs = consoleLines(t, [ 'error', 'warn' ]);
  const fetchBefore = globalThis.fetch;
  const tally = async () => new Response(
    JSON.stringify({ errors: [ { message: 'what Tally said about it' } ] }),
    { status: 502, statusText: 'Bad Gateway' },
  );
  globalThis.fetch = tally as unknown as typeof globalThis.fetch;
  t.teardown(() => { globalThis.fetch = fetchBefore; });

  for (const query of [ '', `?addresses=${ADDRESS}` ]) {
    const response = await get(`/governance/mainnet/comp/accounts${query}`);
    t.equal(response.status, 500, `the accounts${query === '' ? '' : ' of an address'} fail`);
    const body = await response.json() as Envelope;
    t.equal(body.error.code, 'INTERNAL', 'in the envelope');
    t.notMatch(JSON.stringify(body), /Tally|what Tally said/, 'without what Tally answered');
    t.ok(logs.some(line => line.includes(body.error.requestId)), 'which the log has under the request id');
  }
  t.ok(logs.some(line => line.includes('what Tally said about it')), 'with what Tally answered');
});
