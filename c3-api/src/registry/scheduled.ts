import * as Debug from '../../lib/debug-log.js';

import type * as KnownNetwork from '../../lib/well-known/networks/network.js';
import type { Env, ServiceBindings } from '../../entrypoint.js';

import { activeSnapshot, cacheDepsOf, isUnreachable, pruneSnapshots, warmSnapshot } from './cache.js';
import { assertImportable, registryConfig } from './config.js';
import { checkChain } from './drift.js';
import { RpcTransport, proxyTransport } from './enrichment.js';
import { RegistryError, isRegistryError, isTransportFailure } from './errors.js';
import { ImporterDeps, InvocationResult, ManualRequest, isRequested, runInvocation } from './importer.js';
import type { RegistryFetch } from './source/github.js';

/*
 * The Cron entry point of the registry importer: it turns the Worker
 * environment into importer dependencies and runs one bounded invocation.
 *
 * An invocation stopped by a service that did not answer — GitHub while the
 * import looks for the commit, or the database — or refused by the registry
 * ends as a failed result, which the administrative route answers with and
 * the Cron reports as a failed invocation. A market whose own reads fail, its
 * root from GitHub or the chain through the node provider, stops nothing: the
 * importer records the failure on that root and goes on, and the status
 * raises `sync-failing` once such failures repeat. Nothing is retried here:
 * the next invocation resumes from the checkpoints in D1. A fault — a bug, or
 * a database without its migrations — is logged whole and raised: the Cron
 * then reports an exception, and the administrative route answers 500.
 */

/*
 * The registry's own fetch. It applies the same service binding overrides as
 * the request path, so a node provider request reaches the proxy worker
 * directly instead of the public internet, but it holds no shared state.
 *
 * The module-global counting fetch belongs to the request handler: it keeps
 * one quota and one counter for the whole isolate, and an import running
 * beside the requests an isolate serves would have both reset underneath it
 * by any request that arrives meanwhile.
 */
function registryFetch(env: Env): (input: Request | string, init?: RequestInit) => Promise<Response> {
  const overrides = env.URL_SERVICE_BINDING_OVERRIDES ?? [];
  return async (input, init) => {
    const request  = new Request(input, init);
    const override = overrides.find(({ host }) => host === new URL(request.url).hostname);
    if (override === undefined) {
      /*
       * The runtime's fetch answers the Workers Response. The types of a
       * build that also sees Node's (@types/node) can resolve the call to
       * Node's instead, which the Workers types of 4.x do not take as theirs.
       */
      return fetch(request) as Promise<Response>;
    }
    const binding = env[override.binding] as ServiceBindings[keyof ServiceBindings];
    if (binding === undefined) {
      throw new RegistryError(
        'SOURCE_CONFIGURATION_INVALID',
        `${override.host} is mapped to the ${override.binding} service binding, which is not configured`,
      );
    }
    return binding.fetch(request) as Promise<Response>;
  };
}

/*
 * How the registry reaches a chain: through the node provider proxy, with its
 * own fetch, by the canonical name of the network. The importer reads markets
 * this way and the overlay routes read the feeds a document names, so the two
 * cannot read one chain through different paths.
 *
 * A name reaches here from a root the importer parsed against the networks it
 * supports, or from a row such an import wrote, so it is one this API knows.
 */
function transportFor(env: Env, fetch = registryFetch(env)): (network: string) => RpcTransport {
  return network => proxyTransport({
    apiHost:  env.V3_API_HOST,
    nodeHost: env.NODE_PROXY_HOST,
    nodeKey:  env.NODE_PROXY_KEY,
    network:  network as KnownNetwork.Name,
    fetch,
  });
}

function importerDeps(env: Env, debug?: ImporterDeps['debug']): ImporterDeps {
  const config = registryConfig(env);
  assertImportable(config);
  const token = env.COMET_GITHUB_TOKEN;
  const fetch = registryFetch(env);
  return {
    db: env.APP_DB,
    ...(debug === undefined ? {} : { debug }),
    source: {
      repository: env.COMET_SOURCE_REPOSITORY,
      ref:        env.COMET_SOURCE_REF,
      fetch:      fetch as RegistryFetch,
      ...(token === undefined || token.length === 0 ? {} : { token }),
    },
    transportFor: transportFor(env, fetch),
    config: {
      leaseSeconds:            config.leaseSeconds,
      marketsPerInvocation:    config.marketsPerInvocation,
      upstreamIntervalSeconds: config.upstreamIntervalSeconds,
    },
    actor: `registry-cron:${env.ENVIRONMENT}`,
  };
}

/*
 * Runs one invocation of the importer and reports its outcome. Returns the
 * result so a manual administrative sync can answer with it.
 *
 * `requestId` is the id the administrative route answers under, which each
 * line this logs about the invocation carries; the Cron has none.
 */
