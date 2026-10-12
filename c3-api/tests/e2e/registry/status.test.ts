import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type { Address } from '../../../lib/model/comet-registry.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import { activeSnapshot, cacheDepsOf } from '../../../src/registry/cache.js';
import { CHECK_KEY, checkChain } from '../../../src/registry/drift.js';
import { activateVersion, markInvalid, recordValidationResults } from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { FakeChain, fakeChain } from '../../util/fake-chain.js';
import { activateSeeded, loadRegistrySnapshotFixture, seedCandidate, validateSeeded } from '../../util/registry-fixture.js';

/*
 * The status route: one answer a monitor polls and an operator reads.
 *
 * The contract these tests hold is `alerts`: a healthy registry names none,
 * and each condition worth waking someone for names itself, so a check can be
 * "alerts is empty" without the monitor knowing the registry's rules.
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';
const SECRETS     = { COMET_REGISTRY_ADMIN_TOKEN_HASH: await sha256Hex(ADMIN_TOKEN) };

const server = createTestHarness({
  workers: [ {
    configPath: './wrangler.toml',
    secrets:    SECRETS,
  } ],
});

// the worker again, with `vars` set over the ones wrangler.toml gives it, until the next freshDatabase
async function withVars(vars: Record<string, string>): Promise<void> {
  await server.update({ workers: [ { configPath: './wrangler.toml', secrets: SECRETS, vars } ] });
}

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();
const auth     = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };

type Status = {
  environment: string,
  configuration: { invalid: string[] },
  active: { versionId: string, checksum: string, activatedBy: string | null } | null,
  cache: { snapshotCached: boolean, pointerAgeSeconds: number | null },
  sync: {
    lastRun: { id: string, status: string, failedCount: number, lastError: string | null } | null,
    upstreamCheckedAt: string | null,
    upstreamAgeSeconds: number | null,
    intervalSeconds: number,
    rejectedCommit: { sourceCommitSha: string, versionId: string, attempt: number, createdAt: string } | null,
  },
  candidates: {
    importing: Array<{ versionId: string, unreviewed: { networks: number, markets: number } }>,
    validated: Array<{ versionId: string, unserved: string[] }>,
    invalid:   number,
  },
  chainCheck: {
    versionId:  string,
    checkedAt:  string,
    ageSeconds: number | null,
    drifts:     Array<Record<string, unknown>>,
    unreadable: Array<{ chainId: number, network: string, error: string }>,
  } | null,
  alerts: string[],
};

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

async function status(): Promise<Status> {
  const response = await server.fetch('/registry/v1/admin/status', { headers: auth });
  t.equal(response.status, 200);
  return await response.json() as Status;
}

const COMMIT = 'a34d9b571c833b5d77f052ab8e2dbdbe10df726d';

async function recordRun(
  db: D1Database,
  run: { status: string, outcome?: string | null, failed?: number, leaseExpiresAt?: string | null, startedAt?: string },
): Promise<string> {
  const id = randomUUID();
  const at = run.startedAt ?? new Date().toISOString();
  await db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, trigger_kind, status, outcome, lease_owner,
       lease_expires_at, expected_count, completed_count, failed_count, last_error, started_at, completed_at
     ) VALUES (?1, ?2, 'main', 'scheduled', ?3, ?4, ?5, ?6, 1, 0, ?7, ?8, ?9, ?10)`
  ).bind(
    id, COMMIT, run.status, run.outcome ?? null,
    run.status === 'running' ? randomUUID() : null,
    run.leaseExpiresAt ?? null,
    run.failed ?? 0,
    run.status === 'failed' ? 'the source did not answer' : null,
    at,
    run.status === 'running' ? null : at,
  ).run();
  return id;
}

t.test('a registry with nothing in it says exactly what is missing', async t => {
  await freshDatabase();

  const empty = await status();
  t.equal(empty.active, null, 'nothing is active');
  t.equal(empty.sync.lastRun, null, 'and nothing has run');
  t.equal(empty.sync.upstreamCheckedAt, null);
  t.same(empty.alerts.sort(), [ 'no-active-version', 'sync-overdue' ],
    'which is two conditions, each named');
  t.equal(empty.cache.snapshotCached, false);
});

t.test('a healthy registry raises nothing', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);
  await recordRun(db, { status: 'completed', outcome: 'no_change' });
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();

  // the worker caches what it serves, which is what the status then reports
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const healthy = await status();
  t.equal(healthy.active?.versionId, versionId);
  t.equal(healthy.active?.activatedBy, 'test-admin', 'the status says who switched it on');
  t.equal(healthy.cache.snapshotCached, true, 'the bytes of the active version are cached');
  t.type(healthy.cache.pointerAgeSeconds, 'number', 'and the pointer record has an age');
  t.equal(healthy.sync.lastRun?.status, 'completed');
  t.same(healthy.alerts, [], 'so there is nothing to alert on');
  t.same(healthy.configuration, { invalid: [] }, 'every registry setting is one the registry takes');
  t.equal(healthy.environment, 'local');
});

t.test('a candidate nobody has reviewed is reported as work waiting', async t => {
  const db = await freshDatabase();
  const { versionId: active } = await seedCandidate(db, snapshot);
  await activateSeeded(db, active);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const candidate = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  // a market nobody has reviewed is switched off, which the schema enforces
  await db.prepare(
    `UPDATE markets SET reviewed = 0, status = 'disabled', is_default = 0, slug = NULL,
            rewards_enabled = 0, account_rewards_enabled = 0, transaction_history_enabled = 0
     WHERE registry_version_id = ?1 AND deployment_key IN ('usdc', 'weth')
       AND network_id = (SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1)`
  ).bind(candidate.versionId).run();
  await recordRun(db, { status: 'completed', outcome: 'imported' });

  const waiting = await status();
  t.same(waiting.candidates.importing.map(entry => entry.versionId), [ candidate.versionId ],
    'the open candidate is named');
  t.equal(waiting.candidates.importing[0]?.unreviewed.markets, 2, 'with how much of it is unreviewed');
  t.same(waiting.alerts, [ 'candidate-awaiting-review' ]);
});

// switches a version that is already validated on, as an activation or a rollback does
async function switchOn(db: D1Database, versionId: string): Promise<void> {
  await activateVersion(db, { versionId, action: 'activate', actor: 'test-admin', reason: 'switching it on' });
}

/*
 * Once a version is on, the scheduled import validates a new commit by
 * itself, and what it produced waits for somebody to switch it on. A version
 * that was on before and was rolled back from is not news.
 */
