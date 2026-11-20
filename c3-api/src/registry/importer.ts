import { marketKey } from '../../lib/model/comet-registry.js';

import type { Log } from '../log.js';

import { isUnreachable } from './cache.js';
import { Clock, nowOf } from './clock.js';
import { RpcTransport, enrichMarket } from './enrichment.js';
import { RegistryError, isRegistryError, isTransportFailure } from './errors.js';
import {
  applyMarketOverlay,
  applyNetworkOverlay,
  networkOverlayFeedAddresses,
  overlayFeedAddresses,
  provisionalMarketOverlay,
  provisionalNetworkOverlay,
} from './overlay.js';
import { readImportOverlays } from './overlay-store.js';
import type { ClonedOverlays } from './overlay-store.js';
import {
  ImportedMarket,
  candidateRow,
  findAttemptsByCommit,
  marketWrites,
  readActiveVersionId,
  readVersion,
  supersedeEarlierAttempts,
  supersedeStaleAttempts,
} from './repository.js';
import type { SyncRunRow } from './rows.js';
import { changedRows } from './sql-condition.js';
import {
  Fence,
  RunFinish,
  acquireRun,
  bindCandidate,
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
  progressOf,
  readRun,
  recordUpstreamCheck,
  releaseLease,
  runningRun,
  startRun,
} from './sync.js';
import {
  SourceConfig,
  assertReachableFromRef,
  listRootPaths,
  readRoot,
  resolveRef,
} from './source/github.js';
import { sourceChecksum } from './source/roots.js';
import { ALL_ROOTS_CHECK, failures, judgeVersion, verdictStatements } from './validation.js';
import type { Verdict } from './validation.js';
import { failedChecks, recorded } from './validation-store.js';

/*
 * One registry import, driven by the Cron trigger a few markets at a time.
 *
 * An invocation never assumes it can finish: it claims a root, commits that
 * market, and leaves the rest for the next invocation. Everything it needs to
 * resume lives in D1, so a deploy or a timeout costs at most the market in
 * flight. The last invocation, the one that finds no roots left, assembles
 * the candidate, validates it, and records the result.
 */
type ImporterDeps = {
  db:     D1Database,
  /*
   * Where the cause of a failure goes, and housekeeping that did not happen
   * as a warning; D1 keeps only the sanitized form of either.
   */
  debug:  Pick<Log, 'error' | 'warn'>,
  source: SourceConfig,
  // one transport per network, so each chain is read through its own endpoint
  transportFor: (network: string) => RpcTransport,
  config: {
    leaseSeconds:             number,
    marketsPerInvocation:     number,
    upstreamIntervalSeconds:  number,
  },
  actor: string,
  now?:  Clock,
};

/*
 * What any invocation may say: how many roots it processed, the run and the
 * candidate it worked on, why it did what it did, and how far the run has
 * got, in roots — how many the commit has, how many are imported, and how
 * many are still to attempt. A caller that sees `running` learns from these
 * whether the last invocation made progress, and what is left; a root that
 * exhausted its attempts is in neither of the last two.
 */
type Invocation = {
  processed:    number,
  runId?:       string,
  versionId?:   string,
  reason?:      string,
  expected?:    number,
  completed?:   number,
  outstanding?: number,
};

/*
 * What one invocation did, one kind for each thing it can have done, each
 * with what that kind always says. A caller decides by the kind, never by
 * which fields happen to be there.
 *
 * - `idle`: there was nothing to do, which is the usual answer between daily
 *   discovery windows; `reason` says why, and `versionId` names the candidate
 *   it waits on, where it waits on one.
 * - `running`: the run has roots left, for the next invocation.
 * - `held`: no root is left to attempt and the candidate is left open for
 *   review; its checks ran all the same, and `checksFailed` of them failed.
 *   A held run can have given roots up — a first import is held whatever it
 *   brought in — and `reason` then says how many, since the candidate cannot
 *   validate without them.
 * - `imported`: the candidate validated, and is a version to activate.
 * - `unchanged`: the commit is already imported, as `versionId`.
 * - `invalid`: the candidate failed its checks.
 *
 * An invocation that fails does none of these: what stopped it is raised.
 */
