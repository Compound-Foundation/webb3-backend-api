import t from 'tap';

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * REGISTRY_RUNBOOK.md sets API from this, in "Before you start" and in step 4
 * of "The admin tokens", so the requests go to the environment ENVIRONMENT
 * names, the one every Wrangler command of the runbook targets. An
 * environment is read as Wrangler deploys it; one with no single address for
 * every path of one host is refused, and nothing is printed for API to take.
 */
// the compiled script beside the compiled test, given to fileURLToPath as a string: the worker's URL type is not Node's
const SCRIPT = fileURLToPath(new URL('../../scripts/environment-address.js', import.meta.url).href);
const root   = mkdtempSync(join(tmpdir(), 'environment-address-'));
t.teardown(() => rmSync(root, { recursive: true, force: true }));

// a directory holding a wrangler.toml, which the script finds as Wrangler does
function configured(name: string, toml: string): string {
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(join(directory, 'wrangler.toml'), `name = "fixture"\nmain = "entry.js"\ncompatibility_date = "2026-01-01"\n${toml}`);
  return directory;
}

const ROUTES = configured('routes', `
[env.custom]
name = "fixture-custom"
routes = [ { pattern = "custom.example.com", custom_domain = true } ]

[env.zone]
name = "fixture-zone"
routes = [ "zone.example.com/*" ]

[env.schemed]
name = "fixture-schemed"
routes = [ "https://schemed.example.com/*" ]

[env.named]
name = "fixture-named"
routes = [ { pattern = "named.example.com/*", zone_name = "example.com" } ]

[env.single]
name = "fixture-single"
route = "single.example.com/*"

[env.unrouted]
name = "fixture-unrouted"

[env.twice]
name = "fixture-twice"
routes = [ { pattern = "one.example.com", custom_domain = true }, { pattern = "two.example.com", custom_domain = true } ]

[env.partly]
name = "fixture-partly"
routes = [ "partly.example.com/api/*" ]

[env.root]
name = "fixture-root"
routes = [ "root.example.com" ]
`);

// a route at the top level: an environment inherits it, unless it sets routes of its own, an empty list too
const INHERITED = configured('inherited', `
route = "top.example.com/*"

[env.inherits]
name = "fixture-inherits"

[env.emptied]
name = "fixture-emptied"
routes = []
`);

// no environment at all: Wrangler only warns of an unknown name, and reads the top level
const UNDEFINED = configured('undefined', `
routes = [ { pattern = "top.example.com", custom_domain = true } ]
`);

function address(environment: string | undefined, cwd: string): { status: number | null, stdout: string, stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env['ENVIRONMENT'];
  if (environment !== undefined) {
    env['ENVIRONMENT'] = environment;
  }
  const { status, stdout, stderr } = spawnSync(process.execPath, [ SCRIPT ], { cwd, env, encoding: 'utf8' });
  return { status, stdout, stderr };
}

t.test('an environment deployed to every path of one host has that address', async t => {
  const taken: Array<[ string, string, string ]> = [
    [ 'custom',   ROUTES,    'https://custom.example.com\n' ],
    [ 'zone',     ROUTES,    'https://zone.example.com\n' ],
    [ 'schemed',  ROUTES,    'https://schemed.example.com\n' ],
    [ 'named',    ROUTES,    'https://named.example.com\n' ],
    [ 'single',   ROUTES,    'https://single.example.com\n' ],
    [ 'inherits', INHERITED, 'https://top.example.com\n' ],
  ];
  for (const [ name, cwd, printed ] of taken) {
    const { status, stdout } = address(name, cwd);
    t.equal(status, 0, `${name} is read`);
    t.equal(stdout, printed, `as ${printed.trim()}`);
  }
  // the tests run in c3-api, beside the wrangler.toml the runbook reads
  const production = address('production', process.cwd());
  t.equal(production.status, 0, 'production is read from this repository\'s wrangler.toml');
  t.equal(production.stdout, 'https://v3-api.compound.xyz\n', 'as its custom domain');
});

t.test('an environment with no single address is refused, and nothing is printed', async t => {
  const refusals: Array<[ string, string | undefined, string, RegExp ]> = [
    [ 'no name',                           undefined,    ROUTES,    /^ENVIRONMENT is not set: export it as wrangler\.toml names the environment/ ],
    [ 'an empty name',                     '',           ROUTES,    /^ENVIRONMENT is not set/ ],
    [ 'a name of spaces',                  ' ',          ROUTES,    /^ENVIRONMENT is not set/ ],
    [ 'a name the configuration lacks',    'missing',    ROUTES,    /^Wrangler refuses the environment missing: / ],
    [ 'a name where none is defined',      'production', UNDEFINED, /^the Wrangler configuration defines no environment production/ ],
    [ 'an environment with no route',      'unrouted',   ROUTES,    /^the environment unrouted has no route/ ],
    [ 'one that empties its routes',       'emptied',    INHERITED, /^the environment emptied has no route/ ],
    [ 'one with routes to two hosts',      'twice',      ROUTES,    /^the environment twice has routes to more than one host: one\.example\.com, two\.example\.com/ ],
    [ 'one routed to a path of its host',  'partly',     ROUTES,    /^the environment partly has a route that takes less than every path of one host: "partly\.example\.com\/api\/\*"/ ],
    [ 'one routed to the root path alone', 'root',       ROUTES,    /^the environment root has a route that takes less than every path of one host: "root\.example\.com"/ ],
  ];
  for (const [ what, name, cwd, problem ] of refusals) {
    const { status, stdout, stderr } = address(name, cwd);
    t.equal(status, 1, `${what} is refused`);
    t.equal(stdout, '', 'and nothing is printed');
    t.match(stderr, problem, 'with what is wrong');
  }
});
