import { readFileSync } from 'node:fs';

import { unstable_readConfig } from 'wrangler';

/*
 * The environment ENVIRONMENT names, as Wrangler deploys it, read with
 * Wrangler's own reader from the configuration Wrangler finds here: the
 * Worker it deploys to, and the one custom domain of its own that takes its
 * traffic. scripts/environment-address.ts prints that domain's address, and
 * scripts/environment-routing.ts checks that Cloudflare sends it to that
 * Worker alone.
 *
 * It refuses, and the scripts print nothing, while the name is not set, since
 * Wrangler reads no name as the top-level environment, a worker run on your
 * own machine; when the configuration defines no environment of that name;
 * and when the environment is not deployed to one custom domain of its own. A
 * custom domain is the address the configuration gives: Cloudflare creates
 * its DNS record, which points to the Worker, and its certificate. One set
 * enabled = false serves previews alone. A route of a zone is no such
 * address: it runs the Worker only for the requests the zone's DNS sends
 * through Cloudflare, which the configuration does not show, and one written
 * with http:// only for plain http. And the domain is not the environment's
 * own when another Worker of the configuration, the top level among them,
 * lists it too or has a route of the zone on its host, which would run
 * first, or when another environment deploys to the same Worker, whose
 * secrets the two would then share. It also refuses while Wrangler would talk
 * to another API than Cloudflare's own, which the routing check reads, and
 * which the account check before every secret written must reach.
 */
export function refuse(problem: string): never {
  console.error(problem);
  process.exit(1);
}

// a host name: labels of letters, digits and hyphens, none starting or ending with a hyphen, the last starting with a letter
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export type Config = ReturnType<typeof unstable_readConfig>;

export type Environment = {
  name:   string,
  // the Worker Wrangler deploys the environment to, and puts its secrets into
  worker: string,
  // the host of its custom domain, in lowercase
  host:   string,
  config: Config,
};

// the configuration of an environment, or of the top level for none
function read(environment: string | undefined): Config {
  try {
    return unstable_readConfig(environment === undefined ? {} : { env: environment }, { hideWarnings: true });
  } catch (error) {
    refuse(`Wrangler refuses the ${environment === undefined ? 'top level' : `environment ${environment}`}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// the routes Wrangler deploys a configuration to: its routes whenever they are set, an empty list too, else its route
function routesOf(config: Config): unknown[] {
  return config.routes ?? (config.route ? [ config.route ] : []);
}

// the host, in lowercase, of a custom domain, or undefined for any other route
function customDomain(route: unknown): string | undefined {
  if (typeof(route) !== 'object' || route === null) {
    return undefined;
  }
  const { pattern, custom_domain: isCustomDomain } = route as { pattern?: unknown, custom_domain?: unknown };
  return isCustomDomain === true && typeof(pattern) === 'string' && HOST.test(pattern) ? pattern.toLowerCase() : undefined;
}

// whether a custom domain takes the Worker's traffic: one set enabled = false serves previews alone
function takesTraffic(route: unknown): boolean {
  const { enabled } = route as { enabled?: unknown };
  return enabled === undefined || enabled === true;
}

/*
 * Whether a route, a custom domain or one of a zone, of any path, takes the
 * host's requests: its pattern's host, past a scheme and before a path and a
 * port, is the host, a * in it standing for anything, as in *example.com,
 * *.example.com or example.com*.
 */
export function takesHost(route: unknown, host: string): boolean {
  const pattern = typeof(route) === 'string' ? route : (route as { pattern?: unknown } | null)?.pattern;
  if (typeof(pattern) !== 'string') {
    return false;
  }
  const routed = (pattern.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] ?? '').replace(/:\d+$/, '');
  const matching = routed.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${matching}$`, 'i').test(host);
}

/*
 * Wrangler can talk to another API than api.cloudflare.com, which the routing
 * check reads, when the shell, or a .env file it reads for the environment,
 * sets one of these: the base of every API request, the account check's and
 * the secrets' among them, or another Cloudflare API in its place; or the
 * address that takes the login, when `wrangler login` gives it, when Wrangler
 * refreshes it, as `wrangler auth token` may, or when it is revoked. Any value
 * is refused, Wrangler's own defaults too. It reads the files Wrangler reads,
 * from the directory it runs in.
 */
const OVERRIDES = [
  'CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'WRANGLER_API_ENVIRONMENT', 'CLOUDFLARE_COMPLIANCE_REGION',
  'WRANGLER_AUTH_DOMAIN', 'WRANGLER_AUTH_URL', 'WRANGLER_TOKEN_URL', 'WRANGLER_REVOKE_URL',
];
const SETS = new RegExp(`^\\s*(?:export\\s+)?(${OVERRIDES.join('|')})\\s*[=:]`, 'm');

function wranglerAtCloudflare(name: string): void {
  for (const variable of OVERRIDES) {
    if (process.env[variable] !== undefined) {
      refuse(`${variable} is set in this shell, to ${JSON.stringify(process.env[variable])}: Wrangler can send its requests, or your login, elsewhere than Cloudflare's own API: unset it`);
    }
  }
  for (const file of [ '.env', '.env.local', `.env.${name}`, `.env.${name}.local` ]) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const set = SETS.exec(text);
    if (set !== null) {
      refuse(`${String(set[1])} is set in ${file}, which Wrangler reads: it can send its requests, or your login, elsewhere than Cloudflare's own API: remove it`);
    }
  }
}

export function environmentOf(variable: string | undefined): Environment {
  // the environment is ENVIRONMENT's alone: Wrangler's reader takes CLOUDFLARE_ENV for a read that names none
  delete process.env['CLOUDFLARE_ENV'];

  const name = variable ?? '';
  if (name.trim().length === 0) {
    refuse('ENVIRONMENT is not set: export it as wrangler.toml names the environment, such as ENVIRONMENT=production');
  }
  wranglerAtCloudflare(name);

  const config = read(name);
  // with no environment defined at all, Wrangler only warns of a name it does not know, and reads the top level
  const environments: string[] = config.definedEnvironments ?? [];
  if (!environments.includes(name)) {
    refuse(`the Wrangler configuration defines no environment ${name}`);
  }
  const worker = config.name;
  if (worker === undefined || worker.length === 0) {
    refuse(`the environment ${name} names no Worker`);
  }

  const hosts = new Set<string>();
  for (const route of routesOf(config)) {
    const host = customDomain(route);
    if (host === undefined || !takesTraffic(route)) {
      refuse(`the environment ${name} has a route other than a custom domain that takes its traffic: ${JSON.stringify(route)}`);
    }
    hosts.add(host);
  }
  if (hosts.size !== 1) {
    refuse(hosts.size === 0
      ? `the environment ${name} has no route`
      : `the environment ${name} has custom domains of more than one host: ${[ ...hosts ].join(', ')}`);
  }
  const host = [ ...hosts ][0] as string;

  // every other Worker of the configuration: the top level, and each other environment
  for (const other of [ undefined, ...environments.filter(environment => environment !== name) ]) {
    const sibling = read(other);
    const who = other === undefined ? 'the top level' : `the environment ${other}`;
    if (sibling.name === worker) {
      refuse(`the environment ${name} deploys to the Worker ${worker}, as ${who} does`);
    }
    const taking = routesOf(sibling).find(route => takesHost(route, host));
    if (taking !== undefined) {
      refuse(`the environment ${name} shares its custom domain ${host} with ${who}: ${JSON.stringify(taking)}`);
    }
  }

  return { name, worker, host, config };
}