async function runRegistrySync(
  env: Env,
  request: ManualRequest = {},
  { requestId }: { requestId?: string } = {},
): Promise<InvocationResult> {
  /*
   * The root logger, which writes whatever DEBUG says. A sync runs
   * unattended, and a failure that stage and production do not write down is
   * one nobody can diagnose.
   */
  const debug = Debug.MakeLogger([]).configure(env);
  // the request this invocation answers, which every line logged about it names
  const asked = requestId === undefined ? {} : { requestId };
  try {
    const result = await runInvocation(importerDeps(env, debug), request);
    debug.log({ registrySync: result, ...asked });
    /*
     * A candidate that validated is immutable and may be activated at any
     * moment, so its bytes are cached now, by the invocation nobody is
     * waiting on, rather than by the first request after the activation.
     */
    if (result.kind === 'imported') {
      try {
        await warmSnapshot(cacheDepsOf(env, debug), result.versionId);
      } catch (error) {
        // the activation warms it again, so a version not warmed here costs a request, not the import
        debug.warn(`registry snapshot not warmed`, { versionId: result.versionId, error, ...asked });
      }
    }
    return result;
  } catch (error) {
    if (isRegistryError(error)) {
      /*
       * The reason is the sanitized code an answer may carry; what failed
       * underneath, such as the status a provider answered or the error a
       * fetch threw, is the cause, and only the log shows it.
       *
       * A request a person made, refused for what it asked or for what the
       * source answered — an import already running, a commit the ref cannot
       * reach — is answered with why, and is theirs to act on: it is a
       * warning, under the id of that answer. A source or a node provider
       * that did not answer is an error whoever asked, and so is anything the
       * schedule runs into, which only the log tells anyone about.
       */
      const reason = `${error.code}: ${error.message}`;
      if (isRequested(request) && !isTransportFailure(error)) {
        debug.warn(`registry sync refused`, { reason, cause: error.cause, ...asked });
      } else {
        debug.error(`registry sync failed`, { reason, cause: error.cause, ...asked });
      }
      return { kind: 'failed', processed: 0, reason, error };
    }
    if (isTransportFailure(error) || isUnreachable(error)) {
      // the database or a source did not answer: worth retrying, and its message names which
      debug.error(`registry sync failed`, { reason: (error as Error).message, ...asked });
      return { kind: 'failed', processed: 0, reason: 'the import was interrupted by a service that did not answer' };
    }
    /*
     * Anything else is a fault, not a service being down: a bug, or a
     * database without the migrations this release needs. It is logged whole
     * and raised, so the administrative route answers it as an internal error
     * with a request id, and a scheduled invocation is reported as failed.
     */
    debug.error(`registry sync failed unexpectedly`, error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack, ...asked }
      : { error: String(error), ...asked });
    throw error;
  }
}

/*
 * The chain drift check of the Cron (drift.ts). Every invocation asks it,
 * beside the import and whatever the import makes of it — the commit already
 * imported above all, since a source that does not move is when the chain
 * can drift away from what was imported from it. It reads the chain only
 * when the version on is due a check: once a day, and within the hour for a
 * version switched on since, or one whose last check could not read every
 * network. `scheduledAt` is the hour the invocation was scheduled for, which
 * the check is recorded at and due by.
 *
 * It never fails the Cron. A chain it could not read is recorded as unread,
 * never as a drift, and anything else it runs into is logged and left to the
 * next invocation.
 */
async function checkRegistryChain(env: Env, scheduledAt: Date): Promise<void> {
  const debug = Debug.MakeLogger([]).configure(env);
  try {
    await checkChain({
      kv:              env.kv_registry,
      active:          () => activeSnapshot(cacheDepsOf(env, debug)),
      transportFor:    transportFor(env),
      intervalSeconds: registryConfig(env).upstreamIntervalSeconds,
      now:             () => scheduledAt,
      debug,
    });
  } catch (error) {
    debug.warn(`registry chain not checked`, { error });
  }
}

/*
 * The cache's own upkeep, run by the Cron beside the import: the bytes of
 * versions nothing is about to serve are removed from KV (pruneSnapshots).
 * It never fails the Cron — a cache that holds a few versions too many is
 * harmless — so a failure is logged and left to the next hour.
 */
async function maintainRegistryCache(env: Env): Promise<void> {
  const debug = Debug.MakeLogger([]).configure(env);
  try {
    const pruned = await pruneSnapshots(cacheDepsOf(env, debug));
    if (pruned.length > 0) {
      debug.log({ registryCachePruned: pruned });
    }
  } catch (error) {
    debug.warn(`registry cache not pruned`, { error });
  }
}

export {
  checkRegistryChain,
  importerDeps,
  maintainRegistryCache,
  runRegistrySync,
  transportFor,
};
