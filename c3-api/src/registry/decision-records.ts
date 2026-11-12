import { keccak256 } from '../../lib/hash.js';
import { throttleBy } from '../../lib/throttle.js';

import type { CacheDeps } from './cache.js';
import { RegistryUnavailable, isUnreachable } from './cache.js';
import { nowOf } from './clock.js';
import { withDeadline } from './deadline.js';

/*
 * The record the Worker keeps in KV of each kind of decision a read takes on
 * every request, for an outage to answer with. A kind reads its decisions
 * from D1, and says what tells one of their subjects from another and which
 * subject an entry of its record names (RecordedKind); the rest is done here,
 * alike for every kind.
 *
 * During an outage the version is the one D1 last named (cache.ts), and the
 * decisions are the ones the Worker last recorded: every command that makes
 * a decision records them once it has committed, and every isolate checks
 * the record against the decisions it reads, and writes them where it
 * differs, whenever they are not the ones it last found there, and every few
 * minutes besides. Such an answer says it could not be confirmed, as every
 * answer from the cache does. With nothing recorded there is nothing to
 * answer with, and the read fails as one does past the fallback window.
 *
 * The records are kept in the registry's namespace beside the pointer record
 * (cache.ts), each under the key its kind names: every chain's decisions, and
 * when they were recorded. A record does not expire. Decisions do not grow
 * old, they change, and every change records them again.
 */

/*
 * A kind of decision as its record is kept: the record's key, what a log line
 * calls the kind, the member of the record that lists the subjects of its
 * decisions, its read of every chain's decisions from D1, what tells one
 * subject from another, and the subject an entry of its record names (null
 * for an entry that is not one).
 */
type RecordedKind<Subject> = {
  key:       string,
  noun:      string,
  member:    string,
  read:      (db: D1Database) => Promise<Subject[]>,
  keyOf:     (subject: Subject) => string,
  subjectOf: (entry: unknown) => Subject | null,
};

/*
 * The decisions of one kind in force: a subject nobody has decided about, or
 * one decided otherwise, is not among them.
 */
type DecisionSet<Subject> = {
  subjects: Subject[],
  // whether the decisions name the subject, by the key its kind gives it (keyOf)
  has:      (subject: Subject) => boolean,
  // what tells two sets of decisions apart
  digest:   string,
};

// the decisions a read takes, and whether they came from the record rather than from D1
type DecisionRead<Subject> = { decisions: DecisionSet<Subject>, recorded: boolean };

// what names a set of subjects by their keys, in whatever order they were listed
function digestOf(keys: string[]): string {
  return keccak256([ ...keys ].sort().join(',')).slice(0, 16);
}

function decisionSetOf<Subject>({ keyOf }: RecordedKind<Subject>, subjects: Subject[]): DecisionSet<Subject> {
  const keys = subjects.map(keyOf);
  const held = new Set(keys);
  return {
    subjects,
    has:    subject => held.has(keyOf(subject)),
    digest: digestOf(keys),
  };
}

function decisionsIn<Subject>(kind: RecordedKind<Subject>, value: unknown): DecisionSet<Subject> | null {
  const record = value as Record<string, unknown> | null;
  if (record === null || typeof(record) !== 'object' || typeof(record.at) !== 'string') {
    return null;
  }
  const entries = record[kind.member];
  if (!Array.isArray(entries)) {
    return null;
  }
  const subjects = entries.map(kind.subjectOf);
  return subjects.every((subject): subject is Subject => subject !== null) ? decisionSetOf(kind, subjects) : null;
}

async function readDecisions<Subject>(kind: RecordedKind<Subject>, db: D1Database): Promise<DecisionSet<Subject>> {
  return decisionSetOf(kind, await kind.read(db));
}

/*
 * What each isolate knows of a kind's record, per namespace and record: the
 * decisions it last found there or wrote there, or set out to, by their
 * digest; until when the reads of those decisions leave the record alone; and
 * the check under way, if one is.
 *
 * KV takes one write a second to a key, and keeps whichever write reaches it
 * last. So a read writes the record only where it does not hold the decisions
 * the read found, and the isolates of a deploy, starting together, mostly find
 * them there and write nothing; one whose write was refused tries again a
 * minute later, not on every request it answers. And a read that began before
 * a decision can write after the decision's own record, putting back the
 * decisions before it, so an isolate checks the record again every five
 * minutes while the decisions it reads stay the same: such a record is put
 * right by the first check after it.
 *
 * A check holds the record for a minute when it starts, and the five minutes
 * run only once it is done. A check the runtime cut off never finishes, and
 * so is made again a minute later, as one KV refused is.
 */
