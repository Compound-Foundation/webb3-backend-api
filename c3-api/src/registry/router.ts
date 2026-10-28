import * as jsonRpc from '../../lib/json-rpc.js';

import { corsHeaders } from '../http/cors.js';
import { ApiError, ApiErrorCode, failureResponse, isApiError, nodeUnavailable } from '../http/errors.js';

import type * as Evaluator from '../evaluator.js';

import { routeAdmin } from './admin-router.js';
import type { CacheDeps, CachedSnapshot } from './cache.js';
import { activeSnapshot, cacheDepsOf, isUnreachable, versionSnapshot, warmSnapshot } from './cache.js';
import { RegistryErrorCode, isRegistryError } from './errors.js';
import { RegistryContext } from './handlers.js';
import { routePublic } from './public-router.js';
import { isRegistryUnavailable, unavailableError } from './request-catalog.js';
import { registryHeaders } from './version-headers.js';

/*
 * The registry entry point: everything under /registry/v1 is answered here,
 * including its preflight, its errors and its CORS headers, and nothing else
 * is.
 *
 * Errors become the versioned envelope rather than propagating: nothing past
 * this router answers a throw, and a D1 or upstream message must never reach
 * a client.
 */
const PREFIX = '/registry/v1';

/*
 * Whether a path is the registry's to answer. The entrypoint asks this once,
 * and hands every path it claims to this router and every other path to the
 * legacy one, so no path is answered by both or by neither.
 */
