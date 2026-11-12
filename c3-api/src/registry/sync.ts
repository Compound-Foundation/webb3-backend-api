import type { DeploymentPath } from '../../lib/model/comet-registry.js';

import { Clock, ClockOption, nowOf } from './clock.js';
import { RegistryError } from './errors.js';
import type {
  RegistryVersionRow,
  SyncOutcome,
  SyncRunItemRow,
  SyncRunRow,
  SyncRunStatus,
  SyncTriggerKind,
} from './rows.js';
import { Condition, changedRows, conditioned, insertStatement } from './sql-condition.js';

/*
 * The sync fence. One registry import may run at a time, and one invocation
 * at a time may work on it: a Cron invocation can be interrupted by a deploy
 * or a timeout, so work is claimed per root and committed only by the
 * invocation that still owns the run.
 *
 * Ownership is a random owner token, new for every invocation that takes the
 * run. Taking over an expired lease replaces the owner in the same statement
 * that checks the expiry, so the invocation that was replaced names an owner
 * no row carries any more: every later write of it updates zero rows, and it
 * stops.
 */
type Fence = {
  runId: string,
  owner: string,
};

/*
 * A checkpoint needs the git object id of its roots.json: it is what the
 * candidate's source identity is computed from and what the content is
 * verified against, so the type requires it rather than defaulting it.
 */
type RootCheckpoint = DeploymentPath & { sourceBlobSha: string };

type RunInput = {
  sourceCommitSha: string,
  trackedRef:      string | null,
  triggerKind:     SyncTriggerKind,
  requestedBy:     string | null,
  reason:          string | null,
  roots:           RootCheckpoint[],
  // leave the candidate open for review once no root is left to attempt, whether or not the run gave roots up
  holdForReview?:  boolean,
};

type LeaseOptions = ClockOption & {
  leaseSeconds: number,
};

// an item that keeps failing is left for an operator rather than retried forever
const MAX_ITEM_ATTEMPTS = 5;

/*
 * A root still to attempt: not imported, and with attempts left. A root that
 * exhausted its attempts is no longer work, though its market is still
 * missing, which validation reports.
 */
const OUTSTANDING = `status <> 'completed' AND attempts < ${MAX_ITEM_ATTEMPTS}`;

function at(clock: Clock | undefined): string {
  return nowOf(clock).toISOString();
}

function expiry(clock: Clock | undefined, seconds: number): string {
  const base = nowOf(clock).getTime();
  return new Date(base + seconds * 1000).toISOString();
}

/*
 * Starts a new run and its per-root checkpoints in one transaction. The
 * partial unique index on a running status is what makes two concurrent
 * creators collide instead of both importing.
 */
