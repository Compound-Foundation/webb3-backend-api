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
 * environment is read as Wrangler deploys it; one not deployed to one custom
 * domain is refused, and nothing is printed for API to take.
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

[env.upper]
name = "fixture-upper"
routes = [ { pattern = "Upper.Example.com", custom_domain = true } ]

[env.single]
name = "fixture-single"
route = { pattern = "single.example.com", custom_domain = true }

[env.same]
name = "fixture-same"
routes = [ { pattern = "same.example.com", custom_domain = true }, { pattern = "SAME.example.com", custom_domain = true } ]

[env.unrouted]
name = "fixture-unrouted"

[env.twice]
name = "fixture-twice"
routes = [ { pattern = "one.example.com", custom_domain = true }, { pattern = "two.example.com", custom_domain = true } ]

[env.zone]
name = "fixture-zone"
routes = [ "zone.example.com/*" ]

[env.schemed]
name = "fixture-schemed"
routes = [ "https://schemed.example.com/*" ]

[env.plain]
name = "fixture-plain"
routes = [ "http://plain.example.com/*" ]

[env.named]
name = "fixture-named"
routes = [ { pattern = "http://named.example.com/*", zone_name = "example.com" } ]

[env.singlezone]
name = "fixture-singlezone"
route = "singlezone.example.com/*"

[env.mixed]
name = "fixture-mixed"
routes = [ { pattern = "mixed.example.com", custom_domain = true }, "mixed.example.com/*" ]

[env.off]
name = "fixture-off"
routes = [ { pattern = "off.example.com", custom_domain = false } ]

[env.pathed]
name = "fixture-pathed"
routes = [ { pattern = "pathed.example.com/api", custom_domain = true } ]

[env.enabled]
name = "fixture-enabled"
routes = [ { pattern = "enabled.example.com", custom_domain = true, enabled = true } ]

[env.previews]
name = "fixture-previews"
routes = [ { pattern = "previews.example.com", custom_domain = true, enabled = false, previews_enabled = true } ]

[env.idn]
name = "fixture-idn"
routes = [ { pattern = "xn--bcher-kva.example.com", custom_domain = true } ]

[env.address]
name = "fixture-address"
routes = [ { pattern = "192.0.2.1", custom_domain = true } ]

[env.hyphen]
name = "fixture-hyphen"
routes = [ { pattern = "-hyphen.example.com", custom_domain = true } ]
`);

// a route at the top level: an environment inherits it, unless it sets routes of its own, an empty list too
const INHERITED = configured('inherited', `
routes = [ { pattern = "top.example.com", custom_domain = true } ]

[env.inherits]
name = "fixture-inherits"

[env.emptied]
name = "fixture-emptied"
routes = []

[env.own]
name = "fixture-own"
routes = [ { pattern = "own.example.com", custom_domain = true } ]
`);

// a wildcard, which would take the host of every other environment here
const WILDCARD = configured('wildcard', `
[env.wildcard]
name = "fixture-wildcard"
routes = [ { pattern = "*.example.com", custom_domain = true } ]
`);

// one Worker for two environments: whatever one puts into it, the other's requests take too
const WORKER = configured('worker', `
[env.left]
name = "fixture-shared-worker"
routes = [ { pattern = "left.example.com", custom_domain = true } ]

[env.right]
name = "fixture-shared-worker"
routes = [ { pattern = "right.example.com", custom_domain = true } ]
`);

// a route of the zone that another environment lists on the host, which would run before the custom domain
const ROUTED = configured('routed', `
[env.routed]
name = "fixture-routed"
routes = [ { pattern = "routed.example.com", custom_domain = true } ]

[env.taker]
name = "fixture-taker"
routes = [ "routed.example.com/registry/*" ]

[env.under]
name = "fixture-under"
routes = [ { pattern = "api.under.example.com", custom_domain = true } ]

