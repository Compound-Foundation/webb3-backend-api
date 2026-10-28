import t from 'tap';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import { isRegistryError } from '../../../src/registry/errors.js';
import { Condition, candidateRow, conditioned } from '../../../src/registry/repository.js';
import {
  Fence,
  MAX_ITEM_ATTEMPTS,
  RootCheckpoint,
  acquireRun,
  bindCandidate,
  claimItem,
  completeItem,
  dueForDiscovery,
  failItem,
  finishRun,
  progressOf,
  recordUpstreamCheck,
  releaseLease,
  runningRun,
  startRun,
} from '../../../src/registry/sync.js';

import { applyMigrations } from '../../util/d1.js';

/*
 * The sync fence against real local D1. A Cron invocation can be interrupted
 * at any point, so the properties under test are the awkward ones: two
 * invocations overlapping, a lease taken over mid-import, and a result
 * arriving from an invocation that has already been replaced.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

const COMMIT = 'a34d9b571c833b5d77f052ab8e2dbdbe10df726d';

const ROOTS: RootCheckpoint[] = [
  { rootPath: 'deployments/mainnet/usdc/roots.json', upstreamNetworkKey: 'mainnet', deploymentKey: 'usdc', sourceBlobSha: 'a'.repeat(40) },
  { rootPath: 'deployments/mainnet/weth/roots.json', upstreamNetworkKey: 'mainnet', deploymentKey: 'weth', sourceBlobSha: 'b'.repeat(40) },
  { rootPath: 'deployments/base/usdc/roots.json',    upstreamNetworkKey: 'base',    deploymentKey: 'usdc', sourceBlobSha: 'c'.repeat(40) },
];

// a fixed clock, so lease expiry is exercised without waiting for it
function clockAt(iso: string) {
  return () => new Date(iso);
}

// what every commit is given: a committed checkpoint extends the lease by this much
function lease(iso: string) {
  return { leaseSeconds: 900, now: clockAt(iso) };
}

const T0 = '2026-09-18T12:00:00.000Z';
const T1 = '2026-09-18T12:05:00.000Z';
const T2 = '2026-09-18T12:20:00.000Z';

async function newRun(db: D1Database, now: string = T0): Promise<Fence> {
  return startRun(db, {
    sourceCommitSha: COMMIT,
    trackedRef:      'main',
    triggerKind:     'scheduled',
    requestedBy:     'registry-cron',
    reason:          null,
    roots:           ROOTS,
  }, { leaseSeconds: 900, now: clockAt(now) });
}

t.test('one import runs at a time', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  const run = await runningRun(db);
  t.equal(run?.lease_owner, fence.owner, 'a new run is created with its lease held by its creator');
  t.equal(run?.id, fence.runId);
  t.equal(run?.expected_count, ROOTS.length, 'every root is checkpointed');
  t.equal((await progressOf(db, fence.runId)).outstanding, ROOTS.length, 'and starts unprocessed');

  try {
    await newRun(db);
    t.fail('a second run was created while one was running');
  } catch (error) {
    t.ok(isRegistryError(error) && error.code === 'SYNC_ALREADY_RUNNING', 'a concurrent creator is refused');
  }

  // the refused creation leaves no partial run behind
  t.equal((await progressOf(db, fence.runId)).outstanding, ROOTS.length);
  const runs = await db.prepare(`SELECT COUNT(*) AS n FROM sync_runs`).first<number>('n');
  t.equal(runs, 1, 'and no orphaned run rows');
});

t.test('a lease is taken over only once it expires', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  t.equal(await acquireRun(db, { leaseSeconds: 900, now: clockAt(T1) }), null, 'a held lease cannot be taken');

  // T2 is beyond the lease granted at T0
  const resumed = await acquireRun(db, { leaseSeconds: 900, now: clockAt(T2) });
  t.ok(resumed, 'an expired lease is taken over');
  t.equal(resumed!.runId, fence.runId, 'by resuming the same run');
  t.not(resumed!.owner, fence.owner, 'under an owner of its own');
  t.same(
    await db.prepare(`SELECT failed_count, last_error FROM sync_runs WHERE id = ?1`).bind(fence.runId).first(),
    { failed_count: 0, last_error: null },
    'which records no failure when no root was in progress',
  );

  t.equal(await claimItem(db, fence, { now: clockAt(T2) }), null, 'the replaced invocation cannot claim more work');
  t.equal(
    await finishRun(db, fence, { status: 'completed', outcome: 'imported' }, { now: clockAt(T2) }),
    false,
    'nor finish the run it no longer owns',
  );
  t.equal(await releaseLease(db, fence), false, 'nor release a lease it no longer holds');

  t.equal(await releaseLease(db, resumed!), true, 'the current owner may release the lease');
  const released = await acquireRun(db, { leaseSeconds: 900, now: clockAt(T2) });
  t.ok(released, 'a released run is resumable at once, without waiting for expiry');
  t.not(released!.owner, resumed!.owner, 'and whoever takes it is a new owner again');
});

/*
 * An invocation that is getting through its roots keeps the run however many
 * it has: every checkpoint it commits extends its lease. One stuck on a single
 * root for longer than a lease loses it.
 */
