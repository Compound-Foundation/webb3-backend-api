import { execFileSync } from 'node:child_process';

import { environmentOf, refuse, takesHost } from './environment.js';

/*
 * Checks, before a token is sent to the environment's address, how
 * Cloudflare routes it, which the configuration cannot show.
 * REGISTRY_RUNBOOK.md runs it before it sets API, in "Before you start" and
 * in step 4 of "The admin tokens", so that API is set only to an address
 * this check took.
 *
 *   npx tsc -p tsconfig.scripts.json && node dist/scripts/environment-routing.js
 *
 * It runs in c3-api, with the login Wrangler uses for the environment, as
 * `npx wrangler auth token --json --env <it>` gives it, and only reads:
 * - the zone that holds the environment's custom domain, which must be active
 *   and not paused, and the zone's account;
 * - that this account holds the environment's kv_mainnet, by the id
 *   wrangler.toml gives it, which no other account holds: so it is the
 *   account the runbook's account check pins, where the environment's secrets
 *   go;
 * - the custom domain, which must be attached, in that zone and switched on,
 *   to the environment's Worker;
 * - the zone's Worker routes, of which none may run another Worker on the
 *   domain's host, of any path: a route runs before a custom domain. One that
 *   a more specific route without a Worker would negate is refused all the
 *   same, since Cloudflare lists exceptions to its route specificity among its
 *   known issues.
 * An API already set must be the domain's address. It refuses, and prints
 * nothing, on anything else, a request that Cloudflare refuses among them,
 * and it never prints the login, nor lets Wrangler write it to its log.
 */
