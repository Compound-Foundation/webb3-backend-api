import type { Env } from '../../entrypoint.js';

import type { RegistrySnapshotV1, RegistryVersionRefV1, RegistryVersionRow } from '../../lib/model/comet-registry.js';

import { registryConfig } from './config.js';
import {
  readActivePointer,
  readRegistrySnapshot,
  readRetainedVersions,
  readVersion,
  snapshotChecksum,
} from './repository.js';
import type { VersionRef } from './version-headers.js';

/*
 * The snapshot cache: what every request reads the active version through,
 * and what it falls back to when D1 does not answer.
 *
 * Two facts make this safe. A version is immutable once it exists — its rows
 * are frozen and its checksum says so — and only the pointer to the active
 * one moves. So the bytes of a version are held under a key that names the
 * version and its checksum, and are never invalidated; what a request
 * verifies against D1 is the pointer alone, which is one statement.
 *
 * They are held at two levels. An isolate keeps the versions it has served
 * in memory, so a request it has answered before pays the pointer read and
 * nothing else; KV holds them for the isolates that have not, so a new one
 * pays a KV read rather than hydrating the snapshot out of D1. What KV holds
 * is served only once it is checked to be the version it is cached as.
 *
 * D1 stays authoritative. The cache never decides which version is active,
 * and it never answers in place of a D1 that said there is no active version:
 * that is an answer, not an outage. It answers only when D1 could not be
 * reached at all, and then it says so, with the age of what it served, so a
 * caller is never told an old version is the current one.
 *
 * The registry's own routes and the market routes read the active version
 * through the same entry, activeSnapshot, so they degrade the same way: a
 * database that could not be reached, with nothing within the window to fall
 * back on, is RegistryUnavailable, which every route answers with 503; one
 * that answered with a fault is raised as it is, and answered 500.
 */
type CachedSnapshot = {
  snapshot: RegistrySnapshotV1,
  // how old the pointer is, in seconds, when the answer is stale
  staleFor: number | null,
};

type CacheDeps = {
  db:      D1Database,
  kv:      KVNamespace,
  // what the environment configures; see cacheDepsOf
  ttlSeconds:   number,
  staleSeconds: number,
  now?:    () => Date,
  // a failure goes out as an error, a degradation the cache recovers from as a warning
  debug?:  {
    error: (...parameters: unknown[]) => unknown,
    warn:  (...parameters: unknown[]) => unknown,
  },
};

/*
 * A validated version named by id, as a session that pinned it reads it: the
 * reference that names its bytes, and a way to read them. The reference is
 * all a conditional request needs, so a client that already holds the bytes
 * is answered without them being read at all.
 */
type PinnedVersion = {
  ref:      VersionRef,
  snapshot: () => Promise<RegistrySnapshotV1 | null>,
};

/*
 * The registry could not be read: nothing is active, or D1 did not answer
 * and nothing within the fallback window is cached. Every route answers it
 * with 503 — after the cutover there is nothing else to answer from, and
 * silently answering from the static constants would serve markets nobody
 * reviewed or activated. The reason tells the two apart for a route that
 * answers them differently; why D1 did not answer is the cause, for the logs.
 */
type UnavailableReason = 'not_active' | 'unreadable';

class RegistryUnavailable extends Error {
  readonly reason: UnavailableReason;

  constructor(message: string, reason: UnavailableReason, cause?: unknown) {
    super(message, cause === undefined ? {} : { cause });
    this.name   = 'RegistryUnavailable';
    this.reason = reason;
  }
}

function isRegistryUnavailable(error: unknown): error is RegistryUnavailable {
  return error instanceof RegistryUnavailable;
}

/*
 * The schema the cached bytes are written in. A change to RegistrySnapshotV1
 * changes this, so entries written by an older release are never read by a
 * newer one: they are a different representation of the same version.
 */
const SCHEMA = 'v1';

const SNAPSHOT_PREFIX = 'snapshot:';

