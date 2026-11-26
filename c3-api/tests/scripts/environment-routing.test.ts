import t from 'tap';

import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * REGISTRY_RUNBOOK.md runs this before a token is sent to the environment's
 * address: it reads, with the login Wrangler uses, how Cloudflare routes the
 * custom domain, and refuses, printing nothing, unless the environment's
 * Worker alone takes it, in the account that holds the environment's
 * kv_mainnet. Cloudflare is played here by a server on 127.0.0.1, and Wrangler
 * by an npx that prints the login it is given.
 */
// the compiled script beside the compiled test, given to fileURLToPath as a string: the worker's URL type is not Node's
const SCRIPT = fileURLToPath(new URL('../../scripts/environment-routing.js', import.meta.url).href);
const root   = mkdtempSync(join(tmpdir(), 'environment-routing-'));
t.teardown(() => rmSync(root, { recursive: true, force: true }));

const NAMESPACE = '11111111111111111111111111111111';
const ACCOUNT   = 'account-of-the-environment';
const ZONE      = 'zone-of-example-com';

const cwd = join(root, 'c3-api');
mkdirSync(cwd);
writeFileSync(join(cwd, 'wrangler.toml'), `name = "fixture"
main = "entry.js"
compatibility_date = "2026-01-01"

[env.production]
name = "fixture-api"
routes = [ { pattern = "api.example.com", custom_domain = true } ]
kv_namespaces = [ { binding = "kv_mainnet", id = "${NAMESPACE}" } ]
`);

// npx as the script calls it, `npx wrangler auth token --json --env production`: it prints FAKE_AUTH, or says no one is logged in
const bin = join(root, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'npx'), `#!/bin/sh
printf '%s | logs %s %s\\n' "$*" "$WRANGLER_WRITE_LOGS" "$WRANGLER_LOG" >> "$FAKE_CALLS"
if [ "$*" = "wrangler auth token --json --env production" ]; then
  if [ -n "$FAKE_AUTH" ]; then printf '%s\\n' "$FAKE_AUTH"; exit 0; fi
  echo 'Not logged in. Please run \`wrangler login\` to authenticate.' >&2; exit 1
fi
exit 2
`);
chmodSync(join(bin, 'npx'), 0o755);

type Cloudflare = {
  zones:     Record<string, unknown[]>,
  kv:        Record<string, string[]>,
  domains:   Record<string, Array<Record<string, unknown>>>,
  routes:    Record<string, Array<{ pattern: string, script: string | null }>>,
  refuse?:   string,
  nothing?:  string,
  redirect?: string,
  // milliseconds Cloudflare's clock is ahead of this machine's
  skew?:     number,
};
type Request = { url: string, method: string, headers: Record<string, unknown> };

// the Cloudflare a case reads: the environment's zone, account, namespace and domain, and no route
function cloudflare(change: Partial<Cloudflare> = {}): Cloudflare {
  return {
    zones:   { 'example.com': [ { id: ZONE, name: 'example.com', status: 'active', account: { id: ACCOUNT } } ] },
    kv:      { [ACCOUNT]: [ NAMESPACE ] },
    domains: { [ACCOUNT]: [ { hostname: 'api.example.com', service: 'fixture-api', environment: 'production', enabled: true, zone_id: ZONE } ] },
    routes:  { [ZONE]: [] },
    ...change,
  };
}