t.test('a committed checkpoint extends the lease', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  const item = await claimItem(db, fence, { now: clockAt(T1) });
  t.equal(await completeItem(db, fence, { id: item!.id }, lease(T1)), true, 'a root is committed at T1');
  t.equal(
    (await runningRun(db))?.lease_expires_at,
    '2026-09-18T12:20:00.000Z',
    'and the lease runs a whole lease from then, past the expiry granted at T0',
  );
  t.equal(await acquireRun(db, { leaseSeconds: 900, now: clockAt('2026-09-18T12:16:00.000Z') }), null,
    'so it cannot be taken where the first lease would have expired');
  t.ok(await claimItem(db, fence, { now: clockAt('2026-09-18T12:16:00.000Z') }), 'and its holder works on');
});

t.test('roots are claimed once and committed by their claimant', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  const first = await claimItem(db, fence, { now: clockAt(T0) });
  t.ok(first, 'a pending root is claimed');
  t.equal(first!.status, 'processing');
  t.equal(first!.attempts, 1, 'the attempt is counted at claim time, so a crash cannot loop forever');
  t.equal(first!.claim_owner, fence.owner, 'and the root names the invocation that claimed it');

  const second = await claimItem(db, fence, { now: clockAt(T0) });
  t.not(second!.id, first!.id, 'a second claim returns a different root');

  t.equal(
    await completeItem(db, fence, { id: first!.id }, lease(T0)),
    true,
    'the claimant commits its result',
  );
  t.equal(
    await completeItem(db, fence, { id: first!.id }, lease(T0)),
    false,
    'committing the same root twice changes nothing',
  );

  const run = await runningRun(db);
  t.equal(run?.completed_count, 1, 'the run counts one completed root');
  t.equal(run?.failed_count, 0);

  t.equal(
    await failItem(db, fence, { id: second!.id, error: 'price feed did not answer' }, lease(T0)),
    true,
    'a failure is recorded against the run',
  );
  const failed = await runningRun(db);
  t.equal(failed?.failed_count, 0, 'a root that may still be retried is not yet a failed root');
  t.equal(failed?.last_error, 'price feed did not answer', 'but its diagnostic is recorded');
});

t.test('an expired lease commits nothing, not even a counter', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  const item = await claimItem(db, fence, { now: clockAt(T0) });
  t.ok(item, 'a root is claimed while the lease is held');

  /*
   * The import outlives the lease and nobody has taken the run over yet. Both
   * statements of the checkpoint batch check the same fence, so neither the
   * counter nor the item moves.
   */
  t.equal(
    await completeItem(db, fence, { id: item!.id }, lease(T2)),
    false,
    'the commit is refused once the lease has expired',
  );
  const run = await runningRun(db);
  t.equal(run?.completed_count, 0, 'the completed counter is untouched');
  t.equal(run?.failed_count, 0, 'and so is the failed counter');

  const stale = await db.prepare(`SELECT status FROM sync_run_items WHERE id = ?1`).bind(item!.id).first<string>('status');
  t.equal(stale, 'processing', 'the checkpoint is left for whoever takes the run over');
});