type InvocationResult = Invocation & (
  | { kind: 'idle', reason: string }
  | { kind: 'running', runId: string }
  | { kind: 'held', runId: string, versionId: string, reason: string, checksFailed: number }
  | { kind: 'imported', runId: string, versionId: string }
  | { kind: 'unchanged', versionId: string, reason: string }
  | { kind: 'invalid', runId: string, versionId: string, reason: string }
);

type ManualRequest = {
  sourceCommitSha?: string,
  forceNewAttempt?: boolean,
  reason?:          string,
  requestedBy?:     string,
  /*
   * Leave the candidate open once no root is left to attempt, so a market
   * the source has added can be reviewed in place before the version
   * validates. A run that gave roots up leaves one that cannot validate
   * without them, open all the same.
   */
  holdForReview?:   boolean,
  /*
   * How many markets this invocation imports. The Cron keeps to its small
   * configured batch; an operator bringing an environment up asks for the
   * whole source in one request.
   */
  markets?:         number,
};

/*
 * A commit whose roots did not all import is tried again an interval after
 * its last attempt started, then two intervals, four, and at most this many:
 * a chain that was down for a day is tried again at the next discovery, while
 * roots the source names before their contracts are deployed do not cost a
 * whole attempt every day until they are.
 */
const MAX_RETRY_INTERVALS = 8;

// diagnostics are sanitized: an upstream body or a token never reaches D1
function diagnosticOf(error: unknown): string {
  if (isRegistryError(error)) {
    return `${error.code}: ${error.message}`;
  }
  /*
   * The source and the chain fail as registry errors, so a carrier that
   * failed without one is the database: restarted, overloaded or cut off.
   * Recorded as a fault, it would send an operator looking for a bug; what
   * D1 said is in the log.
   */
  return isTransportFailure(error) || isUnreachable(error)
    ? 'the database did not answer'
    : 'an unexpected error interrupted the import';
}

/*
 * Runs what an invocation does while it holds the run, and gives the run back
 * if that fails: the next request, or the Cron, then continues it at once,
 * rather than being told for the rest of the lease that another invocation
 * is importing when none is. The release is fenced, so a lease another
 * invocation has taken over, and a run that has ended, are left as they are.
 *
 * A failure about the work rather than its carrier — a stored overlay a
 * parser refuses, or a fault — fails every invocation the same way, often
 * before any root records anything, so the run keeps it as its error. A
 * source, a provider or a database that did not answer says nothing about
 * the run, and leaves the error as it was.
 */
async function underFence<T>(deps: ImporterDeps, fence: Fence, work: (fence: Fence) => Promise<T>): Promise<T> {
  try {
    return await work(fence);
  } catch (error) {
    /*
     * A registry error is judged by its code, never by its text: a parser
     * quotes what it refused, and a key named "timeout" would otherwise pass
     * for a database that did not answer, leaving the run no error to say why.
     */
    const carrier = isTransportFailure(error) || (!isRegistryError(error) && isUnreachable(error));
    try {
      await releaseLease(deps.db, fence, carrier ? {} : { error: diagnosticOf(error) });
    } catch (unreleased) {
      // the lease then runs out, as it does for an invocation stopped outright
      deps.debug.warn(`registry lease not released`, { runId: fence.runId, error: unreleased });
    }
    throw error;
  }
}

/*
 * Whether a request is an operator's decision rather than routine scheduling:
 * it names a commit, rebuilds an attempt, or holds the candidate open. Each
 * belongs to the run created with it, needs a reason, and is acted on when it
 * is asked — the discovery interval and the retry rules are for the Cron. The
 * administrative route and the importer ask this one question, so a request
 * cannot be a decision to one of them and routine to the other.
 */
function isExplicit(request: ManualRequest): boolean {
  return request.sourceCommitSha !== undefined
    || request.forceNewAttempt === true
    || request.holdForReview === true;
}

/*
 * Whether a person asked for this invocation rather than the schedule: the
 * administrative route always says who asked, and the Cron never does.
 */