t.test('a validated version newer than the active one is reported as waiting to be switched on', async t => {
  const db = await freshDatabase();
  const { versionId: active } = await seedCandidate(db, snapshot);
  await activateSeeded(db, active);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const newer = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await validateSeeded(db, newer.versionId);
  await recordRun(db, { status: 'completed', outcome: 'imported' });

  const waiting = await status();
  t.same(waiting.candidates.validated.map(entry => entry.versionId), [ newer.versionId ], 'the validated version is named');
  t.same(waiting.candidates.validated[0]?.unserved, [], 'serving every market the active one does');
  t.same(waiting.candidates.importing, [], 'and it is no draft');
  t.same(waiting.alerts, [ 'candidate-awaiting-activation' ]);

  await switchOn(db, newer.versionId);
  await switchOn(db, active);
  t.equal((await server.fetch('/registry/v1/active')).status, 200);
  const rolledBack = await status();
  t.same([ rolledBack.candidates.validated, rolledBack.alerts ], [ [], [] ],
    'a version that was on and was rolled back from waits for nobody');
});

/*
 * Nothing holds back a version that would stop serving a market the active
 * one serves: the scheduled import validates it, and it can be switched on.
 * So the status names the markets it would drop, by their keys in the active
 * version, until a version at least that new is on.
 */