t.test('a result from a replaced invocation is discarded', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  const claimed = await claimItem(db, fence, { now: clockAt(T0) });
  t.ok(claimed, 'the first invocation claims a root');

  // the invocation stalls; a later one takes the run over
  const resumed = await acquireRun(db, { leaseSeconds: 900, now: clockAt(T2) });
  t.ok(resumed, 'the run is taken over');

  t.equal(
    await completeItem(db, fence, { id: claimed!.id }, lease(T2)),
    false,
    'the stalled invocation cannot commit its late result',
  );
  const run = await runningRun(db);
  t.equal(run?.completed_count, 0, 'so the counters stay untouched');

  /*
   * Roots that were never attempted are claimed before one left behind by a
   * replaced invocation, so first-attempt coverage comes before retries. The
   * abandoned root is still reclaimed, as a second attempt.
   */
  const reclaimed: Array<{ id: string, attempts: number }> = [];
  for (;;) {
    const item = await claimItem(db, resumed!, { now: clockAt(T2) });
    if (item === null) {
      break;
    }
    reclaimed.push({ id: item.id, attempts: item.attempts });
    await completeItem(db, resumed!, { id: item.id }, lease(T2));
  }

  t.equal(reclaimed.length, ROOTS.length, 'the new owner works through every root');
  t.same(
    reclaimed.find(item => item.id === claimed!.id),
    { id: claimed!.id, attempts: 2 },
    'including the abandoned one, as a second attempt',
  );
  t.same(reclaimed.slice(0, -1).map(item => item.attempts), [ 1, 1 ], 'untouched roots are claimed first');
  t.equal((await runningRun(db))?.completed_count, ROOTS.length, 'and commits them all');
});

/*
 * What a root produced is written in the transaction that commits its
 * checkpoint, under the same condition. A result that arrives after its
 * invocation lost the run writes nothing — not the checkpoint, and not what
 * it would have overwritten either.
 */
t.test('what a root produced commits with its checkpoint, or not at all', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);
  const marker = () => db.prepare(`SELECT updated_at FROM registry_state WHERE singleton_id = 1`).first<string>('updated_at');
  const writes = (value: string) => (condition: Condition) => [
    conditioned(db, `UPDATE registry_state SET updated_at = ?1 WHERE singleton_id = 1`, [ value ], condition),
  ];

  const stale   = await claimItem(db, fence, { now: clockAt(T0) });
  const resumed = await acquireRun(db, { leaseSeconds: 900, now: clockAt(T2) });
  const before  = await marker();

  t.equal(
    await completeItem(db, fence, { id: stale!.id }, { ...lease(T2), writes: writes('written by the replaced invocation') }),
    false,
    'the replaced invocation commits nothing',
  );
  t.equal(await marker(), before, 'and what it produced is not written either');

  const item = await claimItem(db, resumed!, { now: clockAt(T2) });
  t.equal(
    await completeItem(db, resumed!, { id: item!.id }, { ...lease(T2), writes: writes('written by the owner') }),
    true,
    'the owner commits its checkpoint',
  );
  t.equal(await marker(), 'written by the owner', 'together with what the root produced');
});

/*
 * A run's candidate is created and named on the run in one transaction, and
 * only by the invocation holding the run, only once. An invocation replaced
 * while it was creating one can neither leave a candidate without a run nor
 * move the run onto its own.
 */