function isRequested(request: ManualRequest): boolean {
  return request.requestedBy !== undefined;
}

/*
 * What the schedule is answered when another invocation is importing: it has
 * nothing to do this hour, which is not a failure to report, and the answer
 * names the run that is importing, while there is one to name.
 */
function importingElsewhere(running: SyncRunRow | null): InvocationResult {
  return {
    kind:      'idle',
    ...(running === null ? {} : { runId: running.id }),
    ...(running === null || running.registry_version_id === null ? {} : { versionId: running.registry_version_id }),
    processed: 0,
    reason:    'another invocation is importing right now',
  };
}

/*
 * Starts an import if upstream has something this registry has not imported.
 * Discovery is bounded by its own interval: the Cron fires hourly to continue
 * work, but only asks GitHub for a new commit once a day.
 */
async function startImport(
  deps: ImporterDeps,
  request: ManualRequest = {},
): Promise<{ result: InvocationResult, fence: null } | { fence: Fence }> {
  const { db, source, config } = deps;
  const explicit = isExplicit(request);

  if (!explicit && !(await dueForDiscovery(db, { intervalSeconds: config.upstreamIntervalSeconds, now: deps.now }))) {
    return { result: { kind: 'idle', processed: 0, reason: 'upstream was checked recently' }, fence: null };
  }

  const commitSha = request.sourceCommitSha ?? await resolveRef(source);
  if (request.sourceCommitSha !== undefined) {
    await assertReachableFromRef(source, commitSha);
  }

  /*
   * Drafts of this commit older than its newest successful attempt are
   * closed before anything is decided. Otherwise the check below would find
   * such a draft still importing, call it held for review, and stop there on
   * every discovery — even once a newer attempt of the same commit had
   * validated. Closing them is housekeeping: if it fails, this call decides
   * as it did before and the next discovery tries again.
   */
  try {
    await supersedeStaleAttempts(db, source.repository, commitSha, { now: deps.now });
  } catch (error) {
    deps.debug.warn(`registry stale drafts not closed`, { error });
  }
  const attempts = await findAttemptsByCommit(db, source.repository, commitSha);

  /*
   * A candidate of this commit that is still importing, with no run left to
   * continue it, is one an operator is reviewing. Starting another attempt
   * over it would abandon that review, so only an explicit new attempt does.
   *
   * A candidate whose run is still there is not that: another invocation is
   * importing into it right now. runInvocation answers that before discovery;
   * a run started since then falls through to startRun, where the index that
   * allows one running sync refuses this one, and the answer is the one given
   * before discovery.
   */
  const held    = attempts.find(attempt => attempt.status === 'importing');
  const working = held === undefined ? null : await runningRun(db);
  if (held !== undefined && request.forceNewAttempt !== true && working?.registry_version_id !== held.id) {
    await recordUpstreamCheck(db, { now: deps.now });
    return {
      result: {
        kind: 'idle', versionId: held.id, processed: 0,
        reason: 'a candidate of this commit is held for review; validate it or force a new attempt',
      },
      fence: null,
    };
  }

  const imported = attempts.find(attempt => attempt.status === 'validated');
  if (imported !== undefined && request.forceNewAttempt !== true) {
    // upstream answered and has nothing new, so the interval starts here
    await recordUpstreamCheck(db, { now: deps.now });
    return {
      result: {
        kind: 'unchanged', versionId: imported.id, processed: 0, reason: 'the commit is already imported',
      },
      fence: null,
    };
  }

  /*
   * A commit whose newest attempt imported every root and still did not
   * validate would fail the same way again: the same source, the same chain,
   * and the decisions the attempt inherited from the one before. Discovery
   * leaves it alone until the tracked ref moves on or an operator forces an
   * attempt, rather than writing another version of it every day, and the
   * status names it. An attempt that failed because roots did not import is
   * different — a chain that did not answer, or contracts the source names
   * before they are deployed — and is tried again, each time a little later.
   */
  const newest = attempts[0];
  if (!explicit && newest?.status === 'invalid') {
    const complete = !(await failedChecks(db, newest.id)).includes(ALL_ROOTS_CHECK);
    const started  = Date.parse(await lastStartedAt(db, commitSha) ?? newest.created_at);
    const retryAt  = started + config.upstreamIntervalSeconds * 1000 * Math.min(2 ** (attempts.length - 1), MAX_RETRY_INTERVALS);
    if (complete || nowOf(deps.now).getTime() < retryAt) {
      await recordUpstreamCheck(db, { now: deps.now });
      return {
        result: {
          kind: 'idle', versionId: newest.id, processed: 0,
          reason: complete
            ? `attempt ${newest.attempt} of this commit imported every root and is invalid, `
              + `so it is not imported again by itself; force a new attempt, or wait for a new commit`
            : `attempt ${newest.attempt} of this commit did not import every root; `
              + `it is tried again after ${new Date(retryAt).toISOString()}`,
        },
        fence: null,
      };
    }
  }

  const roots = await listRootPaths(source, commitSha);
  let fence: Fence;
  try {
    fence = await startRun(db, {
      sourceCommitSha: commitSha,
      trackedRef:      request.sourceCommitSha === undefined ? source.ref : null,
      triggerKind:     explicit ? 'manual' : 'scheduled',
      requestedBy:     request.requestedBy ?? deps.actor,
      reason:          request.reason ?? null,
      roots,
      ...(request.holdForReview === true ? { holdForReview: true } : {}),
    }, { leaseSeconds: config.leaseSeconds, now: deps.now });
  } catch (error) {
    /*
     * Another invocation started a run while this one was asking the source
     * — most often an administrative sync, sent while the Cron waited on
     * GitHub — and the one running slot refused this one. It is what
     * runInvocation answers before discovery, and it is answered the same
     * way: a person who asked is told so, and the schedule has nothing to do
     * this hour. Which of the two reached the slot first is no failure.
     */
    if (isRequested(request) || !isRegistryError(error) || error.code !== 'SYNC_ALREADY_RUNNING') {
      throw error;
    }
    return { result: importingElsewhere(await runningRun(db)), fence: null };
  }

  /*
   * The discovery interval is consumed only once a run exists: a transient
   * GitHub failure between here and there must not silence discovery for the
   * rest of the interval.
   */
  await underFence(deps, fence, () => recordUpstreamCheck(db, { now: deps.now }));

  /*
   * The run is created with its lease already held, so the fence travels back
   * to the caller: re-acquiring it would correctly be refused by the very
   * lease this invocation owns.
   */
  return { fence };
}