let state = cloudflare();
let requests: Request[] = [];
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  requests.push({ url: `${url.pathname}${url.search}`, method: request.method ?? '', headers: request.headers });
  const answer = (status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Date': new Date(Date.now() + (state.skew ?? 0)).toUTCString() });
    response.end(JSON.stringify(body));
  };
  const path = url.pathname.replace(/^\/client\/v4/, '');
  if (state.refuse !== undefined && path.startsWith(state.refuse)) {
    return answer(403, { success: false, errors: [ { code: 10000, message: 'Authentication error' } ], result: null });
  }
  if (state.nothing !== undefined && path.startsWith(state.nothing)) {
    return answer(200, { success: true, errors: [], result: null });
  }
  if (state.redirect !== undefined && path.startsWith(state.redirect)) {
    response.writeHead(302, { Location: 'http://127.0.0.2:9/elsewhere' });
    return response.end();
  }
  let match: RegExpExecArray | null;
  if (path === '/zones') {
    return answer(200, { success: true, result: state.zones[url.searchParams.get('name') ?? ''] ?? [] });
  }
  if ((match = /^\/accounts\/([^/]+)\/storage\/kv\/namespaces\/([^/]+)$/.exec(path)) !== null) {
    return (state.kv[match[1] ?? ''] ?? []).includes(match[2] ?? '')
      ? answer(200, { success: true, result: { id: match[2], title: 'kv_mainnet' } })
      : answer(404, { success: false, errors: [ { code: 10013, message: 'namespace not found' } ], result: null });
  }
  if ((match = /^\/accounts\/([^/]+)\/workers\/domains$/.exec(path)) !== null) {
    const hostname = url.searchParams.get('hostname');
    return answer(200, { success: true, result: (state.domains[match[1] ?? ''] ?? []).filter(domain => hostname === null || domain['hostname'] === hostname) });
  }
  if ((match = /^\/zones\/([^/]+)\/workers\/routes$/.exec(path)) !== null) {
    return answer(200, { success: true, result: state.routes[match[1] ?? ''] ?? [] });
  }
  return answer(404, { success: false, errors: [ { code: 7003, message: 'no route for that URI' } ], result: null });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
t.teardown(() => new Promise<void>(resolve => server.close(() => resolve())));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;

const OAUTH = JSON.stringify({ type: 'oauth', token: 'the-login-token' });

// null for no login, or no ENVIRONMENT
async function check(given: Cloudflare, auth: string | null = OAUTH, environment: string | null = 'production', api: string | null = null)
  : Promise<{ status: number | null, stdout: string, stderr: string, requests: Request[], npx: string }> {
  state = given;
  requests = [];
  const calls = join(root, `calls-${Math.floor(performance.now() * 1000)}`);
  writeFileSync(calls, '');
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, CLOUDFLARE_API_BASE_URL: BASE, FAKE_CALLS: calls };
  delete env['ENVIRONMENT'];
  delete env['FAKE_AUTH'];
  delete env['API'];
  if (api !== null) {
    env['API'] = api;
  }
  if (environment !== null) {
    env['ENVIRONMENT'] = environment;
  }
  if (auth !== null) {
    env['FAKE_AUTH'] = auth;
  }
  const child = spawn(process.execPath, [ SCRIPT ], { cwd, env });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const status = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
  const { readFileSync } = await import('node:fs');
  return { status, stdout, stderr, requests: [ ...requests ], npx: readFileSync(calls, 'utf8') };
}

