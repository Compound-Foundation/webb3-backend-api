import type { Env } from '../../entrypoint.js';

import { marketKey } from '../../lib/model/comet-registry.js';

import { cacheStatus } from './cache.js';
import type { CacheDeps } from './cache.js';
import { registryConfig } from './config.js';
import { readChainCheck } from './drift.js';
import type { ChainCheck, ChainDrift, UnreadNetwork } from './drift.js';
import { ALL_ROOTS_CHECK } from './validation.js';

/*
 * One document that says whether the registry is healthy, for an operator
 * looking and for a monitor polling.
 *
 * It is deliberately one request: the things that go wrong here are spread
 * across the version table, the run table and the cache, and an alert built
 * from three endpoints is an alert nobody builds. What it reports is the
 * state; `alerts` is that state reduced to the names of the conditions worth
 * waking someone for, so a check can be "alerts is empty" without teaching
 * the monitor the registry's rules.
 */
type Alert =
  | 'configuration-invalid'
  | 'no-active-version'
  | 'candidate-awaiting-review'
  | 'candidate-awaiting-activation'
  | 'candidate-drops-markets'
  | 'commit-rejected'
  | 'chain-drift'
  | 'last-sync-failed'
  | 'sync-failing'
  | 'sync-overdue'
  | 'sync-stalled'
  | 'snapshot-not-cached'
  | 'cache-unreadable';

type RegistryStatus = {
  environment: string,
  checkedAt:   string,
  // the registry settings this environment sets to something they do not take
  configuration: {
    invalid: string[],
  },
  active: {
    versionId:   string,
    checksum:    string,
    activatedAt: string | null,
    activatedBy: string | null,
    ageSeconds:  number | null,
  } | null,
  cache: {
    snapshotCached:    boolean,
    pointerAgeSeconds: number | null,
    readable:          boolean,
  },
  sync: {
    lastRun: {
      id:                string,
      // the version the run imports into, null until it has created one
      registryVersionId: string | null,
      status:            string,
      outcome:           string | null,
      startedAt:         string,
      completedAt:       string | null,
      ageSeconds:        number,
      failedCount:       number,
      expectedCount:     number,
      completedCount:    number,
      lastError:         string | null,
      leaseExpiresAt:    string | null,
    } | null,
    upstreamCheckedAt: string | null,
    upstreamAgeSeconds: number | null,
    intervalSeconds:    number,
    // the commit discovery no longer imports by itself, and the attempt that decided it
    rejectedCommit: {
      sourceCommitSha: string,
      versionId:       string,
      attempt:         number,
      createdAt:       string,
    } | null,
  },
  candidates: {
    importing: Array<{
      versionId:  string,
      attempt:    number,
      createdAt:  string,
      unreviewed: { networks: number, markets: number },
    }>,
    // validated versions newer than the active one that were never switched on
    validated: Array<{
      versionId:   string,
      attempt:     number,
      createdAt:   string,
      validatedAt: string | null,
      // the markets of the active version whose Comet it does not serve, by their keys there
      unserved:    string[],
    }>,
    invalid: number,
  },
  /*
   * The last time the chain was read again (drift.ts), for the version it
   * names: where it disagrees with that version, and the networks it could
   * not be read for. It is a check of the version on, but for the hour after
   * another version is switched on, until the next hourly invocation checks
   * that one. Null until a version has been checked.
   */
  chainCheck: {
    versionId:  string,
    checkedAt:  string,
    ageSeconds: number | null,
    drifts:     ChainDrift[],
    unreadable: UnreadNetwork[],
  } | null,
  alerts: Alert[],
};

type StateRow = {
  active_version_id:        string | null,
  last_upstream_checked_at: string | null,
};

type ActiveRow = {
  id:          string,
  checksum:    string,
  activated_at: string | null,
  actor:        string | null,
};

type RunRow = {
  id: string, registry_version_id: string | null, status: string, outcome: string | null,
  started_at: string, completed_at: string | null, failed_count: number, expected_count: number,
  completed_count: number, last_error: string | null, lease_expires_at: string | null,
};

type CandidateRow = { id: string, attempt: number, created_at: string, status: string };

type CountRow = { version_id: string, markets?: number, networks?: number };

// at most this many open drafts are listed; there is never more than a handful in a healthy environment
const MAX_CANDIDATES = 20;

