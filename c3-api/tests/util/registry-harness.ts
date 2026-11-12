import t from 'tap';

import { createTestHarness } from 'wrangler';
import type { TestHarness } from 'wrangler';

import type { Env } from '../../entrypoint.js';

import { applyMigrations } from './d1.js';
import { registryWorker } from './registry-worker.js';
import { ADMIN_TOKENS, tokenList } from './test-env.js';
import type { ListedToken } from './test-env.js';

/*
 * The worker from wrangler.toml, run in real workerd with local D1, KV and
 * rate-limit bindings, for one file of tests: started before its first test
 * and closed after its last.
 *
 * With `admin`, the worker lists ADMIN_TOKEN and APPROVER_TOKEN (test-env.ts),
 * and `tokens` beside them, as production lists only the digests of its
 * tokens, and the tests present the tokens themselves. A worker that lists
 * none has its administrative routes closed. No test is answered by a token
 * list or a webhook of a developer's .dev.vars (registryWorker). `vars` are
 * set over the ones wrangler.toml and a developer's .dev.vars give the
 * worker.
 */
type HarnessOptions = {
  admin?:  boolean,
  tokens?: ListedToken[],
  vars?:   Record<string, string>,
};

type RegistryHarness = {
  server:        TestHarness,
  // the worker's environment over new storage, migrated
  freshEnv:      () => Promise<Env>,
  freshDatabase: () => Promise<D1Database>,
  // the worker again, with `vars` set over the harness's own, until the next fresh environment
  withVars:      (vars: Record<string, string>) => Promise<void>,
  // the worker again, with secrets set beside its token list, until the next fresh environment
  withSecrets:   (secrets: Record<string, string>) => Promise<void>,
};

async function registryHarness({ admin = false, tokens = [], vars }: HarnessOptions = {}): Promise<RegistryHarness> {
  const listed  = [ ...(admin ? ADMIN_TOKENS : []), ...tokens ];
  const secrets = listed.length === 0 ? {} : { COMET_REGISTRY_ADMIN_TOKENS: await tokenList(listed) };
  const worker  = ({ more, beside }: { more?: Record<string, string>, beside?: Record<string, string> } = {}) => ({
    ...registryWorker({ ...secrets, ...beside }),
    ...(vars === undefined && more === undefined ? {} : { vars: { ...vars, ...more } }),
  });
  const server = createTestHarness({ workers: [ worker() ] });

  t.before(async () => {
    await server.listen();
  });
  t.teardown(() => server.close());

  const freshEnv = async (): Promise<Env> => {
    await server.reset();
    const env = await server.getWorker<Env>().getEnv();
    await applyMigrations(env.APP_DB);
    return env;
  };
  return {
    server,
    freshEnv,
    freshDatabase: async () => (await freshEnv()).APP_DB,
    withVars:      async more => { await server.update({ workers: [ worker({ more }) ] }); },
    withSecrets:   async beside => { await server.update({ workers: [ worker({ beside }) ] }); },
  };
}

export type { RegistryHarness };
export { registryHarness };
