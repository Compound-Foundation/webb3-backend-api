import t from 'tap';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';

import { applyMigrations } from '../../util/d1.js';

/*
 * What protects the administrative API, exercised through the worker: the
 * token, the two limiters, and the size of what a caller may send.
 *
 * The registry's admin routes can rebuild and switch what every market route
 * serves, so the interesting cases are the ones where something is refused:
 * an answer that is refused cheaply, refused before it says anything about
 * the registry, and refused the same way whatever the caller guessed.
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';

const server = createTestHarness({
  workers: [ {
    configPath: './wrangler.toml',
    secrets:    { COMET_REGISTRY_ADMIN_TOKEN_HASH: await sha256Hex(ADMIN_TOKEN) },
  } ],
});

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const auth = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

t.test('the token is what the routes are behind, and nothing else', async t => {
  await freshDatabase();

  const cases: Array<[ string, Record<string, string> | undefined ]> = [
    [ 'no header',        undefined ],
    [ 'another scheme',   { 'Authorization': `Basic ${ADMIN_TOKEN}` } ],
    [ 'an empty token',   { 'Authorization': 'Bearer ' } ],
    [ 'the token hash',   { 'Authorization': `Bearer ${await sha256Hex(ADMIN_TOKEN)}` } ],
    [ 'a prefix of it',   { 'Authorization': `Bearer ${ADMIN_TOKEN.slice(0, -1)}` } ],
    [ 'more after it',    { 'Authorization': `Bearer ${ADMIN_TOKEN} garbage` } ],
  ];
  for (const [ name, headers ] of cases) {
    const response = await server.fetch('/registry/v1/admin/status', headers === undefined ? {} : { headers });
    t.equal(response.status, 401, `${name} is refused`);
    const body = await response.json() as { error: { code: string, message: string } };
    t.equal(body.error.code, 'UNAUTHORIZED', 'with one code for every way of getting it wrong');
    t.notMatch(body.error.message, /registry-admin-token/, 'and nothing of what was presented');
  }

  t.equal((await server.fetch('/registry/v1/admin/status', { headers: auth })).status, 200,
    'the token itself is accepted');
  const spaced = { 'Authorization': `bearer   ${ADMIN_TOKEN}` };
  t.equal((await server.fetch('/registry/v1/admin/status', { headers: spaced })).status, 200,
    'and so is it after the scheme in any case and more than one space');
});

t.test('an administrative body is bounded', async t => {
  await freshDatabase();

  const oversized = JSON.stringify({ reason: 'x'.repeat(70 * 1024) });
  const response = await server.fetch('/registry/v1/admin/sync', {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    oversized,
  });
  t.equal(response.status, 413, 'a body past the limit is refused as too large, not as malformed');
  const refused = await response.json() as { error: { code: string, message: string } };
  t.equal(refused.error.code, 'PAYLOAD_TOO_LARGE');
  t.match(refused.error.message, /exceeds \d+ bytes/);

  const wrongType = await server.fetch('/registry/v1/admin/sync', {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'text/plain' },
    body:    'reason=x',
  });
  t.equal(wrongType.status, 400, 'and so is a body that is not JSON');

  /*
   * An unauthenticated oversized body is refused as an unauthenticated
   * request, not as an oversized one: the token is checked first, so nothing
   * about the routes is learned by sending garbage at them.
   */
  const anonymous = await server.fetch('/registry/v1/admin/sync', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    oversized,
  });
  t.equal(anonymous.status, 401);
});

/*
 * The limiter counts in windows of its period (60 seconds in wrangler.toml)
 * that start on the clock, and a new window starts its count over. A series
 * of requests that ran into the next one would see no refusal at all, or one
 * past the limit, so the series waits for a new window when the current one
 * has too little left to hold it: it takes a second or two.
 */
const LIMITER_PERIOD_MS = 60_000;

const windowOf = (time: number) => Math.floor(time / LIMITER_PERIOD_MS);

async function startOfWindow(): Promise<number> {
  const left = LIMITER_PERIOD_MS - Date.now() % LIMITER_PERIOD_MS;
  if (left < 10_000) {
    await new Promise(resolve => setTimeout(resolve, left + 100));
  }
  return windowOf(Date.now());
}

/*
 * The limiter is permissive abuse protection, not the concurrency authority —
 * that is the D1 sync lock. What matters here is that it is wired at all,
 * that it counts per route family, and that it answers with a code a script
 * can back off on.
 */