// KV refuses an expiration under a minute, and a cache that short would not be one
const MIN_TTL_SECONDS = 60;

// how often an isolate rewrites the pointer record while D1 keeps answering
const POINTER_REFRESH_SECONDS = 300;

// about how long an isolate waits to write the pointer record again after a write that did not land
const POINTER_RETRY_SECONDS = 60;

/*
 * What the environment configures, as registryConfig reads it. The TTL is the
 * max-age public reads advertise, and the fallback window is how old an
 * answer may be when D1 cannot be reached; zero switches the fallback off,
 * which is what an environment that would rather fail than serve an older
 * version sets. A value neither takes is answered with its default, and the
 * status names it.
 */
function cacheDepsOf(env: Env, debug?: CacheDeps['debug']): CacheDeps {
  const { snapshotTtlSeconds, staleFallbackSeconds } = registryConfig(env);
  return {
    db:           env.APP_DB,
    kv:           env.kv_registry,
    ttlSeconds:   snapshotTtlSeconds,
    staleSeconds: staleFallbackSeconds,
    ...(debug === undefined ? {} : { debug }),
  };
}

function snapshotKey({ id, checksum }: VersionRef): string {
  return `${SNAPSHOT_PREFIX}${SCHEMA}:${id}:${checksum}`;
}

/*
 * The pointer as it was last read successfully. It exists only for the
 * outage path: it is what tells a request which version to look for when D1
 * cannot be asked, what that version's bytes must be checked against, and
 * when that pointer was true.
 */
const POINTER_KEY = `active:${SCHEMA}`;

type PointerRecord = RegistryVersionRefV1 & { at: string };

function now(deps: CacheDeps): Date {
  return deps.now?.() ?? new Date();
}

function refOf({ id, checksum }: VersionRef): string {
  return `${id}:${checksum}`;
}

// a version as its row names it, which is what its cached bytes are checked against
function referenceOf(version: RegistryVersionRow, checksum: string): RegistryVersionRefV1 {
  return {
    id:               version.id,
    sourceRepository: version.source_repository,
    sourceCommitSha:  version.source_commit_sha,
    checksum,
  };
}

/*
 * The versions this isolate holds in memory, per database binding. A version
 * read once is answered from here for as long as the isolate lives: a hot
 * isolate pays the pointer read and nothing else, where reading KV would
 * fetch, check and parse the whole snapshot on every request. The database
 * binding is part of the key, because a version id identifies a version of
 * one registry, not of every database an isolate might hold.
 *
 * The version the pointer named last has a place of its own. Every public
 * read and every market route wants it, while the versions sessions pinned
 * are read by id on an anonymous route: in one shared set, a client reading a
 * few old versions would push the active one out, and every request after it
 * would read KV and build its catalog again. The pinned versions share the
 * other places, the one read last kept longest.
 */
type Held = {
  active: { ref: string, snapshot: RegistrySnapshotV1 } | null,
  pinned: Map<string, RegistrySnapshotV1>,
};

const held = new WeakMap<D1Database, Held>();

// how many of the versions sessions pinned an isolate keeps, besides the active one
const PINNED_VERSIONS = 4;

// which place a read holds a version in
type Slot = 'active' | 'pinned';

function heldSnapshot(deps: CacheDeps, pointer: VersionRef): RegistrySnapshotV1 | null {
  const versions = held.get(deps.db);
  if (versions === undefined) {
    return null;
  }
  const ref = refOf(pointer);
  return versions.active?.ref === ref ? versions.active.snapshot : versions.pinned.get(ref) ?? null;
}

// found by its id alone
function heldVersion(deps: CacheDeps, versionId: string): RegistrySnapshotV1 | null {
  const versions = held.get(deps.db);
  if (versions === undefined) {
    return null;
  }
  return [ versions.active?.snapshot, ...versions.pinned.values() ]
    .find(snapshot => snapshot?.registryVersion.id === versionId) ?? null;
}

