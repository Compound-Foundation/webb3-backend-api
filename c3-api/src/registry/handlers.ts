import {
  ActivationAction,
  MarketV1,
  NetworkV1,
  RegistrySnapshotV1,
  VERSION_STATUSES,
  isAddress,
  marketKey,
  normalizeAddress,
} from '../../lib/model/comet-registry.js';

import { matchesIfNoneMatch } from '../http/conditional.js';
import { ApiError } from '../http/errors.js';
import { jsonResponse } from '../http/json.js';

import type { CachedSnapshot, PinnedVersion } from './cache.js';
import { registryHeaders } from './version-headers.js';
import type { VersionRef } from './version-headers.js';
import {
  activateVersion,
  readActivationHistory,
  readActiveVersionId,
  readMarket,
  readNetworkOverlay,
  readSnapshot,
  readUnreviewed,
  readValidationSummary,
  readVersion,
  readVersions,
} from './repository.js';
import { compareVersions } from './changes.js';
import { isServed, servedNetworks } from './catalog.js';
import { orderNetworks, overlayDigest, overlayOfMarket, parseMarketOverlay } from './overlay.js';
import { validateStoredVersion } from './admin.js';
import { cancelRun } from './sync.js';

/*
 * The registry HTTP handlers. They resolve a version, shape the response, and
 * say which version answered; routing and authentication happen around them.
 *
 * Every successful read that resolved a version carries its id and checksum,
 * in headers and in the body, so a client can tell two snapshots apart
 * without parsing the whole payload. The one response that cannot is the
 * no-active 503: there is no version to name.
 */
type RegistryContext = {
  db:    D1Database,
  actor: string,
  // the id the request is answered under, so a line logged about what it came to can name it
  requestId: string,
  /*
   * Where a failure that is not the caller's goes, and a degradation the
   * registry recovered from; the routes never return either.
   */
  debug: {
    error: (...parameters: unknown[]) => unknown,
    warn:  (...parameters: unknown[]) => unknown,
  },
  /*
   * The active snapshot as the cache resolves it: from this isolate's memory
   * or from KV where the pointer D1 reports names a version they already
   * hold, and from the last good version where D1 did not answer at all.
   * Every public read of the active version goes through this, so all of
   * them are cached the same and every stale answer says so; an
   * administrative read that only needs the active version's id still asks
   * D1 directly, because it is asking what is true now.
   */
  active: () => Promise<CachedSnapshot | null>,
  /*
   * A validated version by id, as the cache resolves it: the reference that
   * names its bytes first, so a client that already holds them is answered
   * from that alone, and the bytes only when they are sent.
   */
  version: (versionId: string) => Promise<PinnedVersion | null>,
  /*
   * Caches the bytes of a version that is not active yet. Serializing a
   * snapshot is the expensive half of answering, and after an activation
   * every isolate would pay it at once; a validated candidate is immutable,
   * so it is paid for here instead, while nobody is waiting.
   */
  warm: (versionId: string) => Promise<void>,
};

const SCHEMA_VERSION = 1;

/*
 * The revision of what these routes send for a version. A body is the version
 * as this release presents it, and a release can change that for a version
 * that is already active: the one that stopped listing a network with no
 * served market did. A tag that named the version alone would then confirm,
 * with a 304, a copy an earlier release sent, for as long as that version
 * stays active; so a release that changes what a route sends for a version
 * that already exists moves this on.
 */
const REPRESENTATION_REVISION = 2;

/*
 * The strong ETag of one representation: schema version, the revision of what
 * is sent, what was asked for, the version id, and its checksum. It needs
 * nothing but the reference to the version, so a conditional request is
 * decided before any of its bytes are read.
 *
 * The representation is part of it because these routes serve different
 * bodies from the same version. An ETag that named the version alone would
 * let a conditional request for one route be answered 304 while the client
 * holds another route's body.
 */
function etagOf({ id, checksum }: VersionRef, representation: string): string {
  return `"v${SCHEMA_VERSION}-r${REPRESENTATION_REVISION}-${representation}-${id}-${checksum}"`;
}

function versionRef(snapshot: RegistrySnapshotV1): VersionRef {
  return { id: snapshot.registryVersion.id, checksum: snapshot.registryVersion.checksum };
}

/*
 * A cacheable snapshot response, honoring If-None-Match as RFC 9110 reads it
 * (matchesIfNoneMatch): `*`, a list of tags, and the weak form of this tag,
 * which is what a browser sends back for a response Cloudflare compressed.
 * The body is immutable for a version, so a matching ETag needs no body at
 * all, and the body is built only when it is sent.
 */