/*
 * Imports one market: read its root at the pinned commit, read the chain, and
 * combine both with the reviewed overlay inherited from the active version.
 * Nothing is written here: the market is committed together with the
 * checkpoint that imported it.
 *
 * A market no version has reviewed is imported all the same, with the
 * provisional overlay: disabled, every capability off, marked unreviewed. Its
 * rows are what an operator reviews in place, and until then it changes
 * nothing the API serves. Refusing it instead would fail the whole commit
 * over one deployment nobody has looked at yet.
 *
 * The decisions under a deployment key were made for the Comet the key named
 * then. A key the source has since given another Comet does not hand it
 * them — its label, its creation block, whether it is served: that Comet is
 * a market nobody has reviewed, and comes in as one.
 */
async function importMarket(
  deps: ImporterDeps,
  rootPath: { rootPath: string, upstreamNetworkKey: string, deploymentKey: string, sourceBlobSha: string },
  commitSha: string,
  overlays: ClonedOverlays,
): Promise<ImportedMarket> {
  const root            = await readRoot(deps.source, commitSha, rootPath);
  const key             = marketKey(root.chainId, root.deploymentKey);
  const inherited       = overlays.markets.get(key);
  const reviewedFor     = overlays.comets.get(key);
  const reviewedMarket  = reviewedFor === root.contracts.comet ? inherited : undefined;
  const reviewedNetwork = overlays.networks.get(root.chainId);
  if (inherited !== undefined && reviewedMarket === undefined) {
    deps.debug.warn(`registry overlay not inherited: the deployment key names another Comet`, {
      market: key, reviewedFor, comet: root.contracts.comet,
    });
  }

  /*
   * The overlay names feeds without stating their scale, so their decimals
   * are read from the chain with the market's own feeds, in the same round
   * trip: the remap feeds of its network and the USD and reward feeds of the
   * market. A network or market nobody has reviewed names none.
   */
  const enrichment = await enrichMarket(deps.transportFor(root.network), root, [
    ...(reviewedNetwork === undefined ? [] : networkOverlayFeedAddresses(reviewedNetwork)),
    ...(reviewedMarket === undefined ? [] : overlayFeedAddresses(reviewedMarket)),
  ]);
  const marketOverlay  = reviewedMarket ?? provisionalMarketOverlay(root.deploymentKey, enrichment.baseToken.name);
  const networkOverlay = reviewedNetwork ?? provisionalNetworkOverlay(root.network);

  /*
   * A reviewed reward feed only makes sense with the reward token the chain
   * names. Rather than dropping the decision when the rewards contract
   * reports none, the import fails: the active version keeps the reviewed
   * feed, and an operator sees why the candidate did not validate.
   */
  if (marketOverlay.rewardPriceFeed !== null && enrichment.rewardToken === null) {
    throw new RegistryError(
      'OVERLAY_INVALID',
      `${key} has a reviewed reward feed, but its rewards contract names no reward token`,
      root.rootPath,
    );
  }

  return {
    market:  applyMarketOverlay(root, enrichment, marketOverlay, enrichment.feeds, crypto.randomUUID()),
    network: applyNetworkOverlay(
      { chainId: root.chainId, key: root.network, upstreamKey: root.upstreamNetworkKey, testnet: false },
      networkOverlay,
      [],
      enrichment.feeds,
    ),
    networkReviewed: reviewedNetwork !== undefined,
    marketReviewed:  reviewedMarket !== undefined,
  };
}

