import { unstable_readConfig } from 'wrangler';

/*
 * Prints the https address of the environment ENVIRONMENT names: the one host
 * Wrangler deploys it to, read with Wrangler's own reader from the
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
 * that name; and when the environment has not one address for every path of
 * one host. A custom domain is such an address, and so is a route of a zone
 * that takes every path, `host/*`, with or without a scheme. A route of a
 * zone with no path takes `/` alone, and one with a path only that path.
 */
function refuse(problem: string): never {
  console.error(problem);
  process.exit(1);
}

// a route of a zone that takes every path of its host: the host, or undefined
function zoneHost(pattern: string): string | undefined {
  return /^(?:https?:\/\/)?([^/*:]+)\/\*$/.exec(pattern)?.[1];
}

// the host a route takes every path of, or undefined for a route that takes less
function hostOf(route: unknown): string | undefined {
  if (typeof(route) === 'string') {
    return zoneHost(route);
  }
  if (typeof(route) !== 'object' || route === null) {
    return undefined;
  }
  const { pattern, custom_domain: customDomain } = route as { pattern?: unknown, custom_domain?: unknown };
  if (typeof(pattern) !== 'string') {
    return undefined;
  }
  return customDomain === true ? /^[^/*:]+$/.exec(pattern)?.[0] : zoneHost(pattern);
}

const name = process.env['ENVIRONMENT'] ?? '';
if (name.trim().length === 0) {
  refuse('ENVIRONMENT is not set: export it as wrangler.toml names the environment, such as ENVIRONMENT=production');
}

let config: ReturnType<typeof unstable_readConfig>;
try {
  config = unstable_readConfig({ env: name }, { hideWarnings: true });
} catch (error) {
  refuse(`Wrangler refuses the environment ${name}: ${error instanceof Error ? error.message : String(error)}`);
}
// with no environment defined at all, Wrangler only warns of a name it does not know, and reads the top level
if (!(config.definedEnvironments ?? []).includes(name)) {
  refuse(`the Wrangler configuration defines no environment ${name}`);
}

// the routes Wrangler deploys the environment to: its routes whenever they are set, an empty list too, else its route
const routes: unknown[] = config.routes ?? (config.route ? [ config.route ] : []);
const hosts = new Set<string>();
for (const route of routes) {
  const host = hostOf(route);
  if (host === undefined) {
    refuse(`the environment ${name} has a route that takes less than every path of one host: ${JSON.stringify(route)}`);
  }
  hosts.add(host.toLowerCase());
}
if (hosts.size !== 1) {
  refuse(hosts.size === 0
    ? `the environment ${name} has no route`
    : `the environment ${name} has routes to more than one host: ${[ ...hosts ].join(', ')}`);
}

process.stdout.write(`https://${[ ...hosts ][0]}\n`);