function pin(versions: Held, ref: string, snapshot: RegistrySnapshotV1): void {
  versions.pinned.delete(ref);
  versions.pinned.set(ref, snapshot);
  for (const oldest of versions.pinned.keys()) {
    if (versions.pinned.size <= PINNED_VERSIONS) {
      break;
    }
    versions.pinned.delete(oldest);
  }
}

/*
 * Keeps a version in memory, in the place the read that served it asks for.
 * A version that becomes the active one leaves the pinned places, and the
 * version that was active before takes one of them: the sessions that pinned
 * it are what reads it next.
 */
function hold(deps: CacheDeps, pointer: VersionRef, snapshot: RegistrySnapshotV1, slot: Slot): void {
  let versions = held.get(deps.db);
  if (versions === undefined) {
    versions = { active: null, pinned: new Map() };
    held.set(deps.db, versions);
  }
  const ref = refOf(pointer);
  if (slot === 'pinned') {
    if (versions.active?.ref !== ref) {
      pin(versions, ref, snapshot);
    }
    return;
  }
  const before = versions.active;
  versions.active = { ref, snapshot };
  versions.pinned.delete(ref);
  if (before !== null && before.ref !== ref) {
    pin(versions, before.ref, before.snapshot);
  }
}

/*
 * The snapshot some bytes hold, if they are the version they are cached as,
 * built from the parts of them that were checked and from nothing else.
 *
 * What names the version — its id, the source it was imported from, and the
 * checksum validation recorded — must be what its row says, as D1 or, during
 * an outage, the pointer record names it. The networks are checked against
 * that checksum, computed the way validation computed it. An entry edited by
 * hand, cut short, or written in another shape is not the version, and would
 * be served under that version's genuine checksum; content that cannot even
 * be checksummed, such as a network whose markets are not a list, is not the
 * version either. Whatever else an entry holds is not served.
 *
 * Market ids are the one part the check cannot reach. The checksum leaves out
 * the row ids, which every import generates anew, so the ids of an entry's
 * markets are served as KV holds them.
 */
async function verified(value: unknown, version: RegistryVersionRefV1): Promise<RegistrySnapshotV1 | null> {
  const snapshot = value as RegistrySnapshotV1 | null;
  if (snapshot === null || typeof(snapshot) !== 'object' || !Array.isArray(snapshot.networks)) {
    return null;
  }
  const named = snapshot.registryVersion;
  const same  = named?.id === version.id
    && named?.sourceRepository === version.sourceRepository
    && named?.sourceCommitSha === version.sourceCommitSha
    && named?.checksum === version.checksum;
  if (!same) {
    return null;
  }
  try {
    if (await snapshotChecksum(snapshot.networks) !== version.checksum) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    schemaVersion:   1,
    registryVersion: {
      id:               version.id,
      sourceRepository: version.sourceRepository,
      sourceCommitSha:  version.sourceCommitSha,
      checksum:         version.checksum,
    },
    networks: snapshot.networks,
  };
}

async function cachedSnapshot(deps: CacheDeps, pointer: RegistryVersionRefV1): Promise<RegistrySnapshotV1 | null> {
  let value: unknown;
  try {
    value = await deps.kv.get(snapshotKey(pointer), 'json');
  } catch (error) {
    // a cache that cannot be read is a slow request, never a failed one
    deps.debug?.warn(`registry snapshot cache unreadable`, { versionId: pointer.id, error });
    return null;
  }
  if (value === null || value === undefined) {
    // an ordinary miss: D1 answers
    return null;
  }

  const snapshot = await verified(value, pointer);
  if (snapshot === null) {
    /*
     * Something is under the key that is not the version it names. D1
     * answers instead, and the bytes it hydrates are written over the entry.
     */
    deps.debug?.warn(`registry snapshot cache entry refused: it is not the version it is cached as`, { versionId: pointer.id });
  }
  return snapshot;
}

