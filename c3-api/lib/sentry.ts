import { rewriteFramesIntegration } from '@sentry/cloudflare';
import type { CloudflareOptions } from '@sentry/cloudflare';

/*
 * Secret redaction. Node-provider API keys travel inside URL paths (for
 * example https://<proxy>/<network>/<key>), which the SDK's key-name denylist
 * does not cover. The beforeSend, beforeSendSpan, beforeSendLog and
 * beforeBreadcrumb hooks replace each occurrence of a secret value with
 * "[Filtered]". They build redacted copies, so objects the worker still holds
 * (such as arguments passed to console.*) are left unchanged.
 */
const FILTERED = '[Filtered]';

// Shorter values (empty strings, placeholders) would match ordinary text.
const MIN_SECRET_LENGTH = 8;

function redactString(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (redacted.includes(secret)) {
      redacted = redacted.split(secret).join(FILTERED);
    }
  }
  return redacted;
}

function redactValue(
  value: unknown,
  secrets: string[],
  copies: Map<object, unknown>,
): unknown {
  if (typeof value === 'string') {
    return redactString(value, secrets);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (copies.has(value)) {
    return copies.get(value);
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    for (const item of value) {
      copy.push(redactValue(item, secrets, copies));
    }
    return copy;
  }
  if (value instanceof Error) {
    // An error's name, message and stack are not enumerable.
    const copy: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message, secrets),
    };
    if (value.stack !== undefined) {
      copy.stack = redactString(value.stack, secrets);
    }
    copies.set(value, copy);
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Class instances such as URL or Headers: keep their serialised form.
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    return typeof toJSON === 'function'
      ? redactValue(toJSON.call(value), secrets, copies)
      : redactString(String(value), secrets);
  }
  const copy: Record<string, unknown> = {};
  copies.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = redactValue(item, secrets, copies);
  }
  return copy;
}

function makeRedactor(secretValues: unknown[]) {
  const secrets = secretValues.filter(
    (value): value is string =>
      typeof value === 'string' && value.length >= MIN_SECRET_LENGTH,
  );
  const redact = <T>(payload: T): T =>
    secrets.length === 0
      ? payload
      : redactValue(payload, secrets, new Map()) as T;
  /*
   * An event's sdkProcessingMetadata holds SDK objects (scopes, the request)
   * that the SDK reads after beforeSend and that are never sent as they are.
   * Only its dynamic sampling context, which becomes the envelope's trace
   * header, is redacted.
   */
  const redactEvent = <T extends { sdkProcessingMetadata?: Record<string, unknown> }>(
    event: T,
  ): T => {
    const { sdkProcessingMetadata, ...rest } = event;
    const redacted = redact(rest) as T;
    if (sdkProcessingMetadata !== undefined) {
      const { dynamicSamplingContext } = sdkProcessingMetadata;
      redacted.sdkProcessingMetadata = dynamicSamplingContext === undefined
        ? sdkProcessingMetadata
        : { ...sdkProcessingMetadata, dynamicSamplingContext: redact(dynamicSamplingContext) };
    }
    return redacted;
  };
  return { redact, redactEvent };
}

/*
 * Wrangler bundles the worker into a single entrypoint.js. Its frames are
 * renamed to app:///entrypoint.js, the name scripts/deploy-with-sentry.sh
 * uploads the source map under, so Sentry can map them back to the TypeScript
 * source wherever the runtime reports the bundle from. Sentry looks the map up
 * by abs_path, so both fields are set.
 */
const BUNDLE_FILE = 'entrypoint.js';
const BUNDLE_PATH = `app:///${BUNDLE_FILE}`;

function rewriteBundleFrame<T extends { filename?: string; abs_path?: string }>(frame: T): T {
  if (frame.filename?.split('/').pop() === BUNDLE_FILE) {
    frame.filename = BUNDLE_PATH;
    frame.abs_path = BUNDLE_PATH;
  }
  return frame;
}

interface SentryEnv {
  SENTRY_DSN?: string;
  ENVIRONMENT: string;
  TALLY_API_KEY: string;
  BLOCK_NATIVE_API_KEY?: string;
  NODE_PROXY_HOST: string;
  NODE_PROXY_KEY: string;
}

/*
 * Sentry options for the c3-api worker. Without SENTRY_DSN (as in the test
 * suite) the SDK stays disabled. The release is SENTRY_RELEASE, which
 * scripts/deploy-with-sentry.sh sets to the git commit, or else the
 * CF_VERSION_METADATA binding.
 */
function sentryOptions(env: SentryEnv): CloudflareOptions {
  const { redact, redactEvent } = makeRedactor([
    env.TALLY_API_KEY,
    env.BLOCK_NATIVE_API_KEY,
    env.NODE_PROXY_KEY,
  ]);
  return {
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT,
    // Sample every trace locally; 10% of traces in deployed environments.
    tracesSampleRate: env.ENVIRONMENT === 'local' ? 1.0 : 0.1,
    // beforeSendSpan only runs for streamed spans, so SENTRY_TRACE_LIFECYCLE
    // must not switch to static transactions.
    traceLifecycle: 'stream',
    // Send trace headers only to our node-provider-proxy, never to Tally or
    // Blocknative: the baggage header carries the DSN public key.
    tracePropagationTargets: env.NODE_PROXY_HOST ? [env.NODE_PROXY_HOST] : [],
    dataCollection: {
      // Do not attach client IP addresses to events.
      userInfo: false,
      // RPC request and response bodies are large and add little to errors.
      httpBodies: [],
    },
    // The workers log whole RPC requests and upstream responses with console.*,
    // and the Console integration would attach them to every error as
    // breadcrumbs. Dropping it keeps those bodies out, as httpBodies does for
    // the SDK's own request data.
    integrations: (defaults) => [
      ...defaults.filter((integration) => integration.name !== 'Console'),
      rewriteFramesIntegration({ iteratee: rewriteBundleFrame }),
    ],
    beforeSend: (event) => redactEvent(event),
    beforeSendSpan: (span) => redact(span),
    beforeSendLog: (log) => redact(log),
    beforeBreadcrumb: (breadcrumb) => redact(breadcrumb),
  };
}

export { sentryOptions, makeRedactor, rewriteBundleFrame };