/*
 * Closes the drafts of this commit that the attempt just finished replaces.
 * It runs only when the attempt succeeded, so a forced attempt that fails
 * leaves the draft it was meant to replace open and still validatable. It is
 * housekeeping: a failure is logged, never raised, and discovery closes what
 * is left the next time it checks the commit.
 */
async function closeEarlierAttempts(deps: ImporterDeps, versionId: string): Promise<void> {
  try {
    const version = await readVersion(deps.db, versionId);
    if (version !== null) {
      await supersedeEarlierAttempts(deps.db, version, { now: deps.now });
    }
  } catch (error) {
    deps.debug.warn(`registry earlier drafts not closed`, { versionId, error });
  }
}

// how many of its roots a run gave up, as the check that every root was imported counted the markets missing
function givenUp(verdict: Verdict): string {
  const details = verdict.results.find(result => result.check_name === ALL_ROOTS_CHECK)?.details as
    { expected: number, imported: number } | undefined;
  return details === undefined ? 'roots' : `${details.expected - details.imported} of its ${details.expected} roots`;
}

/*
 * Assembles what the run imported, validates it, and gives the candidate its
 * terminal status. Validation is fail-closed: a candidate that does not pass
 * completely becomes invalid and keeps its diagnostics.
 *
 * A held run validates too, so its diagnostics are there to read, but leaves
 * the candidate importing: its markets are reviewed in place, which a
 * terminal version no longer allows, and an operator validates it once they
 * are. The first import of an environment is always held. Nothing it imports
 * can have been reviewed yet, so it could only ever end invalid.
 *
 * The results, the status they decide and the closing of the run are one
 * transaction, written only while this invocation holds the run and the
 * candidate is as it was checked: either all of it happens, or none does.
 */