[env.over]
name = "fixture-over"
routes = [ "*.under.example.com/*" ]
`);

// one custom domain listed by two Workers: it belongs to whichever was deployed to it last
const SHARED = configured('shared', `
[env.first]
name = "fixture-first"
routes = [ { pattern = "shared.example.com", custom_domain = true } ]

[env.second]
name = "fixture-second"
routes = [ { pattern = "SHARED.example.com", custom_domain = true } ]

[env.serving]
name = "fixture-serving"
routes = [ { pattern = "previewed.example.com", custom_domain = true } ]

[env.previewing]
name = "fixture-previewing"
routes = [ { pattern = "previewed.example.com", custom_domain = true, enabled = false, previews_enabled = true } ]
`);

// no environment at all: Wrangler only warns of an unknown name, and reads the top level
const UNDEFINED = configured('undefined', `
routes = [ { pattern = "top.example.com", custom_domain = true } ]
`);

// the variables that would send Wrangler to another API, which a developer's own shell may set
const ELSEWHERE = [ 'CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'WRANGLER_API_ENVIRONMENT', 'CLOUDFLARE_COMPLIANCE_REGION',
  'WRANGLER_AUTH_DOMAIN', 'WRANGLER_AUTH_URL', 'WRANGLER_TOKEN_URL', 'WRANGLER_REVOKE_URL' ];

function address(environment: string | undefined, cwd: string, extra: Record<string, string> = {}): { status: number | null, stdout: string, stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const variable of ELSEWHERE) {
    delete env[variable];
  }
  Object.assign(env, extra);
  delete env['ENVIRONMENT'];
  if (environment !== undefined) {
    env['ENVIRONMENT'] = environment;
  }
  const { status, stdout, stderr } = spawnSync(process.execPath, [ SCRIPT ], { cwd, env, encoding: 'utf8' });
  return { status, stdout, stderr };
}

t.test('an environment deployed to one custom domain has its address', async t => {
  const taken: Array<[ string, string, string ]> = [
    [ 'custom',   ROUTES,    'https://custom.example.com\n' ],
    [ 'upper',    ROUTES,    'https://upper.example.com\n' ],
    [ 'single',   ROUTES,    'https://single.example.com\n' ],
    [ 'same',     ROUTES,    'https://same.example.com\n' ],
    [ 'enabled',  ROUTES,    'https://enabled.example.com\n' ],
    [ 'idn',      ROUTES,    'https://xn--bcher-kva.example.com\n' ],
    [ 'own',      INHERITED, 'https://own.example.com\n' ],
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
  // CLOUDFLARE_ENV names no environment here: Wrangler's reader would take it for the top level's read
  const pinned = address('own', INHERITED, { CLOUDFLARE_ENV: 'own' });
  t.equal(pinned.stdout, 'https://own.example.com\n', 'whatever CLOUDFLARE_ENV says');
});

t.test('an environment not deployed to one custom domain is refused, and nothing is printed', async t => {
  const other = /^the environment \w+ has a route other than a custom domain that takes its traffic: /;
  const refusals: Array<[ string, string | undefined, string, RegExp ]> = [
    [ 'no name',                             undefined,    ROUTES,    /^ENVIRONMENT is not set: export it as wrangler\.toml names the environment/ ],
    [ 'an empty name',                       '',           ROUTES,    /^ENVIRONMENT is not set/ ],
    [ 'a name of spaces',                    ' ',          ROUTES,    /^ENVIRONMENT is not set/ ],
    [ 'a name the configuration lacks',      'missing',    ROUTES,    /^Wrangler refuses the environment missing: / ],
    [ 'a name where none is defined',        'production', UNDEFINED, /^the Wrangler configuration defines no environment production/ ],
    [ 'an environment with no route',        'unrouted',   ROUTES,    /^the environment unrouted has no route/ ],
    [ 'one that empties its routes',         'emptied',    INHERITED, /^the environment emptied has no route/ ],
    [ 'one with custom domains of two hosts', 'twice',     ROUTES,    /^the environment twice has custom domains of more than one host: one\.example\.com, two\.example\.com/ ],
    [ 'one routed through a zone',           'zone',       ROUTES,    /^the environment zone has a route other than a custom domain that takes its traffic: "zone\.example\.com\/\*"/ ],
    [ 'one routed through a zone for https', 'schemed',    ROUTES,    other ],
    [ 'one routed for plain http alone',     'plain',      ROUTES,    /^the environment plain has a route other than a custom domain that takes its traffic: "http:\/\/plain\.example\.com\/\*"/ ],
    [ 'one routed for plain http by object', 'named',      ROUTES,    other ],
    [ 'one with a route of a zone alone',    'singlezone', ROUTES,    other ],
    [ 'one with a zone beside its domain',   'mixed',      ROUTES,    other ],
    [ 'one marked as no custom domain',      'off',        ROUTES,    other ],
    [ 'one whose domain has a path',         'pathed',     ROUTES,    other ],
    [ 'one whose domain is a wildcard',      'wildcard',   WILDCARD,  other ],
    [ 'one whose domain serves previews',    'previews',   ROUTES,    other ],
    [ 'one whose domain is an IP address',   'address',    ROUTES,    other ],
    [ 'one whose domain starts with a hyphen', 'hyphen',   ROUTES,    other ],
    [ 'one that inherits the top level\'s',  'inherits',   INHERITED, /^the environment inherits shares its custom domain top\.example\.com with the top level/ ],
    [ 'one that another lists too',          'first',      SHARED,    /^the environment first shares its custom domain shared\.example\.com with the environment second/ ],
    [ 'one that another lists for previews', 'serving',    SHARED,    /^the environment serving shares its custom domain previewed\.example\.com with the environment previewing/ ],
    [ 'one whose Worker another deploys to', 'left',       WORKER,    /^the environment left deploys to the Worker fixture-shared-worker, as the environment right does/ ],
    [ 'one with another\'s route on its host', 'routed',   ROUTED,    /^the environment routed shares its custom domain routed\.example\.com with the environment taker: "routed\.example\.com\/registry\/\*"/ ],
    [ 'one under another\'s wildcard route', 'under',      ROUTED,    /^the environment under shares its custom domain api\.under\.example\.com with the environment over: "\*\.under\.example\.com\/\*"/ ],
  ];
  for (const [ what, name, cwd, problem ] of refusals) {
    const { status, stdout, stderr } = address(name, cwd);
    t.equal(status, 1, `${what} is refused`);
    t.equal(stdout, '', 'and nothing is printed');
    t.match(stderr, problem, 'with what is wrong');
  }
});

t.test('a Wrangler that would talk to another API than Cloudflare\'s is refused, and nothing is printed', async t => {
  for (const variable of [ 'CLOUDFLARE_API_BASE_URL', 'WRANGLER_TOKEN_URL' ]) {
    const shell = address('custom', ROUTES, { [variable]: 'http://127.0.0.1:9' });
    t.equal(shell.status, 1, `${variable} set in the shell is refused`);
    t.equal(shell.stdout, '', 'and nothing is printed');
    t.match(shell.stderr, new RegExp(`^${variable} is set in this shell, to "http://127\\.0\\.0\\.1:9": Wrangler can send its requests, or your login, elsewhere than Cloudflare's own API`), 'with what it can do');
  }
  writeFileSync(join(ROUTES, '.env.custom'), 'CF_API_BASE_URL=http://127.0.0.1:9\n');
  const filed = address('custom', ROUTES);
  rmSync(join(ROUTES, '.env.custom'));
  t.equal(filed.status, 1, 'set in a .env file of the environment, which Wrangler reads, is refused');
  t.equal(filed.stdout, '', 'and nothing is printed');
  t.match(filed.stderr, /^CF_API_BASE_URL is set in \.env\.custom, which Wrangler reads/, 'naming the file');
});