/*
 * The bytes of a version this isolate or KV already holds, verified once:
 * what KV answers is kept in memory, so the next request of this isolate
 * reads neither.
 */
async function storedSnapshot(
  deps: CacheDeps,
  pointer: RegistryVersionRefV1,
  slot: Slot,
): Promise<RegistrySnapshotV1 | null> {
  const inMemory = heldSnapshot(deps, pointer);
  if (inMemory !== null) {
    hold(deps, pointer, inMemory, slot);
    return inMemory;
  }
  const cached = await cachedSnapshot(deps, pointer);
  if (cached === null) {
    return null;
  }
  hold(deps, pointer, cached, slot);
  return cached;
}

/*
 * Writes the bytes of one version, for the isolates that come after.
 *
 * Entries are written once and without an expiry: the key contains the
 * checksum of the content, so an entry is never wrong, only unwanted, and the
 * scheduled job removes the unwanted ones (pruneSnapshots). An expiry would
 * take the bytes of a version that stays active from under the fallback that
 * names them, and renewing it would have a write ride on reads.
 *
 * Only bytes that verify are written. A version validated by a release that
 * hydrated another shape does not match its own checksum when this release
 * hydrates it: caching those bytes would only have every other isolate read
 * them, refuse them and hydrate the version again. Such a version is served
 * from D1 and then from memory, and the log says so once per isolate; a new
 * attempt, validated by this release, is what makes it cacheable again.
 */
async function writeSnapshot(deps: CacheDeps, pointer: RegistryVersionRefV1, snapshot: RegistrySnapshotV1): Promise<void> {
  if (await verified(snapshot, pointer) === null) {
    deps.debug?.warn(`registry snapshot not cached: this release hydrates it unlike the release that validated it`, {
      versionId: pointer.id,
    });
    return;
  }
  try {
    await deps.kv.put(snapshotKey(pointer), JSON.stringify(snapshot));
  } catch (error) {
    // the answer is already computed; failing to remember it must not fail it
    deps.debug?.warn(`registry snapshot cache unwritable`, { versionId: pointer.id, error });
  }
}

/*
 * Which version this isolate last wrote the pointer record for, or set out
 * to, and when it writes it again, per namespace.
 *
 * The record is what an outage falls back to, so it has to stay recent while
 * D1 is healthy — but writing it on every request would spend a KV write per
 * request on a value that almost never changes. An isolate therefore rewrites
 * it once a period, min(window / 2, 5 minutes) — twelve times an hour with an
 * hour's window — and at once when the pointer names another version.
 *
 * KV takes one write a second to a key, and every isolate writes this one,
 * all of them together after an activation. So a write is claimed before it
 * is made, and the requests that arrive while it is under way leave it to the
 * one making it. The claim holds for the period only once the write has
 * landed: a write KV refused, or one cut off with its request, is made again
 * about a minute later, not by the next request and not a period later. The
 * minute is spread at random between half a minute and a minute and a half,
 * so isolates refused together do not try again together.
 */
const written = new WeakMap<KVNamespace, { ref: string, due: number }>();

async function rememberPointer(deps: CacheDeps, pointer: RegistryVersionRefV1): Promise<void> {
  if (deps.staleSeconds <= 0) {
    // with no fallback window nothing ever reads this record, so nothing writes it
    return;
  }
  const at     = now(deps).getTime();
  const ref    = refOf(pointer);
  const last   = written.get(deps.kv);
  /*
   * The age of this record is what a fallback reports and what the window is
   * measured from, so a record refreshed rarely would both overstate how old
   * an answer is and cut the window short. Refreshing it every few minutes
   * keeps both within that few minutes, at one write per isolate per period.
   */
  const period = Math.min(Math.max(deps.staleSeconds, MIN_TTL_SECONDS) / 2, POINTER_REFRESH_SECONDS) * 1000;
  if (last !== undefined && last.ref === ref && at < last.due) {
    return;
  }

  const claim = { ref, due: at + Math.min(period, POINTER_RETRY_SECONDS * 1000 * (0.5 + Math.random())) };
  written.set(deps.kv, claim);
  const record: PointerRecord = { ...pointer, at: new Date(at).toISOString() };
  try {
    await deps.kv.put(POINTER_KEY, JSON.stringify(record), {
      expirationTtl: Math.max(deps.staleSeconds, MIN_TTL_SECONDS),
    });
    claim.due = at + period;
  } catch (error) {
    deps.debug?.warn(`registry pointer cache unwritable`, { versionId: pointer.id, error });
  }
}

