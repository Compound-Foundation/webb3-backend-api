import t from 'tap';

import type { Env } from '../../../entrypoint.js';

import { cacheDepsOf } from '../../../src/registry/cache.js';
import { assertImportable, registryConfig, webhookUrlOf } from '../../../src/registry/config.js';
import { isRegistryError } from '../../../src/registry/errors.js';
import { importerDeps } from '../../../src/registry/scheduled.js';

import { makeTestEnv } from '../../util/test-env.js';

/*
 * The registry's settings are read in one place and by one rule, so the
 * importer, the cache and the status cannot disagree about what an
 * environment configured: unset and blank are the default, and anything else
 * is a whole number in the setting's range or not used at all — named, and
 * answered with the default by a read.
 */
const DEFAULTS = {
  leaseSeconds:            900,
  marketsPerInvocation:    2,
  upstreamIntervalSeconds: 86400,
  snapshotTtlSeconds:      300,
  staleFallbackSeconds:    3600,
  approvalTtlSeconds:      86400,
  webhook:                 'off',
};

// an environment as wrangler gives it, where an unquoted value arrives as a number
function envOf(overrides: Record<string, unknown>): Env {
  return makeTestEnv(overrides as Partial<Env>);
}

function configOf(overrides: Record<string, unknown>) {
  return registryConfig(envOf(overrides));
}

t.test('unset and blank settings take their defaults', async t => {
  t.same(configOf({}), { ...DEFAULTS, invalid: [] }, 'the values every environment configures are the defaults');

  const blank = configOf({
    COMET_SYNC_LEASE_SECONDS:          undefined,
    COMET_SYNC_MARKETS_PER_INVOCATION: '',
    COMET_UPSTREAM_CHECK_INTERVAL_S:   '  ',
    REGISTRY_SNAPSHOT_CACHE_TTL_S:     '',
    REGISTRY_STALE_FALLBACK_MAX_S:     '',
    COMET_REGISTRY_APPROVAL_TTL_S:     undefined,
  });
  t.same(blank, { ...DEFAULTS, invalid: [] }, 'blank is unset, for every setting alike');
  t.equal(blank.staleFallbackSeconds, 3600, 'so a blank fallback window does not switch the fallback off');
});

t.test('a whole number is read as written, quoted or not', async t => {
  t.same(configOf({
    COMET_SYNC_LEASE_SECONDS:          '600',
    COMET_SYNC_MARKETS_PER_INVOCATION: 5,
    COMET_UPSTREAM_CHECK_INTERVAL_S:   ' 3600 ',
    REGISTRY_SNAPSHOT_CACHE_TTL_S:     60,
    REGISTRY_STALE_FALLBACK_MAX_S:     '0',
    COMET_REGISTRY_APPROVAL_TTL_S:     7200,
  }), {
    leaseSeconds:            600,
    marketsPerInvocation:    5,
    upstreamIntervalSeconds: 3600,
    snapshotTtlSeconds:      60,
    staleFallbackSeconds:    0,
    approvalTtlSeconds:      7200,
    webhook:                 'off',
    invalid:                 [],
  }, 'a number wrangler passes unquoted counts as the same number, and zero switches the fallback off');
});

/*
 * An approval lets its version be switched on by somebody else for a second
 * up to a week. A value past that is a typo — one zero too many leaves an
 * approval good for months — and stands for nothing but the default.
 */
t.test('an approval lasts a second up to a week, and anything else is named', async t => {
  t.equal(configOf({ COMET_REGISTRY_APPROVAL_TTL_S: '1' }).approvalTtlSeconds, 1, 'a second is the least');
  t.equal(configOf({ COMET_REGISTRY_APPROVAL_TTL_S: '604800' }).approvalTtlSeconds, 604800, 'and a week the most');
  for (const value of [ '0', '604801', '8640000', '99999999999999999999' ]) {
    const config = configOf({ COMET_REGISTRY_APPROVAL_TTL_S: value });
    t.same(config.invalid, [ 'COMET_REGISTRY_APPROVAL_TTL_S' ], `${value} is out of its range, and named`);
    t.equal(config.approvalTtlSeconds, 86400, 'and a day, the default, stands in for it');
  }
  t.doesNotThrow(() => assertImportable(configOf({ COMET_REGISTRY_APPROVAL_TTL_S: '0' })),
    'the import, which approves nothing, runs whatever it is set to');
});

/*
 * The webhook a move or an approval is announced to is an https URL, whose
 * path is its credential. The configuration says whether one is set, and
 * never holds it: the importer, the cache and the status all build it.
 */