/*
 * Once a version is on, the scheduled import validates a new commit by
 * itself, and the result waits for somebody to switch it on. Only what is
 * newer than every version ever switched on is news: a version rolled back
 * from, or one skipped for a newer one, is not raised again when a rollback
 * goes further back. These are the newest of them, as many as are listed.
 */
const AWAITING_ACTIVATION = `
  SELECT version.id
  FROM registry_versions AS version
  WHERE version.status = 'validated'
    AND version.created_at > COALESCE((
      SELECT MAX(activated.created_at)
      FROM registry_versions AS activated
      WHERE EXISTS (SELECT 1 FROM registry_activations WHERE registry_version_id = activated.id)
    ), '')
  ORDER BY version.created_at DESC LIMIT ?1`;

function countsBy(rows: CountRow[] | undefined, field: 'markets' | 'networks'): Map<string, number> {
  return new Map((rows ?? []).map(row => [ row.version_id, row[field] ?? 0 ]));
}

function ageOf(timestamp: string | null, now: Date): number | null {
  if (timestamp === null) {
    return null;
  }
  const at = Date.parse(timestamp);
  return Number.isFinite(at) ? Math.round((now.getTime() - at) / 1000) : null;
}

/*
 * How long a run may sit untouched before nobody is continuing it. The Cron
 * fires hourly, so two hours without an item moving means the trigger is not
 * firing, or every invocation fails before it claims anything.
 */
const STALLED_AFTER_SECONDS = 2 * 60 * 60;

/*
 * A run nobody is continuing. Two shapes of it: a lease still held but
 * expired, which the next invocation takes over by itself, and — the
 * ordinary one — a lease released at the end of an invocation that left work
 * behind, which has no expiry at all. Both are stalled only once nothing has
 * moved for long enough that the next invocation should have come and gone.
 */
function stalled(run: RunRow | null, lastItemAt: string | null, now: Date): boolean {
  if (run === null || run.status !== 'running') {
    return false;
  }
  const expiry = run.lease_expires_at === null ? null : Date.parse(run.lease_expires_at);
  if (expiry !== null && Number.isFinite(expiry) && expiry >= now.getTime()) {
    // somebody holds the lease and is importing right now
    return false;
  }
  const idle = ageOf(lastItemAt ?? run.started_at, now);
  return idle !== null && idle > STALLED_AFTER_SECONDS;
}

/*
 * A run that keeps failing. Every attempt at a root moves the run, so one
 * whose attempts all fail is never stalled: each hourly invocation spends an
 * attempt of a root or two and leaves the run running, until every root has
 * spent all five — about three days for a source of twenty-nine markets.
 * What tells it apart is that its latest attempt failed, which an attempt
 * that succeeds clears, and that this is not the only failure: the roots
 * still failed have spent this many attempts between them, two roots once or
 * one root twice. One failure is not yet a pattern, and an attempt the
 * importer gave back — the invocation had imported a market, then lost the
 * source or the node provider, or ran out of what a Worker is given — is
 * spent by no root, so it raises nothing by itself.
 *
 * An attempt whose invocation stopped in the middle of it — a deploy, or the
 * time or the CPU a Worker is given — recorded nothing, and has failed all
 * the same. The invocation that takes the run over records it (acquireRun).
 * Until then, once the lease of the one making it has run out, it counts
 * among the attempts spent, and it is the run's latest attempt, which failed,
 * whatever error the run still carries from the one before: none, where that
 * one succeeded. The attempt a live invocation is making counts for nothing
 * yet, and the ones before it on the same root count as the failures they
 * were.
 *
 * The run's error can also be that of an invocation that failed before it
 * attempted a root — on a decision a version stores that a parser refuses,
 * or on a fault (importer.ts, underFence) — and it counts as the latest
 * failure all the same. Such an invocation moves no root, so a run that
 * every invocation fails on that way is stalled as well, in time.
 */
const FAILING_AFTER_ATTEMPTS = 2;

function failing(run: RunRow | null, failedAttempts: number, stopped: boolean): boolean {
  return run !== null && run.status === 'running' && (run.last_error !== null || stopped)
    && failedAttempts >= FAILING_AFTER_ATTEMPTS;
}

/*
 * The last chain check. Right after another version is switched on it is
 * still the check of the version before, until the next hourly invocation
 * checks the one on; it is answered all the same, under the version it is
 * of. A namespace that does not answer is `cache-unreadable`'s to say; the
 * check is then unknown.
 */
