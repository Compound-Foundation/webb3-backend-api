import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';

import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { snapshotKey } from '../../../src/registry/cache.js';
import { snapshotChecksum } from '../../../src/registry/repository.js';
import { requestCatalog } from '../../../src/registry/request-catalog.js';

import { applyMigrations } from '../../util/d1.js';
import { activateSeeded, loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * What a request pays for the registry, against real local D1.
 *
 * An activated version is frozen, so every request of an isolate can be
 * served from the catalog the first one built: only the pointer to the active
 * version can move, and that is the one read a request cannot skip.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

async function environmentOf(db: D1Database): Promise<Env> {
  return { ...await server.getWorker<Env>().getEnv(), APP_DB: db };
}

t.test('the active version is built once and reused, until another one is activated', async t => {
  const db  = await freshDatabase();
  const env = await environmentOf(db);

  await t.rejects(requestCatalog(env).load(), { name: 'RegistryUnavailable' }, 'with nothing active there is nothing to serve');

  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);

  const first  = await requestCatalog(env).load();
  const second = await requestCatalog(env).load();
  t.equal(second, first, 'a later request of the same isolate is served the catalog the first one built');
  t.equal(second.versionId, versionId);

  const next = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await activateSeeded(db, next.versionId);

  const activated = await requestCatalog(env).load();
  t.not(activated, first, 'activating another version builds the catalog again');
  t.equal(activated.versionId, next.versionId, 'and the request is served the version that is on');
});

/*
 * A catalog applies the price exceptions that have not expired when it is
 * built, so an isolate keeps it only until the first of those expires: a
 * request after that is served a catalog built again, without it.
 */
t.test('a catalog is built again once an exception it applies has expired', async t => {
  const db  = await freshDatabase();
  const env = await environmentOf(db);

  // a version of the fixture whose first mainnet exception expires a few seconds from now
  const expiresAt = new Date(Date.now() + 3_000).toISOString();
  const expiring: RegistrySnapshotV1 = {
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      priceExceptions: network.priceExceptions.map((exception, index) => index !== 0 ? exception : { ...exception, expiresAt }),
    }),
  };
  const { versionId } = await seedCandidate(db, expiring);
  await activateSeeded(db, versionId);

  const applied = await requestCatalog(env).load();
  t.equal(applied.validUntil, Date.parse(expiresAt), 'a catalog that applies the exception is kept until it expires');
  t.equal(await requestCatalog(env).load(), applied, 'and until then every request is served it');

  await new Promise(resolve => setTimeout(resolve, Date.parse(expiresAt) - Date.now() + 50));
  const rebuilt = await requestCatalog(env).load();
  t.not(rebuilt, applied, 'a request after the expiry is served a catalog built again');
  t.equal(rebuilt.versionId, versionId, 'of the same version');
  t.equal(rebuilt.validUntil, null, 'which no longer applies the exception, and has nothing left to expire');
});

/*
 * An isolate keeps what it read per database binding, so what a request of a
 * hot isolate pays rests on the worker being handed the same binding with
 * every request. The tests above share one binding by construction; this one
 * asks the worker itself, twice.
 */
t.test('the worker serves the next request of an isolate from what the first one read', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);
  const { kv_registry: kv } = await server.getWorker<Env>().getEnv();

  // a market of no version: refused once the request has read the version, before any chain is asked
  const route = `/market/ethereum-mainnet/0x1111111111111111111111111111111111111111/summary`;
  t.equal((await server.fetch(route)).status, 400, 'the first request reads the version to resolve the market');
  const key = snapshotKey({ id: versionId, checksum: await snapshotChecksum(snapshot.networks) });
  t.not(await kv.get(key), null, 'and caches its bytes for the isolates that have not read it');

  /*
   * The bytes are replaced with something no request may serve. A request
   * that read them would refuse them and write the version back over them.
   */
  await kv.put(key, 'not the version');
  t.equal((await server.fetch(route)).status, 400, 'the next request resolves the market all the same');
  t.equal(await kv.get(key), 'not the version', 'without reading the bytes: its isolate held the version');
});