t.test('a validated version that would stop serving a market is raised with the markets it drops', async t => {
  const db = await freshDatabase();
  // the version on serves every market of the fixture but Scroll's, which it holds switched off
  const on = structuredClone(snapshot);
  on.networks.find(network => network.chainId === 534352)!.markets[0]!.status = 'disabled';
  const { versionId: active } = await seedCandidate(db, on);
  await activateSeeded(db, active);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  /*
   * The source drops wbtc, renames usdt to a key the version holds switched
   * off, and gives weth's key to another Comet, switched off too. Base's
   * market is renamed, and deprecated, and so still served under its new key;
   * Base also has a market at wbtc's address, which on another chain is
   * another Comet. Scroll's stays switched off, as it was.
   */
  const next    = structuredClone(on);
  const mainnet = next.networks.find(network => network.chainId === 1)!;
  const base    = next.networks.find(network => network.chainId === 8453)!;
  const market  = (key: string) => mainnet.markets.find(entry => entry.deploymentKey === key)!;
  Object.assign(market('usdt'), { deploymentKey: 'usdt-renamed', status: 'disabled' });
  Object.assign(market('weth'), { status: 'disabled' });
  market('weth').contracts = { ...market('weth').contracts, comet: '0x1111111111111111111111111111111111111111' };
  base.markets.push({
    ...structuredClone(base.markets[0]!),
    deploymentKey: 'wbtc-twin',
    contracts:     { ...base.markets[0]!.contracts, comet: market('wbtc').contracts.comet },
  });
  Object.assign(base.markets[0]!, { deploymentKey: 'aero-renamed', status: 'deprecated' });
  mainnet.markets = mainnet.markets.filter(entry => entry.deploymentKey !== 'wbtc');
  const dropping = await seedCandidate(db, next, { versionId: randomUUID(), attempt: 2 });
  await validateSeeded(db, dropping.versionId);
  await recordRun(db, { status: 'completed', outcome: 'imported' });

  const raised = await status();
  t.same(raised.candidates.validated.map(({ versionId, unserved }) => ({ versionId, unserved })), [
    { versionId: dropping.versionId, unserved: [ '1/usdt', '1/wbtc', '1/weth' ] },
  ], 'the version names each market of the active one whose Comet it does not serve');
  t.same(raised.alerts, [ 'candidate-awaiting-activation', 'candidate-drops-markets' ], 'and the status raises it');

  await switchOn(db, dropping.versionId);
  t.equal((await server.fetch('/registry/v1/active')).status, 200);
  t.same((await status()).alerts, [], 'until it is switched on, which is the decision the alert asks for');
});

t.test('a version skipped for a newer one is not raised again by a rollback past both', async t => {
  const db = await freshDatabase();
  const { versionId: first } = await seedCandidate(db, snapshot);
  await activateSeeded(db, first);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const validated = async (attempt: number) => {
    const version = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt });
    await validateSeeded(db, version.versionId);
    return version.versionId;
  };
  await validated(2);
  const third = await validated(3);
  await switchOn(db, third);
  await switchOn(db, first);
  await recordRun(db, { status: 'completed', outcome: 'imported' });
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const after = await status();
  t.same([ after.candidates.validated, after.alerts ], [ [], [] ], 'the skipped second version waits for nobody either');
});

