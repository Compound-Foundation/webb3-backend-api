import t, { Test } from 'tap';

import { randomUUID } from 'node:crypto';

import C3Api, { Env } from '../../../entrypoint.js';

import { consoleLines } from '../../util/console.js';
import { MemoryKv } from '../../util/kv.js';
import { ADMIN_TOKEN, adminTestEnv, failingDatabase } from '../../util/test-env.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';

import '../../../shim/node-self.js';

/*
 * What the API answers when its database fails, through the worker's own
 * entry point, on the registry's routes and the market routes alike.
 *
 * The two ways D1 fails need opposite answers. One that could not be reached
 * is an outage: a 503 a client may retry and a monitor reads as one, and
 * every route says it the same way. One that answered with a fault is a bug,
 * or a release ahead of its migrations: a 500 that tells the client nothing
 * but the request id, while the log has all of it under that id.
 */
const MAINNET = 'ethereum-mainnet';
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const UNKNOWN = '0x1111111111111111111111111111111111111111';

type Envelope = { error: { code: string, message: string, requestId: string } };

function envWith(overrides: Partial<Env>): Promise<Env> {
  return adminTestEnv({ MEMORY_CACHE_SEED: 'registry-outage', ...overrides });
}

/*
 * Without an execution context, so the request writes the records an outage
 * reads before it answers, not past the answer: what a request records is
 * there for the request after it.
 */
async function get(env: Env, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return C3Api.fetch(new Request(`https://api.test.local${path}`, { headers }), env);
}

function captureLogs(t: Test): string[] {
  return consoleLines(t, [ 'error', 'warn' ], { prefixed: true });
}

t.test('a database that cannot be reached, with nothing cached, is a 503 on every route', async t => {
  const logs = captureLogs(t);
  const env  = await envWith({ APP_DB: failingDatabase('D1_ERROR: Network connection lost.') });

  for (const path of [
    '/registry/v1/active',
    '/registry/v1/networks',
    '/registry/v1/networks/1/markets',
    `/registry/v1/networks/1/markets/${USDC}`,
    `/registry/v1/versions/${randomUUID()}`,
    `/market/${MAINNET}/${USDC}/summary`,
    `/account/${USDC}/rewards`,
  ]) {
    const response = await get(env, path);
    t.equal(response.status, 503, `${path} answers 503`);
    const { error } = await response.json() as Envelope;
    t.equal(error.code, 'UPSTREAM_UNAVAILABLE', 'saying that something it depends on did not answer');
    t.notMatch(error.message, /D1|Network connection/, 'and nothing of what the database said');
    t.ok(logs.some(line => line.includes(error.requestId)), 'which the log has under the same request id');
  }

  const status = await get(env, '/registry/v1/admin/status', { 'Authorization': `Bearer ${ADMIN_TOKEN}` });
  t.equal(status.status, 503, 'and the status a monitor polls fails as an outage, not as a bug');
  t.equal((await status.json() as Envelope).error.code, 'UPSTREAM_UNAVAILABLE');
});

t.test('a database that answers with a fault is a 500 that says nothing but the request id', async t => {
  const logs = captureLogs(t);
  const env  = await envWith({ APP_DB: failingDatabase('D1_ERROR: no such column: version.snapshot_digest: SQLITE_ERROR') });

  for (const path of [ '/registry/v1/active', `/market/${MAINNET}/${USDC}/summary` ]) {
    const response = await get(env, path);
    t.equal(response.status, 500, `${path} answers 500, not an outage`);
    const body = await response.json() as Envelope;
    t.equal(body.error.code, 'INTERNAL');
    t.notMatch(JSON.stringify(body), /no such column|SQLITE/, 'without what the database said');
    t.ok(logs.some(line => line.includes(body.error.requestId)), 'which the log has under the request id');
  }
  t.ok(logs.some(line => line.includes('no such column')), 'whole');
});

