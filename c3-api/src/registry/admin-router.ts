import type { Env } from '../../entrypoint.js';

import { SyncOutcome, parseMarketKey } from '../../lib/model/comet-registry.js';

import { authenticateAdmin } from '../http/bearer-auth.js';
import { clientOf } from '../http/client-address.js';
import { ApiError, methodNotAllowed } from '../http/errors.js';
import { MAX_BODY_BYTES, jsonResponse, readJsonObject } from '../http/json.js';

import { cacheDepsOf } from './cache.js';
import { readCreationBlocks, readFeeds } from './enrichment.js';
import { registryStatus } from './status.js';
import {
  CreationReader,
  FeedReader,
  OverlayDocuments,
  replaceMarketOverlay,
  replaceNetworkOverlay,
  replaceOverlays,
} from './admin.js';
import {
  RegistryContext,
  applyProposal,
  cancelSyncRun,
  chainIdOf,
  getChanges,
  getMarketOverlay,
  getNetworkOverlay,
  getProposal,
  getProposalReview,
  getShadow,
  getSyncRun,
  getVersionDetail,
  getVersions,
  postActivation,
  postValidate,
} from './handlers.js';
import { isExplicit } from './importer.js';
import type { InvocationResult } from './importer.js';
import { runRegistrySync, transportFor } from './scheduled.js';

/*
 * Reads the decimals of the feeds an overlay introduces, through the same
 * node provider path the importer uses. An overlay states which feed to use;
 * the chain states its scale.
 */
function feedReader(env: Env): FeedReader {
  const transport = transportFor(env);
  return async (network, addresses) => addresses.length === 0
    ? new Map()
    : readFeeds(transport(network), addresses, network);
}

// holds the creation blocks an overlay states against the chain, the same way
function creationReader(env: Env): CreationReader {
  const transport = transportFor(env);
  return (network, markets) => readCreationBlocks(transport(network), markets, network);
}

/*
 * The authenticated administrative routes, behind two rate limiters.
 *
 * The first counts every request under the administrative prefix by the
 * client's address, before its token is checked or its path matched: a
 * caller guessing tokens, or paths, pays for every guess. The second counts
 * an authenticated request by its credential and its route family: it
 * protects the registry from a stuck script or a runaway retry loop, while
 * the D1 sync fence remains the real concurrency authority.
 *
 * Callers sharing one token share the second budget. That is a property of
 * the credential, not of the limiter: the environment configures a single
 * token hash, so two operators using it are indistinguishable here and in the
 * audit rows alike. Issuing separate tokens is what would separate them.
 */
const ROUTES = [
  { pattern: /^\/registry\/v1\/admin\/sync$/,                                                  method: 'POST', handler: 'sync',           family: 'sync' },
  { pattern: /^\/registry\/v1\/admin\/sync-runs\/([^/]+)$/,                                    method: 'GET',  handler: 'syncRun',        family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/sync-runs\/([^/]+)\/cancel$/,                            method: 'POST', handler: 'cancelSyncRun',  family: 'sync' },
  { pattern: /^\/registry\/v1\/admin\/shadow$/,                                                method: 'GET',  handler: 'shadow',         family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/status$/,                                                method: 'GET',  handler: 'status',         family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions$/,                                              method: 'GET',  handler: 'versions',       family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)$/,                                     method: 'GET',  handler: 'version',        family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/shadow$/,                             method: 'GET',  handler: 'shadow',         family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/changes$/,                            method: 'GET',  handler: 'changes',        family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/validate$/,                           method: 'POST', handler: 'validate',       family: 'validate' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/activate$/,                           method: 'POST', handler: 'activate',       family: 'activate' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/rollback$/,                           method: 'POST', handler: 'rollback',       family: 'activate' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/networks\/([^/]+)\/overlay$/,         method: 'PUT',  handler: 'networkOverlay', family: 'overlay' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/networks\/([^/]+)\/overlay$/,         method: 'GET',  handler: 'readNetworkOverlay', family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/markets\/([^/]+)\/([^/]+)\/overlay$/, method: 'PUT',  handler: 'marketOverlay',  family: 'overlay' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/markets\/([^/]+)\/([^/]+)\/overlay$/, method: 'GET',  handler: 'readMarketOverlay', family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/overlays$/,                            method: 'PUT',  handler: 'overlays',       family: 'overlay' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/proposal$/,                           method: 'GET',  handler: 'proposal',       family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/proposal\/review$/,                   method: 'GET',  handler: 'proposalReview', family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/proposal\/apply$/,                    method: 'POST', handler: 'applyProposal',  family: 'overlay' },
] as const;