t.test('a run that failed, and one nobody is continuing, each name themselves', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  await recordRun(db, { status: 'failed', failed: 1 });
  const failed = await status();
  t.equal(failed.sync.lastRun?.status, 'failed');
  t.same(failed.alerts, [ 'last-sync-failed' ], 'a failed import is one condition');

  /*
   * An invocation that leaves work behind releases its lease, so the ordinary
   * stalled run has no expiry at all — it is stalled because nothing has
   * moved for longer than the hourly trigger would take.
   */
  await db.prepare(`DELETE FROM sync_runs`).run();
  await recordRun(db, { status: 'running', startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
  const abandoned = await status();
  t.same(abandoned.alerts, [ 'sync-stalled' ], 'a run nobody has continued for hours is another');

  await db.prepare(`DELETE FROM sync_runs`).run();
  await recordRun(db, {
    status:         'running',
    leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    startedAt:      new Date(Date.now() - 60_000).toISOString(),
  });
  t.same((await status()).alerts, [], 'while a run somebody holds the lease on is simply in progress');

  await db.prepare(`DELETE FROM sync_runs`).run();
  await recordRun(db, {
    status:         'running',
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    startedAt:      new Date(Date.now() - 600_000).toISOString(),
  });
  t.same((await status()).alerts, [],
    'and a lease that has just expired is one the next invocation takes over by itself');
});

/*
 * An import whose every attempt fails is never stalled — each attempt moves
 * it — and does not end failed until every root has spent its five attempts,
 * days later. Its latest attempt having failed, with roots left failed that
 * have spent attempts on it more than once, is what names it while it runs.
 */
t.test('an import that keeps failing is named while it runs', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const runId = await recordRun(db, { status: 'running', startedAt: new Date(Date.now() - 5 * 3_600_000).toISOString() });
  const error = 'CHAIN_REQUEST_FAILED: the node provider did not answer within 30 seconds';
  const now   = new Date().toISOString();
  await db.batch([
    // the hourly invocations so far: each attempted two roots, and each attempt failed a moment ago
    ...[ 'usdc', 'weth' ].map(deployment => db.prepare(
      `INSERT INTO sync_run_items (
         id, sync_run_id, root_path, source_blob_sha, upstream_network_key, deployment_key,
         status, attempts, claim_owner, last_error, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, 'mainnet', ?5, 'failed', 3, ?6, ?7, ?8, ?8)`
    ).bind(randomUUID(), runId, `deployments/mainnet/${deployment}/roots.json`, 'a'.repeat(40), deployment, randomUUID(), error, now)),
    db.prepare(`UPDATE sync_runs SET last_error = ?1 WHERE id = ?2`).bind(error, runId),
  ]);

  const failing = await status();
  t.same(failing.alerts, [ 'sync-failing' ], 'is named, though every hour moves it');
  t.equal(failing.sync.lastRun?.status, 'running', 'while it is still running');
  t.equal(failing.sync.lastRun?.lastError, error, 'with why its last attempt failed');

  // an attempt that succeeds clears the run's error, as every completed checkpoint does
  await db.prepare(`UPDATE sync_runs SET last_error = NULL WHERE id = ?1`).bind(runId).run();
  t.same((await status()).alerts, [], 'an import whose latest attempt succeeded is not failing, with roots to try again or not');

  // an invocation that fails before it attempts a root says why as the run's error too, here a decision the version on stores
  await db.prepare(`UPDATE sync_runs SET last_error = ?1 WHERE id = ?2`).bind(
    `OVERLAY_INVALID: version ${versionId} market 1/usdc.displayName must be a non-empty string of at most 200 characters`,
    runId,
  ).run();
  t.same((await status()).alerts, [ 'sync-failing' ], 'which is then the import\'s latest failure');
});

/*
 * One failure is not an import that keeps failing. An invocation that
 * imported a market and then lost the node provider gives the next root's
 * attempt back, since the failure was the invocation's; and a root that
 * failed once against its budget is simply tried again. Either leaves the
 * run's error set until the next invocation, an hour later, and neither is
 * worth waking anyone for. A second failure the roots pay for is: another
 * root's, or the same root's again.
 */
