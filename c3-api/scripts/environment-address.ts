import { environmentOf } from './environment.js';

/*
 * Prints the https address of the environment ENVIRONMENT names: the one
 * custom domain of its own that Wrangler deploys it to (scripts/environment.ts
 * says which it refuses, and prints nothing then). REGISTRY_RUNBOOK.md sets
 * API from it, in "Before you start" and in step 4 of "The admin tokens", so
 * the requests go to the environment that every Wrangler command of the
 * runbook targets with --env "$ENVIRONMENT".
 *
 *   npx tsc -p tsconfig.scripts.json && node dist/scripts/environment-address.js
 *
 * It runs in c3-api, and reads nothing but the configuration: that Cloudflare
 * sends the address to the environment's Worker alone is
 * scripts/environment-routing.ts's to check.
 */
const { host } = environmentOf(process.env['ENVIRONMENT']);
process.stdout.write(`https://${host}\n`);