function pointerRecordOf(value: unknown): PointerRecord | null {
  const record = value as PointerRecord | null;
  if (record === null || typeof(record) !== 'object') {
    return null;
  }
  return [ record.id, record.sourceRepository, record.sourceCommitSha, record.checksum, record.at ]
    .every(field => typeof(field) === 'string')
    ? record
    : null;
}

/*
 * Which version to fall back on when D1 did not answer: the one that was
 * active the last time it did, if that was recent enough.
 *
 * The age is carried back to the caller rather than swallowed. A response
 * built from this is explicitly an older version of the registry, and says so
 * in its headers; nothing about it may look current.
 */
async function stalePointer(deps: CacheDeps): Promise<{ pointer: RegistryVersionRefV1, staleFor: number } | null> {
  if (deps.staleSeconds <= 0) {
    return null;
  }
  let record: PointerRecord | null;
  try {
    record = pointerRecordOf(await deps.kv.get(POINTER_KEY, 'json'));
  } catch (error) {
    deps.debug?.warn(`registry pointer cache unreadable`, { error });
    return null;
  }
  if (record === null) {
    return null;
  }

  const age = (now(deps).getTime() - Date.parse(record.at)) / 1000;
  if (!Number.isFinite(age) || age < 0 || age > deps.staleSeconds) {
    return null;
  }
  const { id, sourceRepository, sourceCommitSha, checksum } = record;
  return { pointer: { id, sourceRepository, sourceCommitSha, checksum }, staleFor: Math.round(age) };
}

/*
 * Whether the database could not be reached, as opposed to having answered
 * that something is wrong.
 *
 * Only the first is what the fallback is for. A statement that names a table
 * or a column the schema does not have is a release that went out ahead of
 * its migration, and serving an hour of older data over it would hide the
 * one thing an operator has to see. Such a failure is raised, and the route
 * says so.
 */
const ANSWERED = /no such (table|column|index)|syntax error|constraint failed|not authorized|datatype mismatch/i;
/*
 * D1 not answering: what its documentation says to retry — a connection
 * lost, a request stream it could not read, an object reset or restarted, a
 * transient issue, a replica cut off — and what it puts down to load, an
 * overload or a storage operation past its timeout.
 */
const UNREACHABLE = /network connection lost|client disconnected|fetch failed|\btimed? ?out\b|connection (reset|refused|closed)|storage (error|operation)|internal error|overloaded|unavailable|code was updated|object to be reset|transient issue|replica disconnected/i;

function isUnreachable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !ANSWERED.test(message) && UNREACHABLE.test(message);
}

// a database that could not be reached is the registry being unavailable; one that answered is its own fault
function unavailableOr(error: unknown): unknown {
  return isUnreachable(error)
    ? new RegistryUnavailable(`the comet registry could not be read`, 'unreadable', error)
    : error;
}

/*
 * When this isolate last said it answers from the fallback, per database
 * binding.
 *
 * A database that cannot be reached is a failure an operator has to see, so
 * it is an error even while the fallback keeps every answer a success. It is
 * said once a minute rather than once a request: an outage the fallback
 * serves for its whole window would otherwise write a line, with the whole
 * error, for every request it answered.
 */
const reportedOutage = new WeakMap<D1Database, number>();

const REPORT_OUTAGE_EVERY_MS = 60_000;