async function finishCandidate(deps: ImporterDeps, fence: Fence, versionId: string): Promise<InvocationResult> {
  /*
   * A candidate that has already ended, under a run still open: a release
   * before this one wrote the two separately, and could be interrupted in
   * between. Its checks are not run again, since an ended version takes no
   * more results; the run is closed as that invocation would have closed it,
   * which is what frees a registry such a run would otherwise hold forever.
   */
  const version = await readVersion(deps.db, versionId);
  if (version !== null && version.status !== 'importing') {
    return closeEndedRun(deps, fence, versionId, version.status);
  }

  const run     = await importOf(deps.db, versionId);
  const verdict = await judgeVersion(deps.db, versionId, run === null ? null : run.roots);
  const held    = run?.holdForReview === true || await readActiveVersionId(deps.db) === null;
  const failed  = failures(verdict.results).length;

  /*
   * A run that completes with every root imported has no failure left to
   * report. An attempt that succeeds clears the run's error, so all it can
   * still carry is that of an invocation that failed outside its attempts —
   * one deciding this candidate, say — which the run has since got past. A
   * run that gave roots up keeps the latest error, which says why.
   */
  const finish: RunFinish = held || failed === 0
    ? { status: 'completed', ...(verdict.complete ? { error: null } : {}) }
    : { status: 'failed', error: 'validation failed' };
  const results = await deps.db.batch([
    ...verdictStatements(deps.db, verdict, { hold: held, when: leaseHeld(fence), at: nowOf(deps.now).toISOString() }),
    // the run closes only with the attempt that decides its candidate, which the statements before record
    finishRunStatement(deps.db, fence, finish, { now: deps.now, when: recorded(versionId, verdict.attempt) }),
  ]);
  if (changedRows(results[results.length - 1]!) !== 1) {
    return uncommitted(deps, fence, versionId);
  }

  if (held) {
    // a held candidate that has every root is a draft at least as good as any earlier one
    if (verdict.complete) {
      await closeEarlierAttempts(deps, versionId);
    }
    /*
     * A held candidate is not validated: it is left open for review. Its
     * checks still ran, and a caller told only that the import completed
     * would not know that some of them failed — nor, of a run that gave
     * roots up, that the candidate lacks their markets.
     */
    return {
      kind: 'held', runId: fence.runId, versionId, processed: 0, checksFailed: failed,
      reason: [
        verdict.complete ? 'every root is imported' : `the import gave up ${givenUp(verdict)}`,
        verdict.complete ? 'the candidate is held for review' : 'the candidate is held for review, and cannot validate without them',
        ...(failed === 0 ? [] : [ `${failed} of its checks failed` ]),
      ].join('; '),
    };
  }

  if (failed > 0) {
    return { kind: 'invalid', runId: fence.runId, versionId, processed: 0, reason: 'validation failed' };
  }
  await closeEarlierAttempts(deps, versionId);
  return { kind: 'imported', runId: fence.runId, versionId, processed: 0 };
}

/*
 * The batch that ends the candidate applied nothing. Either the lease was
 * taken over, and the invocation that took it finishes the candidate; or an
 * overlay was written to the candidate while it was being checked, and the
 * checks no longer describe it. Then the lease is released, so the next
 * invocation checks the candidate as it now is, at once.
 */
async function uncommitted(deps: ImporterDeps, fence: Fence, versionId: string): Promise<InvocationResult> {
  if (!(await releaseLease(deps.db, fence))) {
    return takenOver(deps, fence, versionId, 0);
  }
  return {
    kind: 'running', runId: fence.runId, versionId, processed: 0,
    reason: 'the candidate changed while it was being validated; the next invocation validates it again',
  };
}

/*
 * The lease was taken over: another invocation owns the run now, and this one
 * stops without writing anything more. It answers with the run as it now
 * stands — still running under that invocation, or already finished by it.
 */
async function takenOver(
  deps: ImporterDeps,
  fence: Fence,
  versionId: string | null,
  processed: number,
): Promise<InvocationResult> {
  const run    = await readRun(deps.db, fence.runId);
  const answer = {
    runId: fence.runId,
    ...(versionId === null ? {} : { versionId }),
    processed,
    ...await progressOf(deps.db, fence.runId),
  };
  return run?.status === 'running'
    ? { kind: 'running', ...answer, reason: 'the lease was taken over' }
    : { kind: 'idle', ...answer, reason: 'the lease was taken over, and the run has since finished' };
}

