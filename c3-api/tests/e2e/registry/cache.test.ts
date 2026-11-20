import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';

import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import type { CacheDeps, CachedSnapshot } from '../../../src/registry/cache.js';
import {
  POINTER_KEY,
  activeSnapshot,
  cacheStatus,
  pruneSnapshots,
  snapshotKey,
  versionSnapshot,
  warmSnapshot,
} from '../../../src/registry/cache.js';
import { CHECK_KEY } from '../../../src/registry/drift.js';
import { activateVersion, snapshotChecksum } from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { refusingKv } from '../../util/kv.js';
import { loadRegistrySnapshotFixture, seedCandidate, validateSeeded } from '../../util/registry-fixture.js';

/*
 * The snapshot cache against real local D1 and KV.
 *
 * What is tested here is the division of work: a request verifies the pointer
 * in D1 and reads everything else from the isolate's memory or from KV, a
 * version's bytes are written once and only ever trusted when they are that
 * version, and when D1 does not answer at all the last version it named is
 * served — but only within the configured window, and never in place of a D1
 * that answered "nothing is active".
 *
 * An isolate keeps what it read per database binding, so a test that wants a
 * fresh isolate reads through a binding it has not used before.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();

/*
 * The settings these tests give the cache, passed to it directly rather than
 * read from wrangler.toml: an environment may switch the fallback off, and
 * what is tested here is what the cache does with one.
 */
const TTL   = 300;
const STALE = 3600;

async function freshEnvironment(): Promise<{ db: D1Database, kv: KVNamespace }> {
  await server.reset();
  const { APP_DB, kv_registry } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return { db: APP_DB, kv: kv_registry };
}

async function activate(db: D1Database, versionId: string): Promise<void> {
  await activateVersion(db, { versionId, action: 'activate', actor: 'test-admin', reason: 'test' });
}

/*
 * A binding that records the statements it was asked to prepare, so a test
 * can say what a request read rather than how long it took. Each one is a
 * binding the cache has not seen, which is what a fresh isolate is.
 */
