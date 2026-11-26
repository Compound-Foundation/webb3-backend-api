import { unstable_readConfig } from 'wrangler';

/*
 * Prints the https address of the environment ENVIRONMENT names: the custom
 * domain Wrangler deploys it to, read with Wrangler's own reader from the
 * configuration Wrangler finds here. REGISTRY_RUNBOOK.md sets API from it, in
 * "Before you start" and in step 4 of "The admin tokens", so the requests go
 * to the environment that every Wrangler command of the runbook targets with
 * --env "$ENVIRONMENT".
 *
 *   npx tsc -p tsconfig.scripts.json && node dist/scripts/environment-address.js
 *
 * It runs in c3-api. It refuses, and prints nothing, while the name is not
 * set, since Wrangler reads no name as the top-level environment, a worker
 * run on your own machine; when the configuration defines no environment of
 * that name; and when the environment is not deployed to one custom domain of
 * its own that takes its traffic. A custom domain is the address the
 * configuration gives: Cloudflare creates its DNS record, which points to the
 * Worker, and its certificate. One set enabled = false serves previews alone,
 * and one that another Worker of the configuration lists, the top level
 * among them, belongs to whichever of them was deployed to it last. A route
 * of a zone is no such address: it runs the Worker only for the requests the
 * zone's DNS sends through Cloudflare, which the configuration does not show,
 * and one written with http:// only for plain http. Nor does the
 * configuration show a route of the zone on the custom domain's host, which
 * would run first: the status the runbook reads names the environment that
 * answers.
 */
function refuse(problem: string): never {
  console.error(problem);
  process.exit(1);
}

// the environment is ENVIRONMENT's alone: Wrangler's reader takes CLOUDFLARE_ENV for a read that names none
delete process.env['CLOUDFLARE_ENV'];

// a host name: labels of letters, digits and hyphens, none starting or ending with a hyphen, the last starting with a letter
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

type Config = ReturnType<typeof unstable_readConfig>;

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

const name = process.env['ENVIRONMENT'] ?? '';
if (name.trim().length === 0) {
  refuse('ENVIRONMENT is not set: export it as wrangler.toml names the environment, such as ENVIRONMENT=production');
}

const config = read(name);
// with no environment defined at all, Wrangler only warns of a name it does not know, and reads the top level
const environments: string[] = config.definedEnvironments ?? [];
if (!environments.includes(name)) {
  refuse(`the Wrangler configuration defines no environment ${name}`);
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
const [ host ] = hosts;

// a custom domain belongs to one Worker: whichever of those that list it was deployed to it last
for (const other of [ undefined, ...environments.filter(environment => environment !== name) ]) {
  if (routesOf(read(other)).some(route => customDomain(route) === host)) {
    refuse(`the environment ${name} shares its custom domain ${host} with ${other === undefined ? 'the top level' : `the environment ${other}`}`);
  }
}

process.stdout.write(`https://${host}\n`);