type Known = {
  digest:  string,
  // until when the reads of these decisions leave the record alone
  due:     number,
  // the check under way, which sets `due` once it is done
  pending: Promise<void> | null,
};

// kept by the record's key rather than by the kind, so that a kind made anew finds what the isolate knows of its record
const known = new WeakMap<KVNamespace, Map<string, Known>>();

function knownIn(kv: KVNamespace): Map<string, Known> {
  let records = known.get(kv);
  if (records === undefined) {
    records = new Map();
    known.set(kv, records);
  }
  return records;
}

const CHECK_RECORD_EVERY_MS = 300_000;
const RETRY_RECORD_AFTER_MS = 60_000;

function timeOf(deps: CacheDeps): number {
  return nowOf(deps.now).getTime();
}

// whether the record holds these decisions; one that cannot be read, or is not a record, does not
async function recordHolds<Subject>(kind: RecordedKind<Subject>, deps: CacheDeps, decisions: DecisionSet<Subject>): Promise<boolean> {
  let held: DecisionSet<Subject> | null;
  try {
    held = decisionsIn(kind, await deps.kv.get(kind.key, 'json'));
  } catch {
    return false;
  }
  return held !== null && held.digest === decisions.digest;
}

/*
 * Writes the decisions, unless `check` finds the record holding them already,
 * and says whether KV refused them. It never fails: the answer, or the
 * command, is already made, and failing to record it must not fail it.
 */
async function writeRecord<Subject>(
  kind: RecordedKind<Subject>,
  deps: CacheDeps,
  decisions: DecisionSet<Subject>,
  check: boolean,
): Promise<boolean> {
  try {
    if (check && await recordHolds(kind, deps, decisions)) {
      return false;
    }
    await deps.kv.put(kind.key, JSON.stringify({ at: new Date(timeOf(deps)).toISOString(), [kind.member]: decisions.subjects }));
    return false;
  } catch (error) {
    deps.debug.warn(`${kind.noun} record unwritable`, { error });
    return true;
  }
}

/*
 * Makes the record hold these decisions, then has what this isolate knows of
 * the record say so. A check that a later one replaced meanwhile settles only
 * itself, so what it found never overwrites what the later one finds.
 */
function record<Subject>(kind: RecordedKind<Subject>, deps: CacheDeps, decisions: DecisionSet<Subject>, check: boolean): Promise<void> {
  const entry: Known = { digest: decisions.digest, due: timeOf(deps) + RETRY_RECORD_AFTER_MS, pending: null };
  knownIn(deps.kv).set(kind.key, entry);
  entry.pending = writeRecord(kind, deps, decisions, check).then(refused => {
    entry.due     = timeOf(deps) + (refused ? RETRY_RECORD_AFTER_MS : CHECK_RECORD_EVERY_MS);
    entry.pending = null;
  });
  return entry.pending;
}

/*
 * Records the decisions a read found, where the record may not hold them:
 * they are not the ones this isolate last found there or wrote, which an
 * isolate that has checked nothing yet never has; or it last found or wrote
 * them five minutes ago; or KV refused them, or the runtime cut their check
 * off, a minute ago. An environment without a fallback window never answers
 * from the record, so nothing writes it there.
 *
 * The answer does not wait for the check: it is handed to the request's
 * waitUntil (`defer`), as the pointer record's write is (cache.ts).
 */
async function remember<Subject>(kind: RecordedKind<Subject>, deps: CacheDeps, decisions: DecisionSet<Subject>): Promise<void> {
  if (deps.staleSeconds <= 0) {
    return;
  }
  const last = knownIn(deps.kv).get(kind.key);
  if (last?.digest === decisions.digest && timeOf(deps) < last.due) {
    return;
  }
  const checking = record(kind, deps, decisions, true);
  if (deps.defer === undefined) {
    await checking;
  } else {
    deps.defer(checking);
  }
}