t.test('a custom domain that runs the environment\'s Worker alone is taken', async t => {
  const routes = [
    { pattern: 'api.example.com/*', script: 'fixture-api' },
    { pattern: 'api.example.com/static/*', script: null },
    { pattern: 'other.example.com/*', script: 'someone-else' },
  ];
  const taken = await check(cloudflare({ routes: { [ZONE]: routes } }));
  t.equal(taken.status, 0, 'routes of the same Worker, of no Worker, and of other hosts leave it the environment\'s');
  t.match(taken.stdout, /^https:\/\/api\.example\.com: its custom domain is fixture-api's, /, 'and it says what it read');
  t.equal(taken.stderr, '', 'with nothing else to say');
  t.same(taken.requests.map(request => request.url), [
    '/client/v4/zones?name=api.example.com',
    '/client/v4/zones?name=example.com',
    `/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}`,
    `/client/v4/accounts/${ACCOUNT}/workers/domains?hostname=api.example.com`,
    `/client/v4/zones/${ZONE}/workers/routes`,
  ], 'from the zone of the host, its account, the domain and the routes');
  t.ok(taken.requests.every(request => request.method === 'GET'), 'which it only reads');
  t.ok(taken.requests.every(request => request.headers['authorization'] === 'Bearer the-login-token'), 'with the login Wrangler gives');
  t.equal(taken.npx, 'wrangler auth token --json --env production | logs false log\n',
    'as `npx wrangler auth token --json --env production` gives it, with Wrangler writing no log file');
  t.notMatch(taken.stdout + taken.stderr, /the-login-token/, 'and never prints it');

  const same = await check(cloudflare(), OAUTH, 'production', 'https://api.example.com');
  t.equal(same.status, 0, 'an API already set to the address passes');

  const pending = await check(cloudflare({ zones: { 'example.com': [
    { id: 'zone-pending', name: 'example.com', status: 'pending', account: { id: 'another-account' } },
    { id: ZONE, name: 'example.com', status: 'active', account: { id: ACCOUNT } },
  ] } }));
  t.equal(pending.status, 0, 'a pending zone of the same name is passed over for the active one');

  const key = await check(cloudflare(), JSON.stringify({ type: 'api_key', key: 'the-global-key', email: 'owner@example.com' }));
  t.equal(key.status, 0, 'the global key is a login too');
  t.ok(key.requests.every(request => request.headers['x-auth-key'] === 'the-global-key' && request.headers['x-auth-email'] === 'owner@example.com'),
    'sent with its email');
  t.notMatch(key.stdout + key.stderr, /the-global-key/, 'and never printed');
});

t.test('anything else is refused, and nothing is printed', async t => {
  const refusals: Array<[ string, Cloudflare, string | null, string | null, RegExp ]> = [
    [ 'a custom domain of another Worker',      cloudflare({ domains: { [ACCOUNT]: [ { hostname: 'api.example.com', service: 'someone-else' } ] } }), OAUTH, 'production',
      /^the custom domain api\.example\.com is attached to the Worker someone-else, not to fixture-api/ ],
    [ 'a custom domain attached to no Worker',  cloudflare({ domains: { [ACCOUNT]: [] } }), OAUTH, 'production',
      /^the custom domain api\.example\.com is attached to no Worker of the account account-of-the-environment/ ],
    [ 'a route of another Worker on the host',  cloudflare({ routes: { [ZONE]: [ { pattern: 'api.example.com/registry/*', script: 'interceptor' } ] } }), OAUTH, 'production',
      /^the zone example\.com has a route, api\.example\.com\/registry\/\*, that may run the Worker interceptor on api\.example\.com before its custom domain/ ],
    [ 'a wildcard route of another Worker',     cloudflare({ routes: { [ZONE]: [ { pattern: 'https://*.example.com/*', script: 'interceptor' } ] } }), OAUTH, 'production',
      /^the zone example\.com has a route, https:\/\/\*\.example\.com\/\*, that may run the Worker interceptor/ ],
    [ 'a route that ends in a wildcard',        cloudflare({ routes: { [ZONE]: [ { pattern: 'api.example.com*', script: 'interceptor' } ] } }), OAUTH, 'production',
      /^the zone example\.com has a route, api\.example\.com\*, that may run the Worker interceptor/ ],
    [ 'a route with a port',                    cloudflare({ routes: { [ZONE]: [ { pattern: 'api.example.com:443/*', script: 'interceptor' } ] } }), OAUTH, 'production',
      /^the zone example\.com has a route, api\.example\.com:443\/\*, that may run the Worker interceptor/ ],
    [ 'a broader route a narrower one negates', cloudflare({ routes: { [ZONE]: [ { pattern: '*example.com/*', script: 'interceptor' }, { pattern: 'api.example.com/*', script: null } ] } }), OAUTH, 'production',
      /^the zone example\.com has a route, \*example\.com\/\*, that may run the Worker interceptor on api\.example\.com before its custom domain: no route of another Worker may cover the host/ ],
    [ 'a route of every host',                  cloudflare({ routes: { [ZONE]: [ { pattern: '*/*', script: 'interceptor' } ] } }), OAUTH, 'production',
      /^the zone example\.com has a route, \*\/\*, that may run the Worker interceptor/ ],
    [ 'a custom domain switched off',           cloudflare({ domains: { [ACCOUNT]: [ { hostname: 'api.example.com', service: 'fixture-api', enabled: false, zone_id: ZONE } ] } }), OAUTH, 'production',
      /^the custom domain api\.example\.com is switched off: it takes no traffic/ ],
    [ 'a custom domain of another environment of the Worker', cloudflare({ domains: { [ACCOUNT]: [ { hostname: 'api.example.com', service: 'fixture-api', environment: 'staging', zone_id: ZONE } ] } }), OAUTH, 'production',
      /^the custom domain api\.example\.com is attached to the environment staging of fixture-api, not to the Worker itself/ ],
    [ 'a custom domain in another zone',        cloudflare({ domains: { [ACCOUNT]: [ { hostname: 'api.example.com', service: 'fixture-api', zone_id: 'zone-elsewhere' } ] } }), OAUTH, 'production',
      /^the custom domain api\.example\.com is in the zone zone-elsewhere, and not in example\.com, whose routes this reads/ ],
    [ 'a paused zone',                          cloudflare({ zones: { 'example.com': [ { id: ZONE, name: 'example.com', status: 'active', paused: true, account: { id: ACCOUNT } } ] } }), OAUTH, 'production',
      /^the zone example\.com is paused/ ],
    [ 'an answer with nothing in it',           cloudflare({ nothing: `/accounts/${ACCOUNT}/storage/kv/namespaces/` }), OAUTH, 'production',
      /^the account of example\.com must hold the environment's kv_mainnet, .*: Cloudflare answered GET .* with 200/ ],
    [ 'a redirect',                             cloudflare({ redirect: `/zones/${ZONE}/workers/routes` }), OAUTH, 'production',
      /^reading the Worker routes of example\.com: Cloudflare did not answer GET \/zones\/zone-of-example-com\/workers\/routes: / ],
    [ 'a login that is no header value',        cloudflare(), JSON.stringify({ type: 'oauth', token: 'the-login-token\nX-Other: 1' }), 'production',
      /^Wrangler gives no login that this check can use/ ],
    [ 'a zone in another account',              cloudflare({ kv: { [ACCOUNT]: [] } }), OAUTH, 'production',
      /^the account of example\.com must hold the environment's kv_mainnet, 1{32}, as the environment's account does: Cloudflare answered GET .* with 404, namespace not found \[code: 10013\]/ ],
    [ 'a host no zone holds',                   cloudflare({ zones: {} }), OAUTH, 'production',
      /^no active zone that this login reads holds api\.example\.com/ ],
    [ 'a request Cloudflare refuses',           cloudflare({ refuse: `/zones/${ZONE}/workers/routes` }), OAUTH, 'production',
      /^reading the Worker routes of example\.com: Cloudflare answered GET \/zones\/zone-of-example-com\/workers\/routes with 403, Authentication error \[code: 10000\]/ ],
    [ 'no login',                               cloudflare(), null, 'production',
      /^Wrangler gives no login: Not logged in\. Please run `wrangler login` to authenticate\./ ],
    [ 'a login with no token',                  cloudflare(), JSON.stringify({ type: 'oauth' }), 'production',
      /^Wrangler gives no login that this check can use/ ],
    [ 'no environment',                         cloudflare(), OAUTH, null,
      /^ENVIRONMENT is not set/ ],
    [ 'a clock two hours ahead of Cloudflare\'s', cloudflare({ skew: -2 * 3_600_000 }), OAUTH, 'production',
      /^this machine's clock is 120 minutes ahead of Cloudflare's: set it right, since step 4 counts a rotation's 30 days by it/ ],
    [ 'a clock two hours behind',               cloudflare({ skew: 2 * 3_600_000 }), OAUTH, 'production',
      /^this machine's clock is 120 minutes behind Cloudflare's/ ],
  ];
  for (const [ what, given, auth, environment, problem ] of refusals) {
    const refused = await check(given, auth, environment);
    t.equal(refused.status, 1, `${what} is refused`);
    t.equal(refused.stdout, '', 'and nothing is printed');
    t.match(refused.stderr, problem, 'with what is wrong');
    t.notMatch(refused.stderr, /the-login-token/, 'and never the login');
  }

  const elsewhere = await check(cloudflare(), OAUTH, 'production', 'https://api-elsewhere.example.com');
  t.equal(elsewhere.status, 1, 'an API set to another address is refused');
  t.match(elsewhere.stderr, /^API is https:\/\/api-elsewhere\.example\.com, and the environment production's address is https:\/\/api\.example\.com/,
    'as not the environment\'s');
  t.same(elsewhere.requests, [], 'before Cloudflare is asked');

  const minutes = await check(cloudflare({ skew: 10 * 60_000 }));
  t.equal(minutes.status, 0, 'a clock ten minutes off Cloudflare\'s passes');

  const local = await check(cloudflare(), null, null, 'http://localhost:8787');
  t.equal(local.status, 0, 'an API of a worker on this machine needs no check');
  t.match(local.stdout, /^http:\/\/localhost:8787: a worker on this machine, which a token sent to it never leaves/, 'and it says why');
  t.same([ local.requests, local.npx ], [ [], '' ], 'with neither Cloudflare nor Wrangler asked');

  const unnamed = await check(cloudflare(), OAUTH, null);
  t.same(unnamed.requests, [], 'with no environment, Cloudflare is not asked');
  t.equal(unnamed.npx, '', 'nor is Wrangler');
  const loggedOut = await check(cloudflare(), null);
  t.same(loggedOut.requests, [], 'with no login, Cloudflare is not asked');
});
