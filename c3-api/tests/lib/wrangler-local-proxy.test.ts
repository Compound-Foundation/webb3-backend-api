import t from 'tap';

import { unstable_readConfig } from 'wrangler';

/*
 * wrangler.local-proxy.toml is how a local run reaches the node provider
 * proxy running on the same machine (README, Getting Started): the default
 * environment of wrangler.toml, with the proxy bound to the worker the way
 * stage and production bind theirs. Everything else has to stay
 * wrangler.toml's — above all the local database, which
 * `npm run d1:migrate:local` prepares through wrangler.toml — so a binding or
 * a setting changed in one and not the other fails here.
 */
const BINDING = 'node_provider_proxy';

function read(config: string) {
  return unstable_readConfig({ config }, { hideWarnings: true });
}

const local   = read('./wrangler.toml');
const proxied = read('./wrangler.local-proxy.toml');

/*
 * What the two files differ in by design: where each was read from, the
 * environments only wrangler.toml defines, and the binding, with the two
 * settings that send every call to the node provider proxy through it.
 */
const BY_DESIGN      = [ 'configPath', 'userConfigPath', 'definedEnvironments', 'services' ];
const PROXY_SETTINGS = [ 'NODE_PROXY_HOST', 'URL_SERVICE_BINDING_OVERRIDES' ];

function without(fields: object, names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([ name ]) => !names.includes(name)));
}

function settingsOf(config: ReturnType<typeof read>): Record<string, unknown> {
  return { ...without(config, BY_DESIGN), vars: without(config.vars, PROXY_SETTINGS) };
}

t.test('the proxy node-provider-proxy runs locally is bound to the worker', async t => {
  const proxy = read('../node-provider-proxy/wrangler.toml');
  t.same(proxied.services, [ { binding: BINDING, service: proxy.name } ], 'by the name of its default environment');
  t.same(
    proxied.vars.URL_SERVICE_BINDING_OVERRIDES,
    [ { host: proxied.vars.NODE_PROXY_HOST, binding: BINDING } ],
    'and every call to the node provider proxy goes through the binding',
  );
});

t.test('everything else is the default environment of wrangler.toml', async t => {
  t.same(proxied.d1_databases, local.d1_databases, 'the local database that npm run d1:migrate:local prepares');
  t.same(settingsOf(proxied), settingsOf(local), 'and every other binding and setting');
});