async function closeEndedRun(
  deps: ImporterDeps,
  fence: Fence,
  versionId: string,
  status: 'validated' | 'invalid',
): Promise<InvocationResult> {
  const closed = await finishRun(
    deps.db,
    fence,
    status === 'invalid'
      ? { status: 'failed', error: 'validation failed' }
      // a version validates only with every root imported, which leaves the run nothing to report (finishCandidate)
      : { status: 'completed', error: null },
    { now: deps.now },
  );
  if (!closed) {
    return takenOver(deps, fence, versionId, 0);
  }
  if (status === 'invalid') {
    return { kind: 'invalid', runId: fence.runId, versionId, processed: 0, reason: 'validation failed' };
  }
  await closeEarlierAttempts(deps, versionId);
  return { kind: 'imported', runId: fence.runId, versionId, processed: 0 };
}

/*
 * One Cron invocation: continue the running import, or start one. Returns
 * what it did, which is also what the administrative status endpoint reports.
 */
async function runInvocation(deps: ImporterDeps, request: ManualRequest = {}): Promise<InvocationResult> {
  const { db, config } = deps;
  const lease = { leaseSeconds: config.leaseSeconds, now: deps.now };

  /*
   * A run's commit, its attempt and whether it holds the candidate are all
   * decided when the run is created, so a request carrying any of the three
   * is asking for a new run. If one is unfinished it is refused — and
   * refused before the lease is touched: taking the lease first would abort
   * an invocation that is alive and merely overran it, losing the market it
   * was importing.
   */
  if (isExplicit(request)) {
    const unfinished = await runningRun(db);
    if (unfinished !== null) {
      throw new RegistryError(
        'SYNC_ALREADY_RUNNING',
        `an import is in progress; continue it with an empty body, or wait for it to finish`,
        unfinished.id,
      );
    }
  }

  let fence = await acquireRun(db, lease);
  if (fence === null) {
    /*
     * A run that is running but could not be taken is held by an invocation
     * that is importing right now. There is nothing to start and nothing this
     * one may continue, and that is decided before discovery, which would
     * otherwise ask the source for a commit only to have the one running slot
     * refuse it — or answer that nothing was due, when something is running.
     *
     * A person who asked is told so. The schedule has nothing to do this
     * hour, which is not a failure to report, and its answer names the run
     * that is importing.
     */
    const running = await runningRun(db);
    if (running !== null) {
      if (isRequested(request)) {
        throw new RegistryError(
          'SYNC_ALREADY_RUNNING',
          `another invocation is importing right now; send the request again once it has finished its part`,
          running.id,
        );
      }
      return importingElsewhere(running);
    }
    const started = await startImport(deps, request);
    if (started.fence === null) {
      return started.result;
    }
    fence = started.fence;
  }

  return underFence(deps, fence, held => continueRun(deps, held, request));
}