async function snapshotResponse(
  request: Request,
  ref: VersionRef,
  representation: string,
  body: () => unknown,
  { maxAge, staleFor }: { maxAge: number, staleFor?: number | null },
): Promise<Response> {
  const etag    = etagOf(ref, representation);
  /*
   * A stale answer is the version that was active when D1 last answered, and
   * it must not be stored anywhere: not in a browser, not in a CDN, not under
   * a conditional request. It names its own age, so a client that cares can
   * refuse it.
   */
  const stale   = staleFor !== undefined && staleFor !== null;
  const headers = {
    'ETag':          etag,
    'Cache-Control': `public, max-age=${maxAge}`,
    // which a stale answer replaces with no-store, beside its age
    ...registryHeaders(ref, staleFor),
  };
  /*
   * A stale answer is never confirmed: a 304 tells a client the copy it
   * holds is still the current one, which is exactly what an answer the
   * database could not verify must not say.
   */
  if (!stale && matchesIfNoneMatch(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return jsonResponse(await body(), { headers });
}

/*
 * The version as the API serves it: without the markets it refuses to
 * resolve, and without the networks that leaves with none.
 *
 * A `disabled` market is part of the stored version, and an operator sees it
 * through the administrative routes, but no public read may offer one: the
 * market routes answer 404 for it and the request catalog does not
 * materialize it, so listing it would advertise something unusable.
 *
 * A network whose every market is disabled serves nothing. A chain the
 * source has just added arrives that way — under its canonical name, with
 * nothing about it reviewed — and listing it would offer a network nobody
 * decided to offer. A network whose markets are deprecated is still served,
 * because positions and history in them must stay reachable.
 */
function selectable(snapshot: RegistrySnapshotV1): RegistrySnapshotV1 {
  return {
    ...snapshot,
    networks: servedNetworks(snapshot).map(({ network, markets }) => ({ ...network, markets })),
  };
}

async function activeSnapshot(context: RegistryContext): Promise<CachedSnapshot> {
  const active = await context.active();
  if (active === null) {
    throw new ApiError('REGISTRY_NOT_ACTIVE', `No active registry snapshot is available`);
  }
  return active;
}

function networkOf(snapshot: RegistrySnapshotV1, chainId: number): NetworkV1 {
  const network = snapshot.networks.find(candidate => candidate.chainId === chainId);
  if (network === undefined) {
    throw new ApiError('NOT_FOUND', `chain ${chainId} is not part of the active registry`);
  }
  return network;
}

/*
 * A chain id has one spelling: decimal digits without a leading zero, no
 * larger than a number holds exactly, which is also the bound the schema puts
 * on every chain id it stores. `Number()` alone would read `0x1`, `01`, `1e0`
 * and `1.0` as chain 1 too, giving one resource many URLs, each cached on its
 * own. Every chain id a path or a document key carries is read here.
 */
const CHAIN_ID = /^[1-9][0-9]*$/;

function chainIdOf(value: string): number {
  const chainId = Number(value);
  if (!CHAIN_ID.test(value) || !Number.isSafeInteger(chainId)) {
    throw new ApiError('BAD_REQUEST', `${value} is not a chain id`);
  }
  return chainId;
}

/*
 * A market is addressed by its Comet address. A disabled market is not
 * selectable, so it answers 404 even though it stays in the snapshot for
 * diagnostics; a deprecated one is still readable, because positions and
 * history in it must remain reachable.
 */
function marketOf(network: NetworkV1, address: string): MarketV1 {
  if (!isAddress(address)) {
    throw new ApiError('BAD_REQUEST', `${address} is not an address`);
  }
  const comet  = normalizeAddress(address);
  const market = network.markets.find(candidate => candidate.contracts.comet === comet);
  if (market === undefined || !isServed(market)) {
    throw new ApiError('NOT_FOUND', `no selectable market at ${comet} on chain ${network.chainId}`);
  }
  return market;
}

/*
 * Public reads. The convenience routes serve the same objects and the same
 * order as the bootstrap snapshot; none of them resolves "latest" on its own.
 */
async function getActive(request: Request, context: RegistryContext, maxAge: number): Promise<Response> {
  const { snapshot, staleFor } = await activeSnapshot(context);
  return snapshotResponse(request, versionRef(snapshot), 'snapshot', () => selectable(snapshot), { maxAge, staleFor });
}

async function getNetworks(request: Request, context: RegistryContext, maxAge: number): Promise<Response> {
  const { snapshot, staleFor } = await activeSnapshot(context);
  return snapshotResponse(request, versionRef(snapshot), 'networks', () => ({
    registryVersion: versionRef(snapshot),
    // the summary omits markets, which the market routes serve
    networks: selectable(snapshot).networks.map(({ markets: _markets, ...network }) => network),
  }), { maxAge, staleFor });
}

async function getMarkets(request: Request, context: RegistryContext, chainId: string, maxAge: number): Promise<Response> {
  const { snapshot, staleFor } = await activeSnapshot(context);
  // the same selectability rule the market route and the catalog apply
  const network  = networkOf(selectable(snapshot), chainIdOf(chainId));
  return snapshotResponse(request, versionRef(snapshot), `markets:${network.chainId}`, () => ({
    registryVersion: versionRef(snapshot),
    chainId:         network.chainId,
    markets:         network.markets,
  }), { maxAge, staleFor });
}

async function getMarket(
  request: Request,
  context: RegistryContext,
  chainId: string,
  cometAddress: string,
  maxAge: number,
): Promise<Response> {
  const { snapshot, staleFor } = await activeSnapshot(context);
  const network  = networkOf(snapshot, chainIdOf(chainId));
  const market   = marketOf(network, cometAddress);
  return snapshotResponse(request, versionRef(snapshot), `market:${network.chainId}:${market.contracts.comet}`, () => ({
    registryVersion: versionRef(snapshot),
    chainId:         network.chainId,
    market,
  }), { maxAge, staleFor });
}

/*
 * A retained validated version by id, so a session can refetch the exact
 * snapshot it pinned even after another version was activated.
 *
 * It is read through the cache as the active version is: a client that
 * already holds the version is answered 304 from the version's reference
 * alone, and the bytes come from this isolate or KV before D1. The route is
 * anonymous and the active version's id is in every response's headers, so
 * a request here must not cost D1 a hydration each time it is made.
 */
async function getVersion(request: Request, context: RegistryContext, versionId: string, maxAge: number): Promise<Response> {
  const version = await context.version(versionId);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no validated registry version with that id`);
  }
  return snapshotResponse(request, version.ref, 'snapshot', async () => {
    const snapshot = await version.snapshot();
    if (snapshot === null) {
      throw new ApiError('NOT_FOUND', `no validated registry version with that id`);
    }
    return selectable(snapshot);
  }, { maxAge });
}

/*
 * Administrative reads and commands. They never serve a cached body: an
 * operator asking about a candidate needs its current state.
 */
/*
 * Every version, newest first: what an operator reads to find the id of the
 * draft they are working on, or of the version to roll back to.
 *
 * It is a summary per version — what it was built from and what became of it
 * — and never a snapshot: a listing that carried the markets of every version
 * would be the largest response in the API and the least useful one.
 */
const MAX_VERSIONS = 100;

async function getVersions(context: RegistryContext, query: URLSearchParams): Promise<Response> {
  const status = query.get('status') ?? undefined;
  if (status !== undefined && !(VERSION_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError('BAD_REQUEST', `status must be one of ${VERSION_STATUSES.join(', ')}`);
  }

  const requested = query.get('limit');
  const limit     = requested === null ? 20 : Number(requested);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VERSIONS) {
    throw new ApiError('BAD_REQUEST', `limit must be an integer from 1 to ${MAX_VERSIONS}`);
  }

  /*
   * A page past the first starts after the version `before` names: the
   * `next` of the page before it. A version that does not exist is not a
   * place in the listing, and is refused rather than answered as its end.
   */
  const before = query.get('before') ?? undefined;
  if (before !== undefined && await readVersion(context.db, before) === null) {
    throw new ApiError('NOT_FOUND', `before names no registry version`);
  }

  const { versions, activeVersionId, next } = await readVersions(context.db, {
    ...(status === undefined ? {} : { status }),
    ...(before === undefined ? {} : { before }),
    limit,
  });

  return jsonResponse({
    activeVersionId,
    next,
    versions: versions.map(version => ({
      id:               version.id,
      status:           version.status,
      attempt:          version.attempt,
      isActive:         version.is_active === 1,
      sourceRepository: version.source_repository,
      sourceCommitSha:  version.source_commit_sha,
      snapshotChecksum: version.snapshot_checksum,
      createdAt:        version.created_at,
      validatedAt:      version.validated_at,
      createdBy:        version.created_by,
    })),
  });
}

async function getVersionDetail(context: RegistryContext, versionId: string): Promise<Response> {
  const version = await readVersion(context.db, versionId);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }
  // three reads that do not depend on each other, so one round trip of waiting rather than three
  const [ validation, activations, unreviewed ] = await Promise.all([
    readValidationSummary(context.db, versionId),
    readActivationHistory(context.db, versionId),
    readUnreviewed(context.db, versionId),
  ]);
  return jsonResponse({
    version: {
      id:               version.id,
      status:           version.status,
      attempt:          version.attempt,
      sourceRepository: version.source_repository,
      sourceCommitSha:  version.source_commit_sha,
      sourceChecksum:   version.source_checksum,
      snapshotChecksum: version.snapshot_checksum,
      createdAt:        version.created_at,
      validatedAt:      version.validated_at,
      createdBy:        version.created_by,
    },
    validation,
    activations,
    /*
     * The networks and markets this version imported that nobody has
     * reviewed: disabled, with every capability off, until someone decides
     * how they are served. For the first version of an environment that is
     * everything; later it is whatever the source has added.
     */
    unreviewed,
  });
}

/*
 * One import run and its per-root checkpoints. The lease owner is a secret
 * that fences concurrent invocations, so it is never part of the answer; the
 * expiry is, because that is what tells an operator when the run becomes
 * resumable.
 */
async function getSyncRun(context: RegistryContext, syncRunId: string): Promise<Response> {
  const run = await context.db.prepare(`SELECT * FROM sync_runs WHERE id = ?1`).bind(syncRunId).first<SyncRunRecord>();
  if (run === null || run === undefined) {
    throw new ApiError('NOT_FOUND', `no sync run with that id`);
  }

  const items = await context.db.prepare(
    `SELECT root_path, upstream_network_key, deployment_key, status, attempts,
            completed_at, last_error, updated_at
     FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`
  ).bind(syncRunId).all<SyncRunItemRecord>();

  return syncRunResponse(run, items.results ?? []);
}

type SyncRunRecord = {
  id: string, source_commit_sha: string, tracked_ref: string | null, registry_version_id: string | null,
  trigger_kind: string, requested_by: string | null, reason: string | null, status: string,
  outcome: string | null, lease_expires_at: string | null, expected_count: number,
  completed_count: number, failed_count: number, last_error: string | null,
  started_at: string, completed_at: string | null,
};

type SyncRunItemRecord = {
  root_path: string, upstream_network_key: string, deployment_key: string,
  status: string, attempts: number, completed_at: string | null,
  last_error: string | null, updated_at: string,
};

/*
 * What both sync run routes answer: the run read by id, or as a cancel left
 * it. Every field is named, so neither owner a row carries leaves the worker.
 */
function syncRunResponse(run: SyncRunRecord, items: SyncRunItemRecord[]): Response {
  return jsonResponse({
    syncRun: {
      id:                run.id,
      registryVersionId: run.registry_version_id,
      sourceCommitSha:   run.source_commit_sha,
      trackedRef:        run.tracked_ref,
      triggerKind:       run.trigger_kind,
      requestedBy:       run.requested_by,
      reason:            run.reason,
      status:            run.status,
      outcome:           run.outcome,
      leaseExpiresAt:    run.lease_expires_at,
      expectedCount:     run.expected_count,
      completedCount:    run.completed_count,
      failedCount:       run.failed_count,
      lastError:         run.last_error,
      startedAt:         run.started_at,
      completedAt:       run.completed_at,
    },
    items: items.map(item => ({
      rootPath:           item.root_path,
      upstreamNetworkKey: item.upstream_network_key,
      deploymentKey:      item.deployment_key,
      status:             item.status,
      attempts:           item.attempts,
      completedAt:        item.completed_at,
      lastError:          item.last_error,
      updatedAt:          item.updated_at,
    })),
  });
}

/*
 * Ends a run no invocation can finish (cancelRun), answered with the run as
 * the cancel left it. A run that has ended is refused, and so is one an
 * invocation holds, which may be importing into it, until its lease has run
 * out.
 */
async function cancelSyncRun(context: RegistryContext, syncRunId: string, reason: string): Promise<Response> {
  const { cancelled, run, items } = await cancelRun(context.db, syncRunId, { actor: context.actor, reason });
  if (run === null) {
    throw new ApiError('NOT_FOUND', `no sync run with that id`);
  }
  if (!cancelled) {
    throw new ApiError('CONFLICT', run.status !== 'running'
      ? `the sync run has already ended; it is ${run.status}`
      : `an invocation holds the sync run until ${run.lease_expires_at}; cancel it once that has passed`);
  }
  return syncRunResponse(run, items);
}

/*
 * What a version changes against the version that is on: the markets it adds
 * or drops, and every fact and decision of the others that differs.
 *
 * It answers for a candidate that is still importing as well, because that is
 * when an operator describes a market the source has added, and the facts the
 * import read for it are where that starts.
 * Without a version that is on, everything the version holds is added.
 */
async function getChanges(context: RegistryContext, versionId: string): Promise<Response> {
  const [ version, activeId ] = await Promise.all([
    readVersion(context.db, versionId),
    readActiveVersionId(context.db),
  ]);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }

  // the two versions and the review state are read side by side, not one after another
  const [ after, before, unreviewed ] = await Promise.all([
    readSnapshot(context.db, versionId),
    activeId === null ? null : readSnapshot(context.db, activeId),
    readUnreviewed(context.db, versionId),
  ]);

  return jsonResponse({
    versionId,
    status:       version.status,
    comparedWith: activeId,
    ...compareVersions(before === null ? null : orderNetworks(before), orderNetworks(after), new Set(unreviewed.markets)),
  });
}

/*
 * The overlay of one market of a version, in the form its PUT takes. A market
 * nobody has reviewed answers with the provisional decisions its import
 * wrote, and says so.
 *
 * `digest` names the reviewed overlay, the one a PUT's `expectedDigest` is
 * compared with, and is null for a market nobody has reviewed: a change read
 * here and sent back with it is refused if the market changed in between.
 */
async function getMarketOverlay(
  context: RegistryContext,
  versionId: string,
  chainId: number,
  deploymentKey: string,
): Promise<Response> {
  const scope = marketKey(chainId, deploymentKey);
  // the one market, not every row of the version, and the version beside it
  const [ version, market, unreviewed ] = await Promise.all([
    readVersion(context.db, versionId),
    readMarket(context.db, versionId, { chainId, deploymentKey }),
    readUnreviewed(context.db, versionId),
  ]);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }
  if (market === null) {
    throw new ApiError('NOT_FOUND', `${scope} is not in this registry version`);
  }

  const overlay  = overlayOfMarket(market);
  const reviewed = !unreviewed.markets.includes(scope);
  return jsonResponse({
    versionId,
    scope,
    reviewed,
    digest: reviewed ? await overlayDigest(parseMarketOverlay(overlay, scope)) : null,
    overlay,
  });
}

/*
 * The same for one network. A network overlay is replaced whole, so a change
 * to it starts from what the version holds: one built from what another
 * version serves would drop every exception this one has and that one lacks.
 */
async function getNetworkOverlay(context: RegistryContext, versionId: string, chainId: number): Promise<Response> {
  const [ version, network ] = await Promise.all([
    readVersion(context.db, versionId),
    readNetworkOverlay(context.db, versionId, chainId),
  ]);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }
  if (network === null) {
    throw new ApiError('NOT_FOUND', `chain ${chainId} is not in this registry version`);
  }
  return jsonResponse({
    versionId,
    scope:    String(chainId),
    reviewed: network.reviewed,
    digest:   network.reviewed ? await overlayDigest(network.overlay) : null,
    overlay:  network.overlay,
  });
}

/*
 * A validation that ran answers 200 whatever it decided: an invalid version
 * is the outcome of the command, not a failure of it, and `version.status`
 * says which it is, beside the checks that decided it. A command that could
 * not run — the import still running, the candidate changed under it — is
 * answered in the error envelope, as every route answers a failure.
 */
async function postValidate(context: RegistryContext, versionId: string): Promise<Response> {
  const result = await validateStoredVersion(context.db, versionId);
  if (result.version.status === 'validated') {
    await context.warm(versionId);   // never throws: see the router
  }
  return jsonResponse({ version: result.version, changed: result.changed, summary: result.summary });
}

async function postActivation(
  context: RegistryContext,
  versionId: string,
  action: ActivationAction,
  reason: string,
  expectation: { expectedActiveVersionId?: string | null } = {},
): Promise<Response> {
  // a version that does not exist is not a state conflict, and answers as every other route does
  if (await readVersion(context.db, versionId) === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }
  const result = await activateVersion(context.db, { versionId, action, actor: context.actor, reason, ...expectation });
  /*
   * A rollback names a version that was validated long ago, and whose bytes
   * the hourly prune may have removed from KV: it keeps only the active
   * version, the one the pointer record names and the validated ones newer
   * than the active one (pruneSnapshots). So the warm-up happens here too:
   * the pointer has already moved, and the first request must not be the one
   * that rebuilds it.
   */
  await context.warm(result.registryVersion.id);
  return jsonResponse(result, { headers: registryHeaders(result.registryVersion) });
}

export type { RegistryContext };

export {
  cancelSyncRun,
  chainIdOf,
  getActive,
  getChanges,
  getMarket,
  getMarketOverlay,
  getMarkets,
  getNetworkOverlay,
  getNetworks,
  getSyncRun,
  getVersion,
  getVersions,
  getVersionDetail,
  postActivation,
  postValidate,
};