t.test('one failure, or one given back, is not an import that keeps failing', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const runId = await recordRun(db, { status: 'running', startedAt: new Date(Date.now() - 600_000).toISOString() });
  const error = 'CHAIN_REQUEST_FAILED: a node provider request failed';
  const now   = new Date().toISOString();
  const owner = randomUUID();
  const root  = (deployment: string, status: string, attempts: number) => db.prepare(
    `INSERT INTO sync_run_items (
       id, sync_run_id, root_path, source_blob_sha, upstream_network_key, deployment_key,
       status, attempts, claim_owner, completed_at, last_error, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, 'mainnet', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
  ).bind(
    randomUUID(), runId, `deployments/mainnet/${deployment}/roots.json`, 'a'.repeat(40), deployment,
    status, attempts, owner, status === 'completed' ? now : null, status === 'failed' ? error : null, now,
  );
  const attempts = (deployment: string, spent: number) => db.prepare(
    `UPDATE sync_run_items SET attempts = ?1 WHERE sync_run_id = ?2 AND deployment_key = ?3`
  ).bind(spent, runId, deployment).run();

  // USDC imported, then the provider dropped on WETH: that attempt was given back, and WETH has spent none
  await db.batch([
    root('usdc', 'completed', 1),
    root('weth', 'failed', 0),
    db.prepare(`UPDATE sync_runs SET last_error = ?1 WHERE id = ?2`).bind(error, runId),
  ]);
  const interrupted = await status();
  t.equal(interrupted.sync.lastRun?.lastError, error, 'the run says why its latest attempt failed');
  t.same(interrupted.alerts, [], 'but an attempt given back is spent by no root, and raises nothing');

  await attempts('weth', 1);
  t.same((await status()).alerts, [], 'nor does a root that has failed once against its budget');

  await attempts('weth', 2);
  t.same((await status()).alerts, [ 'sync-failing' ], 'the same root failing again is an import that keeps failing');

  await attempts('weth', 1);
  await root('wbtc', 'failed', 1).run();
  t.same((await status()).alerts, [ 'sync-failing' ], 'and so is a second root failing beside it');
});

/*
 * An invocation stopped in the middle of a root — a deploy, or the time or
 * the CPU a Worker is given — leaves it in progress and records nothing; the
 * invocation that takes the run over records the attempt as failed, and is
 * then importing the root itself. An import whose invocations keep stopping
 * is one that keeps failing, so a root in progress counts the attempts it
 * spent before the one under way, and that one too once the lease of the
 * invocation making it has run out. That attempt is then the run's latest,
 * and failed, even where a root the invocation imported before it cleared
 * the run's error.
 */
t.test('an attempt whose invocation stopped is a failed one, and an attempt under way is not yet', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const runId = await recordRun(db, {
    status:         'running',
    leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    startedAt:      new Date(Date.now() - 4_000_000).toISOString(),
  });
  const owner = await db.prepare(`SELECT lease_owner FROM sync_runs WHERE id = ?1`).bind(runId).first<string>('lease_owner');
  const error = 'the invocation importing this root did not finish';
  const now   = new Date().toISOString();
  await db.batch([
    // an hour ago an invocation was stopped on weth; the one that took the run over recorded it, and is importing weth now
    db.prepare(
      `INSERT INTO sync_run_items (
         id, sync_run_id, root_path, source_blob_sha, upstream_network_key, deployment_key,
         status, attempts, claim_owner, last_error, created_at, updated_at
       ) VALUES (?1, ?2, 'deployments/mainnet/weth/roots.json', ?3, 'mainnet', 'weth', 'processing', 2, ?4, ?5, ?6, ?6)`
    ).bind(randomUUID(), runId, 'a'.repeat(40), owner, error, now),
    db.prepare(`UPDATE sync_runs SET last_error = ?1 WHERE id = ?2`).bind(error, runId),
  ]);
  t.same((await status()).alerts, [], 'one attempt failed and one under way is not yet an import that keeps failing');

  const attempts = (spent: number) => db.prepare(`UPDATE sync_run_items SET attempts = ?1 WHERE sync_run_id = ?2`)
    .bind(spent, runId).run();
  await attempts(3);
  t.same((await status()).alerts, [ 'sync-failing' ], 'two attempts failed are, whatever the one under way does');

  await attempts(2);
  await db.prepare(`UPDATE sync_runs SET lease_expires_at = ?1 WHERE id = ?2`)
    .bind(new Date(Date.now() - 60_000).toISOString(), runId).run();
  t.same((await status()).alerts, [ 'sync-failing' ], 'and once its lease has run out, the attempt it was making failed too');

  // a root the invocation imported before this one cleared the run's error, as every completed checkpoint does
  await db.prepare(`UPDATE sync_runs SET last_error = NULL, lease_expires_at = ?1 WHERE id = ?2`)
    .bind(new Date(Date.now() + 600_000).toISOString(), runId).run();
  await attempts(3);
  t.same((await status()).alerts, [], 'while it makes the next attempt, the latest one recorded is that success');

  await db.prepare(`UPDATE sync_runs SET lease_expires_at = ?1 WHERE id = ?2`)
    .bind(new Date(Date.now() - 60_000).toISOString(), runId).run();
  t.same((await status()).alerts, [ 'sync-failing' ],
    'but once its lease has run out, the attempt it was stopped in is the latest, and failed');
});

/*
 * A commit whose newest attempt imported every root and still did not
 * validate is one discovery stops importing: another attempt would fail the
 * same way. Whether to fix a review and force one, or to wait for the source
 * to move on, is somebody's decision, so the commit is named and raised.
 */
t.test('a commit discovery stopped importing is named', async t => {
  const db = await freshDatabase();
  const { versionId: active } = await seedCandidate(db, snapshot);
  await activateSeeded(db, active);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);
  t.equal((await status()).sync.rejectedCommit, null, 'a registry whose newest version is on has none');

  const invalid = async (attempt: number, rootsImported: boolean) => {
    const version = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt });
    await recordValidationResults(db, version.versionId, 1, [
      rootsImported
        ? { check_name: 'all-roots-imported', scope: 'global', passed: 1 }
        : { check_name: 'all-roots-imported', scope: 'global', passed: 0, details: { missing: [ 'mainnet/weth' ] } },
      { check_name: 'single-default-market', scope: 'global', passed: 0, details: { defaults: [] } },
    ]);
    await markInvalid(db, version.versionId);
    return version.versionId;
  };

  const rejected = await invalid(2, true);
  const stopped  = await status();
  t.same(
    { ...stopped.sync.rejectedCommit, createdAt: undefined },
    { sourceCommitSha: snapshot.registryVersion.sourceCommitSha, versionId: rejected, attempt: 2, createdAt: undefined },
    'the commit is named, with the attempt that decided it',
  );
  t.same(stopped.alerts, [ 'commit-rejected' ], 'and raised');

  await invalid(3, false);
  const retried = await status();
  t.equal(retried.sync.rejectedCommit, null, 'an attempt that did not import every root is retried by discovery, so is not one');
  t.same(retried.alerts, [], 'and raises nothing of its own');
});

/*
 * The hourly job reads the chain again and records what it found (drift.ts);
 * the status reads that record and asks the chain nothing. A drift of the
 * version on is raised with what it is, and a chain the check could not read
 * neither raises one nor clears one. A version switched on is checked at the
 * next invocation, and until then the drifts of the one before stand for it,
 * so the alert clears only once a check of the version on finds it agrees
 * with the chain.
 */
t.test('a version the chain has drifted from is raised, until the version on agrees with it', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);
  t.equal((await status()).chainCheck, null, 'a version never checked has no check to report');

  // each check a day after the one before, the first of them a month ago, so that each one is made
  const env   = await server.getWorker<Env>().getEnv();
  const month = Date.now() - 30 * 86_400_000;
  let days    = 0;
  const check = (chain: FakeChain) => {
    const at = new Date(month + ++days * 86_400_000);
    return checkChain({
      kv:              env.kv_registry,
      active:          () => activeSnapshot(cacheDepsOf(env)),
      transportFor:    chain.transportFor,
      intervalSeconds: 86_400,
      now:             () => at,
    });
  };
  // switches a version on, and serves it once, as the first request after the switch would
  const switchOn = async (version: string) => {
    await activateSeeded(db, version);
    t.equal((await server.fetch('/registry/v1/active')).status, 200);
  };

  const usdc  = snapshot.networks.find(network => network.chainId === 1)!.markets.find(market => market.deploymentKey === 'usdc')!;
  const comet = usdc.contracts.comet!;
  const moved = '0x3fb418b74ec30bc3e940221f58a04e16afc6378b' as Address;
  await check(fakeChain(snapshot, { changes: { [comet]: {
    collateralAssets: usdc.collateralAssets.map(asset => ({
      token:     asset.token.address,
      priceFeed: asset.assetIndex === 2 ? moved : asset.priceFeed.address,
    })),
  } } }));

  const drifted = await status();
  const weth    = usdc.collateralAssets[2]!;
  t.same(drifted.alerts, [ 'chain-drift' ], 'a drift is one condition');
  t.same(drifted.chainCheck?.drifts, [ {
    chainId: 1,
    network: 'ethereum-mainnet',
    market:  '1/usdc',
    comet,
    asset:   { role: 'collateral', assetIndex: 2, token: weth.token.address, symbol: weth.token.symbol },
    field:   'priceFeed',
    stored:  weth.priceFeed.address,
    current: moved,
    seenAt:  drifted.chainCheck?.checkedAt,
  } ], 'named by its network, market and asset, with the feed the version stores, the one the chain answers, and when it did');
  t.equal(drifted.chainCheck?.versionId, versionId, 'by a check of the version on');
  t.type(drifted.chainCheck?.checkedAt, 'string', 'and when the check ran');

  await check(fakeChain(snapshot, { unreadable: [ 'ethereum-mainnet' ] }));
  const unread = await status();
  t.same(unread.alerts, [ 'chain-drift' ], 'a chain the check could not read clears nothing');
  t.same(unread.chainCheck?.drifts, drifted.chainCheck?.drifts, 'the drift stands as it was last seen');
  t.same(
    unread.chainCheck?.unreadable,
    [ { chainId: 1, network: 'ethereum-mainnet', error: 'CHAIN_REQUEST_FAILED: a node provider request failed' } ],
    'and the chain is listed as unread',
  );

  await check(fakeChain(snapshot));
  const agreed = await status();
  t.same([ agreed.alerts, agreed.chainCheck?.drifts ], [ [], [] ], 'a version that agrees with its chain raises nothing');
  await check(fakeChain(snapshot, { changes: { [comet]: { basePriceFeed: moved } }, unreadable: [ 'ethereum-mainnet' ] }));
  t.same((await status()).alerts, [], 'nor does a chain the check could not read raise anything of its own');

  const baseMoved = fakeChain(snapshot, { changes: { [comet]: { basePriceFeed: moved } } });
  await check(baseMoved);
  t.same((await status()).alerts, [ 'chain-drift' ]);

  // a version that stores the same feed switched on, as a rollback would
  const rolledBack = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await switchOn(rolledBack.versionId);
  const switched = await status();
  t.same([ switched.alerts, switched.chainCheck?.versionId ], [ [ 'chain-drift' ], versionId ],
    'the version switched on is taken to drift as the one before it did, until it is checked');
  await check(baseMoved);
  const confirmed = await status();
  t.same([ confirmed.alerts, confirmed.chainCheck?.versionId ], [ [ 'chain-drift' ], rolledBack.versionId ],
    'which its own check confirms: it stores the feed the chain moved away from');

  // the commit imported again, which reads the feed the chain answers now, and switched on
  const reimported = {
    ...snapshot,
    networks: snapshot.networks.map(network => ({
      ...network,
      markets: network.markets.map(market => market.contracts.comet !== comet ? market : {
        ...market,
        baseAsset: { ...market.baseAsset, priceFeed: { ...market.baseAsset.priceFeed, address: moved } },
      }),
    })),
  };
  const fixed = await seedCandidate(db, reimported, { versionId: randomUUID(), attempt: 3 });
  await switchOn(fixed.versionId);
  t.same((await status()).alerts, [ 'chain-drift' ], 'a version that agrees is no exception until it is checked');
  await check(baseMoved);
  const cleared = await status();
  t.same([ cleared.alerts, cleared.chainCheck?.versionId, cleared.chainCheck?.drifts ], [ [], fixed.versionId, [] ],
    'and the check of it clears the alert');
});

t.test('the source going unchecked is an alert of its own', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const long = new Date(Date.now() - 5 * 86_400_000).toISOString();
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`).bind(long).run();

  const overdue = await status();
  t.ok((overdue.sync.upstreamAgeSeconds ?? 0) > overdue.sync.intervalSeconds * 2,
    'the age is past twice the interval the environment configures');
  t.same(overdue.alerts, [ 'sync-overdue' ]);
});

