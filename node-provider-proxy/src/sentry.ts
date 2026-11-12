import { rewriteFramesIntegration } from '@sentry/cloudflare';
import type { CloudflareOptions } from '@sentry/cloudflare';

/*
 * The app key and node-provider API keys travel inside URL paths (for example
 * https://node-provider-v3-api.compound.xyz/<network>/<app key> and
 * https://<subdomain>.g.alchemy.com/v2/<key>), which the SDK's key-name
 * denylist does not cover. Every payload the SDK sends passes through
 * `redact`, which replaces each occurrence of a secret value with "[Filtered]".
 */
const FILTERED = '[Filtered]';

// Shorter values (empty strings, placeholders) would match ordinary text.
const MIN_SECRET_LENGTH = 8;

function redactValues(
  payload: unknown,
  secrets: string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof payload === 'string') {
    let redacted = payload;
    for (const secret of secrets) {
      if (redacted.includes(secret)) {
        redacted = redacted.split(secret).join(FILTERED);
      }
    }
    return redacted;
  }
  if (payload === null || typeof payload !== 'object' || seen.has(payload)) {
    return payload;
  }
  seen.add(payload);
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    record[key] = redactValues(record[key], secrets, seen);
  }
  return payload;
}

function makeRedactor(secretValues: unknown[]) {
  const secrets = secretValues.filter(
    (value): value is string =>
      typeof value === 'string' && value.length >= MIN_SECRET_LENGTH,
  );
  return <T>(payload: T): T =>
    secrets.length === 0
      ? payload
      : redactValues(payload, secrets, new WeakSet()) as T;
}

/*
 * Wrangler bundles the worker into a single index.js. Its frames are renamed to
 * app:///index.js, the name scripts/deploy-with-sentry.sh uploads the source map
 * under, so Sentry can map them back to the TypeScript source wherever the
 * runtime reports the bundle from.
 */
const BUNDLE_FILE = 'index.js';

const rewriteBundleFrames = rewriteFramesIntegration({
  iteratee: (frame) => {
    if (frame.filename?.split('/').pop() === BUNDLE_FILE) {
      frame.filename = `app:///${BUNDLE_FILE}`;
    }
    return frame;
  },
});

interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
}

/*
 * Sentry options for the node-provider-proxy worker. Without SENTRY_DSN (as in
 * the test suite) the SDK stays disabled. The release is SENTRY_RELEASE, which
 * scripts/deploy-with-sentry.sh sets to the git commit, or else the
 * CF_VERSION_METADATA binding.
 *
 * Every string binding other than SENTRY_* is the app key or a provider
 * secret, so all of them are redacted; new providers are covered without
 * changes here.
 */
function sentryOptions(env: SentryEnv): CloudflareOptions {
  const environment = env.SENTRY_ENVIRONMENT ?? 'local';
  const redact = makeRedactor(
    Object.entries(env)
      .filter(([name]) => !name.startsWith('SENTRY_'))
      .map(([, value]) => value),
  );
  return {
    dsn: env.SENTRY_DSN,
    environment,
    // Sample every trace locally; 10% of traces in deployed environments.
    tracesSampleRate: environment === 'local' ? 1.0 : 0.1,
    dataCollection: {
      // Do not attach client IP addresses to events.
      userInfo: false,
      // RPC request and response bodies are large and add little to errors.
      httpBodies: [],
    },
    integrations: [rewriteBundleFrames],
    beforeSend: (event) => redact(event),
    beforeSendSpan: (span) => redact(span),
    beforeSendLog: (log) => redact(log),
    beforeBreadcrumb: (breadcrumb) => redact(breadcrumb),
  };
}

export { sentryOptions, makeRedactor };
