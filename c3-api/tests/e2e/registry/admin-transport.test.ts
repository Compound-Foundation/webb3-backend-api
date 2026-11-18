import t, { Test } from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';
import { sha256 } from '../../../lib/hash.js';

import { activeRegistryDatabase } from '../../util/registry-database.js';
import type { RegistryDatabase } from '../../util/registry-database.js';
import { makeTestEnv } from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * How the administrative API is reached: over https, and over plain http from
 * this machine alone.
 *
 * The worker runs in Node here, and sees the URL a request was sent to as
 * the test wrote it. The harness the other registry tests run it in reaches
 * it over plain http alone, so it cannot show an https request served.
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';

const auth = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };

type Envelope = { error: { code: string, message: string, requestId: string, details?: Record<string, unknown> } };

// an answer that may be no error at all: the status, or a preflight's empty body, served where it should have been refused
type Answer = Partial<Envelope>;

/*
 * The environment, with limiters that record every key they are asked
 * about, and take each: a request refused for its scheme is asked of
 * neither.
 */
async function envWith(registry: RegistryDatabase, overrides: Partial<Env> = {}): Promise<{ env: Env, limited: string[] }> {
  const limited: string[] = [];
  const limiter = {
    limit: async ({ key }: { key: string }) => {
      limited.push(key);
      return { success: true };
    },
  };
  const env = makeTestEnv({
    MEMORY_CACHE_SEED:                'registry-admin-transport',
    APP_DB:                           registry.db,
    COMET_REGISTRY_ADMIN_TOKENS:      JSON.stringify([
      { name: 'alice', sha256: await sha256(ADMIN_TOKEN), role: 'admin', notAfter: null },
    ]),
    REGISTRY_ADMIN_RATE_LIMITER:      limiter,
    REGISTRY_ADMIN_AUTH_RATE_LIMITER: limiter,
    ...overrides,
  });
  return { env, limited };
}

async function database(t: Test): Promise<RegistryDatabase> {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  return registry;
}

function send(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  return C3Api.fetch(new Request(url, init), env);
}

// a refusal is logged, as every 403 is: its lines are kept here, out of the test's output, for a test that reads them
function warnings(t: Test): string[] {
  const lines: string[] = [];
  const { warn } = console;
  console.warn = (...parameters: unknown[]) => { lines.push(parameters.map(String).join(' ')); };
  t.teardown(() => { console.warn = warn; });
  return lines;
}

// what a request over plain http is answered, whatever it carries
async function refusedForHttp(t: Test, response: Response, what: string): Promise<void> {
  t.equal(response.status, 403, `${what} is refused`);
  t.equal(response.headers.get('www-authenticate'), null, 'asking for no token, which would cross the network in clear text again');
  const { error } = await response.json().catch(() => ({})) as Answer;
  t.same([ error?.code, error?.message, error?.details ], [
    'FORBIDDEN',
    'the administrative API takes requests over https only',
    { code: 'HTTPS_REQUIRED' },
  ], 'saying that https is what it takes');
}

/*
 * Over plain http, the token of an administrative request crossed the
 * network in clear text. The request is refused at once — never redirected,
 * which would have the client send the token again — whatever it asks for,
 * and before its address or its token is counted.
 */