// whether `work` settles within `milliseconds`: the runtime's own time, which is what cuts work off
async function settlesWithin(work: Promise<void>, milliseconds: number): Promise<boolean> {
  return milliseconds > 0 && await withDeadline(work.then(() => true, () => true), milliseconds) === true;
}

/*
 * What a command that may have changed the decisions does once it has
 * committed: records them, as D1 now holds them, whatever this isolate found
 * in the record before, unless one of its reads is recording these very
 * decisions already. The command waits for that check while it holds the
 * record and no longer: one the runtime cut off never finishes, and the
 * command then records the decisions itself. It waits for its own write
 * rather than hand it to waitUntil, as a read hands its check: an outage
 * right after the command answers with its decision.
 *
 * It never fails the command, which has committed already; a record it could
 * not write is written by a later read (remember): of any isolate that last
 * found other decisions there, or of this one a minute later.
 */
async function recordDecisions<Subject>(kind: RecordedKind<Subject>, deps: CacheDeps): Promise<void> {
  if (deps.staleSeconds <= 0) {
    return;
  }
  let decisions: DecisionSet<Subject>;
  try {
    decisions = await readDecisions(kind, deps.db);
  } catch (error) {
    deps.debug.warn(`${kind.noun} record not written: the decisions could not be read`, { error });
    return;
  }
  const last = knownIn(deps.kv).get(kind.key);
  if (last !== undefined && last.digest === decisions.digest && last.pending !== null
    && await settlesWithin(last.pending, last.due - timeOf(deps))) {
    return;
  }
  await record(kind, deps, decisions, false);
}

/*
 * The decisions the Worker last recorded, for a read D1 could not answer. A
 * namespace that does not answer, a record that is not one, or none at all,
 * leaves the read nothing to answer with: the registry is unavailable, as it
 * is past the fallback window.
 */
async function recordedDecisions<Subject>(kind: RecordedKind<Subject>, deps: CacheDeps, cause: unknown): Promise<DecisionSet<Subject>> {
  const unavailable = () => new RegistryUnavailable(`the ${kind.noun} decisions could not be read`, cause);
  let value: unknown;
  try {
    value = await deps.kv.get(kind.key, 'json');
  } catch (error) {
    deps.debug.warn(`${kind.noun} record unreadable`, { error });
    throw unavailable();
  }
  const decisions = decisionsIn(kind, value);
  if (decisions === null) {
    throw unavailable();
  }
  return decisions;
}

/*
 * When this isolate says it answers with a kind's recorded decisions, per
 * database binding: once a minute, as the cache says it answers from an older
 * version, rather than once a request.
 */
const fallbackDue = throttleBy<D1Database>(60_000);

function reportFallback<Subject>(kind: RecordedKind<Subject>, deps: CacheDeps, error: unknown): void {
  if (!fallbackDue(deps.db, kind.key, timeOf(deps))) {
    return;
  }
  deps.debug.warn(`${kind.noun} decisions unreadable; answering with the ones last recorded`, { error });
}

/*
 * The decisions of a recorded kind, as a read takes them: every chain's, from
 * D1, or — when D1 could not be reached, in an environment that answers from
 * the cache at all — the ones last recorded. A database that answered with a
 * fault, such as a release ahead of the kind's migration, is raised as it is.
 */
async function markedDecisions<Subject>(kind: RecordedKind<Subject>, deps: CacheDeps): Promise<DecisionRead<Subject>> {
  let decisions: DecisionSet<Subject>;
  try {
    decisions = await readDecisions(kind, deps.db);
  } catch (error) {
    if (!isUnreachable(error)) {
      throw error;
    }
    if (deps.staleSeconds <= 0) {
      throw new RegistryUnavailable(`the comet registry could not be read`, error);
    }
    const last = await recordedDecisions(kind, deps, error);
    reportFallback(kind, deps, error);
    return { decisions: last, recorded: true };
  }
  await remember(kind, deps, decisions);
  return { decisions, recorded: false };
}

export type { DecisionRead, DecisionSet, RecordedKind };
export {
  decisionSetOf,
  digestOf,
  markedDecisions,
  recordDecisions,
};