t.test('the webhook is on, off or invalid, and the configuration never holds it', async t => {
  const url = 'https://hooks.example.test/services/T0SECRET/B0SECRET/webhook-secret';

  for (const value of [ undefined, '', '   ' ]) {
    t.same(configOf({ COMET_REGISTRY_WEBHOOK_URL: value }), { ...DEFAULTS, invalid: [] }, `${JSON.stringify(value)} is no webhook`);
  }

  const on = configOf({ COMET_REGISTRY_WEBHOOK_URL: ` ${url}\n` });
  t.same(on, { ...DEFAULTS, webhook: 'on', invalid: [] }, 'an https URL is one, around whatever whitespace it was put with');
  t.notOk(JSON.stringify(on).includes('T0SECRET'), 'and the configuration says no more than that');
  t.equal(webhookUrlOf(makeTestEnv({ COMET_REGISTRY_WEBHOOK_URL: url })), url, 'the notifier alone reads the URL');
  t.equal(webhookUrlOf(makeTestEnv({ COMET_REGISTRY_WEBHOOK_URL: 'https://HOOKS.Example.TEST:443/services/T0' })),
    'https://hooks.example.test/services/T0', 'as the runtime parses it');

  for (const value of [ 'http://hooks.example.test/services/T0', 'hooks.example.test/services/T0', 'not a url', 'ftp://hooks.example.test/x' ]) {
    const config = configOf({ COMET_REGISTRY_WEBHOOK_URL: value });
    t.equal(config.webhook, 'invalid', `${JSON.stringify(value)} is no webhook a message can go to`);
    t.same(config.invalid, [ 'COMET_REGISTRY_WEBHOOK_URL' ], 'and is named, by the secret it is set under');
    t.equal(webhookUrlOf(makeTestEnv({ COMET_REGISTRY_WEBHOOK_URL: value })), null, 'so nothing is sent to it');
  }
  t.doesNotThrow(() => assertImportable(configOf({ COMET_REGISTRY_WEBHOOK_URL: 'not a url' })),
    'the import, which announces nothing, runs whatever it is set to');
});

t.test('anything else is named, and the default stands in for it', async t => {
  for (const value of [ '24h', '-1', '1.5', '1e3', '0x10', 'NaN', '99999999999999999999' ]) {
    const config = configOf({ COMET_UPSTREAM_CHECK_INTERVAL_S: value });
    t.same(config.invalid, [ 'COMET_UPSTREAM_CHECK_INTERVAL_S' ], `${JSON.stringify(value)} is not a whole number of seconds`);
    t.equal(config.upstreamIntervalSeconds, 86400, 'and reads as the default');
  }

  const zero = configOf({ COMET_SYNC_LEASE_SECONDS: '0', REGISTRY_SNAPSHOT_CACHE_TTL_S: '0' });
  t.same(zero.invalid, [ 'COMET_SYNC_LEASE_SECONDS', 'REGISTRY_SNAPSHOT_CACHE_TTL_S' ],
    'zero is a value only the fallback window takes');

  const source = configOf({ COMET_SOURCE_REPOSITORY: 'comet', COMET_SOURCE_REF: 'refs/heads/../evil' });
  t.same(source.invalid, [ 'COMET_SOURCE_REPOSITORY', 'COMET_SOURCE_REF' ],
    'and a source that is not owner/repository at a git ref is named too: it has no default');
});

t.test('the cache reads what the importer and the status read', async t => {
  const env = makeTestEnv({ REGISTRY_SNAPSHOT_CACHE_TTL_S: '120', REGISTRY_STALE_FALLBACK_MAX_S: '' });
  t.same(
    [ cacheDepsOf(env).ttlSeconds, cacheDepsOf(env).staleSeconds ],
    [ 120, 3600 ],
    'a blank fallback window keeps the fallback, as a blank import setting keeps its default',
  );
  t.equal(cacheDepsOf(makeTestEnv({ REGISTRY_STALE_FALLBACK_MAX_S: 'off' })).staleSeconds, 3600,
    'and a window that is no number is answered with the default, as the status says');
  t.equal(cacheDepsOf(makeTestEnv({ REGISTRY_STALE_FALLBACK_MAX_S: '0' })).staleSeconds, 0,
    'while zero switches it off');
});

/*
 * The import refuses to start while a setting of its own is invalid, before
 * it asks anything of the source or of D1, and names every one of them with
 * what it takes. A read setting does not stop it.
 */
t.test('the import refuses its own invalid settings, all of them at once', async t => {
  const env = makeTestEnv({ COMET_UPSTREAM_CHECK_INTERVAL_S: '24h', COMET_SYNC_LEASE_SECONDS: '-1' });
  try {
    importerDeps(env);
    t.fail('the import starts');
  } catch (error) {
    t.ok(isRegistryError(error) && error.code === 'SOURCE_CONFIGURATION_INVALID', 'the import is refused');
    t.equal(
      (error as Error).message,
      'COMET_SYNC_LEASE_SECONDS must be a positive integer; COMET_UPSTREAM_CHECK_INTERVAL_S must be a positive integer',
      'naming each setting with what it takes',
    );
  }

  t.doesNotThrow(() => assertImportable(configOf({ REGISTRY_STALE_FALLBACK_MAX_S: 'off' })),
    'a setting only reads take is answered with its default, and the import runs');
  t.same(importerDeps(envOf({ COMET_SYNC_MARKETS_PER_INVOCATION: 7 })).config, {
    leaseSeconds:            900,
    marketsPerInvocation:    7,
    upstreamIntervalSeconds: 86400,
  }, 'and the importer runs with the values the status reports');
});