t.test('one request resolves everything from the version it loaded', async t => {
  const db  = await freshDatabase();
  const env = await environmentOf(db);

  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);

  const request = requestCatalog(env);
  t.equal(request.loaded(), null, 'a route that needs no registry loads none');

  const [ loaded, again ] = await Promise.all([ request.load(), request.load() ]);
  t.equal(again, loaded, 'two computations of one response read one catalog');
  t.equal(request.loaded(), loaded, 'which the response headers then name');

  const next = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await activateSeeded(db, next.versionId);
  t.equal(await request.load(), loaded, 'a version activated mid-request does not change what it answers with');
});

/*
 * The consumer path has the same fallback the registry's own reads have: a
 * market route keeps answering from the version D1 last named, and the
 * response says how old that version is.
 */
t.test('a request that cannot reach D1 is served the last version it named', async t => {
  const db  = await freshDatabase();
  const env = await environmentOf(db);

  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);

  /*
   * One binding that stops answering, rather than a second one: an isolate
   * holds what it built per database binding, so replacing the binding would
   * measure a different isolate than the one the outage happens to.
   */
  let reachable = true;
  const flaky = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === 'prepare' || property === 'batch') && typeof(value) === 'function') {
        return (...parameters: unknown[]) => {
          if (!reachable) {
            throw new Error(`D1_ERROR: network connection lost`);
          }
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as D1Database;

  const flakyEnv = { ...env, APP_DB: flaky } as Env;
  const loaded   = await requestCatalog(flakyEnv).load();
  t.equal(loaded.versionId, versionId);

  reachable = false;
  const request = requestCatalog(flakyEnv);
  const catalog = await request.load();
  t.equal(catalog.versionId, versionId, 'the version the cache holds answers the request');
  t.type(request.staleFor(), 'number', 'and the request knows the answer is an older one');
  t.equal(catalog, loaded,
    'the catalog this isolate already holds is reused: an outage is when rebuilding it is least affordable');

  const closed = requestCatalog({ ...flakyEnv, REGISTRY_STALE_FALLBACK_MAX_S: '0' } as Env);
  await t.rejects(closed.load(), { name: 'RegistryUnavailable' },
    'with no window configured the route fails rather than answering from the cache');
});

/*
 * A market route reads the active version through the same entry as the
 * registry's own routes, so it fails the way they do: nothing active, or a
 * database that did not answer with nothing to fall back on, is the registry
 * being unavailable, a 503; a database that answered with a fault is that
 * fault, which must not be dressed as an outage — a release that went out
 * ahead of its migration would otherwise look like a database that is down.
 */
t.test('a market route fails the way a registry route does', async t => {
  const db  = await freshDatabase();
  const env = await environmentOf(db);

  const inactive = await requestCatalog(env).load().then(() => null, (error: unknown) => error as Error & { reason?: string });
  t.equal(inactive?.name, 'RegistryUnavailable', 'nothing active is the registry being unavailable');
  t.equal(inactive?.reason, 'not_active', 'and says that it is nothing being active');

  const failing = (message: string) => ({
    prepare() { throw new Error(message); },
    batch()   { throw new Error(message); },
  }) as unknown as D1Database;

  const fault = await requestCatalog({ ...env, APP_DB: failing('D1_ERROR: no such table: registry_state: SQLITE_ERROR') } as Env)
    .load().then(() => null, (error: unknown) => error as Error);
  t.not(fault?.name, 'RegistryUnavailable', 'a database that answered with a fault is not an outage');
  t.match(fault?.message, /no such table/, 'it is raised as the fault it is');

  const { kv_registry } = await server.getWorker<Env>().getEnv();
  t.equal((await kv_registry.list()).keys.length, 0, 'with nothing cached to fall back on');
  const down = await requestCatalog({ ...env, APP_DB: failing('D1_ERROR: Network connection lost.') } as Env)
    .load().then(() => null, (error: unknown) => error as Error & { reason?: string });
  t.equal(down?.name, 'RegistryUnavailable', 'a database that did not answer is the registry being unavailable');
  t.equal(down?.reason, 'unreadable', 'because it could not be read');
  t.match((down?.cause as Error | undefined)?.message, /Network connection lost/, 'and why is its cause, for the log');
});