function counting(db: D1Database): { db: D1Database, statements: string[] } {
  const statements: string[] = [];
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'prepare' && typeof(value) === 'function') {
        return (query: string) => {
          statements.push(query);
          return (value as (query: string) => D1PreparedStatement).call(target, query);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { db: proxy as D1Database, statements };
}

function recordingWrites(kv: KVNamespace): { kv: KVNamespace, written: string[] } {
  const written: string[] = [];
  const proxy = new Proxy(kv, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'put' && typeof(value) === 'function') {
        return (...parameters: unknown[]) => {
          written.push(parameters[0] as string);
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  return { kv: proxy, written };
}

function countingReads(kv: KVNamespace): { kv: KVNamespace, reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(kv, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === 'get' || property === 'getWithMetadata') && typeof(value) === 'function') {
        return (...parameters: unknown[]) => {
          reads += 1;
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  return { kv: proxy, reads: () => reads };
}

// a namespace whose writes of `key` land only once the test releases them, so that reads arrive while one is under way
function heldWrites(kv: KVNamespace, key: string): { kv: KVNamespace, release: () => void } {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const proxy = new Proxy(kv, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'put' && typeof(value) === 'function') {
        return async (...parameters: unknown[]) => {
          if (parameters[0] === key) {
            await released;
          }
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  return { kv: proxy, release };
}

// a namespace whose first write of `key` never finishes, as a write cut off with its request
function unfinishedWrite(kv: KVNamespace, key: string): KVNamespace {
  let cut = false;
  return new Proxy(kv, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'put' && typeof(value) === 'function') {
        return (...parameters: unknown[]) => {
          if (parameters[0] === key && !cut) {
            cut = true;
            return new Promise(() => {});
          }
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
}

/*
 * Waits until each of `reads` has either set out on its write, which `writes`
 * counts, or been answered. It turns the event loop rather than a clock, so
 * what a test sees does not depend on how long anything takes.
 */
async function writingOrAnswered(reads: Array<Promise<unknown>>, writes: () => number): Promise<void> {
  let settled = 0;
  for (const read of reads) {
    read.then(() => { settled += 1; }, () => { settled += 1; });
  }
  while (writes() + settled < reads.length) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function capturedLog(): { error: unknown[], warn: unknown[], debug: NonNullable<CacheDeps['debug']> } {
  const lines = { error: [] as unknown[], warn: [] as unknown[] };
  return {
    ...lines,
    debug: {
      error: (message: unknown) => lines.error.push(message),
      warn:  (message: unknown) => lines.warn.push(message),
    },
  };
}

// D1 that cannot be reached at all, which is what the fallback exists for
function unreachable(): D1Database {
  return {
    prepare() { throw new Error(`D1_ERROR: network connection lost`); },
    batch()   { throw new Error(`D1_ERROR: network connection lost`); },
  } as unknown as D1Database;
}

function depsOf(db: D1Database, kv: KVNamespace, now?: () => Date): CacheDeps {
  return { db, kv, ttlSeconds: TTL, staleSeconds: STALE, ...(now === undefined ? {} : { now }) };
}

/*
 * What a read of the active version was answered from, told by what it read.
 * Every read asks D1 for the pointer; one that asked D1 for more hydrated the
 * version out of it, one that read KV instead was answered by the cache, and
 * one that read neither by the isolate's own memory.
 */
async function answeredFrom(
  isolate: { db: D1Database, statements: string[] },
  kv: KVNamespace,
  now?: () => Date,
): Promise<{ answer: CachedSnapshot | null, from: 'memory' | 'cache' | 'origin' }> {
  const asked   = isolate.statements.length;
  const watched = countingReads(kv);
  const answer  = await activeSnapshot(depsOf(isolate.db, watched.kv, now));
  const from    = isolate.statements.length - asked > 1 ? 'origin' : watched.reads() > 0 ? 'cache' : 'memory';
  return { answer, from };
}

async function activeFixture(): Promise<{ db: D1Database, kv: KVNamespace, versionId: string }> {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validateSeeded(db, versionId);
  await activate(db, versionId);
  return { db, kv, versionId };
}

t.test('a version is hydrated once, then read from the cache', async t => {
  const { db, kv, versionId } = await activeFixture();

  const cold = counting(db);
  const { answer: first, from: hydrated } = await answeredFrom(cold, kv);
  t.equal(hydrated, 'origin', 'the first read hydrates the version out of D1');
  t.equal(first?.snapshot.registryVersion.id, versionId);
  t.ok(cold.statements.length > 1, 'which is more than one statement');

  const checksum = first!.snapshot.registryVersion.checksum;
  t.ok(await kv.get(snapshotKey({ id: versionId, checksum })) !== null, 'the bytes are cached under version and checksum');
  t.ok(await kv.get(POINTER_KEY) !== null, 'and the pointer that named them is remembered');

  const warm = counting(db);
  const { answer: second, from: cached } = await answeredFrom(warm, kv);
  t.equal(cached, 'cache', 'another isolate reads it from KV');
  t.same(second?.snapshot, first?.snapshot, 'with the same snapshot');
  t.equal(warm.statements.length, 1, 'having read D1 once, for the pointer alone');
  t.match(warm.statements[0], /registry_state/, 'which is the pointer statement');
});

/*
 * A hot isolate answers what it has read before from memory: it pays the
 * pointer read and nothing else, where reading KV would fetch and parse the
 * whole snapshot on every request.
 */
t.test('an isolate answers a version it has read before from memory', async t => {
  const { db, kv } = await activeFixture();
  const isolate = counting(db);
  const first   = await activeSnapshot(depsOf(isolate.db, kv));

  const watched = countingReads(kv);
  isolate.statements.length = 0;
  const again = await activeSnapshot(depsOf(isolate.db, watched.kv));
  t.equal(again?.snapshot, first?.snapshot, 'the same isolate answers with the very snapshot it read');
  t.equal(isolate.statements.length, 1, 'after the pointer read');
  t.equal(watched.reads(), 0, 'and without reading KV at all');
});

/*
 * The version the pointer names has a place in memory of its own. Pinned
 * versions are read by id on an anonymous route, and however many of them a
 * client reads, the active one stays where every public read and market
 * route finds it — with the catalog built from it, which is kept for as long
 * as the snapshot is.
 */
t.test('the versions sessions pin do not push the active one out of memory', async t => {
  const { db, kv, versionId: activeId } = await activeFixture();
  const pinned: string[] = [];
  for (let attempt = 2; attempt <= 6; attempt += 1) {
    const { versionId } = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt });
    await validateSeeded(db, versionId);
    pinned.push(versionId);
  }

  const isolate = counting(db);
  const first   = await activeSnapshot(depsOf(isolate.db, kv));
  for (const versionId of pinned) {
    const version = await versionSnapshot(depsOf(isolate.db, kv), versionId);
    t.equal((await version!.snapshot())?.registryVersion.id, versionId, 'a pinned version is read');
  }

  const watched = countingReads(kv);
  const again   = await activeSnapshot(depsOf(isolate.db, watched.kv));
  t.equal(again?.snapshot, first?.snapshot, 'after more pinned versions than an isolate keeps, the active one is in memory');
  t.equal(watched.reads(), 0, 'and KV is not read');

  await activate(db, pinned[pinned.length - 1]!);
  t.equal((await answeredFrom(isolate, kv)).from, 'memory', 'a pinned version switched on is answered from memory');
  isolate.statements.length = 0;
  t.equal((await versionSnapshot(depsOf(isolate.db, kv), activeId))?.ref.id, activeId);
  t.equal(isolate.statements.length, 0, 'and the version it replaced is kept for the sessions that pinned it');
});

t.test('the bytes of a version are written once, and never again while they are served', async t => {
  const { db, kv } = await activeFixture();
  const recorded = recordingWrites(kv);
  const snapshots = () => recorded.written.filter(key => key.startsWith('snapshot:'));
  const pointers  = () => recorded.written.filter(key => key === POINTER_KEY);

  const start = Date.parse('2026-09-23T12:00:00.000Z');
  await activeSnapshot(depsOf(counting(db).db, recorded.kv, () => new Date(start)));
  t.same(recorded.written.map(key => key.split(':')[0]).sort(), [ 'active', 'snapshot' ],
    'the first read writes the snapshot and the pointer');

  /*
   * An entry is never rewritten to keep it alive: it has no expiry to renew,
   * and the scheduled job, not a request, removes what nothing serves. A read
   * from a fresh isolate long after the write finds it there and writes none
   * of it again, where an expiring entry would have had its readers rewrite
   * it every half of its life.
   */
  for (const hours of [ 1, 2, 24 ]) {
    const later = await answeredFrom(counting(db), recorded.kv, () => new Date(start + hours * 3_600_000));
    t.equal(later.from, 'cache', `${hours} hours later another isolate still reads it from KV`);
  }
  t.equal(snapshots().length, 1, 'and no read wrote the snapshot again');
  t.equal(pointers().length, 4, 'while the pointer record is written by the first read of each of the four isolates');

  const [ entry ] = (await kv.list({ prefix: 'snapshot:' })).keys;
  t.equal(entry?.expiration, undefined, 'the bytes have no expiry');
});

/*
 * Every isolate writes the pointer record, to the one key, which KV takes one
 * write a second to. An isolate writes it on its first read, then once a
 * period — five minutes with an hour's window — and at once when the pointer
 * names another version. The reads of a test share one namespace, as the
 * requests of one isolate do.
 */
t.test('an isolate writes the pointer record once a period, and at once for another version', async t => {
  const { db, kv } = await activeFixture();
  const isolate  = { db: counting(db).db, ...recordingWrites(kv) };
  const pointers = () => isolate.written.filter(key => key === POINTER_KEY).length;
  const record   = async () => await kv.get(POINTER_KEY, 'json') as { id: string, at: string } | null;
  const start    = Date.parse('2026-09-23T12:00:00.000Z');
  const readAt   = (seconds: number) => activeSnapshot(depsOf(isolate.db, isolate.kv, () => new Date(start + seconds * 1000)));

  for (const seconds of [ 0, 10, 299 ]) {
    await readAt(seconds);
  }
  t.equal(pointers(), 1, 'the reads of one period write it once');

  await readAt(300);
  t.equal(pointers(), 2, 'and the first read of the next period writes it again');
  t.equal((await record())?.at, new Date(start + 300_000).toISOString(), 'dated by that read');

  const { versionId: next } = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await validateSeeded(db, next);
  await activate(db, next);
  await readAt(301);
  t.equal(pointers(), 3, 'a read that finds another version on writes it at once');
  t.equal((await record())?.id, next, 'naming that version');
});

/*
 * After an activation, or when a deploy starts many isolates, they all write
 * the record together, and KV refuses what exceeds its one write a second. An
 * isolate whose write was refused writes again a minute or so later — at a
 * random point between half a minute and a minute and a half, so that those
 * refused together do not try again together — not on every read it answers.
 */
t.test('a pointer record KV refused is written again a minute or so later, not by every read', async t => {
  const { db, kv, versionId } = await activeFixture();
  let refusing = true;
  const isolate  = { db: counting(db).db, ...recordingWrites(refusingKv(kv, method => method === 'put' && refusing)) };
  const pointers = () => isolate.written.filter(key => key === POINTER_KEY).length;
  const log      = capturedLog();
  const start    = Date.parse('2026-09-23T12:00:00.000Z');
  const readAt   = (seconds: number) => activeSnapshot({
    ...depsOf(isolate.db, isolate.kv, () => new Date(start + seconds * 1000)),
    debug: log.debug,
  });

  for (const seconds of [ 0, 1, 10, 29 ]) {
    t.equal((await readAt(seconds))?.snapshot.registryVersion.id, versionId, `a read ${seconds} seconds in is answered`);
  }
  t.equal(pointers(), 1, 'and the write was tried once');
  t.same(log.warn.filter(line => line === 'registry pointer cache unwritable'), [ 'registry pointer cache unwritable' ],
    'which the log warns of once');
  t.same(log.error, [], 'and not as an error');

  refusing = false;
  await readAt(91);
  t.equal(pointers(), 2, 'a read a minute and a half later writes it again');
  t.equal((await kv.get(POINTER_KEY, 'json') as { at: string } | null)?.at, new Date(start + 91_000).toISOString(),
    'and the record is written');
  await readAt(92);
  t.equal(pointers(), 2, 'after which the period runs as it does for any write');
});

/*
 * A write that never finishes — its request cancelled when the client went
 * away — is as good as refused. A claim lasts the period only once its write
 * has landed, so the write is made again a minute or so later rather than a
 * period later: after an activation, the record would name the version before
 * for that long.
 */
t.test('a pointer record whose write never finished is written again a minute or so later', async t => {
  const { db, kv } = await activeFixture();
  const isolate  = { db: counting(db).db, ...recordingWrites(unfinishedWrite(kv, POINTER_KEY)) };
  const pointers = () => isolate.written.filter(key => key === POINTER_KEY).length;
  const start    = Date.parse('2026-09-23T12:00:00.000Z');
  const readAt   = (seconds: number) => activeSnapshot(depsOf(isolate.db, isolate.kv, () => new Date(start + seconds * 1000)));

  // the read whose write never finishes is never answered either
  await writingOrAnswered([ readAt(0) ], pointers);
  for (const seconds of [ 1, 10, 29 ]) {
    await readAt(seconds);
  }
  t.equal(pointers(), 1, 'the reads that come while it is under way leave the write to it');

  await readAt(91);
  t.equal(pointers(), 2, 'and a read a minute and a half later writes it again');
  t.equal((await kv.get(POINTER_KEY, 'json') as { at: string } | null)?.at, new Date(start + 91_000).toISOString(),
    'so the record is written');
});

/*
 * The reads an isolate answers at once all find the record due, and each
 * would write it while the first write is still under way. The first claims
 * it, and the others leave it to that one. The write is held until every
 * read has set out on it or been answered, whatever the timing.
 */
t.test('the reads an isolate answers together write the pointer record once', async t => {
  const { db, kv } = await activeFixture();
  const held     = heldWrites(kv, POINTER_KEY);
  const isolate  = { db: counting(db).db, ...recordingWrites(held.kv) };
  const pointers = () => isolate.written.filter(key => key === POINTER_KEY).length;
  const start    = Date.parse('2026-09-23T12:00:00.000Z');

  const reads = [ 1, 2, 3, 4, 5 ].map(() => activeSnapshot(depsOf(isolate.db, isolate.kv, () => new Date(start))));
  await writingOrAnswered(reads, pointers);
  held.release();

  const answers = await Promise.all(reads);
  t.ok(answers.every(answer => answer !== null), 'every read is answered');
  t.equal(pointers(), 1, 'and one of them writes the record');
});

t.test('a version that is not active yet can be warmed', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validateSeeded(db, versionId);

  const warmed = await warmSnapshot(depsOf(db, kv), versionId);
  t.equal(warmed?.id, versionId, 'the validated candidate is serialized');
  t.ok(await kv.get(snapshotKey(warmed!)) !== null, 'and cached');
  t.equal(await kv.get(POINTER_KEY), null, 'without becoming what an outage would fall back to');

  await activate(db, versionId);
  const first = counting(db);
  const served = await answeredFrom(first, kv);
  t.equal(served.from, 'cache', 'so the first request after the activation pays the pointer read only');
  t.equal(first.statements.length, 1);
});

/*
 * A listing can be a minute behind a delete made in another location, and
 * the hourly job may be removing the bytes of a version switched on after it
 * read what to keep. So the bytes of the version on are written whatever KV
 * lists, while a version not on yet is taken as cached when it is listed.
 */
t.test('the bytes of the version on are written whatever a listing says', async t => {
  const { db, kv, versionId } = await activeFixture();
  const { versionId: waiting } = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await validateSeeded(db, waiting);

  // a listing that names every key it is asked for, as one behind a delete may
  const behind = new Proxy(kv, {
    get(target, property, receiver) {
      if (property === 'list') {
        return async ({ prefix }: { prefix: string }) => ({ keys: [ { name: prefix } ], list_complete: true, cacheStatus: null });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  const recorded = recordingWrites(behind);

  const on = await warmSnapshot(depsOf(db, recorded.kv), versionId);
  t.ok(await kv.get(snapshotKey(on!)) !== null, 'the version on is written, though the listing names it');

  const off = await warmSnapshot(depsOf(db, recorded.kv), waiting);
  t.equal(off?.id, waiting);
  t.equal(await kv.get(snapshotKey(off!)), null, 'and a version not on yet is taken as cached');
  t.same(recorded.written, [ snapshotKey(on!) ], 'with nothing written for it');
});

t.test('when D1 does not answer, the last version it named is served, and says how old it is', async t => {
  const { db, kv, versionId } = await activeFixture();

  const activatedAt = Date.parse('2026-09-23T12:00:00.000Z');
  await activeSnapshot(depsOf(db, kv, () => new Date(activatedAt)));

  const within = await activeSnapshot(depsOf(unreachable(), kv, () => new Date(activatedAt + 600_000)));
  t.equal(within?.snapshot.registryVersion.id, versionId, 'the version D1 last named answers while D1 is unreachable');
  t.equal(within?.staleFor, 600, 'and the answer says how many seconds old it is');

  /*
   * With nothing to fall back on, the registry is unavailable, which every
   * route answers with 503 — and why is kept for the log.
   */
  const past = await activeSnapshot(depsOf(unreachable(), kv, () => new Date(activatedAt + (STALE + 60) * 1000)))
    .then(() => null, (error: unknown) => error as Error & { reason?: string });
  t.equal(past?.name, 'RegistryUnavailable', 'past the window there is no answer to give');
  t.equal(past?.reason, 'unreadable', 'because the registry could not be read');
  t.match((past?.cause as Error | undefined)?.message, /D1_ERROR/, 'and the D1 failure is its cause');

  await t.rejects(
    activeSnapshot({ ...depsOf(unreachable(), kv, () => new Date(activatedAt + 600_000)), staleSeconds: 0 }),
    { name: 'RegistryUnavailable', reason: 'unreadable' },
    'an environment that configures no window would rather fail than serve an older version',
  );

  const { kv: empty } = await freshEnvironment();
  await t.rejects(
    activeSnapshot(depsOf(unreachable(), empty, () => new Date(activatedAt + 600_000))),
    { name: 'RegistryUnavailable', reason: 'unreadable' },
    'and so does a cache that holds nothing',
  );
});

/*
 * A database that cannot be reached is an error an operator has to see, even
 * while the fallback answers every request. The log says so once a minute,
 * not once a request: an outage served for an hour would otherwise write a
 * line, with the whole error, for every request it answered.
 */
t.test('an outage the fallback answers is an error in the log, once a minute', async t => {
  const { db, kv } = await activeFixture();
  const start = Date.parse('2026-09-23T12:00:00.000Z');
  await activeSnapshot(depsOf(db, kv, () => new Date(start)));

  const lines = { error: [] as unknown[], warn: [] as unknown[] };
  const debug = {
    error: (message: unknown) => lines.error.push(message),
    warn:  (message: unknown) => lines.warn.push(message),
  };
  const down = unreachable();
  for (const seconds of [ 1, 2, 30, 59, 61, 62 ]) {
    const served = await activeSnapshot({ ...depsOf(down, kv, () => new Date(start + seconds * 1000)), debug });
    t.equal(served?.staleFor, seconds, `${seconds} seconds into the outage the request is answered, as that old`);
  }
  t.same(lines.error, [
    'registry database unreachable; answering from the version it last named',
    'registry database unreachable; answering from the version it last named',
  ], 'the log says so as an error when the outage is first met, and again once a minute has passed');
  t.same(lines.warn, [], 'and says nothing else about it');
});

t.test('a registry with nothing active is an answer, not an outage', async t => {
  const { db, kv } = await activeFixture();
  const cached = await activeSnapshot(depsOf(db, kv));
  const pointer = cached!.snapshot.registryVersion;
  const bytes   = JSON.stringify(cached!.snapshot);

  /*
   * A database with no activation, and a cache that could answer for one:
   * the reset clears both stores, so the cache is written again by hand —
   * otherwise this would assert nothing.
   */
  const empty = await freshEnvironment();
  await empty.kv.put(snapshotKey(pointer), bytes);
  await empty.kv.put(POINTER_KEY, JSON.stringify({ ...pointer, at: new Date().toISOString() }), { expirationTtl: 3600 });
  t.ok((await empty.kv.list()).keys.length >= 2, 'the cache holds a version and the pointer that named it');

  t.equal(await activeSnapshot(depsOf(empty.db, empty.kv)), null,
    'a D1 that says no version is active is believed, even with a cache that could answer');
});

t.test('the public read is served through the cache', async t => {
  const { kv, versionId } = await activeFixture();

  const response = await server.fetch('/registry/v1/active');
  t.equal(response.status, 200);
  t.equal(response.headers.get('x-registry-version'), versionId);
  t.equal(response.headers.get('x-registry-stale'), null, 'a verified answer is not stale');
  t.match(response.headers.get('cache-control') ?? '', /max-age=\d+/);

  const keys: string[] = (await kv.list()).keys.map((key: { name: string }) => key.name);
  t.ok(keys.some(name => name.startsWith('snapshot:v1:')), 'the worker cached the snapshot it served');
  t.ok(keys.includes(POINTER_KEY), 'and the pointer it verified');
});

/*
 * The headers a cross-origin client needs: which version answered, whether
 * it came from the cache because the database could not be reached, and the
 * tag a conditional request sends back.
 */
t.test('the version headers are readable by a browser', async t => {
  await activeFixture();

  const response = await server.fetch('/registry/v1/active');
  const exposed  = response.headers.get('access-control-expose-headers') ?? '';
  for (const header of [ 'ETag', 'X-Registry-Version', 'X-Registry-Checksum', 'X-Registry-Stale' ]) {
    t.match(exposed, header, `${header} is exposed to a cross-origin client`);
  }
});

/*
 * An entry is trusted for what it is, not for what it claims to be. The key
 * names the version and its checksum, and the content is checked against
 * that checksum: an entry edited by hand, or one that is not a snapshot at
 * all, would otherwise be served under the version's genuine checksum, or
 * fail in the catalog on every request of every isolate.
 */
t.test('an entry that is not the version it is cached as is refused, and replaced', async t => {
  const { db, kv } = await activeFixture();
  const first   = await activeSnapshot(depsOf(counting(db).db, kv));
  const pointer = first!.snapshot.registryVersion;

  const tampered: RegistrySnapshotV1 = structuredClone(first!.snapshot);
  tampered.networks[0]!.markets[0]!.baseAsset.token.symbol = 'TAMPERED';
  const broken = structuredClone(first!.snapshot) as unknown as { networks: Array<{ markets: unknown }> };
  broken.networks[0]!.markets = null;
  const elsewhere: RegistrySnapshotV1 = {
    ...first!.snapshot,
    registryVersion: { ...pointer, sourceRepository: 'someone-else/comet', sourceCommitSha: 'f'.repeat(40) },
  };

  for (const [ what, entry ] of [
    [ 'an edited value',         tampered ],
    [ 'a network without a list of markets', broken ],
    [ 'something that is not a snapshot', { registryVersion: pointer } ],
    [ 'the version said to come from another source', elsewhere ],
  ] as const) {
    await kv.put(snapshotKey(pointer), JSON.stringify(entry));

    const { answer: answered, from } = await answeredFrom(counting(db), kv);
    t.equal(from, 'origin', `${what} is refused, and D1 answers instead`);
    t.same(answered?.snapshot, first?.snapshot, 'with the version itself');

    const rewritten = await kv.get(snapshotKey(pointer), 'json');
    t.same(rewritten, first?.snapshot, 'and the entry is replaced by the version');
  }
});

/*
 * What is served of an entry is what was checked: the version as its row
 * names it, and the networks its checksum covers. Anything else the entry
 * holds stays in KV.
 */
t.test('only what was checked of an entry is served', async t => {
  const { db, kv } = await activeFixture();
  const first   = await activeSnapshot(depsOf(counting(db).db, kv));
  const pointer = first!.snapshot.registryVersion;

  await kv.put(snapshotKey(pointer), JSON.stringify({ ...first!.snapshot, injected: 'not part of the version' }));
  const { answer: answered, from } = await answeredFrom(counting(db), kv);
  t.equal(from, 'cache', 'an entry that holds the version is read from KV');
  t.equal((answered?.snapshot as unknown as Record<string, unknown>).injected, undefined, 'without what else it holds');
  t.same(answered?.snapshot, first?.snapshot, 'as the version itself');

  // during an outage the version is named by the pointer record, and checked against it the same way
  const record = JSON.parse(await kv.get(POINTER_KEY) ?? 'null') as Record<string, string>;
  t.same([ record.sourceRepository, record.sourceCommitSha ], [ pointer.sourceRepository, pointer.sourceCommitSha ],
    'the pointer record names the source of the version');
  const stale = await activeSnapshot(depsOf(unreachable(), kv));
  t.not(stale?.staleFor ?? null, null, 'and answered as stale');
  t.equal((stale?.snapshot as unknown as Record<string, unknown>).injected, undefined, 'and serves no more of it');
});

/*
 * The checksum a version was validated with covers its content as the
 * release that validated it hydrated it. A release that hydrates another
 * shape no longer matches it: such a version is served from D1, and then
 * from memory, but never written to KV, where every isolate would read it,
 * refuse it and hydrate it again.
 */
t.test('a version this release cannot verify is served, but not cached', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validateSeeded(db, versionId, { checksum: 'f'.repeat(64) });
  await activate(db, versionId);

  const isolate = counting(db);
  const served  = await answeredFrom(isolate, kv);
  t.equal(served.from, 'origin', 'the version is served from D1');
  t.equal(served.answer?.snapshot.registryVersion.id, versionId);
  t.equal((await kv.list({ prefix: 'snapshot:' })).keys.length, 0, 'and its bytes are not cached');
  t.equal((await answeredFrom(isolate, kv)).from, 'memory', 'while the isolate keeps them');
});

/*
 * The fallback is for a database that could not be reached. A database that
 * answered — with a table that does not exist, because a release went out
 * ahead of its migration — must not be papered over with an hour of older
 * data: that is the one failure an operator has to see.
 */
t.test('a database that answers with a fault is not masked by the cache', async t => {
  const { db, kv } = await activeFixture();
  await activeSnapshot(depsOf(db, kv));

  const faulty = {
    prepare() { throw new Error(`D1_ERROR: no such column: version.snapshot_digest`); },
    batch()   { throw new Error(`D1_ERROR: no such column: version.snapshot_digest`); },
  } as unknown as D1Database;

  await t.rejects(
    activeSnapshot(depsOf(faulty, kv)),
    { message: /no such column/ },
    'the fault is raised, with what the database actually said',
  );
  t.not((await activeSnapshot(depsOf(unreachable(), kv)))?.staleFor ?? null, null,
    'while a database that could not be reached is what the fallback is for');
});

/*
 * KV is an optimization. A namespace that does not answer, or refuses what is
 * written to it, leaves a read to D1: slower, with the same answer. What it
 * takes away is the fallback, so an outage of D1 then has nothing to be
 * answered from.
 */
t.test('a namespace that does not answer slows a read, never fails it', async t => {
  const { db, kv, versionId } = await activeFixture();

  const unwritable = capturedLog();
  const writer     = counting(db);
  const written    = await activeSnapshot({ ...depsOf(writer.db, refusingKv(kv, method => method === 'put')), debug: unwritable.debug });
  t.equal(written?.snapshot.registryVersion.id, versionId, 'a namespace that refuses writes leaves the version on served');
  t.ok(writer.statements.length > 1, 'out of D1');
  t.same(unwritable.warn, [ 'registry pointer cache unwritable', 'registry snapshot cache unwritable' ],
    'with a warning for each write it refused');
  t.same(unwritable.error, [], 'and no error');

  const unreadable = capturedLog();
  const reader     = counting(db);
  const served     = await activeSnapshot({ ...depsOf(reader.db, refusingKv(kv)), debug: unreadable.debug });
  t.same(served?.snapshot, written?.snapshot, 'a namespace that answers nothing leaves it served all the same');
  t.equal(served?.staleFor, null, 'as the version on');
  t.ok(reader.statements.length > 1, 'out of D1');
  t.same(unreadable.warn, [ 'registry pointer cache unwritable', 'registry snapshot cache unreadable', 'registry snapshot cache unwritable' ],
    'with a warning for each call it refused');
  t.same(unreadable.error, [], 'and no error');

  const pinned = await versionSnapshot(depsOf(counting(db).db, refusingKv(kv)), versionId);
  t.same(await pinned?.snapshot(), written?.snapshot, 'and a version named by id is read out of D1 too');

  // a fresh isolate's read caches the version, and the pointer record that names it
  await activeSnapshot(depsOf(counting(db).db, countingReads(kv).kv));
  t.not((await activeSnapshot(depsOf(unreachable(), kv)))?.staleFor ?? null, null,
    'with the namespace answering, an outage of D1 is answered from it');
  await t.rejects(
    activeSnapshot(depsOf(unreachable(), refusingKv(kv))),
    { name: 'RegistryUnavailable', reason: 'unreadable' },
    'while one that answers nothing leaves it nothing to be answered from',
  );

  const { versionId: waiting } = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await validateSeeded(db, waiting);
  const unlisted = refusingKv(kv, method => method === 'list');
  await t.rejects(warmSnapshot(depsOf(db, unlisted), waiting), { message: /^KV GET failed/ },
    'a warm-up that cannot list the namespace fails, which is why the router and the import catch it');
  t.equal((await warmSnapshot(depsOf(db, unlisted), versionId))?.id, versionId,
    'while the warm-up of the version on lists nothing');
});

/*
 * A version named by id is read the way the active one is: its row names its
 * bytes, and the bytes come from memory or KV before D1. Its reference alone
 * is what a conditional request needs.
 */
t.test('a pinned version is read through the cache', async t => {
  const { db, kv, versionId } = await activeFixture();
  await activeSnapshot(depsOf(counting(db).db, kv));

  const isolate = counting(db);
  const pinned  = await versionSnapshot(depsOf(isolate.db, kv), versionId);
  t.same(pinned?.ref, { id: versionId, checksum: await snapshotChecksum(snapshot.networks) }, 'its row names it');
  t.equal(isolate.statements.length, 1, 'which is one statement');
  t.equal((await pinned!.snapshot())?.registryVersion.id, versionId);
  t.equal(isolate.statements.length, 1, 'and its bytes come from KV, not from D1');

  isolate.statements.length = 0;
  const again = await versionSnapshot(depsOf(isolate.db, kv), versionId);
  t.equal(again?.ref.id, versionId, 'an isolate that holds it');
  t.equal(isolate.statements.length, 0, 'answers without asking D1: a validated version never changes');

  t.equal(await versionSnapshot(depsOf(db, kv), randomUUID()), null, 'a version that does not exist is none');
  await t.rejects(
    versionSnapshot(depsOf(unreachable(), kv), randomUUID()),
    { name: 'RegistryUnavailable', reason: 'unreadable' },
    'and a database that does not answer is the registry being unavailable',
  );
});

/*
 * Entries have no expiry, so the scheduled job removes those of versions
 * nothing is about to serve: what stays is the active version, the one the
 * pointer record names for an outage, and every validated version newer than
 * the active one, cached for its activation.
 */
t.test('the scheduled job removes the bytes nothing is about to serve', async t => {
  const { db, kv } = await freshEnvironment();
  const later = () => new Promise(resolve => setTimeout(resolve, 5));
  const seed  = async () => {
    const { versionId } = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 1 });
    await validateSeeded(db, versionId);
    await later();
    return versionId;
  };
  const older   = await seed();
  const active  = await seed();
  const waiting = await seed();
  await activate(db, active);

  for (const versionId of [ older, active, waiting ]) {
    await warmSnapshot(depsOf(db, kv), versionId);
  }
  const foreign = `snapshot:v0:${randomUUID()}:${'a'.repeat(64)}`;
  await kv.put(foreign, '{}');
  await activeSnapshot(depsOf(counting(db).db, kv));

  const checksum = await snapshotChecksum(snapshot.networks);
  const pruned   = await pruneSnapshots(depsOf(db, kv));
  t.same(pruned.sort(), [ foreign, snapshotKey({ id: older, checksum }) ].sort(),
    'an older version nothing serves and an entry of another schema are removed');

  const left: string[] = (await kv.list({ prefix: 'snapshot:' })).keys.map((key: { name: string }) => key.name).sort();
  t.same(left, [ snapshotKey({ id: active, checksum }), snapshotKey({ id: waiting, checksum }) ].sort(),
    'the active version and the one waiting for its activation stay');

  // a rollback to the pruned version caches it again when it is read
  await activate(db, older);
  t.equal((await answeredFrom(counting(db), kv)).from, 'origin', 'a version pruned and switched on again');
  t.ok(await kv.get(snapshotKey({ id: older, checksum })) !== null, 'is cached again by the first read');

  await t.rejects(pruneSnapshots(depsOf(unreachable(), kv)), /D1_ERROR/, 'and with D1 unreachable');
  t.equal((await kv.list({ prefix: 'snapshot:' })).keys.length, 3, 'nothing is removed');
});

/*
 * The job reads what to keep before it deletes. A version switched on in
 * between — a rollback to an older version — is not among what it keeps, and
 * its activation may write its bytes before the job deletes them. The job
 * asks D1 again once its deletes are over, and writes back the bytes of the
 * version on.
 *
 * Each case starts from two versions, the older one replaced by the one on,
 * both cached, with the pointer record naming the version on. `switching`
 * wraps the namespace the job is given: just before it deletes the older
 * version's bytes, the rollback to that version commits and its activation
 * warms them.
 */
async function rollbackDuringPrune(): Promise<{
  db:        D1Database,
  kv:        KVNamespace,
  older:     { id: string, checksum: string },
  switching: (namespace: KVNamespace) => KVNamespace,
  switched:  () => boolean,
}> {
  const { db, kv } = await freshEnvironment();
  const seed = async (attempt: number) => {
    const { versionId } = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt });
    await validateSeeded(db, versionId);
    return versionId;
  };
  const older = await seed(1);
  await activate(db, older);
  const active = await seed(2);
  await activate(db, active);
  for (const versionId of [ older, active ]) {
    await warmSnapshot(depsOf(db, kv), versionId);
  }
  // a fresh isolate's read, which has the pointer record name the version on
  await activeSnapshot(depsOf(counting(db).db, countingReads(kv).kv));

  const ref = { id: older, checksum: await snapshotChecksum(snapshot.networks) };
  let switched = false;
  const switching = (namespace: KVNamespace) => new Proxy(namespace, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'delete' && typeof(value) === 'function') {
        return async (name: string) => {
          if (name === snapshotKey(ref)) {
            await activateVersion(db, { versionId: older, action: 'rollback', actor: 'test-admin', reason: 'test' });
            await warmSnapshot(depsOf(db, kv), older);
            switched = true;
          }
          return (value as (name: string) => Promise<void>).call(target, name);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  return { db, kv, older: ref, switching, switched: () => switched };
}

const SWITCHED_ON = 'registry snapshot switched on while the prune removed it; caching it again';

t.test('a version switched on while the scheduled job removes its bytes is cached again', async t => {
  const { db, kv, older, switching } = await rollbackDuringPrune();

  const log    = capturedLog();
  const pruned = await pruneSnapshots({ ...depsOf(db, switching(kv)), debug: log.debug });
  t.same(pruned, [ snapshotKey(older) ], 'the job removes the bytes of the version it read as unwanted');
  t.ok(await kv.get(snapshotKey(older)) !== null, 'yet that version, switched on meanwhile, is cached');
  t.equal((await cacheStatus(depsOf(db, kv), older)).snapshotCached, true, 'as the status says');
  t.same(log.warn, [ SWITCHED_ON ], 'and the log says why');
});

/*
 * A delete the namespace refuses ends the run, and leaves what it did not
 * reach to the next hour. What it did delete is checked all the same.
 */
t.test('the bytes the job removed are checked though a later delete fails', async t => {
  const { db, kv, older, switching, switched } = await rollbackDuringPrune();
  // an entry of another schema, listed after the older version's bytes
  const foreign = `snapshot:v2:${randomUUID()}:${'a'.repeat(64)}`;
  await kv.put(foreign, '{}');
  const refused = refusingKv(kv, (method, [ name ]) => method === 'delete' && name === foreign);

  const log = capturedLog();
  await t.rejects(pruneSnapshots({ ...depsOf(db, switching(refused)), debug: log.debug }), { message: /^KV DELETE failed/ },
    'the job fails on the delete the namespace refused');
  t.ok(switched(), 'after removing the bytes of the version switched on meanwhile');
  t.ok(await kv.get(snapshotKey(older)) !== null, 'which are cached again all the same');
  t.same(log.warn, [ SWITCHED_ON ], 'as the log says');
  t.ok(await kv.get(foreign) !== null, 'while the entry it could not delete is left to the next run');
});

// KV may remove an entry and still answer its delete as failed, so that delete is checked too
t.test('the bytes of a delete that failed are checked too', async t => {
  const { db, kv, older, switching } = await rollbackDuringPrune();
  const lost = new Proxy(kv, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'delete' && typeof(value) === 'function') {
        return async (name: string) => {
          await (value as (name: string) => Promise<void>).call(target, name);
          throw new Error('KV DELETE failed: 503 Service Unavailable');
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;

  const log = capturedLog();
  await t.rejects(pruneSnapshots({ ...depsOf(db, switching(lost)), debug: log.debug }), { message: /^KV DELETE failed/ },
    'the job fails on a delete that removed its entry and answered as failed');
  t.ok(await kv.get(snapshotKey(older)) !== null, 'and caches again the bytes of the version switched on meanwhile');
  t.same(log.warn, [ SWITCHED_ON ], 'as the log says');
});

// a database that, once the rollback has switched, does not answer the statements `fails` picks
function downOnceSwitched(db: D1Database, switched: () => boolean, fails: (query: string) => boolean = () => true): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'prepare' && typeof(value) === 'function') {
        return (query: string) => {
          if (switched() && fails(query)) {
            throw new Error(`D1_ERROR: network connection lost`);
          }
          return (value as (query: string) => D1PreparedStatement).call(target, query);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as D1Database;
}

/*
 * The deletes are over when the job asks D1 again, so a database that does
 * not answer then fails that check, not the job: the job still answers with
 * what it removed. A version switched on meanwhile is left to the first read
 * that hydrates it.
 */
t.test('a database that stops answering once the job deletes leaves the job its answer', async t => {
  const { db, kv, older, switching, switched } = await rollbackDuringPrune();

  const log    = capturedLog();
  const pruned = await pruneSnapshots({ ...depsOf(downOnceSwitched(db, switched), switching(kv)), debug: log.debug });
  t.same(pruned, [ snapshotKey(older) ], 'the job answers with what it removed');
  t.same(log.warn, [ 'registry snapshot not checked again after the prune' ], 'and warns that it could not ask again');
  t.equal(await kv.get(snapshotKey(older)), null, 'so the version switched on meanwhile is not cached');

  await activeSnapshot(depsOf(counting(db).db, kv));
  t.ok(await kv.get(snapshotKey(older)) !== null, 'until a read hydrates it');
});

// D1 says which version is on, and does not answer the warm-up that would cache it again
t.test('a warm-up D1 does not answer once the job deletes leaves the job its answer', async t => {
  const { db, kv, older, switching, switched } = await rollbackDuringPrune();
  const hydrating = downOnceSwitched(db, switched, query => !/registry_state/.test(query));

  const log    = capturedLog();
  const pruned = await pruneSnapshots({ ...depsOf(hydrating, switching(kv)), debug: log.debug });
  t.same(pruned, [ snapshotKey(older) ], 'the job answers with what it removed');
  t.same(log.warn, [ SWITCHED_ON, 'registry snapshot not warmed' ], 'and warns that the bytes were not cached again');
  t.equal(await kv.get(snapshotKey(older)), null, 'as they are not');
});

/*
 * The log says the job sets out to cache the bytes again, not that it did:
 * writeSnapshot says so when the namespace refuses the write.
 */
t.test('a write the namespace refuses is not logged as the bytes cached again', async t => {
  const { db, kv, older, switching } = await rollbackDuringPrune();
  const unwritable = refusingKv(kv, method => method === 'put');

  const log = capturedLog();
  await pruneSnapshots({ ...depsOf(db, switching(unwritable)), debug: log.debug });
  t.same(log.warn, [ SWITCHED_ON, 'registry snapshot cache unwritable' ], 'the log says the job tried, and that the write was refused');
  t.equal(await kv.get(snapshotKey(older)), null, 'and the bytes are not cached');
});

/*
 * The removal runs in the hourly Cron, beside the import. Entries have no
 * expiry, so a Cron that stopped pruning would leave every version ever
 * served in KV for good.
 */
t.test('the hourly Cron prunes the cache', async t => {
  const { db, kv, versionId } = await activeFixture();
  const scheduledTime = new Date();
  /*
   * The Cron reaches out to two services, and each was asked recently: the
   * source, which discovery asks once a day, and the chain, which the version
   * on is held against once a day. A check of each recorded now keeps the
   * Cron off the network.
   */
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(scheduledTime.toISOString()).run();
  const checked = { versionId, checkedAt: scheduledTime.toISOString(), drifts: [], unreadable: [] };
  await kv.put(CHECK_KEY, JSON.stringify(checked));
  await activeSnapshot(depsOf(counting(db).db, kv));

  const checksum = await snapshotChecksum(snapshot.networks);
  const unwanted = snapshotKey({ id: randomUUID(), checksum });
  await kv.put(unwanted, '{}');

  const scheduled = await server.getWorker<Env>().scheduled({ cron: '0 * * * *', scheduledTime });
  t.equal(scheduled.outcome, 'ok', 'the Cron runs');
  t.equal(await kv.get(unwanted), null, 'and removes the bytes of a version nothing serves');
  t.ok(await kv.get(snapshotKey({ id: versionId, checksum })) !== null, 'while the active version keeps its own');
  t.same(await kv.get(CHECK_KEY, 'json'), checked, 'and leaves the chain, checked this hour, alone');
});