t.test('administrative requests are rate limited per route family', async t => {
  await freshDatabase();

  const LIMIT = 30;
  let refused: { json: () => Promise<unknown>, headers: Headers } | null = null;
  let allowed = 0;
  const window = await startOfWindow();
  for (let attempt = 0; attempt < LIMIT + 5; attempt++) {
    const response = await server.fetch('/registry/v1/admin/status', { headers: auth });
    if (response.status === 429) {
      refused = response as unknown as { json: () => Promise<unknown>, headers: Headers };
      break;
    }
    t.equal(response.status, 200);
    allowed += 1;
  }
  // every read route is one family, so the reads the status spent are another read's too
  const versions = await server.fetch('/registry/v1/admin/versions', { headers: auth });
  t.equal(windowOf(Date.now()), window, 'the requests were counted in one window of the limiter');

  t.not(refused, null, 'the limiter refuses a caller that keeps going');
  if (refused === null) {
    return;
  }
  t.ok(allowed <= LIMIT, `it allowed ${allowed} reads, which is within the configured ${LIMIT}`);
  const body = await refused.json() as { error: { code: string } };
  t.equal(body.error.code, 'RATE_LIMITED', 'with the code a script backs off on');
  t.equal(refused.headers.get('retry-after'), '60', 'and how long to back off for: the period the limiter counts in');
  t.equal(versions.status, 429, 'every read shares one budget: another read route is refused as well');

  /*
   * Reads and activations are counted separately, so a monitor polling the
   * status cannot lock an operator out of switching a version on. The
   * activation below is refused for its own reason, which is what proves the
   * limiter let it through.
   */
  const activation = await server.fetch('/registry/v1/admin/versions/00000000-0000-4000-8000-000000000000/activate', {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ reason: 'not this one' }),
  });
  t.equal(activation.status, 404, 'another family still answers, on its own merits');
});

/*
 * Every request under the administrative prefix spends from the budget of the
 * address it comes from (CF-Connecting-IP) before its token is checked: a
 * caller guessing tokens, or paths, pays for every guess, and once the budget
 * is spent a right guess from that address is refused like the others.
 * Another address has a budget of its own.
 */
t.test('administrative requests are rate limited per address, before the token is checked', async t => {
  await freshDatabase();

  const LIMIT   = 60;
  const guesser = '198.51.100.7';
  const from    = (address: string, headers: Record<string, string> = {}) => ({ headers: { 'CF-Connecting-IP': address, ...headers } });
  const bearer  = (token: string) => ({ 'Authorization': `Bearer ${token}` });

  const window   = await startOfWindow();
  const statuses = new Set<number>();
  // half the budget enumerating paths no route takes, half guessing tokens
  for (let attempt = 0; attempt < LIMIT; attempt++) {
    const response = attempt % 2 === 0
      ? await server.fetch(`/registry/v1/admin/guess-${attempt}`, from(guesser))
      : await server.fetch('/registry/v1/admin/status', from(guesser, bearer(`wrong-${attempt}`)));
    statuses.add(response.status);
  }
  t.same([ ...statuses ].sort(), [ 401, 404 ], 'the budget is spent on answers that refuse the guess');

  const over = await server.fetch('/registry/v1/admin/status', from(guesser, bearer('wrong-again')));
  t.equal(windowOf(Date.now()), window, 'the requests were counted in one window of the limiter');
  t.equal(over.status, 429, 'the next wrong token is refused as too many requests, not as a wrong token');
  t.equal(over.headers.get('retry-after'), '60', 'saying how long to back off for');
  const { error } = await over.json() as { error: { code: string, message: string } };
  t.same([ error.code, error.message ], [ 'RATE_LIMITED', 'too many administrative requests from this address' ],
    'with the code a script backs off on, naming the budget that ran out');

  t.equal((await server.fetch('/registry/v1/admin/status', from(guesser, bearer(ADMIN_TOKEN)))).status, 429,
    'the token itself is refused from that address too');
  t.equal((await server.fetch('/registry/v1/admin/guess-again', from(guesser))).status, 429,
    'and so is a path no route takes');

  t.equal((await server.fetch('/registry/v1/admin/status', from('198.51.100.8', bearer('wrong')))).status, 401,
    'another address is answered as before');
  t.equal((await server.fetch('/registry/v1/admin/status', from('198.51.100.8', bearer(ADMIN_TOKEN)))).status, 200,
    'and its operator served');
});

/*
 * An IPv6 client is given a whole /64, and can send each request from another
 * address of it. The budget is the /64's: guesses spread over the addresses
 * of one subnet are counted together, while another /64 has a budget of its
 * own.
 */
t.test('the addresses of one IPv6 /64 share one budget', async t => {
  await freshDatabase();

  const LIMIT  = 60;
  const from   = (address: string, token: string) => ({
    headers: { 'CF-Connecting-IP': address, 'Authorization': `Bearer ${token}` },
  });

  const window   = await startOfWindow();
  const statuses = new Set<number>();
  for (let attempt = 0; attempt < LIMIT; attempt++) {
    const address  = `2001:db8:1:2::${(attempt + 1).toString(16)}`;
    const response = await server.fetch('/registry/v1/admin/status', from(address, `wrong-${attempt}`));
    statuses.add(response.status);
  }
  t.same([ ...statuses ], [ 401 ], 'each guess from another address of the /64 is refused as a wrong token');

  const over = await server.fetch('/registry/v1/admin/status', from('2001:db8:1:2:ffff:ffff:ffff:ffff', ADMIN_TOKEN));
  t.equal(windowOf(Date.now()), window, 'the requests were counted in one window of the limiter');
  t.equal(over.status, 429, 'and once the /64 has spent its budget, the token itself is refused from any address of it');

  t.equal((await server.fetch('/registry/v1/admin/status', from('2001:db8:1:3::1', ADMIN_TOKEN))).status, 200,
    'while another /64 is served');
});