const MAX_REASON = 1000;

/*
 * How many markets one administrative sync imports. The Cron keeps to a
 * small batch because it runs unattended every hour; an operator bringing an
 * environment up wants the whole source in one request, so that is the
 * default here.
 *
 * A market costs seven subrequests — its root from GitHub, three rounds of
 * reads from the node, three D1 statements or batches — and a run about
 * thirty besides: the whole source of twenty-nine markets is about 230, and
 * the ceiling about 380, inside the 10,000 subrequests and 1,000 D1 queries
 * the Workers Paid plan gives an invocation (README, "Workers Plan") and far
 * beyond the Free plan's 50.
 */
const MAX_MARKETS_PER_REQUEST = 50;

/*
 * A reviewed directory in one request. Every network and market of a registry
 * fits several times over; the bound keeps the write one D1 batch of a size
 * the other administrative writes already produce, and the body limit is
 * raised for this route alone because a directory is what it carries.
 */
const MAX_OVERLAYS_PER_REQUEST = 100;
const MAX_OVERLAYS_BODY_BYTES  = 512 * 1024;

/*
 * A reason is required wherever an operator changes what the registry serves,
 * because the audit row that records the change is only as useful as the
 * reason stored with it.
 */
function requireReason(body: Record<string, unknown>): string {
  const reason = body.reason;
  if (typeof(reason) !== 'string' || reason.trim().length === 0 || reason.length > MAX_REASON) {
    throw new ApiError('BAD_REQUEST', `a non-empty reason of at most ${MAX_REASON} characters is required`);
  }
  return reason.trim();
}

function requireExactKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(body).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ApiError('BAD_REQUEST', `unexpected properties: ${unexpected.sort().join(', ')}`);
  }
}

/*
 * What a command says it was decided against, where it says it: absent says
 * nothing, null says there was nothing, and anything else must look like
 * what it names. A value of the wrong shape is refused rather than ignored,
 * because ignoring it would drop the very precondition its sender relied on.
 */
function optionalExpectation(body: Record<string, unknown>, name: string, shape: RegExp, what: string): { value?: string | null } {
  const value = body[name];
  if (value === undefined) {
    return {};
  }
  if (value !== null && (typeof(value) !== 'string' || !shape.test(value))) {
    throw new ApiError('BAD_REQUEST', `${name} must be null or ${what}`);
  }
  return { value };
}

const OVERLAY_DIGEST = /^[0-9a-f]{64}$/;

function expectedDigestOf(body: Record<string, unknown>): { expectedDigest?: string | null } {
  const { value } = optionalExpectation(body, 'expectedDigest', OVERLAY_DIGEST, 'the 64 hex characters of an overlay digest');
  return value === undefined ? {} : { expectedDigest: value };
}

/*
 * `expectedActiveVersionId` names the version an activation or a rollback is
 * decided against, so a move made against a version someone else has since
 * replaced is refused instead of silently undoing theirs.
 */
function expectedActiveVersionOf(body: Record<string, unknown>): { expectedActiveVersionId?: string | null } {
  const { value } = optionalExpectation(body, 'expectedActiveVersionId', /^[0-9A-Za-z-]{1,64}$/, 'a registry version id');
  return value === undefined ? {} : { expectedActiveVersionId: value };
}

/*
 * The period every environment configures for both administrative limiters
 * (wrangler.toml [3]). A refused caller is told to wait it out: by then its
 * count has started again, whenever in the period it was refused.
 */