t.test('a run is given its candidate once, by the invocation that holds it', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);
  const draft = (attempt: number) => candidateRow({
    repository:     'Compound-Foundation/comet',
    commitSha:      COMMIT,
    sourceChecksum: 'a'.repeat(64),
    attempt,
    createdBy:      'registry-cron',
  });
  const versions = () => db.prepare(`SELECT COUNT(*) AS n FROM registry_versions`).first<number>('n');

  const replaced = { ...fence, owner: 'a replaced invocation' };
  t.equal(await bindCandidate(db, replaced, draft(1), { now: clockAt(T0) }), false, 'an invocation that does not hold the run');
  t.equal(await bindCandidate(db, fence, draft(1), { now: clockAt(T2) }), false, 'or whose lease has run out');
  t.equal(await versions(), 0, 'creates no candidate');

  const first = draft(1);
  t.equal(await bindCandidate(db, fence, first, { now: clockAt(T0) }), true, 'the holder creates one');
  t.equal((await runningRun(db))?.registry_version_id, first.id, 'and the run names it');

  t.equal(await bindCandidate(db, fence, draft(2), { now: clockAt(T0) }), false, 'a run that has one is not given another');
  t.equal(await versions(), 1, 'and the second is not created at all');
});

t.test('a root that keeps failing stops being retried', async t => {
  const db    = await freshDatabase();
  let fence   = await newRun(db);

  // fail every root until the fence stops handing work out
  let processed = 0;
  const limit   = MAX_ITEM_ATTEMPTS * ROOTS.length + 1;
  for (;;) {
    const item = await claimItem(db, fence, { now: clockAt(T0) });
    if (item === null || processed > limit) {
      break;
    }
    processed++;
    await failItem(db, fence, { id: item.id, error: 'unreadable' }, lease(T0));
  }
  t.equal(processed, MAX_ITEM_ATTEMPTS * ROOTS.length, 'each root is retried up to its bound, then left alone');
  t.equal(await claimItem(db, fence, { now: clockAt(T0) }), null, 'nothing remains claimable');
  t.equal((await progressOf(db, fence.runId)).outstanding, 0, 'and nothing is reported as outstanding work');
  t.equal(
    (await runningRun(db))?.failed_count,
    ROOTS.length,
    'each exhausted root counts once, however many attempts it took',
  );

  t.equal(
    await finishRun(db, fence, { status: 'failed', error: 'every root failed' }, { now: clockAt(T0) }),
    true,
    'the run finishes as failed',
  );
  t.equal(await runningRun(db), null, 'and no longer holds the running slot');

  fence = await newRun(db, T2);
  t.ok(fence.runId, 'a new run may start once the previous one is terminal');
});

/*
 * An invocation stopped in the middle of a root — a deploy, or the time or
 * the CPU a Worker is given — leaves the root in progress and writes nothing
 * more. The invocation that takes the run over records that attempt as the
 * stopped one would have recorded a failure: the root says why, so does the
 * run, and a root whose last attempt was the one that stopped is given up
 * and counted, rather than left in progress for good.
 */
t.test('a root an invocation left in progress is failed by the invocation that takes the run over', async t => {
  const db        = await freshDatabase();
  let fence       = await newRun(db);
  const ABANDONED = 'the invocation importing this root did not finish';
  const minutes   = (count: number) => () => new Date(Date.parse(T0) + count * 60_000);
  const rootOf    = (id: string) => db.prepare(
    `SELECT status, attempts, last_error, updated_at FROM sync_run_items WHERE id = ?1`
  ).bind(id).first<{ status: string, attempts: number, last_error: string | null, updated_at: string }>();

  // the invocation claims a root, imports the others, and is stopped before it commits the first
  const stopped = (await claimItem(db, fence, { now: clockAt(T0) }))!;
  for (;;) {
    const item = await claimItem(db, fence, { now: clockAt(T0) });
    if (item === null) {
      break;
    }
    await completeItem(db, fence, { id: item.id }, lease(T0));
  }

  // every twenty minutes, past the lease of the one before, an invocation takes the run over and is stopped on the root
  for (let attempt = 1; attempt < MAX_ITEM_ATTEMPTS; attempt++) {
    const now = minutes(20 * attempt);
    fence = (await acquireRun(db, { leaseSeconds: 900, now }))!;
    t.same(
      await rootOf(stopped.id),
      { status: 'failed', attempts: attempt, last_error: ABANDONED, updated_at: now().toISOString() },
      `attempt ${attempt} is recorded as failed, with why, by the invocation that took the run over`,
    );
    t.equal((await claimItem(db, fence, { now }))?.id, stopped.id, 'which tries the root again');
  }

  const now = minutes(20 * MAX_ITEM_ATTEMPTS);
  fence = (await acquireRun(db, { leaseSeconds: 900, now }))!;
  t.match(await rootOf(stopped.id), { status: 'failed', attempts: MAX_ITEM_ATTEMPTS, last_error: ABANDONED },
    'the last attempt is recorded as failed as well');
  const run = await runningRun(db);
  t.same([ run?.completed_count, run?.failed_count, run?.last_error ], [ ROOTS.length - 1, 1, ABANDONED ],
    'and the root is counted among those the run gave up, with why the run did');
  t.equal((await progressOf(db, fence.runId)).outstanding, 0, 'so nothing is left to attempt');
  t.equal(await claimItem(db, fence, { now }), null, 'and nothing to claim');
});

