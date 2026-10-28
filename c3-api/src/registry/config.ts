import type { Env } from '../../entrypoint.js';

import { RegistryError } from './errors.js';
import { isRef, isRepository } from './source/github.js';

/*
 * The registry's settings, read from the environment in one place and by one
 * rule, so the importer, the cache and the status cannot disagree about what
 * an environment configured.
 *
 * A number that is unset or blank takes its default; anything else has to be
 * a whole number in its range. A setting set to something it does not take is
 * never acted on, and is named in `invalid`. Reads take the default in its
 * place, because a route cannot refuse to answer over how long a cache lives.
 * The import refuses to start while one of its own settings is invalid,
 * because what it would do then is not what anybody configured. And the
 * status raises every invalid setting at once, as `configuration-invalid`,
 * rather than leaving it to be found by the failures it causes.
 */
type RegistryConfig = {
  // how long an invocation holds the import before another may take it over
  leaseSeconds:            number,
  // how many markets the Cron imports per invocation
  marketsPerInvocation:    number,
  // how often discovery asks the source for a new commit
  upstreamIntervalSeconds: number,
  // the max-age public reads advertise
  snapshotTtlSeconds:      number,
  // how old an answer may be when D1 cannot be reached; zero switches the fallback off
  staleFallbackSeconds:    number,
  // every setting set to something it does not take, by the name it is set under
  invalid:                 string[],
};

type NumericSetting = Exclude<keyof RegistryConfig, 'invalid'>;

/*
 * Each number by the variable that sets it, with its default and the least
 * value it takes: only the fallback window takes zero, which is how an
 * environment that would rather fail than serve an older version says so.
 */
const NUMBERS = {
  leaseSeconds:            { name: 'COMET_SYNC_LEASE_SECONDS',          fallback: 900,   minimum: 1 },
  marketsPerInvocation:    { name: 'COMET_SYNC_MARKETS_PER_INVOCATION', fallback: 2,     minimum: 1 },
  upstreamIntervalSeconds: { name: 'COMET_UPSTREAM_CHECK_INTERVAL_S',   fallback: 86400, minimum: 1 },
  snapshotTtlSeconds:      { name: 'REGISTRY_SNAPSHOT_CACHE_TTL_S',     fallback: 300,   minimum: 1 },
  staleFallbackSeconds:    { name: 'REGISTRY_STALE_FALLBACK_MAX_S',     fallback: 3600,  minimum: 0 },
} as const;

// the settings an import reads, which it refuses to start with while one of them is invalid
const IMPORT_SETTINGS: ReadonlySet<string> = new Set([
  'COMET_SOURCE_REPOSITORY',
  'COMET_SOURCE_REF',
  NUMBERS.leaseSeconds.name,
  NUMBERS.marketsPerInvocation.name,
  NUMBERS.upstreamIntervalSeconds.name,
]);

// what each setting takes, as a refusal names it
const REQUIREMENTS: Record<string, string> = {
  COMET_SOURCE_REPOSITORY: 'owner/repository',
  COMET_SOURCE_REF:        'a git ref',
  ...Object.fromEntries(Object.values(NUMBERS).map(({ name, minimum }) => (
    [ name, minimum === 0 ? 'a non-negative integer' : 'a positive integer' ]
  ))),
};

/*
 * A number as the environment holds it: undefined when it is unset or blank,
 * and null when it is set to something that is not a whole number in its
 * range. Wrangler passes a quoted value as a string and an unquoted one as a
 * number, so both are read as the digits they are written with; a sign, a
 * fraction or an exponent is not a whole number written out.
 */
function numberOf(value: unknown, minimum: number): number | null | undefined {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (text.length === 0) {
    return undefined;
  }
  const parsed = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function registryConfig(env: Env): RegistryConfig {
  // the source has no default: what is not a repository and a ref names no source at all
  const invalid = [
    ...(isRepository(String(env.COMET_SOURCE_REPOSITORY ?? '')) ? [] : [ 'COMET_SOURCE_REPOSITORY' ]),
    ...(isRef(String(env.COMET_SOURCE_REF ?? '')) ? [] : [ 'COMET_SOURCE_REF' ]),
  ];
  const read = (setting: NumericSetting): number => {
    const { name, fallback, minimum } = NUMBERS[setting];
    const value = numberOf(env[name], minimum);
    if (value === null) {
      invalid.push(name);
    }
    return value ?? fallback;
  };
  return {
    leaseSeconds:            read('leaseSeconds'),
    marketsPerInvocation:    read('marketsPerInvocation'),
    upstreamIntervalSeconds: read('upstreamIntervalSeconds'),
    snapshotTtlSeconds:      read('snapshotTtlSeconds'),
    staleFallbackSeconds:    read('staleFallbackSeconds'),
    invalid,
  };
}

/*
 * Refuses an import while any of its own settings is invalid, naming each
 * with what it takes, before anything is asked of the source or of D1.
 */
function assertImportable(config: RegistryConfig): void {
  const refused = config.invalid.filter(name => IMPORT_SETTINGS.has(name));
  if (refused.length > 0) {
    throw new RegistryError(
      'SOURCE_CONFIGURATION_INVALID',
      refused.map(name => `${name} must be ${REQUIREMENTS[name]}`).join('; '),
    );
  }
}

export type { RegistryConfig };
export { assertImportable, registryConfig };