t.test('an administrative request over plain http is refused before anything else is done with it', async t => {
  const logged = warnings(t);
  const { env, limited } = await envWith(await database(t));

  await refusedForHttp(t, await send(env, 'http://api.test.local/registry/v1/admin/status', { headers: auth }),
    'the status, asked for with a token the environment lists,');
  for (const path of [ '/registry/v1/admin', '/registry/v1/admin/', '/registry/v1/admin/nothing-here', '/registry/v1/administrator' ]) {
    await refusedForHttp(t, await send(env, `http://api.test.local${path}`, { headers: auth }),
      `${path}, under the administrative prefix and no route,`);
  }
  // a command that, served, would read the database alone: an import would reach for GitHub
  await refusedForHttp(t, await send(env, 'http://api.test.local/registry/v1/admin/versions/00000000-0000-4000-8000-000000000000/validate', {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    '{}',
  }), 'a command');
  await refusedForHttp(t, await send(env, 'http://api.test.local/registry/v1/admin/status', { method: 'OPTIONS' }), 'a preflight');
  // a host that only starts like this machine's is another one
  await refusedForHttp(t, await send(env, 'http://localhost.example.test/registry/v1/admin/status', { headers: auth }),
    'a host named like this machine');
  // the scheme and the host are the URL's: what a header says of either changes nothing
  await refusedForHttp(t, await send(env, 'http://api.test.local/registry/v1/admin/status', {
    headers: { ...auth, 'X-Forwarded-Proto': 'https', 'Forwarded': 'proto=https', 'CF-Visitor': '{"scheme":"https"}', 'Host': 'localhost' },
  }), 'a request whose headers claim https, or this machine,');

  t.same(limited, [], 'and none of them spent anything of its address\'s budget, nor of a token\'s');
  t.ok(logged.some(line => line.includes('registry route refused')), 'each is logged as a refusal, as every 403 is');
  t.ok(logged.some(line => line.includes(`scheme: 'http:'`)), 'with the scheme it came over, which tells it from the other refusals');
});

/*
 * The token list is read before the request's Authorization header, so an
 * environment whose list the worker cannot read refuses every request alike,
 * whatever it sends (bearer-auth.ts). A request answered for its scheme by
 * such an environment, rather than for its list, was refused before the list
 * was read, and so before its token was.
 */
t.test('a request over plain http is refused before the token list is read', async t => {
  warnings(t);
  const { env, limited } = await envWith(await database(t), { COMET_REGISTRY_ADMIN_TOKENS: 'not a list' });

  await refusedForHttp(t, await send(env, 'http://api.test.local/registry/v1/admin/status', { headers: auth }),
    'a request to an environment whose list the worker cannot read');
  t.same(limited, [], 'having spent nothing');

  const secure = await send(env, 'https://api.test.local/registry/v1/admin/status', { headers: auth });
  t.equal(secure.status, 403, 'the same request over https is refused too');
  const { error } = await secure.json() as Envelope;
  t.equal(error.message, 'the administrative API is misconfigured in this environment: COMET_REGISTRY_ADMIN_TOKENS is malformed',
    'but for the list, which it read');
});

/*
 * A worker run on this machine with `wrangler dev` is reached over plain
 * http at localhost, 127.0.0.1 or [::1], as the runbook's preflight reaches
 * it, and is answered as over https: both limiters, then the token.
 */
t.test('an administrative request is served over https, and over plain http from this machine', async t => {
  warnings(t);
  const registry = await database(t);
  const { env, limited } = await envWith(registry);

  for (const origin of [ 'https://api.test.local', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787' ]) {
    limited.length = 0;
    const response = await send(env, `${origin}/registry/v1/admin/status`, { headers: auth });
    t.equal(response.status, 200, `${origin} is served`);
    t.equal(limited.length, 2, 'once its address and its token have spent from their budgets');
    const unknown = await send(env, `${origin}/registry/v1/admin/nothing-here`, { headers: auth });
    t.equal(unknown.status, 404, 'and a path no route takes is no route, as before');
  }

  const anonymous = await send(env, 'https://api.test.local/registry/v1/admin/status');
  t.equal(anonymous.status, 401, 'over https a request without a token is asked for one');
  t.equal(anonymous.headers.get('www-authenticate'), 'Bearer');
});

t.test('a public registry read is served over plain http as over https', async t => {
  const registry = await database(t);
  const { env, limited } = await envWith(registry);

  for (const origin of [ 'http://api.test.local', 'https://api.test.local' ]) {
    const response = await send(env, `${origin}/registry/v1/active`);
    t.equal(response.status, 200, `${origin} is served`);
    t.equal(response.headers.get('x-registry-version'), registry.versionId, 'the active version');
    t.equal((await send(env, `${origin}/registry/v1/active`, { method: 'OPTIONS' })).status, 204, 'and so is its preflight');
  }
  t.same(limited, [], 'without either administrative limiter');
});