function reportOutage(deps: CacheDeps, stale: { pointer: VersionRef, staleFor: number }, error: unknown): void {
  const at   = now(deps).getTime();
  const last = reportedOutage.get(deps.db);
  if (last !== undefined && at - last < REPORT_OUTAGE_EVERY_MS) {
    return;
  }
  reportedOutage.set(deps.db, at);
  deps.debug?.error(`registry database unreachable; answering from the version it last named`, {
    versionId: stale.pointer.id,
    staleFor:  stale.staleFor,
    error,
  });
}

/*
 * What to answer when D1 did not: the version that was active the last time
 * it did, if that was recent enough and its bytes are still held, by this
 * isolate or in KV. A database that answered with a fault is not what this
 * is for, and its failure is raised as it is.
 */
async function staleFallback(deps: CacheDeps, error: unknown): Promise<CachedSnapshot> {
  if (!isUnreachable(error)) {
    throw error;
  }
  const stale  = await stalePointer(deps);
  const stored = stale === null ? null : await storedSnapshot(deps, stale.pointer, 'active');
  if (stale === null || stored === null) {
    throw unavailableOr(error);
  }
  // served, but older than it may be: the response says so, and the log says why
  reportOutage(deps, stale, error);
  return { snapshot: stored, staleFor: stale.staleFor };
}

/*
 * Which version is active, straight from D1. This is the one read a request
 * cannot skip, and the only one a hot isolate usually pays: what a pointer
 * names never changes, so everything else can be held.
 */
async function activePointer(deps: CacheDeps): Promise<RegistryVersionRefV1 | null> {
  const pointer = await readActivePointer(deps.db);
  if (pointer !== null) {
    await rememberPointer(deps, pointer);
  }
  return pointer;
}

/*
 * The bytes of one version: from this isolate, from KV, or hydrated out of D1
 * and written to both for the requests and isolates that come after.
 *
 * `known` is the version's row, where the caller has already read it, which
 * saves hydrating it a statement.
 */
async function snapshotFor(
  deps: CacheDeps,
  pointer: RegistryVersionRefV1,
  slot: Slot,
  known?: RegistryVersionRow,
): Promise<RegistrySnapshotV1 | null> {
  const stored = await storedSnapshot(deps, pointer, slot);
  if (stored !== null) {
    return stored;
  }

  const snapshot = await readRegistrySnapshot(deps.db, pointer.id, known);
  if (snapshot === null) {
    return null;
  }
  await writeSnapshot(deps, pointer, snapshot);
  hold(deps, pointer, snapshot, slot);
  return snapshot;
}

/*
 * The active snapshot: null when the registry has no active version, which is
 * a fact and not a failure. When D1 could not be reached it is the version D1
 * last named, within the fallback window, or else RegistryUnavailable; when D1
 * answered with a fault, that fault.
 */
async function activeSnapshot(deps: CacheDeps): Promise<CachedSnapshot | null> {
  let pointer: RegistryVersionRefV1 | null;
  try {
    pointer = await activePointer(deps);
  } catch (error) {
    return staleFallback(deps, error);
  }

  if (pointer === null) {
    return null;
  }

  try {
    const snapshot = await snapshotFor(deps, pointer, 'active');
    return snapshot === null ? null : { snapshot, staleFor: null };
  } catch (error) {
    return staleFallback(deps, error);
  }
}

/*
 * A validated version by id, for a session that pinned it, or null when there
 * is no such validated version.
 *
 * A version this isolate holds is answered without asking D1: a validated
 * version never changes, nor stops being validated. Otherwise its row names
 * its bytes, and they are read the way the active version's are. A database
 * that does not answer is RegistryUnavailable: a version named by id has no
 * older answer to fall back on, only itself.
 */