function isRegistryPath(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

/*
 * Whether a registry path is an administrative one, which decides both the
 * router that answers it and the CORS headers it answers with. It is matched
 * as a prefix, so anything that only starts like an administrative path is
 * answered as one: without CORS headers, and after the address limiter.
 */
function isAdminPath(pathname: string): boolean {
  return pathname.startsWith(`${PREFIX}/admin`);
}

/*
 * A trailing slash names the same resource, so a path is matched without it,
 * as the legacy routes match theirs: `/registry/v1/active/` is the snapshot,
 * not a 404.
 */
function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/*
 * The cache one request reads the active version through. It is built per
 * request and asked at most once, so two handlers of one response cannot be
 * served different versions.
 */
function activeReader(deps: CacheDeps): () => Promise<CachedSnapshot | null> {
  let pending: Promise<CachedSnapshot | null> | null = null;
  return () => pending ??= activeSnapshot(deps);
}

/*
 * What a public answer that failed after the active version was read says of
 * that version, as a legacy route's failure does: whether a chain or a market
 * is known depends on the version, so a 404 that does not name it cannot be
 * told apart from one an older version gave. A version the cache served
 * because D1 could not be reached is named with its age, and the answer may
 * not be kept.
 */
function servedHeaders({ snapshot, staleFor }: CachedSnapshot): Record<string, string> {
  return registryHeaders(snapshot.registryVersion, staleFor);
}

/*
 * How a registry failure is answered. Only a source or a node provider that
 * did not answer is a 503, worth trying again. Everything else the registry
 * refuses for what was asked of it, or for what the source or the chain said,
 * and asking again changes neither. The map is total, so a code added to
 * RegistryErrorCode is given its status here before the worker builds.
 */
const ERROR_STATUS: Record<RegistryErrorCode, ApiErrorCode> = {
  SOURCE_CONFIGURATION_INVALID: 'UNPROCESSABLE',
  SOURCE_REF_UNRESOLVED:        'UNPROCESSABLE',
  SOURCE_COMMIT_UNREACHABLE:    'UNPROCESSABLE',
  SOURCE_REQUEST_FAILED:        'UPSTREAM_UNAVAILABLE',
  SOURCE_RESPONSE_INVALID:      'UNPROCESSABLE',
  SOURCE_TREE_TRUNCATED:        'UNPROCESSABLE',
  SOURCE_CONTENT_TOO_LARGE:     'UNPROCESSABLE',
  SOURCE_BLOB_MISMATCH:         'UNPROCESSABLE',
  ROOT_PATH_INVALID:            'UNPROCESSABLE',
  ROOT_NETWORK_UNSUPPORTED:     'UNPROCESSABLE',
  ROOT_DOCUMENT_INVALID:        'UNPROCESSABLE',
  ROOT_DUPLICATE:               'UNPROCESSABLE',
  CHAIN_REQUEST_FAILED:         'UPSTREAM_UNAVAILABLE',
  CHAIN_RESPONSE_INVALID:       'UNPROCESSABLE',
  CHAIN_CALL_REVERTED:          'UNPROCESSABLE',
  CHAIN_CONTRACT_MISSING:       'UNPROCESSABLE',
  OVERLAY_INVALID:              'BAD_REQUEST',
  OVERLAY_FEED_UNREADABLE:      'UNPROCESSABLE',
  OVERLAY_CREATION_BLOCK_WRONG: 'UNPROCESSABLE',
  CANDIDATE_STATE_CONFLICT:     'CONFLICT',
  SYNC_ALREADY_RUNNING:         'CONFLICT',
};

/*
 * What a failure means to a client, or null for a fault the client is told
 * nothing about. A registry error keeps its own code in `details.code`, under
 * the class of answer in `error.code`.
 */
function asApiError(error: unknown): ApiError | null {
  if (isApiError(error)) {
    return error;
  }
  if (isRegistryError(error)) {
    return new ApiError(ERROR_STATUS[error.code], error.message, { code: error.code });
  }
  if (isRegistryUnavailable(error)) {
    return unavailableError(error);
  }
  // a node provider that did not serve a call no registry code names: a 503, as on every route
  if (jsonRpc.isNotServed(error)) {
    return nodeUnavailable(error);
  }
  /*
   * A database that could not be reached, wherever a route read it, is the
   * registry being unavailable: a 503 whichever route found out. One that
   * answered with a fault is not this, and stays a 500.
   */
  if (isUnreachable(error)) {
    return new ApiError('UPSTREAM_UNAVAILABLE', `a service the registry depends on did not answer`);
  }
  return null;
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [ name, value ] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}

async function routeRegistry(
  request: Request,
  // the request's context, with the id the entrypoint gave it, which its error answer and its log lines carry
  { env, debug, requestId }: Evaluator.Context & { requestId: string },
): Promise<Response> {
  const pathname = withoutTrailingSlash(new URL(request.url).pathname);
  const route    = isAdminPath(pathname) ? 'admin' : 'public';

  if (request.method === 'OPTIONS') {
    // administrative routes answer no CORS headers, so a preflight there
    // tells a browser nothing it could use
    return withHeaders(new Response(null, { status: 204 }), corsHeaders(route, { preflight: true }));
  }
  const cors = corsHeaders(route);

  const deps = cacheDepsOf(env, debug);
  const read = activeReader(deps);
  // the active version a handler has read: a public answer that fails after that names it
  let served: CachedSnapshot | null = null;
  const context: RegistryContext = {
    db:      env.APP_DB,
    actor:   env.COMET_REGISTRY_ADMIN_ACTOR ?? `registry-admin:${env.ENVIRONMENT}`,
    requestId,
    debug,
    active:  async () => (served = await read()),
    version: versionId => versionSnapshot(deps, versionId),
    /*
     * Warming is an optimization, and an optimization may not fail a command
     * that has already committed: an activation whose pointer has moved must
     * not answer 500 because KV or D1 hiccuped afterwards.
     */
    warm: async versionId => {
      try {
        await warmSnapshot(deps, versionId);
      } catch (error) {
        debug.warn(`registry snapshot not warmed`, { versionId, error });
      }
    },
  };

  try {
    const response = route === 'admin'
      ? await routeAdmin(request, env, context, pathname)
      : await routePublic(request, context, pathname, { maxAge: deps.ttlSeconds });
    if (response === null) {
      throw new ApiError('NOT_FOUND', `no registry route matches ${pathname}`);
    }
    return withHeaders(response, cors);
  } catch (error) {
    return failureResponse(asApiError(error), error, {
      requestId,
      pathname,
      debug,
      label:   'registry route',
      headers: { ...cors, ...(route === 'public' && served !== null ? servedHeaders(served) : {}) },
    });
  }
}

export { ERROR_STATUS, asApiError, isRegistryPath, routeRegistry };
