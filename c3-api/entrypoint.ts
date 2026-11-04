import fetch      from './lib/request-counting-fetch.js';
import Quota      from './lib/quota.js';
import * as Flags from './lib/flags.js';
import * as Debug from './lib/debug-log.js';

import { route }      from './src/router.js';
import * as Evaluator from './src/evaluator.js';

import { corsHeaders } from './src/http/cors.js';
import { isRegistryPath, routeRegistry } from './src/registry/router.js';
import {
  checkRegistryChain,
  maintainRegistryCache,
  runRegistrySync,
} from './src/registry/scheduled.js';

import * as v2           from './lib/computations/v2.js';
import * as evm          from './lib/computations/evm.js';
import * as comet        from './lib/computations/comet.js';
import * as market       from './lib/computations/market.js';
import * as rewards      from './lib/computations/rewards.js';
import * as account      from './lib/computations/account.js';
import * as defisaver    from './lib/computations/defisaver.js';
import * as governance   from './lib/computations/governance.js';
import * as cometRewards from './lib/computations/comet-rewards.js';
import * as sleuthQuery  from './lib/computations/sleuth/sleuth-query.js';

/*
 * worker-to-worker service bindings configured in wrangler.toml must be
 * added here as optional fields pointing to service binding objects
 */
interface ServiceBindings {
  node_provider_proxy?: { fetch: (typeof self.fetch) }
}

/*
 * Workers rate limiting binding (`ratelimits` in wrangler.toml). Declared
 * here because installs through the workspace preinstall resolve
 * @cloudflare/workers-types 3.x, which has no rate limit type.
 */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env extends Flags.Env, ServiceBindings {
  kv_mainnet:   KVNamespace,
  kv_testnet:   KVNamespace,
  // versioned comet registry snapshot cache and last-valid fallback
  kv_registry:  KVNamespace,
  // application database shared by all D1-backed features
  APP_DB:       D1Database,
  // every registry admin request, reads included, keyed per admin token and route family
  REGISTRY_ADMIN_RATE_LIMITER: RateLimiter,
  // every request under the registry admin prefix, before its token is checked, keyed per client address
  REGISTRY_ADMIN_AUTH_RATE_LIMITER: RateLimiter,
  ENVIRONMENT:  string,
  /*
   * seed for memory cache, useful for testing where we need independent
   * memory caches for each test suite
   */
  MEMORY_CACHE_SEED: string,
  TALLY_API_KEY: string,
  BLOCK_NATIVE_API_KEY?: string,
  V3_API_HOST: string,
  NODE_PROXY_HOST: string,
  NODE_PROXY_KEY: string,

  /*
   * comet registry source, sync, and cache settings; numeric values are
   * strings, as in wrangler.toml
   */
  COMET_SOURCE_REPOSITORY: string,
  COMET_SOURCE_REF: string,
  COMET_UPSTREAM_CHECK_INTERVAL_S: string,
  COMET_SYNC_MARKETS_PER_INVOCATION: string,
  COMET_SYNC_LEASE_SECONDS: string,
  REGISTRY_SNAPSHOT_CACHE_TTL_S: string,
  REGISTRY_STALE_FALLBACK_MAX_S: string,
  // the operator identity recorded in audit rows, never taken from a request
  COMET_REGISTRY_ADMIN_ACTOR?: string,
  // comet registry secrets, never set in wrangler.toml
  COMET_REGISTRY_ADMIN_TOKEN_HASH?: string,
  COMET_GITHUB_TOKEN?: string,

  /*
   * for worker-to-worker requests we need to override fetch() requests to
   * the corresponding URL to instead invoke the service binding directly
   */
  URL_SERVICE_BINDING_OVERRIDES?: Array<{
    host:    string,
    binding: (keyof ServiceBindings),
  }>,
  // debug configuration
  DEBUG?:       string,
  DEBUG_DEPTH?: string,
  DEBUG_LEVEL?: string,
  // quota configuration
  QUOTA_SUBREQUESTS?: number;
  QUOTA_CACHE_OPERATIONS?: number;
}

export { Env, ServiceBindings };

/*
 * security headers applied to every response, per security team recommendation
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security':    'max-age=63072000; includeSubDomains; preload',
  'Content-Security-Policy':      "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options':       'nosniff',
  'X-Frame-Options':              'DENY',
  'Referrer-Policy':              'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/*
 * A response as it leaves the worker: with the CORS headers given, where the
 * router that answered leaves them to the entrypoint, and the security
 * headers over everything.
 */