async function versionSnapshot(deps: CacheDeps, versionId: string): Promise<PinnedVersion | null> {
  const holding = heldVersion(deps, versionId);
  if (holding !== null) {
    const ref = { id: versionId, checksum: holding.registryVersion.checksum };
    // read through the memory, so the version a session keeps reading is the last to go
    hold(deps, ref, holding, 'pinned');
    return { ref, snapshot: async () => holding };
  }

  let version: RegistryVersionRow | null;
  try {
    version = await readVersion(deps.db, versionId);
  } catch (error) {
    throw unavailableOr(error);
  }
  if (version === null || version.status !== 'validated' || version.snapshot_checksum === null) {
    return null;
  }

  const named = referenceOf(version, version.snapshot_checksum);
  return {
    ref:      { id: named.id, checksum: named.checksum },
    snapshot: async () => {
      try {
        return await snapshotFor(deps, named, 'pinned', version);
      } catch (error) {
        throw unavailableOr(error);
      }
    },
  };
}

// whether the bytes of a version are cached, without pulling them over the network
async function isCached(deps: CacheDeps, pointer: VersionRef): Promise<boolean> {
  const listed = await deps.kv.list({ prefix: snapshotKey(pointer) });
  return listed.keys.length > 0;
}

/*
 * What the cache holds right now, for the status an operator or a monitor
 * reads. It never pulls a snapshot body: a listing says whether the bytes are
 * there, and the pointer record is small.
 */
async function cacheStatus(deps: CacheDeps, pointer: VersionRef | null): Promise<{
  // false only when the namespace answered and the bytes were not there
  snapshotCached:    boolean,
  pointerAgeSeconds: number | null,
  // whether the namespace could be read at all; false is a fault of its own
  readable:          boolean,
}> {
  try {
    const listed = pointer === null
      ? { keys: [] as Array<{ name: string }> }
      : await deps.kv.list({ prefix: snapshotKey(pointer) });
    const record = pointerRecordOf(await deps.kv.get(POINTER_KEY, 'json'));
    const age    = record === null ? null : Math.round((now(deps).getTime() - Date.parse(record.at)) / 1000);
    return {
      snapshotCached:    listed.keys.length > 0,
      pointerAgeSeconds: age !== null && Number.isFinite(age) ? age : null,
      readable:          true,
    };
  } catch (error) {
    /*
     * The namespace itself did not answer. Reporting that as "not cached"
     * would point an operator at a harmless condition while the real one —
     * no cache at all, and so no fallback when the database next fails — went
     * unsaid.
     */
    deps.debug?.warn(`registry cache status unreadable`, { error });
    return { snapshotCached: false, pointerAgeSeconds: null, readable: false };
  }
}

/*
 * Caches the bytes of a version before it is the active one.
 *
 * Serializing a snapshot is the expensive half of answering, and after an
 * activation every isolate in every region pays it at once. A validated
 * candidate is already immutable, so its bytes can be written while nobody is
 * waiting for them, and the activation is then only a pointer move.
 *
 * It never writes the pointer record: a version warmed before its activation
 * must not become what an outage falls back to.
 */
async function warmSnapshot(deps: CacheDeps, versionId: string): Promise<VersionRef | null> {
  /*
   * One row says which bytes these would be. Hydrating the snapshot to find
   * that out would pay the cost this function exists to avoid — and a
   * version is warmed up to three times, by the import that validated it, by
   * an explicit validate, and by the activation.
   */
  const version = await readVersion(deps.db, versionId);
  if (version === null || version.snapshot_checksum === null) {
    return null;
  }
  const pointer = referenceOf(version, version.snapshot_checksum);
  /*
   * The active version's bytes are written even where a listing shows them.
   * A listing can be up to a minute behind a delete made elsewhere, and the
   * hourly prune may be removing the bytes of a version switched on after it
   * read what to keep (pruneSnapshots); KV keeps the write made last.
   */
  const active = (await readActivePointer(deps.db))?.id === versionId;
  if (!active && await isCached(deps, pointer)) {
    return pointer;
  }

  // the row is already in hand, so hydrating does not read it again
  const snapshot = await readRegistrySnapshot(deps.db, versionId, version);
  if (snapshot === null) {
    return null;
  }
  await writeSnapshot(deps, pointer, snapshot);
  return pointer;
}