const RATE_LIMIT_PERIOD_SECONDS = 60;

// a refusal says which budget ran out, since the two are waited out the same way but spent differently
function rateLimited(message: string): ApiError {
  return new ApiError('RATE_LIMITED', message, undefined, { 'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS) });
}

/*
 * The key of a request that names no client address. A request through
 * Cloudflare's edge always has one; a local run and a test may not, and
 * share this one budget.
 */
const NO_ADDRESS = 'no-address';

/*
 * What every request under the administrative prefix spends first, before
 * its token is checked and before its path is matched, from the budget of
 * the address Cloudflare saw it come from (`CF-Connecting-IP`) — of its /64,
 * for an IPv6 client, which can send from any address of it (clientOf).
 *
 * Counting only the requests that fail would not slow guessing down: a right
 * guess answers 200 and would never be counted. Counting after the match
 * would leave the paths no route takes, which answer 404, free to enumerate.
 * An operator and a monitor polling the status fit inside the budget many
 * times over; a guess at a token at that pace gets nowhere.
 */
async function limitAddress(env: Env, request: Request): Promise<void> {
  const address = request.headers.get('cf-connecting-ip');
  const key     = `registry-admin-auth:${address === null || address.length === 0 ? NO_ADDRESS : clientOf(address)}`;
  const allowed = await env.REGISTRY_ADMIN_AUTH_RATE_LIMITER.limit({ key });
  if (!allowed.success) {
    throw rateLimited(`too many administrative requests from this address`);
  }
}

/*
 * The limiter key names the credential, never the token: `fingerprint` is a
 * prefix of the token's SHA-256, which distinguishes two configured tokens
 * without carrying either one into a key that is logged and counted.
 */
async function limit(env: Env, fingerprint: string, family: string): Promise<void> {
  const allowed = await env.REGISTRY_ADMIN_RATE_LIMITER.limit({ key: `registry-admin:${fingerprint}:${family}` });
  if (!allowed.success) {
    throw rateLimited(`too many ${family} requests with this token`);
  }
}

type SyncFailure = Extract<InvocationResult, { kind: 'invalid' | 'failed' }>;

/*
 * The error an administrative sync answers with when the invocation failed.
 *
 * A registry error is answered as the routes answer it everywhere: a request
 * the registry has to refuse, such as a commit the tracked ref cannot reach,
 * is the client's to fix. A candidate that failed its checks would fail the
 * same way again, so it is refused with the ids to inspect it by rather than
 * offered as something to retry. A database or a source that did not answer
 * is a 503; a fault never reaches here — it is raised, and answered 500.
 */
function syncFailure(result: SyncFailure): Error {
  switch (result.kind) {
    case 'invalid':
      return new ApiError('UNPROCESSABLE', result.reason, {
        syncRunId:         result.runId,
        registryVersionId: result.versionId,
      });
    case 'failed':
      return result.error ?? new ApiError('UPSTREAM_UNAVAILABLE', result.reason);
  }
}

/*
 * What an administrative sync answers with when the invocation did not fail:
 * the run's status, and for one that completed, what it produced. A held
 * candidate completed its import as one that validated did, and says that it
 * is held, and how many of its checks failed.
 */
function syncAnswer(result: Exclude<InvocationResult, SyncFailure>): {
  status:        'idle' | 'running' | 'completed',
  outcome:       SyncOutcome | null,
  heldForReview: boolean,
  checksFailed:  number,
} {
  switch (result.kind) {
    case 'idle':
    case 'running':
      return { status: result.kind, outcome: null, heldForReview: false, checksFailed: 0 };
    case 'held':
      return { status: 'completed', outcome: 'imported', heldForReview: true, checksFailed: result.checksFailed };
    case 'imported':
      return { status: 'completed', outcome: 'imported', heldForReview: false, checksFailed: 0 };
    case 'unchanged':
      return { status: 'completed', outcome: 'no_change', heldForReview: false, checksFailed: 0 };
  }
}

/*
 * Starts or continues an import. A manual request may pin an explicit commit
 * or force a new attempt, and both require a reason: they are decisions, not
 * routine scheduling.
 *
 * `holdForReview` leaves the candidate open once no root is left to attempt,
 * so a market the source has added can be reviewed in place before anything
 * validates the version; a run that gave roots up leaves one that cannot
 * validate without them. `markets` bounds how much of the source this one
 * request imports.
 */
async function postSync(
  env: Env,
  body: Record<string, unknown>,
  { actor, requestId }: Pick<RegistryContext, 'actor' | 'requestId'>,
): Promise<Response> {
  requireExactKeys(body, [ 'sourceCommitSha', 'forceNewAttempt', 'holdForReview', 'markets', 'reason' ]);

  const sourceCommitSha = body.sourceCommitSha;
  const forceNewAttempt = body.forceNewAttempt ?? false;
  const holdForReview   = body.holdForReview ?? false;
  const markets         = body.markets ?? MAX_MARKETS_PER_REQUEST;
  if (sourceCommitSha !== undefined && (typeof(sourceCommitSha) !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommitSha))) {
    throw new ApiError('BAD_REQUEST', `sourceCommitSha must be a 40 character commit sha`);
  }
  if (typeof(forceNewAttempt) !== 'boolean') {
    throw new ApiError('BAD_REQUEST', `forceNewAttempt must be a boolean`);
  }
  if (typeof(holdForReview) !== 'boolean') {
    throw new ApiError('BAD_REQUEST', `holdForReview must be a boolean`);
  }
  if (typeof(markets) !== 'number' || !Number.isInteger(markets) || markets < 1 || markets > MAX_MARKETS_PER_REQUEST) {
    throw new ApiError('BAD_REQUEST', `markets must be an integer from 1 to ${MAX_MARKETS_PER_REQUEST}`);
  }
  const request = {
    ...(sourceCommitSha === undefined ? {} : { sourceCommitSha: sourceCommitSha as string }),
    ...(forceNewAttempt ? { forceNewAttempt: true } : {}),
    ...(holdForReview ? { holdForReview: true } : {}),
    markets,
    requestedBy: actor,
  };
  /*
   * A routine sync has no decision to keep a reason with, and one that
   * continues a run has nowhere to keep it, so the reason is refused rather
   * than dropped where the audit would never show it.
   */
  if (body.reason !== undefined && !isExplicit(request)) {
    throw new ApiError('BAD_REQUEST', `a reason is taken only with sourceCommitSha, forceNewAttempt or holdForReview`);
  }
  /*
   * Holding a candidate open leaves the commit unimported until someone acts
   * on it, which is a decision like the other two. The importer asks the
   * same question, so what needs a reason here is also what it acts on at
   * once rather than at the next discovery.
   */
  const result = await runRegistrySync(
    env,
    isExplicit(request) ? { ...request, reason: requireReason(body) } : request,
    { requestId },
  );

  if (result.kind === 'invalid' || result.kind === 'failed') {
    throw syncFailure(result);
  }
  const { status, outcome, heldForReview, checksFailed } = syncAnswer(result);
  return jsonResponse({
    syncRunId:         result.runId ?? null,
    registryVersionId: result.versionId ?? null,
    status,
    outcome,
    processed:         result.processed,
    /*
     * How far the run has got, so a caller can see that an import which
     * answers `running` is making progress: how many roots the commit has,
     * how many are imported, and how many this invocation left to attempt.
     */
    expected:          result.expected ?? null,
    completed:         result.completed ?? null,
    outstanding:       result.outstanding ?? null,
    heldForReview,
    checksFailed,
    reason:            result.reason ?? null,
  }, {
    /*
     * 202 while the import has work left, which a later request continues;
     * 200 once this request is the answer: the import completed, or there
     * was nothing to do.
     */
    status: status === 'running' ? 202 : 200,
  });
}

function documentsOf(value: unknown, name: string): Array<[ string, unknown ]> {
  if (value === undefined) {
    return [];
  }
  if (typeof(value) !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError('BAD_REQUEST', `${name} must be an object keyed by what each overlay reviews`);
  }
  return Object.entries(value);
}

/*
 * `expectedDigests` is to a directory what `expectedDigest` is to one
 * document, keyed as the documents are: a chain id for a network, and
 * `chainId/deploymentKey` for a market, which no chain id can be. A document
 * it names nothing for is written whatever its scope holds. A key that names
 * no document of the request is refused, as a digest of the wrong shape is:
 * ignored, it would drop the precondition its sender relied on.
 */
function expectedDigestsOf(body: Record<string, unknown>, documents: string[]): Map<string, { expectedDigest: string | null }> {
  return new Map(documentsOf(body.expectedDigests, 'expectedDigests').map(([ key, digest ]) => {
    if (!documents.includes(key)) {
      throw new ApiError('BAD_REQUEST', `expectedDigests names ${key}, which this request has no overlay for`);
    }
    if (digest !== null && (typeof(digest) !== 'string' || !OVERLAY_DIGEST.test(digest))) {
      throw new ApiError('BAD_REQUEST', `expectedDigests.${key} must be null or the 64 hex characters of an overlay digest`);
    }
    return [ key, { expectedDigest: digest } ];
  }));
}

/*
 * The body of `PUT /versions/{id}/overlays`: network overlays keyed by chain
 * id, market overlays keyed by `chainId/deploymentKey`, what each was decided
 * against, and the one reason every audit event of the request is stored
 * with.
 *
 * A key spells its chain id the one way a path does (chainIdOf), which is
 * how the proposal's bundle writes it, so a key names its scope as written:
 * no two keys of one document review the same network or market.
 */
function overlayDocuments(body: Record<string, unknown>, versionId: string, actor: string): OverlayDocuments {
  requireExactKeys(body, [ 'reason', 'networks', 'markets', 'expectedDigests' ]);
  const reason = requireReason(body);

  const networkDocuments = documentsOf(body.networks, 'networks');
  const marketDocuments  = documentsOf(body.markets, 'markets');
  const expected = expectedDigestsOf(body, [ ...networkDocuments, ...marketDocuments ].map(([ key ]) => key));

  const networks = networkDocuments.map(([ key, overlay ]) => ({
    chainId: chainIdOf(key),
    overlay,
    ...expected.get(key),
  }));
  const markets = marketDocuments.map(([ key, overlay ]) => {
    const market = parseMarketKey(key);
    if (market === null) {
      throw new ApiError('BAD_REQUEST', `${key} must name a market as chainId/deploymentKey`);
    }
    return { chainId: chainIdOf(market.chainId), deploymentKey: market.deploymentKey, overlay, ...expected.get(key) };
  });

  const count = networks.length + markets.length;
  if (count === 0 || count > MAX_OVERLAYS_PER_REQUEST) {
    throw new ApiError('BAD_REQUEST', `between 1 and ${MAX_OVERLAYS_PER_REQUEST} overlays are required`);
  }

  return { versionId, actor, reason, networks, markets };
}

async function routeAdmin(
  request: Request,
  env: Env,
  context: RegistryContext,
  pathname: string,
): Promise<Response | null> {
  // every request spends from its address's budget first, a path no route takes among them
  await limitAddress(env, request);

  const matching = ROUTES
    .map(entry => ({ ...entry, match: entry.pattern.exec(pathname) }))
    .filter(({ match }) => match !== null);
  if (matching.length === 0) {
    return null;
  }
  /*
   * Authentication comes before anything the answer could tell an anonymous
   * caller apart by: which verbs a path takes, and whether the version it
   * names exists, stay behind the token. Which paths exist does not — API.md
   * publishes them — so a path that is none of them answers 404 without a
   * token being asked for, as any unknown path does.
   */
  const credential = await authenticateAdmin(request, env.COMET_REGISTRY_ADMIN_TOKEN_HASH);

  const route = matching.find(entry => entry.method === request.method);
  if (route === undefined) {
    // the allowed set is every verb the path takes, and the preflight
    throw methodNotAllowed(request.method, pathname, [ ...new Set(matching.map(entry => entry.method)), 'OPTIONS' ]);
  }

  await limit(env, credential.fingerprint, route.family);

  const [ , versionId, second, third ] = route.match!;
  const body = route.method === 'GET'
    ? {}
    : await readJsonObject(request, { maxBytes: route.handler === 'overlays' ? MAX_OVERLAYS_BODY_BYTES : MAX_BODY_BYTES });

  switch (route.handler) {
    case 'status':
      /*
       * Whether the registry is healthy, in one answer: what is active, what
       * the cache holds, when the source was last checked, and which
       * candidates are waiting. A monitor polls this and alerts on `alerts`.
       */
      return jsonResponse(await registryStatus(env, cacheDepsOf(env, context.debug)));
    case 'sync':
      return await postSync(env, body, context);
    case 'syncRun':
      return await getSyncRun(context, versionId!);
    case 'cancelSyncRun':
      requireExactKeys(body, [ 'reason' ]);
      return await cancelSyncRun(context, versionId!, requireReason(body));
    case 'versions':
      return await getVersions(context, new URL(request.url).searchParams);
    case 'version':
      return await getVersionDetail(context, versionId!);
    case 'proposal':
      return await getProposal(context, versionId!);
    case 'proposalReview':
      return await getProposalReview(context, versionId!);
    case 'applyProposal': {
      requireExactKeys(body, [ 'reason', 'digest' ]);
      const reason = requireReason(body);
      if (typeof(body.digest) !== 'string' || !/^[0-9a-f]{16}$/.test(body.digest)) {
        throw new ApiError('BAD_REQUEST', `digest must be the 16 hex characters the proposal's review names`);
      }
      return await applyProposal(context, versionId!, { digest: body.digest, reason }, feedReader(env), creationReader(env));
    }
    case 'readNetworkOverlay':
      return await getNetworkOverlay(context, versionId!, chainIdOf(second!));
    case 'readMarketOverlay':
      return await getMarketOverlay(context, versionId!, chainIdOf(second!), third!);
    case 'changes':
      return await getChanges(context, versionId!);
    case 'shadow':
      // without a captured id the route is /admin/shadow: the active version
      return await getShadow(context, versionId);
    case 'validate':
      /*
       * Validation decides nothing: it checks the stored candidate and records
       * every check it ran, exactly as the scheduled import does unattended.
       * The decision a person makes about a version, with its reason, is the
       * activation.
       */
      requireExactKeys(body, []);
      return await postValidate(context, versionId!);
    case 'activate':
      requireExactKeys(body, [ 'reason', 'expectedActiveVersionId' ]);
      return await postActivation(context, versionId!, 'activate', requireReason(body), expectedActiveVersionOf(body));
    case 'rollback':
      requireExactKeys(body, [ 'reason', 'expectedActiveVersionId' ]);
      return await postActivation(context, versionId!, 'rollback', requireReason(body), expectedActiveVersionOf(body));
    case 'networkOverlay':
      requireExactKeys(body, [ 'reason', 'overlay', 'expectedDigest' ]);
      return jsonResponse(await replaceNetworkOverlay(context.db, {
        versionId: versionId!,
        chainId:   chainIdOf(second!),
        overlay:   body.overlay,
        actor:     context.actor,
        reason:    requireReason(body),
        ...expectedDigestOf(body),
      }, feedReader(env)));
    case 'marketOverlay':
      requireExactKeys(body, [ 'reason', 'overlay', 'expectedDigest' ]);
      return jsonResponse(await replaceMarketOverlay(context.db, {
        versionId:     versionId!,
        chainId:       chainIdOf(second!),
        deploymentKey: third!,
        overlay:       body.overlay,
        actor:         context.actor,
        reason:        requireReason(body),
        ...expectedDigestOf(body),
      }, feedReader(env), creationReader(env)));
    case 'overlays':
      return jsonResponse(await replaceOverlays(context.db, overlayDocuments(body, versionId!, context.actor), feedReader(env), creationReader(env)));
  }
}

export { routeAdmin, syncAnswer, syncFailure };