function secured(response: Response, cors: Record<string, string> = {}): Response {
  for (const [ name, value ] of Object.entries({ ...cors, ...SECURITY_HEADERS })) {
    response.headers.set(name, value);
  }
  return response;
}

/*
 * What a request is answered with, whichever router answers it: its context,
 * the id it is answered under, what it may spend, and every computation the
 * legacy router's evaluators evaluate. The registry router is handed the
 * context and the id alone.
 */
function prepare(env: Env) {
  /*
   * What one request may spend before the counting fetch and the
   * computation cache refuse it themselves. No environment sets either
   * value, so both are unbounded and the platform's budget is the one that
   * applies: on the Workers Paid plan, 10,000 subrequests an invocation,
   * which fetches and KV operations count against (README, "Workers Plan").
   */
  const quota = Quota.initialize({
    ops:    env.QUOTA_CACHE_OPERATIONS ?? Infinity,
    reads:  env.QUOTA_CACHE_OPERATIONS ?? Infinity,
    writes: env.QUOTA_CACHE_OPERATIONS ?? Infinity,

    subrequests: env.QUOTA_SUBREQUESTS ?? Infinity,
  });
  fetch.configure(env, quota);
  fetch.resetCount();
  const debug = Debug.MakeLogger([]).configure(env);
  const flags = Flags.parse(env);
  const context: Evaluator.Context = { env, debug, flags };
  return {
    context,
    /*
     * One id per request, made here: every error answer carries it, and so
     * does the log line written about it, so a client's report leads to the
     * line that explains it.
     */
    requestId: crypto.randomUUID(),
    quota,
    computations: {
      ...evm.applyIndexBias(
        Flags.defaults(flags).ethComputationIndexBias,
        evm
      ),
      ...v2,
      ...comet,
      ...market,
      ...account,
      ...rewards,
      ...defisaver,
      ...governance,
      ...cometRewards,
      ...sleuthQuery,
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    /*
     * The path decides which router answers, here and nowhere else. The
     * registry answers everything under its prefix, its preflight, its errors
     * and its CORS headers included — none on an administrative route, whose
     * authenticated writes no script on any origin may read.
     */
    if (isRegistryPath(pathname)) {
      const { context, requestId } = prepare(env);
      return secured(await routeRegistry(request, { ...context, requestId }));
    }
    /*
     * Every other path is a legacy route's. Its preflight reads nothing, so
     * it is answered before anything is set up for it.
     */
    if (request.method === 'OPTIONS') {
      return secured(new Response(null, { status: 204 }), corsHeaders('legacy', { preflight: true }));
    }
    const { context, requestId, quota, computations } = prepare(env);
    const response = await route(
      request,
      { ...context, requestId },
      Evaluator.preInstantiate(quota, context, computations),
    );
    return secured(response, corsHeaders('legacy'));
  },

  /*
   * cron entry point for the resumable comet registry sync: one invocation
   * imports a bounded number of markets and leaves the rest to the next one,
   * resuming from the checkpoints it finds in APP_DB
   */
  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    /*
     * No invocation is run again by the platform: the next one, an hour
     * later, resumes from the checkpoints, which is the only retry the import
     * needs.
     */
    controller.noRetry();
    // the bytes of versions nothing is about to serve are removed, beside the import
    context.waitUntil(maintainRegistryCache(env));
    /*
     * The version on is held against the chain beside the import, when it is
     * due a check (checkRegistryChain), by the hour this invocation was
     * scheduled for.
     */
    context.waitUntil(checkRegistryChain(env, new Date(controller.scheduledTime)));
    /*
     * The import brings its own fetch rather than configuring the shared
     * request-counting one: a request arriving while it runs would reset that
     * counter and quota.
     *
     * Its outcome is the invocation's. An import that failed — GitHub not
     * answering while it looks for the commit, a database that did not
     * answer, a configuration it refuses — fails the Cron, so the Cron's
     * metrics and past events show it, rather than a success that only the
     * log contradicts. A market that failed fails only its root.
     */
    const result = await runRegistrySync(env);
    if (result.kind === 'failed') {
      throw new Error(`registry sync failed: ${result.reason}`);
    }
  },
};
