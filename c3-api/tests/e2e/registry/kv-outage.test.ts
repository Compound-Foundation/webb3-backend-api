import t, { Test } from 'tap';

import { randomUUID } from 'node:crypto';

import C3Api, { Env } from '../../../entrypoint.js';
import { sha256 } from '../../../lib/hash.js';
import { POINTER_KEY } from '../../../src/registry/cache.js';
import { maintainRegistryCache } from '../../../src/registry/scheduled.js';

import { MemoryKv, refusingKv } from '../../util/kv.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { seedCandidate } from '../../util/registry-fixture.js';
import { makeTestEnv } from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * What the API answers when its KV namespace does not answer, through the
 * worker's own entry point. KV is an optimization: without it every route is
 * answered out of D1, a command that committed is answered as committed, and
 * the Cron's upkeep fails nothing. The status is what says the cache is gone,
 * and with it the older version a database outage would be answered from.
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';
const MAINNET     = 'ethereum-mainnet';
const UNKNOWN     = '0x1111111111111111111111111111111111111111';

type Envelope = { error: { code: string, message: string, requestId: string } };

async function envWith(overrides: Partial<Env>): Promise<Env> {
  return makeTestEnv({
    MEMORY_CACHE_SEED:                'registry-kv-outage',
    COMET_REGISTRY_ADMIN_TOKEN_HASH:  await sha256(ADMIN_TOKEN),
    REGISTRY_ADMIN_RATE_LIMITER:      { limit: async () => ({ success: true }) },
    REGISTRY_ADMIN_AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    kv_registry:                      refusingKv(),
    ...overrides,
  });
}

async function get(env: Env, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return C3Api.fetch(new Request(`https://api.test.local${path}`, { headers }), env);
}

async function post(env: Env, path: string, body: unknown): Promise<Response> {
  return C3Api.fetch(new Request(`https://api.test.local${path}`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }), env);
}

function captureLogs(t: Test): string[] {
  const lines: string[] = [];
  const { error, warn, log } = console;
  console.error = (...parameters: unknown[]) => { lines.push(`error: ${parameters.map(String).join(' ')}`); };
  console.warn  = (...parameters: unknown[]) => { lines.push(`warn: ${parameters.map(String).join(' ')}`); };
  console.log   = (...parameters: unknown[]) => { lines.push(`log: ${parameters.map(String).join(' ')}`); };
  t.teardown(() => {
    console.error = error;
    console.warn  = warn;
    console.log   = log;
  });
  return lines;
}

t.test('a namespace that does not answer leaves every read to the database', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const logs = captureLogs(t);
  const env  = await envWith({ APP_DB: registry.db });

  const active = await get(env, '/registry/v1/active');
  t.equal(active.status, 200, 'the registry route answers');
  t.equal(active.headers.get('x-registry-version'), registry.versionId, 'with the version on');
  t.equal(active.headers.get('x-registry-stale'), null, 'as current, not as an older version');

  const market = await get(env, `/market/${MAINNET}/${UNKNOWN}/summary`);
  t.equal(market.status, 400, 'a market route resolves against the same version');
  t.equal(market.headers.get('x-registry-version'), registry.versionId);

  t.ok(logs.includes('warn: registry snapshot cache unreadable'), 'the log warns that the cache did not answer');
  t.notOk(logs.some(line => line.startsWith('error:')), 'and says nothing of it as an error');
});

/*
 * A command's warm-up reaches KV once the command has committed: a validation
 * lists the namespace for bytes it may already hold, and an activation writes
 * the bytes of the version it switched on. A command that committed must not
 * answer as if it had failed: the operator would send it again.
 */