/*
 * A missing table is such a fault too. Only the token policy, deprecated
 * collateral and hidden collateral tables are answered otherwise, by the
 * routes that read them, with a 503 that names the remedy
 * (token-policy-routes, deprecated-collateral-routes,
 * hidden-collateral-routes); a registry table missing is a 500 on the active
 * reads as everywhere else.
 */
t.test('a missing table is a 500, unless it is a token policy, deprecated collateral or hidden collateral table', async t => {
  const logs = captureLogs(t);
  const env  = await envWith({ APP_DB: failingDatabase('D1_ERROR: no such table: registry_state: SQLITE_ERROR') });

  for (const path of [ '/registry/v1/active', '/registry/v1/networks/1/markets' ]) {
    const response = await get(env, path);
    t.equal(response.status, 500, `${path} answers 500, not a missing migration`);
    const body = await response.json() as Envelope;
    t.equal(body.error.code, 'INTERNAL');
    t.ok(logs.some(line => line.includes(body.error.requestId)), 'which the log has under the request id');
  }
  t.ok(logs.some(line => line.includes('no such table: registry_state')), 'whole');
});

/*
 * The fallback answers both kinds of route from the same version, and both
 * say the answer is an older one in the same headers.
 */
t.test('a database that stops answering is answered from the version it last named', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const logs = captureLogs(t);

  let reachable = true;
  const flaky = new Proxy(registry.db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === 'prepare' || property === 'batch') && typeof(value) === 'function') {
        return (...parameters: unknown[]) => {
          if (!reachable) {
            throw new Error(`D1_ERROR: Network connection lost.`);
          }
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as D1Database;
  const env = await envWith({ APP_DB: flaky, kv_registry: MemoryKv({}) });

  t.equal((await get(env, '/registry/v1/active')).status, 200, 'a read while the database answers caches the version');
  reachable = false;

  const snapshot = await get(env, '/registry/v1/active');
  t.equal(snapshot.status, 200, 'the registry route answers from the cache');
  t.equal(snapshot.headers.get('x-registry-version'), registry.versionId);
  t.match(snapshot.headers.get('x-registry-stale'), /^\d+$/, 'saying how old its answer is');
  t.equal(snapshot.headers.get('cache-control'), 'no-store', 'and that nothing may keep it');

  // a 304 would say the copy a client holds is current, which an answer the database could not confirm may not
  const etag = snapshot.headers.get('etag')!;
  for (const header of [ etag, `W/${etag}`, '*', `"v1-other-version", ${etag}` ]) {
    t.equal((await get(env, '/registry/v1/active', { 'If-None-Match': header })).status, 200,
      `a stale answer confirms nothing, not even for ${header}`);
  }

  const market = await get(env, `/market/${MAINNET}/${UNKNOWN}/summary`);
  t.equal(market.status, 400, 'a market route resolves against the same version');
  t.equal(market.headers.get('x-registry-version'), registry.versionId);
  t.match(market.headers.get('x-registry-stale'), /^\d+$/, 'and says so the same way');
  t.equal(market.headers.get('cache-control'), 'no-store');

  for (const path of [ '/registry/v1/networks/999/markets', `/registry/v1/networks/1/markets/${UNKNOWN}` ]) {
    const refused = await get(env, path);
    t.equal(refused.status, 404, `${path} is refused against the same version`);
    t.equal(refused.headers.get('x-registry-version'), registry.versionId);
    t.match(refused.headers.get('x-registry-stale'), /^\d+$/, 'and says so the same way');
    t.equal(refused.headers.get('cache-control'), 'no-store');
  }

  /*
   * Every answer is a success, so the log is what tells an operator about the
   * outage: as an error, but once a minute rather than once a request.
   */
  for (let request = 0; request < 8; request += 1) {
    t.equal((await get(env, '/registry/v1/active')).status, 200);
  }
  t.same(
    logs.filter(line => line.includes('registry database unreachable')),
    [ 'error: registry database unreachable; answering from the version it last named' ],
    'the outage is logged as an error once for the sixteen answers it was met by',
  );
});