// what an invocation does with the run it holds: import a batch of its roots, or decide its candidate
async function continueRun(deps: ImporterDeps, fence: Fence, request: ManualRequest): Promise<InvocationResult> {
  const { db, config } = deps;
  const lease = { leaseSeconds: config.leaseSeconds, now: deps.now };

  const run = await readRun(db, fence.runId);
  if (run === null) {
    return { kind: 'idle', processed: 0, reason: 'the run disappeared' };
  }

  /*
   * The candidate is created by the first invocation of a run and reused by
   * the ones that continue it, so markets accumulate in one version.
   */
  let versionId = run.registry_version_id;
  if (versionId === null) {
    const [ newest ] = await findAttemptsByCommit(db, deps.source.repository, run.source_commit_sha);
    const version = candidateRow({
      repository: deps.source.repository,
      commitSha:  run.source_commit_sha,
      /*
       * The checkpoints carry the git object id of every roots.json, so the
       * candidate can name its exact source before a single root has been
       * read, and a rerun of the same commit produces the same identity.
       */
      sourceChecksum: await sourceChecksum(await checkpointsOf(db, fence.runId)),
      attempt:   (newest?.attempt ?? 0) + 1,
      /*
       * Whoever asked for the run: the operator whose administrative sync
       * started it, whatever the request asked for, or the schedule, which a
       * run it started names as its requester too. Whichever invocation
       * reaches this first, the version is the run's.
       */
      createdBy: run.requested_by ?? deps.actor,
      createdAt: nowOf(deps.now).toISOString(),
    });
    if (!(await bindCandidate(db, fence, version, { now: deps.now }))) {
      return takenOver(deps, fence, null, 0);
    }
    versionId = version.id;
  }

  /*
   * At most one attempt per root in one invocation. A failed root goes back
   * into the pool, so a batch larger than what is outstanding would claim it
   * again straight away — and a chain that is briefly down would burn every
   * retry of every root inside a single request.
   */
  const batch = Math.min(request.markets ?? config.marketsPerInvocation, (await progressOf(db, fence.runId)).outstanding);
  // the overlays only matter to a market about to be imported, and an invocation that only finishes reads none
  const overlays = batch === 0 ? null : await readImportOverlays(db, versionId);
  let processed = 0;
  // roots this invocation actually imported, which is what tells a failure apart from an interruption
  let imported  = 0;
  // every root this invocation has claimed, so none of them is claimed twice
  const tried: string[] = [];
  while (overlays !== null && processed < batch) {
    const item = await claimItem(db, fence, { now: deps.now, except: tried });
    if (item === null) {
      break;
    }
    tried.push(item.id);
    let committed: boolean;
    try {
      const market = await importMarket(deps, {
        rootPath:           item.root_path,
        upstreamNetworkKey: item.upstream_network_key,
        deploymentKey:      item.deployment_key,
        sourceBlobSha:      item.source_blob_sha,
      }, run.source_commit_sha, overlays);
      committed = await completeItem(db, fence, item.id, {
        ...lease,
        writes: await marketWrites(db, versionId, market),
      });
      imported += 1;
    } catch (error) {
      const message = diagnosticOf(error);
      /*
       * D1 keeps the sanitized code, because an upstream body or a token
       * must never be written where diagnostics are read. The cause itself
       * goes to the logs, where it is the only way to tell which limit or
       * which provider ended the invocation.
       */
      deps.debug.error(`registry root failed`, { rootPath: item.root_path, error });
      /*
       * A transport failure in an invocation that has already imported
       * something is the invocation running out — of the subrequests or the
       * time a Worker is given — rather than anything about this root, so it
       * does not spend one of the root's five attempts. That is what stops a
       * large source from exhausting every root's budget in five invocations
       * and leaving a candidate that can never be completed.
       *
       * An invocation that has imported nothing gets no such benefit: a chain
       * or a provider that answers for no root at all is a failure this run
       * has to end on, or it would hold the one running slot forever and the
       * registry would stop following the source.
       */
      const interrupted = isTransportFailure(error) && imported > 0;
      committed = await failItem(db, fence, { id: item.id, error: message }, { ...lease, refund: interrupted });
    }
    /*
     * A checkpoint that does not commit means the lease was taken over while
     * this market was being imported, and neither the market nor its
     * checkpoint was written: they commit together, under the fence. The
     * invocation that replaced this one is redoing the work, so stopping here
     * is what keeps two invocations out of one candidate.
     */
    if (!committed) {
      return takenOver(deps, fence, versionId, processed);
    }
    processed++;
  }

  const progress = await progressOf(db, fence.runId);
  if (progress.outstanding > 0) {
    // more roots remain: release the fence so the next invocation continues
    await releaseLease(db, fence);
    return { kind: 'running', runId: fence.runId, versionId, processed, ...progress };
  }

  /*
   * Deciding the candidate changes none of these counts, so they are not
   * read again: once the run is closed the import has happened, and a
   * database that stops answering now must not answer it as a failure.
   */
  const finished = await finishCandidate(deps, fence, versionId);
  return { ...finished, processed, ...progress };
}

export type { ImporterDeps, InvocationResult, ManualRequest };

export {
  isExplicit,
  isRequested,
  runInvocation,
};