t.test('a validation, an activation and a rollback answer as committed, though nothing could be cached', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const logs = captureLogs(t);
  const env  = await envWith({ APP_DB: registry.db });

  const { versionId: next } = await seedCandidate(registry.db, registry.snapshot, { versionId: randomUUID(), attempt: 2 });
  const validated = await post(env, `/registry/v1/admin/versions/${next}/validate`, {});
  t.equal(validated.status, 200, 'a validation answers 200');
  t.match(await validated.json(), { version: { id: next, status: 'validated' } }, 'with the version it validated');
  t.ok(logs.includes('warn: registry snapshot not warmed'), 'its warm-up, which could not list the namespace, a warning');

  const activated = await post(env, `/registry/v1/admin/versions/${next}/activate`, {
    reason: 'the namespace does not answer', expectedActiveVersionId: registry.versionId,
  });
  t.equal(activated.status, 200, 'an activation answers 200');
  t.equal(activated.headers.get('x-registry-version'), next, 'naming the version it switched on');

  const rolledBack = await post(env, `/registry/v1/admin/versions/${registry.versionId}/rollback`, {
    reason: 'the namespace does not answer', expectedActiveVersionId: next,
  });
  t.equal(rolledBack.status, 200, 'and so does a rollback');
  t.equal((await get(env, '/registry/v1/active')).headers.get('x-registry-version'), registry.versionId,
    'which the reads answer with at once');

  t.ok(logs.includes('warn: registry snapshot cache unwritable'), 'the bytes that could not be cached are a warning');
  t.notOk(logs.some(line => line.startsWith('error:')), 'not an error');
});

/*
 * An import warms the candidate it validated the way a validation does, once
 * the run has closed. The run here has no root left to import, so the sync
 * only decides its candidate, and asks nothing of GitHub or a chain.
 */
t.test('an import answers as completed, though its candidate could not be cached', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const logs = captureLogs(t);
  const env  = await envWith({ APP_DB: registry.db });

  const { versionId: candidate } = await seedCandidate(registry.db, registry.snapshot, { versionId: randomUUID(), attempt: 2 });
  await registry.db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, registry_version_id, trigger_kind, requested_by, status, started_at
     ) VALUES (?1, ?2, 'main', ?3, 'scheduled', 'registry-cron', 'running', ?4)`
  ).bind(randomUUID(), registry.snapshot.registryVersion.sourceCommitSha, candidate, new Date().toISOString()).run();

  const synced = await post(env, '/registry/v1/admin/sync', {});
  t.equal(synced.status, 200, 'the sync answers 200');
  t.match(await synced.json(), { registryVersionId: candidate, status: 'completed', outcome: 'imported' },
    'with the version it imported');
  t.ok(logs.includes('warn: registry snapshot not warmed'), 'its warm-up, which could not list the namespace, a warning');
  t.notOk(logs.some(line => line.startsWith('error:')), 'not an error');
});

t.test('the status says the namespace does not answer', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  captureLogs(t);
  const env = await envWith({ APP_DB: registry.db });

  const response = await get(env, '/registry/v1/admin/status', { 'Authorization': `Bearer ${ADMIN_TOKEN}` });
  t.equal(response.status, 200, 'the status a monitor polls answers');
  const status = await response.json() as { alerts: string[], cache: unknown };
  t.ok(status.alerts.includes('cache-unreadable'), 'naming cache-unreadable');
  t.notOk(status.alerts.includes('snapshot-not-cached'), 'rather than a version not cached, which would be harmless');
  t.same(status.cache, { snapshotCached: false, pointerAgeSeconds: null, readable: false });
});

/*
 * The fallback is read out of KV. A namespace that stops answering together
 * with the database leaves nothing to answer from, however recently both
 * answered: an outage, as when nothing was ever cached.
 */
t.test('a database that cannot be reached, with a namespace that does not answer either, is a 503', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  captureLogs(t);

  let reachable = true;
  const db = new Proxy(registry.db, {
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
  const cached = MemoryKv({});
  const env    = await envWith({ APP_DB: db, kv_registry: refusingKv(cached, () => !reachable) });

  t.equal((await get(env, '/registry/v1/active')).status, 200, 'a read while both answer');
  t.ok(await cached.get(POINTER_KEY) !== null, 'caches the pointer record');
  t.equal((await cached.list({ prefix: 'snapshot:' })).keys.length, 1, 'and the bytes of the version on');
  reachable = false;

  for (const path of [ '/registry/v1/active', `/market/${MAINNET}/${UNKNOWN}/summary` ]) {
    const response = await get(env, path);
    t.equal(response.status, 503, `${path} answers 503`);
    const { error } = await response.json() as Envelope;
    t.same([ error.code, error.message ], [ 'UPSTREAM_UNAVAILABLE', 'the comet registry could not be read' ],
      'as the registry being unavailable');
  }
});

t.test("the Cron's upkeep of a namespace that does not answer fails nothing", async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const logs = captureLogs(t);
  const env  = await envWith({ APP_DB: registry.db });

  await t.resolves(maintainRegistryCache(env), 'the prune resolves');
  t.ok(logs.includes('warn: registry cache not pruned'), 'and leaves a warning, and the prune, to the next hour');
});