async function chainCheckOf(deps: CacheDeps, now: Date): Promise<RegistryStatus['chainCheck']> {
  let check: ChainCheck | null;
  try {
    check = await readChainCheck(deps.kv);
  } catch (error) {
    deps.debug?.warn(`registry chain check unreadable`, { error });
    return null;
  }
  if (check === null) {
    return null;
  }
  return {
    versionId:  check.versionId,
    checkedAt:  check.checkedAt,
    ageSeconds: ageOf(check.checkedAt, now),
    drifts:     check.drifts,
    unreadable: check.unreadable,
  };
}

async function registryStatus(env: Env, deps: CacheDeps): Promise<RegistryStatus> {
  const now = deps.now?.() ?? new Date();
  const db  = deps.db;

  const [
    state, active, run, candidates, unreviewedMarkets, unreviewedNetworks, lastItem, invalid, validated, unserved, rejected,
  ] = await db.batch([
    db.prepare(`SELECT active_version_id, last_upstream_checked_at FROM registry_state WHERE singleton_id = 1`),
    db.prepare(
      `SELECT version.id AS id, version.snapshot_checksum AS checksum,
              activation.created_at AS activated_at, activation.actor AS actor
       FROM registry_state AS state
       JOIN registry_versions AS version ON version.id = state.active_version_id
       LEFT JOIN registry_activations AS activation
         ON activation.registry_version_id = version.id
        AND activation.created_at = (
          SELECT MAX(created_at) FROM registry_activations WHERE registry_version_id = version.id
        )
       WHERE state.singleton_id = 1`
    ),
    db.prepare(
      `SELECT id, registry_version_id, status, outcome, started_at, completed_at, failed_count,
              expected_count, completed_count, last_error, lease_expires_at
       FROM sync_runs ORDER BY started_at DESC LIMIT 1`
    ),
    /*
     * The open candidates, bounded: an environment that has accumulated
     * drafts must not turn the status into the most expensive read in the
     * API, on an endpoint a monitor polls.
     */
    db.prepare(
      `SELECT id, attempt, created_at, status FROM registry_versions
       WHERE status = 'importing' ORDER BY created_at DESC LIMIT ?1`
    ).bind(MAX_CANDIDATES),
    db.prepare(
      `SELECT market.registry_version_id AS version_id, COUNT(*) AS markets
       FROM markets AS market
       JOIN registry_versions AS version ON version.id = market.registry_version_id
       WHERE version.status = 'importing' AND market.reviewed = 0
       GROUP BY market.registry_version_id`
    ),
    db.prepare(
      `SELECT network.registry_version_id AS version_id, COUNT(*) AS networks
       FROM registry_networks AS network
       JOIN registry_versions AS version ON version.id = network.registry_version_id
       WHERE version.status = 'importing' AND network.reviewed = 0
       GROUP BY network.registry_version_id`
    ),
    /*
     * When an item last moved; the attempts the roots still failed have
     * spent: every one of a failed root, and every one of a root in progress
     * but the one a live invocation is making; and whether a root is in
     * progress under an invocation that is no longer live, whose attempt is
     * then the run's latest, and failed (FAILING_AFTER_ATTEMPTS).
     */
    db.prepare(
      `SELECT MAX(item.updated_at) AS last_item_at,
              COALESCE(SUM(CASE
                WHEN item.status = 'failed' THEN item.attempts
                WHEN item.status <> 'processing' THEN 0
                WHEN item.claim_owner = run.lease_owner AND run.lease_expires_at > ?1 THEN item.attempts - 1
                ELSE item.attempts
              END), 0) AS failed_attempts,
              COALESCE(MAX(CASE
                WHEN item.status <> 'processing' THEN 0
                WHEN item.claim_owner = run.lease_owner AND run.lease_expires_at > ?1 THEN 0
                ELSE 1
              END), 0) AS stopped
       FROM sync_run_items AS item
       JOIN sync_runs AS run ON run.id = item.sync_run_id
       WHERE item.sync_run_id = (SELECT id FROM sync_runs ORDER BY started_at DESC LIMIT 1)`
    ).bind(now.toISOString()),
    db.prepare(`SELECT COUNT(*) AS count FROM registry_versions WHERE status = 'invalid'`),
    db.prepare(
      `SELECT version.id, version.attempt, version.created_at, version.validated_at
       FROM registry_versions AS version
       WHERE version.id IN (${AWAITING_ACTIVATION})
       ORDER BY version.created_at DESC`
    ).bind(MAX_CANDIDATES),
    /*
     * What each of them would stop serving, switched on: every market the
     * active version serves whose Comet it serves under no key of the same
     * chain. A dropped deployment, a renamed one nobody has reviewed under
     * its new key, and a key the source gave another Comet all read the same
     * here, and every one of them is a market users lose.
     */
    db.prepare(
      `SELECT candidate.id AS version_id, network.chain_id, market.deployment_key
       FROM registry_versions AS candidate
       JOIN registry_state AS state ON state.singleton_id = 1
       JOIN markets AS market ON market.registry_version_id = state.active_version_id
       JOIN registry_networks AS network ON network.id = market.network_id
       JOIN market_contracts AS comet ON comet.market_id = market.id AND comet.role = 'comet'
       WHERE candidate.id IN (${AWAITING_ACTIVATION})
         AND market.status <> 'disabled'
         AND NOT EXISTS (
           SELECT 1
           FROM markets AS kept
           JOIN registry_networks AS kept_network ON kept_network.id = kept.network_id
           JOIN market_contracts AS kept_comet ON kept_comet.market_id = kept.id AND kept_comet.role = 'comet'
           WHERE kept.registry_version_id = candidate.id AND kept.status <> 'disabled'
             AND kept_network.chain_id = network.chain_id AND kept_comet.address = comet.address
         )
       ORDER BY network.chain_id, market.deployment_key`
    ).bind(MAX_CANDIDATES),
    /*
     * A commit discovery has stopped importing: the newest version there is
     * ended invalid although its import brought in every root. Another
     * attempt would fail the same way, so discovery leaves the commit alone
     * until the ref moves on or somebody forces an attempt — and somebody has
     * to decide which.
     */
    db.prepare(
      `SELECT version.id, version.source_commit_sha, version.attempt, version.created_at
       FROM registry_versions AS version
       WHERE version.id = (SELECT id FROM registry_versions ORDER BY created_at DESC, attempt DESC LIMIT 1)
         AND version.status = 'invalid'
         AND NOT EXISTS (
           SELECT 1 FROM validation_results AS result
           WHERE result.registry_version_id = version.id AND result.check_name = ?1 AND result.passed = 0
             AND result.validation_attempt = (
               SELECT MAX(validation_attempt) FROM validation_results WHERE registry_version_id = version.id
             )
         )`
    ).bind(ALL_ROOTS_CHECK),
  ]);

  const stateRow     = (state.results?.[0] ?? null) as StateRow | null;
  const activeRow    = (active.results?.[0] ?? null) as ActiveRow | null;
  const runRow       = (run.results?.[0] ?? null) as RunRow | null;
  const importing    = (candidates.results ?? []) as CandidateRow[];
  const invalidCount = ((invalid.results?.[0] ?? { count: 0 }) as { count: number }).count;
  const dropped      = new Map<string, string[]>();
  for (const row of (unserved.results ?? []) as Array<{ version_id: string, chain_id: number, deployment_key: string }>) {
    dropped.set(row.version_id, [ ...(dropped.get(row.version_id) ?? []), marketKey(row.chain_id, row.deployment_key) ]);
  }
  const awaiting     = ((validated.results ?? []) as Array<{ id: string, attempt: number, created_at: string, validated_at: string | null }>)
    .map(version => ({
      versionId:   version.id,
      attempt:     version.attempt,
      createdAt:   version.created_at,
      validatedAt: version.validated_at,
      unserved:    dropped.get(version.id) ?? [],
    }));
  const rejectedRow  = (rejected.results?.[0] ?? null) as { id: string, source_commit_sha: string, attempt: number, created_at: string } | null;
  const items        = (lastItem.results?.[0] ?? null) as { last_item_at: string | null, failed_attempts: number, stopped: number } | null;

  const pointer    = activeRow === null ? null : { id: activeRow.id, checksum: activeRow.checksum };
  const cache      = await cacheStatus(deps, pointer);
  const chainCheck = pointer === null ? null : await chainCheckOf(deps, now);

  const config      = registryConfig(env);
  const upstreamAge = ageOf(stateRow?.last_upstream_checked_at ?? null, now);
  const interval    = config.upstreamIntervalSeconds;

  const marketsOpen  = countsBy(unreviewedMarkets.results as CountRow[] | undefined, 'markets');
  const networksOpen = countsBy(unreviewedNetworks.results as CountRow[] | undefined, 'networks');
  const unreviewed   = importing.map(candidate => ({
    versionId:  candidate.id,
    attempt:    candidate.attempt,
    createdAt:  candidate.created_at,
    unreviewed: {
      networks: networksOpen.get(candidate.id) ?? 0,
      markets:  marketsOpen.get(candidate.id) ?? 0,
    },
  }));

  const alerts: Alert[] = [];
  if (config.invalid.length > 0) {
    /*
     * A setting the environment sets to something it does not take: the
     * import refuses to start over one of its own, and a read takes the
     * default in its place. Nothing else would say so before the failures it
     * causes did — for the interval, not until the source had gone unchecked
     * for twice the default.
     */
    alerts.push('configuration-invalid');
  }
  if (!cache.readable) {
    // the namespace did not answer: there is no cache, and no fallback either
    alerts.push('cache-unreadable');
  }
  if (pointer === null) {
    alerts.push('no-active-version');
  } else if (cache.readable && !cache.snapshotCached) {
    /*
     * The bytes of the active version are not cached, so every cold isolate
     * hydrates the snapshot out of D1 again. It is not an outage; it is the
     * warm-up having failed or expired, and it is the first thing to look at
     * when D1 reads climb.
     */
    alerts.push('snapshot-not-cached');
  }
  if (unreviewed.length > 0 && runRow?.status !== 'running') {
    alerts.push('candidate-awaiting-review');
  }
  if (awaiting.length > 0) {
    alerts.push('candidate-awaiting-activation');
  }
  if (awaiting.some(version => version.unserved.length > 0)) {
    /*
     * Nothing holds such a version back: the scheduled import validates it
     * like any other, and switching it on is allowed. Upstream removing a
     * deployment is upstream's decision; what this asks is that somebody
     * sees which markets go before they do.
     */
    alerts.push('candidate-drops-markets');
  }
  if (rejectedRow !== null) {
    alerts.push('commit-rejected');
  }
  if (chainCheck !== null && chainCheck.drifts.length > 0) {
    /*
     * The version on describes a market otherwise than its chain does now.
     * Until a version switched on has been checked, the drifts of the one
     * before it stand for it, so the alert clears only once a check of the
     * version on finds it agrees with the chain. A network the check could
     * not read keeps the drifts the last read of it found: a chain that does
     * not answer neither raises a drift nor clears one.
     */
    alerts.push('chain-drift');
  }
  if (runRow?.status === 'failed') {
    alerts.push('last-sync-failed');
  }
  if (failing(runRow, items?.failed_attempts ?? 0, items?.stopped === 1)) {
    alerts.push('sync-failing');
  }
  if (stalled(runRow, items?.last_item_at ?? null, now)) {
    alerts.push('sync-stalled');
  }
  /*
   * Discovery is due once per interval; twice that without a check means the
   * Cron has not run, or every invocation has failed before recording one.
   */
  if (upstreamAge === null || upstreamAge > interval * 2) {
    alerts.push('sync-overdue');
  }

  return {
    environment:   env.ENVIRONMENT,
    checkedAt:     now.toISOString(),
    configuration: { invalid: config.invalid },
    active: activeRow === null ? null : {
      versionId:   activeRow.id,
      checksum:    activeRow.checksum,
      activatedAt: activeRow.activated_at,
      activatedBy: activeRow.actor,
      ageSeconds:  ageOf(activeRow.activated_at, now),
    },
    cache,
    sync: {
      lastRun: runRow === null ? null : {
        id:                runRow.id,
        registryVersionId: runRow.registry_version_id,
        status:            runRow.status,
        outcome:           runRow.outcome,
        startedAt:         runRow.started_at,
        completedAt:       runRow.completed_at,
        ageSeconds:        ageOf(runRow.completed_at ?? runRow.started_at, now) ?? 0,
        failedCount:       runRow.failed_count,
        expectedCount:     runRow.expected_count,
        completedCount:    runRow.completed_count,
        lastError:         runRow.last_error,
        leaseExpiresAt:    runRow.lease_expires_at,
      },
      upstreamCheckedAt:  stateRow?.last_upstream_checked_at ?? null,
      upstreamAgeSeconds: upstreamAge,
      intervalSeconds:    interval,
      rejectedCommit:     rejectedRow === null ? null : {
        sourceCommitSha: rejectedRow.source_commit_sha,
        versionId:       rejectedRow.id,
        attempt:         rejectedRow.attempt,
        createdAt:       rejectedRow.created_at,
      },
    },
    candidates: { importing: unreviewed, validated: awaiting, invalid: invalidCount },
    chainCheck,
    alerts,
  };
}

export type { Alert, RegistryStatus };
export { registryStatus };
