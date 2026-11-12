import t from 'tap';

import { randomUUID } from 'node:crypto';

import { sha256 } from '../../../lib/hash.js';
import { ROLES } from '../../../src/http/bearer-auth.js';
import type { Role } from '../../../src/http/bearer-auth.js';
import { ROUTES } from '../../../src/registry/admin-router.js';

import { registryHarness } from '../../util/registry-harness.js';
import { registryWorker } from '../../util/registry-worker.js';
import { ADMIN_TOKEN } from '../../util/test-env.js';

/*
 * What protects the administrative API, exercised through the worker: the
 * tokens and their roles, the two limiters, and the size of what a caller may
 * send.
 *
 * The registry's admin routes can rebuild and switch what every market route
 * serves, so the interesting cases are the ones where something is refused:
 * an answer that is refused cheaply, refused before it says anything about
 * the registry, and refused the same way whatever the caller guessed.
 */
// a token of the list for each role, held by somebody of that role's name
const ROLE_TOKENS: Record<Role, string> = {
  monitor:  'registry-monitor-token-for-tests',
  reader:   'registry-reader-token-for-tests',
  operator: 'registry-operator-token-for-tests',
  admin:    'registry-admin-role-token-for-tests',
};

// a holder rotating a token: the one rotated out has expired, the one rotated in has not
const ROTATED_OUT = 'registry-rotated-out-token-for-tests';
const ROTATED_IN  = 'registry-rotated-in-token-for-tests';

// an entry of a list a test gives the worker in place of the harness's, which holds the token's digest
const listed = async (name: string, token: string, role: Role, notAfter: string | null = null) =>
  ({ name, sha256: await sha256(token), role, notAfter });

/*
 * The worker lists test-admin's token, which most cases send, and
 * test-approver's (registryHarness), and beside them a token for each role,
 * under the role's name, and the two tokens of a holder rotating one.
 */
const { server, freshDatabase } = await registryHarness({ admin: true, tokens: [
  ...ROLES.map(role => ({ name: role, token: ROLE_TOKENS[role], role })),
  { name: 'rotating', token: ROTATED_OUT, role: 'operator', notAfter: '2026-01-01T00:00:00Z' },
  { name: 'rotating', token: ROTATED_IN,  role: 'operator' },
] });

const auth = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };

t.test('the token is what the routes are behind, and nothing else', async t => {
  await freshDatabase();

  const cases: Array<[ string, Record<string, string> | undefined ]> = [
    [ 'no header',        undefined ],
    [ 'another scheme',   { 'Authorization': `Basic ${ADMIN_TOKEN}` } ],
    [ 'an empty token',   { 'Authorization': 'Bearer ' } ],
    [ 'the token hash',   { 'Authorization': `Bearer ${await sha256(ADMIN_TOKEN)}` } ],
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
  const monitor  = await server.fetch('/registry/v1/admin/status', { headers: { 'Authorization': `Bearer ${ROLE_TOKENS.monitor}` } });
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
  t.equal(monitor.status, 200, 'and the budget is the token\'s: a monitor polling with a token of its own reads on');

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

/*
 * Every administrative route, with a request a token allowed on it is
 * answered for on its own merits without changing anything: an unknown id, or
 * a body refused as malformed. `role` is the least role the route takes.
 */
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

// unlike a move, an approval always names the version on it was read against
const APPROVAL = { reason: 'not this one', expectedActiveVersionId: null };

const ROUTE_TABLE: Array<{ method: string, path: string, body?: unknown, role: Role }> = [
  { method: 'POST', path: '/registry/v1/admin/sync',                                         body: { markets: 0 },                  role: 'operator' },
  { method: 'GET',  path: `/registry/v1/admin/sync-runs/${UNKNOWN}`,                                                                role: 'reader' },
  { method: 'POST', path: `/registry/v1/admin/sync-runs/${UNKNOWN}/cancel`,                  body: { reason: 'not this one' },      role: 'operator' },
  { method: 'GET',  path: '/registry/v1/admin/status',                                                                              role: 'monitor' },
  { method: 'GET',  path: '/registry/v1/admin/versions',                                                                            role: 'reader' },
  { method: 'GET',  path: `/registry/v1/admin/versions/${UNKNOWN}`,                                                                 role: 'reader' },
  { method: 'GET',  path: `/registry/v1/admin/versions/${UNKNOWN}/changes`,                                                         role: 'reader' },
  { method: 'POST', path: `/registry/v1/admin/versions/${UNKNOWN}/validate`,                 body: {},                              role: 'admin' },
  { method: 'POST', path: `/registry/v1/admin/versions/${UNKNOWN}/approve`,                  body: APPROVAL,                        role: 'admin' },
  { method: 'POST', path: `/registry/v1/admin/versions/${UNKNOWN}/activate`,                 body: { reason: 'not this one' },      role: 'admin' },
  { method: 'POST', path: `/registry/v1/admin/versions/${UNKNOWN}/rollback`,                 body: { reason: 'not this one' },      role: 'admin' },
  { method: 'PUT',  path: `/registry/v1/admin/versions/${UNKNOWN}/networks/1/overlay`,       body: { reason: 'x', overlay: {} },    role: 'operator' },
  { method: 'GET',  path: `/registry/v1/admin/versions/${UNKNOWN}/networks/1/overlay`,                                              role: 'reader' },
  { method: 'PUT',  path: `/registry/v1/admin/versions/${UNKNOWN}/markets/1/usdc/overlay`,   body: { reason: 'x', overlay: {} },    role: 'operator' },
  { method: 'GET',  path: `/registry/v1/admin/versions/${UNKNOWN}/markets/1/usdc/overlay`,                                          role: 'reader' },
  { method: 'PUT',  path: `/registry/v1/admin/versions/${UNKNOWN}/overlays`,                 body: { reason: 'x' },                 role: 'operator' },
];

// a route the router takes and the table leaves out would go untested, so the table is held to the router
t.test('the table of roles names every administrative route once', async t => {
  for (const route of ROUTES) {
    const rows = ROUTE_TABLE.filter(row => row.method === route.method && route.pattern.test(row.path));
    t.equal(rows.length, 1, `${route.method} ${route.pattern} has one row`);
  }
  for (const row of ROUTE_TABLE) {
    t.equal(ROUTES.filter(route => route.method === row.method && route.pattern.test(row.path)).length, 1,
      `${row.method} ${row.path} is a route`);
  }
});

t.test('a token reaches the routes of its role and of every role before it, and no other', async t => {
  await freshDatabase();

  for (const [ rank, role ] of ROLES.entries()) {
    // each role from an address of its own, so the address's budget is not what answers
    const address = `198.51.100.${20 + rank}`;
    for (const row of ROUTE_TABLE) {
      const response = await server.fetch(row.path, {
        method:  row.method,
        headers: {
          'Authorization':   `Bearer ${ROLE_TOKENS[role]}`,
          'CF-Connecting-IP': address,
          ...(row.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(row.body === undefined ? {} : { body: JSON.stringify(row.body) }),
      });
      const what = `${role} on ${row.method} ${row.path}`;
      // roles nest: each takes every route the roles before it take
      if (rank >= ROLES.indexOf(row.role)) {
        t.notOk([ 401, 403 ].includes(response.status), `${what} is answered on its own merits, ${response.status}`);
        continue;
      }
      t.equal(response.status, 403, `${what} is refused`);
      t.equal(response.headers.get('www-authenticate'), 'Bearer error="insufficient_scope"', 'as a token without the scope');
      const { error } = await response.json() as { error: { code: string, message: string, details: unknown } };
      t.same([ error.code, error.details ], [ 'FORBIDDEN', { role, requiredRole: row.role } ], 'saying which role it needs');
      t.equal(error.message, `the token ${role} has the role ${role}, and this route needs ${row.role}`);
    }
  }
});

/*
 * A refusal for the token is logged under the answer's request id, with whose
 * token it was — an expired one still in use may have leaked — and never the
 * token, its digest, or the fingerprint its budget is kept under.
 */
t.test('a refused token is logged by its name, and never by itself', async t => {
  await freshDatabase();
  server.clearLogs();

  const from = (token: string) => ({ headers: { 'Authorization': `Bearer ${token}`, 'CF-Connecting-IP': '198.51.100.30' } });
  const role = await server.fetch('/registry/v1/admin/versions', from(ROLE_TOKENS.monitor));
  t.equal(role.status, 403, 'a monitor reading the versions is refused');
  const expired = await server.fetch('/registry/v1/admin/status', from(ROTATED_OUT));
  t.equal(expired.status, 401, 'and so is a token past its notAfter');

  const logged = server.getLogs().map(line => line.message).join('\n');
  t.match(logged, /registry route refused/, 'both are logged as refusals');
  t.match(logged, /name: 'monitor'/, 'with the name of the token that lacked the role');
  t.match(logged, /requiredRole: 'reader'/, 'and the role the route needs');
  t.match(logged, /name: 'rotating'/, 'and the name of the token that has expired');
  for (const token of [ ROLE_TOKENS.monitor, ROTATED_OUT ]) {
    const digest = await sha256(token);
    t.notOk(logged.includes(token) || logged.includes(digest.slice(0, 16)), 'never the token, nor any of its digest');
  }
});

/*
 * Rotating a token: a holder is given a second token under the same name, and
 * the first is given a notAfter. Past it, the first is refused as expired,
 * while the second acts under the name both share.
 */
t.test('a rotated token is refused once it has expired, and its replacement acts under the same name', async t => {
  const db   = await freshDatabase();
  const from = (token: string) => ({ 'Authorization': `Bearer ${token}`, 'CF-Connecting-IP': '198.51.100.31' });

  const expired = await server.fetch('/registry/v1/admin/status', { headers: from(ROTATED_OUT) });
  t.equal(expired.status, 401, 'the token rotated out is refused');
  t.equal(expired.headers.get('www-authenticate'), 'Bearer error="invalid_token"', 'with the challenge a wrong token gets');
  const { error } = await expired.json() as { error: { message: string } };
  t.equal(error.message, 'the bearer token has expired', 'saying that it has expired');

  // a run whose lease has run out, for the token rotated in to cancel
  const runId = randomUUID();
  const past  = new Date(Date.now() - 60_000).toISOString();
  await db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, trigger_kind, requested_by, status,
       lease_owner, lease_expires_at, expected_count, started_at
     ) VALUES (?1, ?2, 'main', 'scheduled', 'registry-cron', 'running', 'stopped-invocation', ?3, 1, ?3)`
  ).bind(runId, 'a'.repeat(40), past).run();
  const cancelled = await server.fetch(`/registry/v1/admin/sync-runs/${runId}/cancel`, {
    method:  'POST',
    headers: { ...from(ROTATED_IN), 'Content-Type': 'application/json' },
    body:    JSON.stringify({ reason: 'rotated in' }),
  });
  t.equal(cancelled.status, 200, 'the token rotated in is taken');
  const { syncRun } = await cancelled.json() as { syncRun: { lastError: string } };
  t.equal(syncRun.lastError, 'cancelled by rotating: rotated in', 'and acts under the name the two share');
});

/*
 * A list the worker cannot read closes the administrative API: every token is
 * refused, those of its entries that are well formed included, until the list
 * is put again. The answer names the setting alone; the log line names the
 * entry and what is wrong with it, and nothing of its values.
 */
t.test('a list the worker cannot read closes the administrative API to every token', async t => {
  await freshDatabase();
  await server.update({ workers: [ registryWorker({
    COMET_REGISTRY_ADMIN_TOKENS: JSON.stringify([
      await listed('test-admin', ADMIN_TOKEN, 'admin'),
      await listed('monitor', ROLE_TOKENS.monitor, 'monitor'),
      { ...await listed('somebody', ROLE_TOKENS.admin, 'admin'), name: 'Somebody' },
    ]),
  }) ] });
  server.clearLogs();

  for (const [ token, what ] of [ [ ADMIN_TOKEN, 'an admin\'s token the list names' ], [ ROLE_TOKENS.monitor, 'a monitor\'s' ] ] as const) {
    const response = await server.fetch('/registry/v1/admin/status', {
      headers: { 'Authorization': `Bearer ${token}`, 'CF-Connecting-IP': '198.51.100.32' },
    });
    t.equal(response.status, 403, `${what} is refused`);
    t.equal(response.headers.get('www-authenticate'), null, 'as the environment\'s fault, asking for no other token');
    const { error } = await response.json() as { error: { code: string, message: string } };
    t.same([ error.code, error.message ], [
      'FORBIDDEN',
      'the administrative API is misconfigured in this environment: COMET_REGISTRY_ADMIN_TOKENS is malformed',
    ], 'naming the setting alone');
  }

  const logged = server.getLogs().map(line => line.message).join('\n');
  t.match(logged, /COMET_REGISTRY_ADMIN_TOKENS\[2\]\.name must be/, 'the log names the entry and what is wrong with it');
  t.notMatch(logged, /Somebody/, 'and not the value');
});

/*
 * The list is the only place a token is taken from: an environment without
 * one has no administrative API, and refuses every request as its own fault,
 * asking for no token, whatever the request sends.
 */
t.test('an environment without a list refuses every administrative request', async t => {
  await freshDatabase();
  await server.update({ workers: [ registryWorker() ] });

  for (const [ headers, what ] of [
    [ { 'Authorization': `Bearer ${ADMIN_TOKEN}` }, 'a token' ],
    [ {}, 'no token' ],
  ] as const) {
    const response = await server.fetch('/registry/v1/admin/status', { headers: { ...headers, 'CF-Connecting-IP': '198.51.100.34' } });
    t.equal(response.status, 403, `a request with ${what} is refused`);
    t.equal(response.headers.get('www-authenticate'), null, 'as the environment\'s fault, asking for no token');
    const { error } = await response.json() as { error: { code: string, message: string } };
    t.same([ error.code, error.message ], [ 'FORBIDDEN', 'the administrative API is not configured in this environment' ],
      'saying the API is not configured');
  }
});
