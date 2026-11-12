import type { Env } from '../../entrypoint.js';
import { sha256 } from '../../lib/hash.js';
import type { Role } from '../../src/http/bearer-auth.js';

import { MemoryKv } from './kv.js';

/*
 * The tokens the administrative routes take in tests. A worker is given only
 * their digests, in its list of tokens (COMET_REGISTRY_ADMIN_TOKENS), as
 * production is, and a test presents the tokens themselves. ADMIN_TOKEN is
 * test-admin's, which a request sends unless it says otherwise, and
 * APPROVER_TOKEN test-approver's, an admin of another name, who approves
 * what test-admin switches on.
 */
const ADMIN_TOKEN    = 'registry-admin-token-for-tests';
const APPROVER_TOKEN = 'registry-approver-token-for-tests';

// a token of a worker's list as a test holds it: who holds it, the token itself, its role, and its last instant
type ListedToken = { name: string, token: string, role: Role, notAfter?: string | null };

const ADMIN_TOKENS: ListedToken[] = [
  { name: 'test-admin',    token: ADMIN_TOKEN,    role: 'admin' },
  { name: 'test-approver', token: APPROVER_TOKEN, role: 'admin' },
];

// the list a worker is given for tokens (COMET_REGISTRY_ADMIN_TOKENS): their digests, never the tokens
async function tokenList(tokens: ListedToken[]): Promise<string> {
  return JSON.stringify(await Promise.all(tokens.map(async ({ name, token, role, notAfter = null }) => (
    { name, sha256: await sha256(token), role, notAfter }
  ))));
}

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
    COMET_REGISTRY_APPROVAL_TTL_S:     '',
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

/*
 * The Env of a Node-side test that sends administrative requests: its routes
 * take ADMIN_TOKEN and APPROVER_TOKEN, and both limiters let every request
 * through, where the default ones throw. What the limiters refuse is tested
 * through workerd, in tests/e2e/registry/security.test.ts.
 */
async function adminTestEnv(overrides: Partial<Env> = {}): Promise<Env> {
  return makeTestEnv({
    COMET_REGISTRY_ADMIN_TOKENS:      await tokenList(ADMIN_TOKENS),
    REGISTRY_ADMIN_RATE_LIMITER:      { limit: async () => ({ success: true }) },
    REGISTRY_ADMIN_AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  });
}

// a database every call to which throws `failure`, or an error with that message
function failingDatabase(failure: string | Error): D1Database {
  const fail = () => { throw typeof(failure) === 'string' ? new Error(failure) : failure; };
  return { prepare: fail, batch: fail, exec: fail, dump: fail } as unknown as D1Database;
}

/*
 * `db` with part of it out of reach: a statement `failing` matches fails when
 * it is run, as D1 fails one it could not run, with `message`; while `down()`
 * says the database is down, every statement and batch fails so. The rest is
 * `db`'s to answer.
 */
function failingStatements(
  db: D1Database,
  failing: RegExp,
  { down = () => false, message = 'D1_ERROR: Network connection lost.' }: { down?: () => boolean, message?: string } = {},
): D1Database {
  const fail = async () => { throw new Error(message); };
  const statement = { bind: () => statement, all: fail, first: fail, run: fail, raw: fail };
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => down() || failing.test(sql) ? statement : target.prepare(sql);
      }
      if (property === 'batch') {
        return (statements: D1PreparedStatement[]) => down() ? fail() : target.batch(statements);
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

export type { ListedToken };
export {
  ADMIN_TOKEN,
  ADMIN_TOKENS,
  APPROVER_TOKEN,
  adminTestEnv,
  failingDatabase,
  failingStatements,
  makeTestEnv,
  tokenList,
};