// at most this many entries are removed by one run; the next one continues
const MAX_PRUNED_PER_RUN = 100;

// one page of a KV listing, as every version of the Workers types describes it
type ListedPage = { keys: Array<{ name: string }>, list_complete: boolean, cursor?: string };

/*
 * Removes from KV the bytes of versions nothing is about to serve.
 *
 * What stays is the active version, the version the pointer record names —
 * what an outage falls back to, which right after an activation is still the
 * one before — and every validated version newer than the active one, cached
 * for the activation it waits for. Everything else under the snapshot prefix
 * goes, the entries of an older schema with it. A version removed here and
 * served again, by a rollback or by a session that pinned it, is cached again
 * by the activation or by the read.
 *
 * The keys are listed before D1 is asked what to keep, so an entry written in
 * between is either not listed or already one to keep. A version switched on
 * after D1 was asked is not kept, and its activation may have written its
 * bytes before they were removed; so once the deletes are over, or one of
 * them failed, D1 is asked again, and the active version's bytes are written
 * again if the job reached them (cacheAgainIfSwitchedOn). The activation of a
 * version switched on after that writes its bytes after these deletes, and KV
 * keeps the last write (warmSnapshot). A D1 that cannot be asked first
 * removes nothing.
 */
async function pruneSnapshots(deps: CacheDeps): Promise<string[]> {
  const listed: string[] = [];
  let cursor: string | undefined;
  do {
    const page: ListedPage = await deps.kv.list(cursor === undefined
      ? { prefix: SNAPSHOT_PREFIX }
      : { prefix: SNAPSHOT_PREFIX, cursor });
    listed.push(...page.keys.map(key => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);

  const record = pointerRecordOf(await deps.kv.get(POINTER_KEY, 'json'));
  const keep   = new Set([
    ...(await readRetainedVersions(deps.db)).map(snapshotKey),
    ...(record === null ? [] : [ snapshotKey(record) ]),
  ]);

  const unwanted = listed.filter(name => !keep.has(name)).slice(0, MAX_PRUNED_PER_RUN);
  // a delete that failed may still have removed its entry, so it counts among those reached
  const reached: string[] = [];
  try {
    for (const name of unwanted) {
      reached.push(name);
      await deps.kv.delete(name);
    }
  } finally {
    await cacheAgainIfSwitchedOn(deps, reached);
  }
  return unwanted;
}

/*
 * The prune's second look at D1, once its deletes are over: the bytes of a
 * version switched on meanwhile are written again if the prune reached them.
 * It never fails the prune, whose deletes are already made. A D1 that does
 * not answer here leaves that version to its activation or its next read,
 * and the log says so.
 */
async function cacheAgainIfSwitchedOn(deps: CacheDeps, reached: string[]): Promise<void> {
  let active: RegistryVersionRefV1 | null;
  try {
    active = await readActivePointer(deps.db);
  } catch (error) {
    deps.debug?.warn(`registry snapshot not checked again after the prune`, { error });
    return;
  }
  if (active === null || !reached.includes(snapshotKey(active))) {
    return;
  }
  // logged before the write, not as its outcome: writeSnapshot warns of a write it could not make
  deps.debug?.warn(`registry snapshot switched on while the prune removed it; caching it again`, { versionId: active.id });
  try {
    await warmSnapshot(deps, active.id);
  } catch (error) {
    deps.debug?.warn(`registry snapshot not warmed`, { versionId: active.id, error });
  }
}

export type { CacheDeps, CachedSnapshot, PinnedVersion };

export {
  POINTER_KEY,
  RegistryUnavailable,
  activeSnapshot,
  cacheDepsOf,
  cacheStatus,
  isRegistryUnavailable,
  isUnreachable,
  pruneSnapshots,
  snapshotKey,
  versionSnapshot,
  warmSnapshot,
};
