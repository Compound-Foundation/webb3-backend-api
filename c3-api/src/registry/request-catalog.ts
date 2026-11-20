import type { Env } from '../../entrypoint.js';

import type { RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';

import { ApiError } from '../http/errors.js';

import { Catalog, catalogOf } from './catalog.js';
import type { CacheDeps } from './cache.js';
import { RegistryUnavailable, activeSnapshot, cacheDepsOf, isRegistryUnavailable } from './cache.js';
import { registryHeaders } from './version-headers.js';

/*
 * One registry version per request.
 *
 * A request that resolves markets, tokens, or feeds resolves all of them from
 * the same snapshot: two computations of one response must never describe the
 * same address differently because a new version was activated between them.
 * The catalog is therefore loaded at most once per request and held for its
 * duration, and the version that answered is reported back in the response
 * headers.
 *
 * Loading is lazy: V2 and gas price never pay a D1 read, and governance reads
 * it only to name the markets of proposal actions, and answers without it.
 */
type RequestCatalog = {
  // loads the active version; throws RegistryUnavailable when there is none to serve, and a database fault as it is
  load(): Promise<Catalog>,
  // the version that answered this request, if one was loaded
  loaded(): Catalog | null,
  /*
   * How old that version is, in seconds, when it was served from the cache
   * because D1 could not be reached. Null means the pointer was verified, so
   * the answer is the version that is on.
   */
  staleFor(): number | null,
};

/*
 * The catalog of each version this isolate has served, kept for as long as
 * the snapshot it was built from. The cache hands out one snapshot object per
 * version for as long as it holds that version, so a request of a hot isolate
 * pays the pointer read alone, rather than reading the snapshot and building
 * every market's contracts again for an answer that cannot differ.
 *
 * A price exception may expire, and a catalog resolves expiry when it is
 * built, so one is kept only for as long as it says it stays valid: the
 * catalog decides that with the same rule it applies exceptions by.
 */
const built = new WeakMap<RegistrySnapshotV1, { catalog: Catalog, until: number | null }>();

// the clock the cache was given, so an injected one decides expiry as well as staleness
function clockOf(deps: CacheDeps): number {
  return (deps.now?.() ?? new Date()).getTime();
}

function catalogFor(snapshot: RegistrySnapshotV1, now: number): Catalog {
  const kept = built.get(snapshot);
  if (kept !== undefined && (kept.until === null || now < kept.until)) {
    return kept.catalog;
  }
  const catalog = catalogOf(snapshot, new Date(now));
  built.set(snapshot, { catalog, until: catalog.validUntil });
  return catalog;
}

/*
 * How a route answers a registry it cannot read: 503 either way, with a code
 * that says which — nothing is active, or the database did not answer. Why it
 * did not answer is the log's to say, never the client's.
 */
function unavailableError(error: RegistryUnavailable): ApiError {
  return error.reason === 'not_active'
    ? new ApiError('REGISTRY_NOT_ACTIVE', `No active registry snapshot is available`)
    : new ApiError('UPSTREAM_UNAVAILABLE', `the comet registry could not be read`);
}

function requestCatalog(env: Env, debug?: CacheDeps['debug']): RequestCatalog {
  const deps = cacheDepsOf(env, debug);
  let pending: Promise<Catalog> | null = null;
  let catalog: Catalog | null          = null;
  let staleFor: number | null          = null;

  return {
    loaded:   () => catalog,
    staleFor: () => staleFor,
    load() {
      /*
       * The active version is read as the registry's own routes read it, so a
       * market route fails as they do: a database that did not answer, with
       * nothing within the window to fall back on, is RegistryUnavailable,
       * and one that answered with a fault is raised as it is.
       *
       * A failed load is not memoized: the promise is cleared so a later
       * handler of the same request can try again, which matters when the
       * first attempt lost a race with a D1 hiccup rather than finding an
       * empty registry.
       */
      pending ??= (async () => {
        try {
          const active = await activeSnapshot(deps);
          if (active === null) {
            throw new RegistryUnavailable(`no comet registry version is active`, 'not_active');
          }
          catalog  = catalogFor(active.snapshot, clockOf(deps));
          staleFor = active.staleFor;
          return catalog;
        } catch (error) {
          pending = null;
          throw error;
        }
      })();
      return pending;
    },
  };
}

/*
 * The headers a registry-dependent response carries: they name the version a
 * client was served without changing any response body.
 */
function catalogHeaders(catalog: Catalog, staleFor: number | null = null): Record<string, string> {
  return {
    ...registryHeaders({ id: catalog.versionId, checksum: catalog.checksum }, staleFor),
  };
}

/*
 * The headers of whatever a request answered, by the version it loaded: none
 * when it loaded none, since nothing it said depended on one. A failure that
 * came after the version was read names it too, because an error a client
 * reports is only diagnosable if it says what it was computed against. The
 * legacy router sets these over everything else a response carries.
 */
function catalogHeadersOf(registry: RequestCatalog): Record<string, string> {
  const catalog = registry.loaded();
  return catalog === null ? {} : catalogHeaders(catalog, registry.staleFor());
}

export type { RequestCatalog };
export { RegistryUnavailable, catalogHeaders, catalogHeadersOf, isRegistryUnavailable, requestCatalog, unavailableError };