const BASE = (process.env['CLOUDFLARE_API_BASE_URL'] ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');

const environment = environmentOf(process.env['ENVIRONMENT']);
const { name, worker, host } = environment;
const address = `https://${host}`;
const api = process.env['API'] ?? '';
if (api.length > 0 && api.replace(/\/+$/, '') !== address) {
  refuse(`API is ${api}, and the environment ${name}'s address is ${address}: read API again, as REGISTRY_RUNBOOK.md's Before you start does`);
}
const bindings: Array<{ binding?: string, id?: string }> = environment.config.kv_namespaces ?? [];
const namespace = bindings.find(binding => binding.binding === 'kv_mainnet')?.id;
if (namespace === undefined) {
  refuse(`the environment ${name} binds no kv_mainnet, by which its account is known`);
}

// a value that can go in a header as it is: printable, with no space or control character in it
const HEADER_VALUE = /^[\x21-\x7e]+$/;

/*
 * The credentials Wrangler uses for the environment, as its own command gives
 * them: an API token, a login's, or the global key with its email. It reads
 * the environment's .env files as the account check does, and writes no log
 * file, which would keep the login for a month.
 */
function credentials(): Record<string, string> {
  let printed: string;
  try {
    printed = execFileSync('npx', [ 'wrangler', 'auth', 'token', '--json', '--env', name ], {
      encoding: 'utf8',
      stdio:    [ 'ignore', 'pipe', 'pipe' ],
      timeout:  120_000,
      env:      { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'log' },
    });
  } catch (error) {
    const { stderr, status, signal } = error as { stderr?: unknown, status?: unknown, signal?: unknown };
    const said = typeof(stderr) === 'string' ? stderr.trim() : '';
    refuse(`Wrangler gives no login: ${said.length > 0 ? said : signal ? 'npx wrangler auth token did not finish within two minutes' : `npx wrangler auth token exited with ${String(status)}`}`);
  }
  let auth: { type?: unknown, token?: unknown, key?: unknown, email?: unknown };
  try {
    auth = JSON.parse(printed.slice(printed.indexOf('{'), printed.lastIndexOf('}') + 1)) as typeof auth;
  } catch {
    refuse('Wrangler printed no login that this check can read');
  }
  const { type, token, key, email } = auth;
  if ((type === 'api_token' || type === 'oauth') && typeof(token) === 'string' && HEADER_VALUE.test(token)) {
    return { Authorization: `Bearer ${token}` };
  }
  if (type === 'api_key' && typeof(key) === 'string' && HEADER_VALUE.test(key) && typeof(email) === 'string' && HEADER_VALUE.test(email)) {
    return { 'X-Auth-Key': key, 'X-Auth-Email': email };
  }
  refuse('Wrangler gives no login that this check can use');
}
const headers = credentials();

type Answer = { success?: unknown, result?: unknown, errors?: Array<{ code?: unknown, message?: unknown }> };

// what Cloudflare answers to a GET of the path, or a refusal that says what it was for
async function read(path: string, purpose: string): Promise<unknown> {
  // Node's own fetch, whose answer is not the worker's Response type
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    // a request that hangs would hang the command it guards, and a redirect could take the login elsewhere
    response = await fetch(`${BASE}${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    refuse(`${purpose}: Cloudflare did not answer GET ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let answer: Answer;
  try {
    answer = await response.json() as Answer;
  } catch {
    refuse(`${purpose}: Cloudflare answered GET ${path} with ${response.status}, and not with JSON`);
  }
  if (!response.ok || answer.success !== true || answer.result === undefined || answer.result === null) {
    const errors = (Array.isArray(answer.errors) ? answer.errors : []).map(error => `${String(error.message)} [code: ${String(error.code)}]`).join('; ');
    refuse(`${purpose}: Cloudflare answered GET ${path} with ${response.status}${errors.length > 0 ? `, ${errors}` : ''}`);
  }
  return answer.result;
}

// a list Cloudflare answers, or a refusal
async function list<T>(path: string, purpose: string): Promise<T[]> {
  const result = await read(path, purpose);
  if (!Array.isArray(result)) {
    refuse(`${purpose}: Cloudflare answered GET ${path} with no list`);
  }
  return result as T[];
}

type Zone = { id?: unknown, name?: unknown, status?: unknown, paused?: unknown, account?: { id?: unknown } };
type Domain = { hostname?: unknown, service?: unknown, environment?: unknown, enabled?: unknown, zone_id?: unknown };
type Route = { pattern?: unknown, script?: unknown };

// the zone that holds the host: the longest of its parent names that is an active zone this login reads
async function zoneOf(): Promise<{ id: string, name: string, account: string }> {
  const labels = host.split('.');
  for (let first = 0; first <= labels.length - 2; first++) {
    const candidate = labels.slice(first).join('.');
    const zones = await list<Zone>(`/zones?name=${encodeURIComponent(candidate)}`, `finding the zone of ${host}`);
    const zone = zones.find(zone => zone.name === candidate && zone.status === 'active');
    if (zone !== undefined) {
      if (zone.paused === true) {
        refuse(`the zone ${candidate} is paused: Cloudflare sends its traffic past its Workers`);
      }
      const { id } = zone;
      const account = zone.account?.id;
      if (typeof(id) !== 'string' || typeof(account) !== 'string') {
        refuse(`Cloudflare names no id or no account for the zone ${candidate}`);
      }
      return { id, name: candidate, account };
    }
  }
  refuse(`no active zone that this login reads holds ${host}`);
}

const zone = await zoneOf();

await read(`/accounts/${zone.account}/storage/kv/namespaces/${namespace}`,
  `the account of ${zone.name} must hold the environment's kv_mainnet, ${namespace}, as the environment's account does`);

const domains = (await list<Domain>(`/accounts/${zone.account}/workers/domains?hostname=${encodeURIComponent(host)}`, `reading the custom domain ${host}`))
  .filter(domain => typeof(domain.hostname) === 'string' && domain.hostname.toLowerCase() === host);
if (domains.length === 0) {
  refuse(`the custom domain ${host} is attached to no Worker of the account ${zone.account}: the environment ${name} is not deployed to it`);
}
for (const domain of domains) {
  if (domain.service !== worker) {
    refuse(`the custom domain ${host} is attached to the Worker ${String(domain.service)}, not to ${worker}`);
  }
  if (domain.environment !== undefined && domain.environment !== null && domain.environment !== 'production') {
    refuse(`the custom domain ${host} is attached to the environment ${String(domain.environment)} of ${worker}, not to the Worker itself`);
  }
  if (domain.enabled === false) {
    refuse(`the custom domain ${host} is switched off: it takes no traffic`);
  }
  if (domain.zone_id !== undefined && domain.zone_id !== zone.id) {
    refuse(`the custom domain ${host} is in the zone ${String(domain.zone_id)}, and not in ${zone.name}, whose routes this reads`);
  }
}

const routes = await list<Route>(`/zones/${zone.id}/workers/routes`, `reading the Worker routes of ${zone.name}`);
const before = routes.find(route => takesHost(route.pattern, host) && typeof(route.script) === 'string' && route.script.length > 0 && route.script !== worker);
if (before !== undefined) {
  refuse(`the zone ${zone.name} has a route, ${String(before.pattern)}, that may run the Worker ${String(before.script)} on ${host} before its custom domain: no route of another Worker may cover the host`);
}

process.stdout.write(`${address}: its custom domain is ${worker}'s, in the account that holds the environment's kv_mainnet, and no route of ${zone.name} runs another Worker on ${host}\n`);
