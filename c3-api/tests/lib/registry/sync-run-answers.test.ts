import t from 'tap';

import { randomUUID } from 'node:crypto';

import C3Api, { type Env } from '../../../entrypoint.js';

import { activeRegistryDatabase } from '../../util/registry-database.js';
import { ADMIN_TOKEN, adminTestEnv } from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * The administrative answers that carry a sync run: both sync run routes, and
 * the status's last run. They read the run through one summary
 * (syncRunSummary), but each lists its fields in the order it always has, and
 * the two orders differ: a body compared as text, or read in order, is what
 * it was. Every column of the seeded run holds a value of its own, so two
 * fields of one type that trade places are caught as well.
 */

// an administrative request, through the worker
function admin(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return C3Api.fetch(new Request(`https://api.test.local/registry/v1/admin/${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
  }), env);
}

// what started the run, then how far it got
const RUN_MEMBERS = [
  'id', 'registryVersionId', 'sourceCommitSha', 'trackedRef', 'triggerKind', 'requestedBy', 'reason',
  'status', 'outcome', 'leaseExpiresAt', 'expectedCount', 'completedCount', 'failedCount', 'lastError',
  'startedAt', 'completedAt',
];

const ITEM_MEMBERS = [
  'rootPath', 'upstreamNetworkKey', 'deploymentKey', 'status', 'attempts', 'completedAt', 'lastError', 'updatedAt',
];

const COMPLETED_AT = '2026-09-21T12:00:09.528Z';

// a completed run of two roots, whose lease and claim owners must not be answered
async function seededRun(db: D1Database, versionId: string): Promise<string> {
  const runId = randomUUID();
  await db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, registry_version_id, trigger_kind, requested_by, reason,
       status, outcome, lease_owner, lease_expires_at, expected_count, completed_count, failed_count,
       last_error, started_at, completed_at
     ) VALUES (
       ?1, 'a34d9b571c833b5d77f052ab8e2dbdbe10df726d', 'main', ?2, 'manual', 'test-admin',
       'a release that needs the new markets', 'completed', 'imported', 'secret-lease-owner',
       '2026-09-21T12:15:09.528Z', 7, 4, 2, 'CHAIN_REQUEST_FAILED: a node provider request failed',
       '2026-09-20T22:00:01.117Z', ?3
     )`
  ).bind(runId, versionId, COMPLETED_AT).run();

  // out of path order, which is the order the roots are answered in
  for (const [ network, key, status, attempts, completedAt, lastError, updatedAt ] of [
    [ 'mainnet',  'weth', 'failed',    5, null,                       'CHAIN_REQUEST_FAILED: the node provider did not answer', '2026-09-21T12:00:01.000Z' ],
    [ 'arbitrum', 'usdc', 'completed', 3, '2026-09-21T11:58:00.000Z', 'SOURCE_REQUEST_FAILED: GitHub did not answer',           '2026-09-21T11:58:30.000Z' ],
  ] as const) {
    await db.prepare(
      `INSERT INTO sync_run_items (
         id, sync_run_id, root_path, source_blob_sha, upstream_network_key, deployment_key,
         status, attempts, claim_owner, completed_at, last_error, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'secret-claim-owner', ?9, ?10, '2026-09-20T22:00:02.000Z', ?11)`
    ).bind(
      randomUUID(), runId, `deployments/${network}/${key}/roots.json`, 'b'.repeat(40),
      network, key, status, attempts, completedAt, lastError, updatedAt,
    ).run();
  }
  return runId;
}

t.test('a sync run route answers the run and its roots field by field, in the order it always has', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env   = await adminTestEnv({ DEBUG: '', APP_DB: registry.db });
  const runId = await seededRun(registry.db, registry.versionId);

  const read = await admin(env, `sync-runs/${runId}`);
  t.equal(read.status, 200, 'a run is read by its id');
  const { syncRun, items } = await read.json() as { syncRun: object, items: object[] };
  t.strictSame(Object.keys(syncRun), RUN_MEMBERS, 'listing what started it, then how far it got');
  t.strictSame(syncRun, {
    id:                runId,
    registryVersionId: registry.versionId,
    sourceCommitSha:   'a34d9b571c833b5d77f052ab8e2dbdbe10df726d',
    trackedRef:        'main',
    triggerKind:       'manual',
    requestedBy:       'test-admin',
    reason:            'a release that needs the new markets',
    status:            'completed',
    outcome:           'imported',
    leaseExpiresAt:    '2026-09-21T12:15:09.528Z',
    expectedCount:     7,
    completedCount:    4,
    failedCount:       2,
    lastError:         'CHAIN_REQUEST_FAILED: a node provider request failed',
    startedAt:         '2026-09-20T22:00:01.117Z',
    completedAt:       COMPLETED_AT,
  }, 'each field from its own column, and nothing else');
  t.strictSame(items.map(item => Object.keys(item)), [ ITEM_MEMBERS, ITEM_MEMBERS ], 'its roots likewise');
  t.strictSame(items, [
    {
      rootPath:           'deployments/arbitrum/usdc/roots.json',
      upstreamNetworkKey: 'arbitrum',
      deploymentKey:      'usdc',
      status:             'completed',
      attempts:           3,
      completedAt:        '2026-09-21T11:58:00.000Z',
      lastError:          'SOURCE_REQUEST_FAILED: GitHub did not answer',
      updatedAt:          '2026-09-21T11:58:30.000Z',
    },
    {
      rootPath:           'deployments/mainnet/weth/roots.json',
      upstreamNetworkKey: 'mainnet',
      deploymentKey:      'weth',
      status:             'failed',
      attempts:           5,
      completedAt:        null,
      lastError:          'CHAIN_REQUEST_FAILED: the node provider did not answer',
      updatedAt:          '2026-09-21T12:00:01.000Z',
    },
  ], 'by path, each field from its own column');

  // a run an invocation was stopped in, whose lease has run out
  const stopped = randomUUID();
  await registry.db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, trigger_kind, requested_by, status,
       lease_owner, lease_expires_at, expected_count, started_at
     ) VALUES (?1, ?2, 'main', 'scheduled', 'registry-cron', 'running', 'secret-lease-owner', ?3, 1, ?3)`
  ).bind(stopped, 'c'.repeat(40), new Date(Date.now() - 60_000).toISOString()).run();
  const cancelled = await admin(env, `sync-runs/${stopped}/cancel`, {
    method: 'POST',
    body:   JSON.stringify({ reason: 'a stored overlay no longer parses' }),
  });
  t.equal(cancelled.status, 200, 'a cancel');
  t.strictSame(Object.keys((await cancelled.json() as { syncRun: object }).syncRun), RUN_MEMBERS,
    'answers with the run in the same order');
});

t.test('the status lists its last run with the age right after completedAt, as it always has', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env   = await adminTestEnv({ DEBUG: '', APP_DB: registry.db });
  const runId = await seededRun(registry.db, registry.versionId);

  const response = await admin(env, 'status');
  t.equal(response.status, 200, 'the status is read');
  const { lastRun } = (await response.json() as { sync: { lastRun: Record<string, unknown> } }).sync;
  t.strictSame(Object.keys(lastRun), [
    'id', 'registryVersionId', 'status', 'outcome', 'startedAt', 'completedAt', 'ageSeconds',
    'failedCount', 'expectedCount', 'completedCount', 'lastError', 'leaseExpiresAt',
  ], 'the run, its age, then how far it got');

  const { ageSeconds, ...run } = lastRun;
  t.strictSame(run, {
    id:                runId,
    registryVersionId: registry.versionId,
    status:            'completed',
    outcome:           'imported',
    startedAt:         '2026-09-20T22:00:01.117Z',
    completedAt:       COMPLETED_AT,
    failedCount:       2,
    expectedCount:     7,
    completedCount:    4,
    lastError:         'CHAIN_REQUEST_FAILED: a node provider request failed',
    leaseExpiresAt:    '2026-09-21T12:15:09.528Z',
  }, 'each field from its own column, as the run read by id has it');
  const since = (Date.now() - Date.parse(COMPLETED_AT)) / 1000;
  t.ok(typeof(ageSeconds) === 'number' && Math.abs(ageSeconds - since) < 60, 'and its age counted from when it completed');
});
