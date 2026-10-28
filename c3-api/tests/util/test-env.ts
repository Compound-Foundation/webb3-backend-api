import type { Env } from '../../entrypoint.js';
import { MemoryKv } from './kv.js';

/*
 * Stands in for a binding that only exists inside workerd. Any use throws, so
 * a Node-side test that reaches D1 or the rate limiter fails loudly instead of
 * passing against a fake. Symbol keys and `then` stay undefined so the double
 * can be inspected, copied, and awaited-through without throwing.
 */
function workerdOnlyBinding<T extends object>(binding: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then') {
        return undefined;
      }
      throw new Error(
        `${binding}.${property} is not available in Node tests; use the workerd harness (npm run test:worker)`
      );
    },
  });
}

function defaultTestEnv(): Env {
  return {
    ENVIRONMENT:       'test',
    MEMORY_CACHE_SEED: 'test',
    TALLY_API_KEY:     'test',
    V3_API_HOST:       'test',
    NODE_PROXY_HOST:   'test',
    NODE_PROXY_KEY:    'test',
    kv_testnet:        MemoryKv({}),
    kv_mainnet:        MemoryKv({}),
    kv_registry:       MemoryKv({}),
    APP_DB:            workerdOnlyBinding('APP_DB'),
    REGISTRY_ADMIN_RATE_LIMITER: workerdOnlyBinding('REGISTRY_ADMIN_RATE_LIMITER'),
    REGISTRY_ADMIN_AUTH_RATE_LIMITER: workerdOnlyBinding('REGISTRY_ADMIN_AUTH_RATE_LIMITER'),
    COMET_SOURCE_REPOSITORY:           'Compound-Foundation/comet',
    COMET_SOURCE_REF:                  'main',
    /*
     * Left blank, so the registry takes its own defaults
     * (src/registry/config.ts) rather than a third copy of the numbers
     * wrangler.toml sets. A test that needs another value sets it.
     */
    COMET_UPSTREAM_CHECK_INTERVAL_S:   '',
    COMET_SYNC_MARKETS_PER_INVOCATION: '',
    COMET_SYNC_LEASE_SECONDS:          '',
    REGISTRY_SNAPSHOT_CACHE_TTL_S:     '',
    REGISTRY_STALE_FALLBACK_MAX_S:     '',
  };
}

/*
 * Builds the worker Env for tests that call the entrypoint or computations
 * directly in Node. Each call gets fresh in-memory KVs. `overrides` replaces
 * defaults; `processEnv`, when passed, is applied last so shell variables such
 * as NODE_PROXY_HOST or FLAGS_* still win, as they did in the inline literals.
 */
function makeTestEnv(overrides: Partial<Env> = {}, processEnv: NodeJS.ProcessEnv = {}): Env {
  return Object.assign(defaultTestEnv(), overrides, processEnv);
}

export { makeTestEnv };