/*
 * A setting the environment sets to something it does not take is raised at
 * once, by name. Nothing else would say so before the failures it causes:
 * the import refuses to start every hour, and the source goes unchecked for
 * two days before `sync-overdue` notices.
 */
t.test('a setting the environment does not take is raised at once, by name', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  await withVars({ COMET_UPSTREAM_CHECK_INTERVAL_S: '24h' });
  const misconfigured = await status();
  t.same(misconfigured.alerts, [ 'configuration-invalid' ], 'it is one condition');
  t.same(misconfigured.configuration.invalid, [ 'COMET_UPSTREAM_CHECK_INTERVAL_S' ], 'naming the setting');
  t.equal(misconfigured.sync.intervalSeconds, 86400, 'whose default the source is measured against meanwhile');

  const sync = await server.fetch('/registry/v1/admin/sync', {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    '{}',
  });
  t.equal(sync.status, 422, 'an import is refused');
  const { error } = await sync.json() as { error: { message: string, details: { code: string } } };
  t.same(
    [ error.details.code, error.message ],
    [ 'SOURCE_CONFIGURATION_INVALID', 'COMET_UPSTREAM_CHECK_INTERVAL_S must be a positive integer' ],
    'saying which setting, and what it takes',
  );
  // the version on was held against the chain this hour already, which keeps the Cron's chain check off the network
  const scheduledTime   = new Date();
  const { kv_registry } = await server.getWorker<Env>().getEnv();
  const checked = { versionId, checkedAt: scheduledTime.toISOString(), drifts: [], unreadable: [] };
  await kv_registry.put(CHECK_KEY, JSON.stringify(checked));
  t.same(
    await server.getWorker<Env>().scheduled({ cron: '0 * * * *', scheduledTime }),
    { outcome: 'exception', noRetry: true },
    'and so is the hourly one: the Cron fails where its metrics show it, and is not run again',
  );
  t.same(await kv_registry.get(CHECK_KEY, 'json'), checked, 'while the chain, checked this hour, is not read again');

  await withVars({ REGISTRY_SNAPSHOT_CACHE_TTL_S: 'five minutes' });
  const read = await server.fetch('/registry/v1/active');
  t.equal(read.status, 200, 'a setting only reads take does not fail them');
  t.equal(read.headers.get('cache-control'), 'public, max-age=300', 'they take its default');
  t.same((await status()).configuration.invalid, [ 'REGISTRY_SNAPSHOT_CACHE_TTL_S' ], 'and it is raised all the same');
});

t.test('the status is behind the admin token', async t => {
  await freshDatabase();
  t.equal((await server.fetch('/registry/v1/admin/status')).status, 401, 'an anonymous caller is refused');
  t.equal(
    (await server.fetch('/registry/v1/admin/status', { method: 'POST', headers: auth, body: '{}' })).status,
    405,
    'and it is a read',
  );
});
