import t from 'tap';
import * as Sentry from '@sentry/cloudflare';

import { makeRedactor, rewriteBundleFrame, sentryOptions } from '../../lib/sentry.js';

const PROXY_HOST = 'node-proxy.example';
const PROXY_KEY = 'proxy-key-1234567890';
const TALLY_KEY = 'tally-key-1234567890';
const BODY_MARKER = 'upstream-body-marker';

const testEnv = {
  SENTRY_DSN: 'https://public@o1.ingest.sentry.io/1',
  ENVIRONMENT: 'production',
  TALLY_API_KEY: TALLY_KEY,
  NODE_PROXY_HOST: PROXY_HOST,
  NODE_PROXY_KEY: PROXY_KEY,
};

t.test('redact copies nested values and replaces secrets', async t => {
  const { redact } = makeRedactor([PROXY_KEY]);
  const span = {
    name: `POST https://${PROXY_HOST}/mainnet/${PROXY_KEY}`,
    attributes: { 'url.full': `https://${PROXY_HOST}/mainnet/${PROXY_KEY}?x=${PROXY_KEY}` },
    links: [{ note: 'unrelated' }],
  };
  const redacted = redact(span);
  t.same(redacted, {
    name: `POST https://${PROXY_HOST}/mainnet/[Filtered]`,
    attributes: { 'url.full': `https://${PROXY_HOST}/mainnet/[Filtered]?x=[Filtered]` },
    links: [{ note: 'unrelated' }],
  });
  t.equal(span.attributes['url.full'].includes(PROXY_KEY), true, 'input is not modified');
});

t.test('redact serialises errors and class instances', async t => {
  const { redact } = makeRedactor([PROXY_KEY]);
  const url = new URL(`https://${PROXY_HOST}/mainnet/${PROXY_KEY}`);
  const redacted = redact({ url, error: new Error(`failed: ${PROXY_KEY}`) }) as any;
  t.equal(redacted.url, `https://${PROXY_HOST}/mainnet/[Filtered]`);
  t.equal(redacted.error.message, 'failed: [Filtered]');
  t.notOk(redacted.error.stack.includes(PROXY_KEY));
});

t.test('redact ignores missing and short secret values', async t => {
  const { redact } = makeRedactor([undefined, '', 'short']);
  t.same(redact({ message: 'a short message' }), { message: 'a short message' });
});

t.test('redact handles cyclic payloads', async t => {
  const { redact } = makeRedactor([PROXY_KEY]);
  const payload: Record<string, unknown> = { url: `/mainnet/${PROXY_KEY}` };
  payload.self = payload;
  const redacted = redact(payload);
  t.equal(redacted.url, '/mainnet/[Filtered]');
  t.equal(redacted.self, redacted);
});

t.test('redactEvent leaves SDK metadata but redacts the sampling context', async t => {
  const { redactEvent } = makeRedactor([PROXY_KEY]);
  const scope = new Sentry.Scope();
  const redacted = redactEvent({
    message: PROXY_KEY,
    sdkProcessingMetadata: { scope, dynamicSamplingContext: { transaction: PROXY_KEY } },
  });
  t.equal(redacted.message, '[Filtered]');
  t.equal(redacted.sdkProcessingMetadata?.scope, scope);
  t.same(redacted.sdkProcessingMetadata?.dynamicSamplingContext, { transaction: '[Filtered]' });
});

t.test('rewriteBundleFrame names bundle frames after the uploaded map', async t => {
  t.same(
    rewriteBundleFrame({ filename: '/workers/entrypoint.js', abs_path: '/workers/entrypoint.js' }),
    { filename: 'app:///entrypoint.js', abs_path: 'app:///entrypoint.js' },
  );
  t.same(rewriteBundleFrame({ filename: 'node:internal/x.js' }), { filename: 'node:internal/x.js' });
});

t.test('options sample by environment', async t => {
  t.equal(sentryOptions(testEnv).tracesSampleRate, 0.1);
  t.equal(sentryOptions({ ...testEnv, ENVIRONMENT: 'local' }).tracesSampleRate, 1.0);
  t.same(sentryOptions({ ...testEnv, NODE_PROXY_HOST: '' }).tracePropagationTargets, []);
});

t.test('a wrapped worker sends no secrets and no trace headers to vendors', async t => {
  const envelopes: string[] = [];
  const outgoing: Array<{ url: string, headers: Record<string, string> }> = [];
  const originalFetch = globalThis.fetch;
  t.teardown(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    outgoing.push({ url: request.url, headers: Object.fromEntries(request.headers) });
    return new Response('{}');
  };
  const transport = (options: any) => Sentry.createTransport(options, async request => {
    envelopes.push(typeof request.body === 'string'
      ? request.body
      : new TextDecoder().decode(request.body));
    return { statusCode: 200 };
  });

  const logged = { url: `https://${PROXY_HOST}/mainnet/${PROXY_KEY}` };
  const handler = {
    async fetch(_request: Request, _env: typeof testEnv, _ctx: unknown): Promise<Response> {
      await fetch(logged.url, { method: 'POST', body: '{}' });
      await fetch('https://api.tally.xyz/query', { headers: { 'Api-Key': TALLY_KEY } });
      console.warn('calling', logged);
      // As json-rpc.ts does for a non-JSON upstream response.
      console.warn('Invalid JSON-RPC response: not JSON', { text: `<html>${BODY_MARKER}</html>` });
      throw new Error(`upstream failed: ${logged.url}`, { cause: `<html>${BODY_MARKER}</html>` });
    },
  };
  const worker = Sentry.withSentry(
    (env: typeof testEnv) => ({ ...sentryOptions(env), transport, tracesSampleRate: 1.0 }),
    handler,
  );
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} };
  await t.rejects(worker.fetch!(
    new Request('https://v3-api.example/market/mainnet/usdc/summary') as any,
    testEnv,
    ctx as any,
  ));
  await Promise.allSettled(pending);
  await Sentry.flush(2000);

  t.ok(envelopes.some(body => body.includes('"type":"event"')), 'error event sent');
  t.ok(envelopes.some(body => body.includes('upstream failed')), 'error message sent');
  t.ok(envelopes.some(body => body.includes('[Filtered]')), 'proxy key replaced, not dropped');
  for (const body of envelopes) {
    t.notOk(body.includes(PROXY_KEY), 'no proxy key in envelope');
    t.notOk(body.includes(TALLY_KEY), 'no Tally key in envelope');
    t.notOk(body.includes(BODY_MARKER), 'no logged upstream body in envelope');
  }
  const toProxy = outgoing.find(request => request.url.includes(PROXY_HOST));
  const toTally = outgoing.find(request => request.url.includes('tally'));
  t.ok(toProxy?.headers['sentry-trace'], 'trace header sent to the proxy');
  t.notOk(toTally?.headers['sentry-trace'], 'no trace header sent to Tally');
  t.notOk(toTally?.headers['baggage'], 'no baggage header sent to Tally');
  t.equal(logged.url, `https://${PROXY_HOST}/mainnet/${PROXY_KEY}`, 'logged object unchanged');
});