async function startRun(db: D1Database, input: RunInput, options: LeaseOptions): Promise<Fence> {
  const runId     = crypto.randomUUID();
  const owner     = crypto.randomUUID();
  const timestamp = at(options.now);

  const statements = [
    db.prepare(
      `INSERT INTO sync_runs (
         id, source_commit_sha, tracked_ref, trigger_kind, requested_by, reason,
         status, lease_owner, lease_expires_at, expected_count, started_at, hold_for_review
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?9, ?10, ?11)`
    ).bind(
      runId, input.sourceCommitSha, input.trackedRef, input.triggerKind, input.requestedBy, input.reason,
      owner, expiry(options.now, options.leaseSeconds), input.roots.length, timestamp,
      input.holdForReview === true ? 1 : 0,
    ),
    ...input.roots.map(root => db.prepare(
      `INSERT INTO sync_run_items (
         id, sync_run_id, root_path, source_blob_sha,
         upstream_network_key, deployment_key, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
    ).bind(
      crypto.randomUUID(), runId, root.rootPath, root.sourceBlobSha,
      root.upstreamNetworkKey, root.deploymentKey, timestamp,
    )),
  ];

  try {
    await db.batch(statements);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: sync_runs.status')) {
      throw new RegistryError('SYNC_ALREADY_RUNNING', `a registry sync is already running`, input.sourceCommitSha);
    }
    throw error;
  }
  return { runId, owner };
}

// why a root the invocation importing it left in progress failed, as its checkpoint and its run record it
const ABANDONED = 'the invocation importing this root did not finish';

/*
 * Takes over the running job when nobody holds an unexpired lease on it. The
 * compare-and-set is one statement: expiring a lease and claiming it in two
 * steps would let two invocations both believe they own the run.
 *
 * A root still in progress when the run is taken is one whose invocation
 * stopped while importing it — a deploy, the time or the CPU a Worker is
 * given, a client that went away — or overran its lease; either way nothing
 * it would still write is accepted (checkpointHeld). That attempt failed, and
 * the same transaction says so, as a failure committed by the invocation
 * would have: the root is failed with why, the run carries the error, and a
 * root that has spent its last attempt counts among the run's failed roots.
 * Left in progress, a root whose invocations kept stopping would be retried
 * with nothing recorded, and once out of attempts it would be neither
 * outstanding nor failed.
 */
async function acquireRun(db: D1Database, options: LeaseOptions): Promise<Fence | null> {
  const owner     = crypto.randomUUID();
  const timestamp = at(options.now);
  // the run this batch has just given to `owner`, which no other run can be
  const taken     = `SELECT id FROM sync_runs WHERE status = 'running' AND lease_owner = ?1`;

  const [ claimed ] = await db.batch([
    db.prepare(
      `UPDATE sync_runs
       SET lease_owner = ?1, lease_expires_at = ?2
       WHERE id = (
         SELECT id FROM sync_runs
         WHERE status = 'running' AND (lease_owner IS NULL OR lease_expires_at <= ?3)
         LIMIT 1
       )
       RETURNING id`
    ).bind(owner, expiry(options.now, options.leaseSeconds), timestamp),
    // the counter first, while the roots it counts are still in progress
    db.prepare(
      `UPDATE sync_runs
       SET failed_count = failed_count + (
             SELECT COUNT(*) FROM sync_run_items
             WHERE sync_run_id = sync_runs.id AND status = 'processing' AND attempts >= ${MAX_ITEM_ATTEMPTS}
           ),
           last_error = ?2
       WHERE id = (${taken})
         AND EXISTS (SELECT 1 FROM sync_run_items WHERE sync_run_id = sync_runs.id AND status = 'processing')`
    ).bind(owner, ABANDONED),
    db.prepare(
      `UPDATE sync_run_items SET status = 'failed', last_error = ?2, updated_at = ?3
       WHERE sync_run_id = (${taken}) AND status = 'processing'`
    ).bind(owner, ABANDONED, timestamp),
  ]);

  const [ run ] = (claimed?.results ?? []) as Array<{ id: string }>;
  return run === undefined ? null : { runId: run.id, owner };
}

/*
 * Releases the lease without finishing the run, so the next invocation can
 * continue immediately instead of waiting for the lease to expire. `error`
 * is why the invocation stopped, where that is the run's to report, and
 * replaces the run's error under the same fence.
 */
async function releaseLease(db: D1Database, fence: Fence, options: { error?: string } = {}): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sync_runs SET lease_owner = NULL, lease_expires_at = NULL, last_error = COALESCE(?3, last_error)
     WHERE id = ?1 AND status = 'running' AND lease_owner = ?2`
  ).bind(fence.runId, fence.owner, options.error ?? null).run();
  return changedRows(result) === 1;
}

/*
 * The run is still running and this invocation still holds it, though its
 * lease may have run out: unlike checkpointHeld, this leaves the expiry
 * unread. It guards the verdict that ends the run, committed with
 * finishRunStatement, which reads the owner alone as well; an invocation
 * whose lease ran out holds the run until another takes it over (acquireRun)
 * or an operator cancels it (cancelRun).
 */
function leaseHeld(fence: Fence): Condition {
  return {
    sql: first => `EXISTS (
      SELECT 1 FROM sync_runs WHERE id = ?${first} AND status = 'running' AND lease_owner = ?${first + 1}
    )`,
    values: [ fence.runId, fence.owner ],
  };
}

/*
 * What every write committed with a checkpoint is conditioned on: the run is
 * still running, this invocation holds its lease and the lease has not
 * expired, and the root is still claimed by it and in progress. An
 * invocation that lost the run — however late its result arrives — writes
 * nothing at all.
 */
function checkpointHeld(fence: Fence, itemId: string, timestamp: string): Condition {
  return {
    sql: first => `EXISTS (
      SELECT 1 FROM sync_runs AS run
      JOIN sync_run_items AS item ON item.sync_run_id = run.id
      WHERE run.id = ?${first} AND run.status = 'running' AND run.lease_owner = ?${first + 1}
        AND run.lease_expires_at > ?${first + 2}
        AND item.id = ?${first + 3} AND item.claim_owner = ?${first + 1} AND item.status = 'processing'
    )`,
    values: [ fence.runId, fence.owner, timestamp, itemId ],
  };
}

// no run is importing into a version, so it changes only through its overlay
function noRunImporting(versionId: string): Condition {
  return {
    sql:    first => `NOT EXISTS (SELECT 1 FROM sync_runs WHERE registry_version_id = ?${first} AND status = 'running')`,
    values: [ versionId ],
  };
}

/*
 * Claims one root to process: a pending one, or one that failed and may be
 * retried, the fewest attempts first, so every root is tried before any is
 * tried again. A root in progress is never claimed: one a lost invocation
 * left is failed by the invocation that took the run over (acquireRun), and
 * is claimed as any failed root is. The condition proves the caller still
 * owns an unexpired run, so claiming and the fence check cannot disagree.
 */
async function claimItem(
  db: D1Database,
  fence: Fence,
  options: ClockOption & { except?: readonly string[] } = {},
): Promise<SyncRunItemRow | null> {
  const timestamp = at(options.now);
  /*
   * `except` is what this invocation has already tried. An attempt that was
   * given back — because the invocation ran out rather than the root being
   * wrong — leaves the root looking untouched, and the ordering below would
   * then hand it straight back to the same invocation, which would spend its
   * whole batch on one root and never reach the others.
   */
  const excluded = options.except ?? [];
  const holes    = excluded.map((_, index) => `?${index + 5}`).join(', ');
  const claimed = await db.prepare(
    `UPDATE sync_run_items
     SET status = 'processing', attempts = attempts + 1, claim_owner = ?1, claimed_at = ?2, updated_at = ?2
     WHERE id = (
       SELECT item.id
       FROM sync_run_items AS item
       JOIN sync_runs AS run ON run.id = item.sync_run_id
       WHERE item.sync_run_id = ?3
         AND run.status = 'running'
         AND run.lease_owner = ?1
         AND run.lease_expires_at > ?2
         AND item.attempts < ?4
         AND item.status IN ('pending', 'failed')
         ${excluded.length === 0 ? '' : `AND item.id NOT IN (${holes})`}
       ORDER BY item.attempts, item.root_path
       LIMIT 1
     )
     RETURNING *`
  ).bind(fence.owner, timestamp, fence.runId, MAX_ITEM_ATTEMPTS, ...excluded)
    .first<SyncRunItemRow>();
  return claimed ?? null;
}

/*
 * How an attempt at a root ended. One that completed carries what the root
 * produced, committed in the same transaction as its checkpoint and under the
 * same condition: both, or neither. One that failed carries why, and is
 * refunded when the failure was not about the root.
 */
type Attempt =
  | { status: 'completed', writes: (condition: Condition) => D1PreparedStatement[] }
  | { status: 'failed', error: string, refund: boolean };

/*
 * What an attempt adds to its run's counters. Counters count roots, not
 * attempts: a root that failed but may still be retried is not yet a failed
 * root, and counting it as one would exceed the expected count the schema
 * enforces. A spent attempt makes the root (?4) a failed root when it was its
 * last; a refunded attempt can never be the last one, so it adds nothing.
 */
function incrementOf(attempt: Attempt): string {
  switch (attempt.status) {
    case 'completed':
      return `completed_count = completed_count + 1`;
    case 'failed':
      return attempt.refund
        ? `failed_count = failed_count`
        : `failed_count = failed_count + (
           SELECT CASE WHEN attempts >= ${MAX_ITEM_ATTEMPTS} THEN 1 ELSE 0 END
           FROM sync_run_items WHERE id = ?4
         )`;
  }
}

async function checkpoint(
  db: D1Database,
  fence: Fence,
  itemId: string,
  attempt: Attempt,
  options: LeaseOptions,
): Promise<boolean> {
  const timestamp = at(options.now);
  const held      = checkpointHeld(fence, itemId, timestamp);
  const error     = attempt.status === 'failed' ? attempt.error : null;
  /*
   * Claiming a root counts an attempt, so giving one back is a decrement
   * here, and the root keeps the budget it never used.
   */
  const refunded  = attempt.status === 'failed' && attempt.refund;
  const spent     = attempt.status === 'failed' && !attempt.refund;

  /*
   * What the root produced comes first and the checkpoint last, because every
   * statement names a root still in progress, which the last one ends. The
   * counter is bumped before the item for the same reason.
   *
   * A committed checkpoint extends the lease: an invocation that is getting
   * through its roots keeps the run however many it has, while one stuck on a
   * single root for longer than a lease loses it, and its late result is then
   * refused by the condition above.
   */
  const results = await db.batch([
    ...(attempt.status === 'completed' ? attempt.writes(held) : []),
    conditioned(
      db,
      /*
       * `last_error` is replaced, not coalesced: a run that recovers from a
       * failed attempt must stop reporting it, or a successful import still
       * carries the diagnostic of a root that has since succeeded.
       */
      `UPDATE sync_runs SET ${incrementOf(attempt)}, last_error = ?1, lease_expires_at = ?2 WHERE id = ?3`,
      [ error, expiry(options.now, options.leaseSeconds), fence.runId, ...(spent ? [ itemId ] : []) ],
      held,
    ),
    conditioned(
      db,
      `UPDATE sync_run_items
       SET status = ?1, completed_at = ?2, last_error = ?3, updated_at = ?4${refunded ? ', attempts = MAX(attempts - 1, 0)' : ''}
       WHERE id = ?5`,
      [ attempt.status, attempt.status === 'completed' ? timestamp : null, error, timestamp, itemId ],
      held,
    ),
  ]);

  /*
   * Every statement carries the same condition in one transaction, so they
   * apply together or not at all: a late result from a replaced invocation
   * moves neither the counters nor the checkpoint.
   */
  return changedRows(results[results.length - 1]!) === 1;
}

async function completeItem(
  db: D1Database,
  fence: Fence,
  itemId: string,
  { writes = () => [], ...lease }: LeaseOptions & { writes?: (condition: Condition) => D1PreparedStatement[] },
): Promise<boolean> {
  return checkpoint(db, fence, itemId, { status: 'completed', writes }, lease);
}

/*
 * Records a failed attempt at one root. `refund` says the failure was the
 * carrier's, not the root's — see isTransportFailure — and the root's budget
 * is left as it was.
 */
async function failItem(
  db: D1Database,
  fence: Fence,
  item: { id: string, error: string },
  { refund = false, ...lease }: LeaseOptions & { refund?: boolean },
): Promise<boolean> {
  return checkpoint(db, fence, item.id, { status: 'failed', error: item.error, refund }, lease);
}

/*
 * Creates the candidate a run imports into and names it on the run, in one
 * transaction and under the run's fence: a run that has its candidate is never
 * without it on record, and a candidate never exists without the run that
 * imports into it. Both statements also require the run to have none yet, so
 * an invocation replaced while it was creating one cannot move the run onto
 * its own.
 */
async function bindCandidate(
  db: D1Database,
  fence: Fence,
  version: RegistryVersionRow,
  options: ClockOption = {},
): Promise<boolean> {
  const unbound: Condition = {
    sql: first => `EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = ?${first} AND status = 'running' AND lease_owner = ?${first + 1}
        AND lease_expires_at > ?${first + 2} AND registry_version_id IS NULL
    )`,
    values: [ fence.runId, fence.owner, at(options.now) ],
  };
  const [ created, bound ] = await db.batch([
    insertStatement(db, 'registry_versions', version, unbound),
    conditioned(db, `UPDATE sync_runs SET registry_version_id = ?1 WHERE id = ?2`, [ version.id, fence.runId ], unbound),
  ]);
  // D1 rolls a batch back on an error, not on a statement that changed nothing
  return changedRows(created!) === 1 && changedRows(bound!) === 1;
}

/*
 * Finishes the run, whose candidate bindCandidate has already named. `error`
 * replaces the run's error: a failed run says why, and a completed one may
 * clear it with null, or, leaving it out, keep the error it has.
 */
type RunFinish =
  | { status: 'completed', error?: null }
  | { status: 'failed', error: string };

/*
 * Closing a run as a statement, for a caller that commits it in one batch
 * with what the run produced, and only while `when` holds as well.
 */
function finishRunStatement(
  db: D1Database,
  fence: Fence,
  finish: RunFinish,
  options: ClockOption & { when?: Condition } = {},
): D1PreparedStatement {
  /*
   * The schema requires a completed run's outcome, and a run only ever
   * completes `imported`: a commit already imported starts no run, and
   * `no_change` is only what a sync answers then (admin-router.ts).
   */
  const outcome: SyncOutcome | null = finish.status === 'completed' ? 'imported' : null;
  return conditioned(
    db,
    `UPDATE sync_runs
     SET status = ?1, outcome = ?2,
         last_error = CASE WHEN ?7 = 1 THEN ?3 ELSE last_error END,
         lease_owner = NULL, lease_expires_at = NULL, completed_at = ?4
     WHERE id = ?5 AND status = 'running' AND lease_owner = ?6`,
    [
      finish.status,
      outcome,
      finish.error ?? null,
      at(options.now),
      fence.runId, fence.owner,
      finish.error === undefined ? 0 : 1,
    ],
    options.when,
  );
}

async function finishRun(db: D1Database, fence: Fence, finish: RunFinish, options: ClockOption = {}): Promise<boolean> {
  return changedRows(await finishRunStatement(db, fence, finish, options).run()) === 1;
}

/*
 * Reading a run, and the roots it checkpointed in the order every answer
 * lists them. They are statements so that a batch reads them inside its own
 * transaction (cancelRun) exactly as readRun and readRunItems read them alone.
 */
function runStatement(db: D1Database, runId: string): D1PreparedStatement {
  return db.prepare(`SELECT * FROM sync_runs WHERE id = ?1`).bind(runId);
}

function runItemsStatement(db: D1Database, runId: string): D1PreparedStatement {
  return db.prepare(`SELECT * FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`).bind(runId);
}

/*
 * Ends a run no invocation can finish: one whose every invocation fails the
 * same way before it gets anywhere, which the hourly job and every request
 * would otherwise keep taking up. An operator ends it, with why.
 *
 * Only a run nobody holds is ended — its lease given back, or run out — since
 * an invocation holding a live one may be importing into it. A root still in
 * progress was left by an invocation that stopped, and is failed as the
 * invocation taking the run over would fail it (acquireRun). Every statement
 * carries the same condition in one transaction, so all of it happens, or
 * none does.
 *
 * The run and its roots are read back in that transaction too. The caller
 * answers with what the cancel found or did, which a read after it could
 * contradict — a lease given back in between — or fail on, once the run
 * has already ended.
 */
async function cancelRun(
  db: D1Database,
  runId: string,
  cancel: { actor: string, reason: string },
  options: ClockOption = {},
): Promise<{ cancelled: boolean, run: SyncRunRow | null, items: SyncRunItemRow[] }> {
  const timestamp = at(options.now);
  const idle      = `id = ?1 AND status = 'running' AND (lease_owner IS NULL OR lease_expires_at <= ?2)`;
  const [ , , ended, run, items ] = await db.batch([
    // the counter first, while the roots it counts are still in progress
    db.prepare(
      `UPDATE sync_runs
       SET failed_count = failed_count + (
             SELECT COUNT(*) FROM sync_run_items
             WHERE sync_run_id = sync_runs.id AND status = 'processing' AND attempts >= ${MAX_ITEM_ATTEMPTS}
           )
       WHERE ${idle}`
    ).bind(runId, timestamp),
    db.prepare(
      `UPDATE sync_run_items SET status = 'failed', last_error = ?3, updated_at = ?2
       WHERE sync_run_id = ?1 AND status = 'processing' AND EXISTS (SELECT 1 FROM sync_runs WHERE ${idle})`
    ).bind(runId, timestamp, ABANDONED),
    db.prepare(
      `UPDATE sync_runs
       SET status = 'failed', last_error = ?3, lease_owner = NULL, lease_expires_at = NULL, completed_at = ?2
       WHERE ${idle}`
    ).bind(runId, timestamp, `cancelled by ${cancel.actor}: ${cancel.reason}`),
    runStatement(db, runId),
    runItemsStatement(db, runId),
  ]);
  return {
    cancelled: changedRows(ended!) === 1,
    run:       (run!.results?.[0] ?? null) as SyncRunRow | null,
    items:     (items!.results ?? []) as SyncRunItemRow[],
  };
}

async function runningRun(db: D1Database): Promise<SyncRunRow | null> {
  return db.prepare(`SELECT * FROM sync_runs WHERE status = 'running'`).first<SyncRunRow>();
}

async function readRun(db: D1Database, runId: string): Promise<SyncRunRow | null> {
  const run = await runStatement(db, runId).first<SyncRunRow | null>();
  return run ?? null;
}

async function readRunItems(db: D1Database, runId: string): Promise<SyncRunItemRow[]> {
  const { results } = await runItemsStatement(db, runId).all<SyncRunItemRow>();
  return results ?? [];
}

// the roots a run checkpointed, with the git object ids its candidate's source identity is computed from
async function checkpointsOf(db: D1Database, runId: string): Promise<Array<{ rootPath: string, sourceBlobSha: string }>> {
  const { results } = await db.prepare(
    `SELECT root_path, source_blob_sha FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`
  ).bind(runId).all<{ root_path: string, source_blob_sha: string }>();
  return (results ?? []).map(item => ({ rootPath: item.root_path, sourceBlobSha: item.source_blob_sha }));
}

/*
 * The run that imported a version, and the roots it checkpointed: which
 * markets the version must hold to be complete. A version has one run, the
 * one that created it; a version written some other way has none.
 */
type ImportRun = {
  status:        SyncRunStatus,
  holdForReview: boolean,
  roots:         Array<{ upstreamNetworkKey: string, deploymentKey: string }>,
};

async function importOf(db: D1Database, versionId: string): Promise<ImportRun | null> {
  const { results } = await db.prepare(
    `SELECT run.status, run.hold_for_review, item.upstream_network_key, item.deployment_key
     FROM sync_runs AS run
     LEFT JOIN sync_run_items AS item ON item.sync_run_id = run.id
     WHERE run.id = (SELECT id FROM sync_runs WHERE registry_version_id = ?1 ORDER BY started_at DESC LIMIT 1)
     ORDER BY item.root_path`
  ).bind(versionId).all<{
    status: SyncRunStatus, hold_for_review: number,
    upstream_network_key: string | null, deployment_key: string | null,
  }>();
  const [ run ] = results ?? [];
  if (run === undefined) {
    return null;
  }
  return {
    status:        run.status,
    holdForReview: run.hold_for_review === 1,
    roots: (results ?? [])
      .filter(item => item.upstream_network_key !== null && item.deployment_key !== null)
      .map(item => ({ upstreamNetworkKey: item.upstream_network_key!, deploymentKey: item.deployment_key! })),
  };
}

/*
 * How far a run has got, in roots. One statement, so every answer can carry
 * it: a caller that is told `running` needs to know whether the invocation
 * made progress and how much is left, and deriving that from the status
 * alone is what makes a resumable import look erratic.
 */
async function progressOf(db: D1Database, runId: string): Promise<{
  expected: number, completed: number, outstanding: number,
}> {
  const counts = await db.prepare(
    `SELECT run.expected_count AS expected, run.completed_count AS completed,
            (SELECT COUNT(*) FROM sync_run_items WHERE sync_run_id = ?1 AND ${OUTSTANDING}) AS outstanding
     FROM sync_runs AS run WHERE run.id = ?1`
  ).bind(runId).first<{ expected: number, completed: number, outstanding: number } | null>();
  return counts ?? { expected: 0, completed: 0, outstanding: 0 };
}

/*
 * When the newest finished run of a commit started, which is what a retry of
 * the commit waits from. A run starts the discovery interval again, so whole
 * intervals counted from its start are over by the discovery that many
 * intervals later; counted from its end, hours later, they would always wait
 * for the discovery after.
 */
async function lastStartedAt(db: D1Database, commitSha: string): Promise<string | null> {
  const started = await db.prepare(
    `SELECT MAX(started_at) AS started FROM sync_runs WHERE source_commit_sha = ?1 AND status <> 'running'`
  ).bind(commitSha).first<string | null>('started');
  return started ?? null;
}

/*
 * Whether upstream should be checked for a new commit. Discovery is daily,
 * while the Cron fires hourly to continue an unfinished import.
 */
async function dueForDiscovery(db: D1Database, options: ClockOption & { intervalSeconds: number }): Promise<boolean> {
  const checkedAt = await db
    .prepare(`SELECT last_upstream_checked_at FROM registry_state WHERE singleton_id = 1`)
    .first<string | null>('last_upstream_checked_at');
  if (checkedAt === null || checkedAt === undefined) {
    return true;
  }
  const elapsed = nowOf(options.now).getTime() - Date.parse(checkedAt);
  return elapsed >= options.intervalSeconds * 1000;
}

async function recordUpstreamCheck(db: D1Database, options: ClockOption = {}): Promise<void> {
  const timestamp = at(options.now);
  await db.prepare(
    `UPDATE registry_state SET last_upstream_checked_at = ?1, updated_at = ?1 WHERE singleton_id = 1`
  ).bind(timestamp).run();
}

export type { Fence, ImportRun, LeaseOptions, RootCheckpoint, RunFinish, RunInput };

export {
  MAX_ITEM_ATTEMPTS,
  acquireRun,
  bindCandidate,
  cancelRun,
  checkpointsOf,
  claimItem,
  completeItem,
  dueForDiscovery,
  failItem,
  finishRun,
  finishRunStatement,
  importOf,
  lastStartedAt,
  leaseHeld,
  noRunImporting,
  progressOf,
  readRun,
  readRunItems,
  recordUpstreamCheck,
  releaseLease,
  runningRun,
  startRun,
};