/*
 * An attempt is given back when the failure was the invocation's rather than
 * the root's. What must not follow is the same invocation claiming that root
 * again: it looks untouched, it sorts first, and one root would then consume
 * the whole batch while the others were never tried.
 */
t.test('an attempt can be given back, and the root is not claimed again by the same invocation', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  const first = await claimItem(db, fence, { now: clockAt(T0) });
  t.equal(first?.attempts, 1, 'claiming spends an attempt');
  await failItem(db, fence, { id: first!.id, error: 'the node provider did not answer' }, {
    ...lease(T0),
    spendsAttempt: false,
  });

  const refunded = await db.prepare(`SELECT attempts, status FROM sync_run_items WHERE id = ?1`)
    .bind(first!.id).first<{ attempts: number, status: string }>();
  t.same(refunded, { attempts: 0, status: 'failed' }, 'and giving it back leaves the root as it was');
  t.equal((await runningRun(db))?.failed_count, 0, 'a refunded attempt never makes a root a failed root');

  const next = await claimItem(db, fence, { now: clockAt(T0), except: [ first!.id ] });
  t.not(next?.id, first!.id, 'the same invocation claims a different root');
  t.equal(next?.attempts, 1);

  /*
   * A later invocation is a different one, and the root is claimable again —
   * with the budget it never spent.
   */
  const later = await claimItem(db, fence, { now: clockAt(T0) });
  t.equal(later?.id, first!.id, 'the refunded root is claimed first by whoever comes next');
  t.equal(later?.attempts, 1, 'spending its first attempt for the first time');
});

t.test('a finished run records what it produced', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  for (;;) {
    const item = await claimItem(db, fence, { now: clockAt(T0) });
    if (item === null) {
      break;
    }
    await completeItem(db, fence, { id: item.id }, lease(T0));
  }

  t.equal((await progressOf(db, fence.runId)).outstanding, 0, 'every root is checkpointed as done');
  t.equal(
    await finishRun(db, fence, { status: 'completed', outcome: 'no_change' }, { now: clockAt(T0) }),
    true,
  );

  const run = await db.prepare(`SELECT * FROM sync_runs WHERE id = ?1`).bind(fence.runId).first<{
    status: string, outcome: string, completed_count: number, lease_owner: string | null, completed_at: string,
  }>();
  t.equal(run?.status, 'completed');
  t.equal(run?.outcome, 'no_change', 'an unchanged source is a successful outcome, not an import');
  t.equal(run?.completed_count, ROOTS.length);
  t.equal(run?.lease_owner, null, 'the lease is released');
  t.ok(run?.completed_at, 'and the run is timestamped');
});

t.test('discovery is due once a day, while continuation is hourly', async t => {
  const db = await freshDatabase();
  const day = 86400;

  t.equal(await dueForDiscovery(db, { intervalSeconds: day, now: clockAt(T0) }), true, 'the first check is always due');

  await recordUpstreamCheck(db, { now: clockAt(T0) });
  t.equal(await dueForDiscovery(db, { intervalSeconds: day, now: clockAt(T2) }), false, 'an hour later it is not');
  t.equal(
    await dueForDiscovery(db, { intervalSeconds: day, now: clockAt('2026-09-19T12:00:00.000Z') }),
    true,
    'a day later it is due again',
  );
});
