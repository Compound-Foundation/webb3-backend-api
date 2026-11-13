import test from 'node:test';
import { strict as assert } from 'node:assert';

import * as Sentry from '@sentry/cloudflare';

import { rewriteBundleFrame, sentryOptions } from '../src/sentry.js';

/*
 * This file runs in its own process, so the SDK client it creates (and the
 * fetch and console patches that come with it) does not reach test/main.ts.
 */

const APP_KEY = 'app-key-1234567890';
const ALCHEMY_KEY = 'alchemy-key-1234567890';
const BODY_MARKER = 'rpc-body-marker';

test('rewriteBundleFrame names bundle frames after the uploaded map', () => {
  assert.deepEqual(
    rewriteBundleFrame({ filename: 'index.js' }),
    { filename: 'app:///index.js', abs_path: 'app:///index.js' },
  );
  assert.deepEqual(
    rewriteBundleFrame({ filename: 'node:internal/x.js' }),
    { filename: 'node:internal/x.js' },
  );
});

test('a wrapped worker sends no secrets and no trace headers upstream', async () => {
  const envelopes: string[] = [];
  const outgoing: Array<{ url: string, headers: Record<string, string> }> = [];
  const originalFetch = globalThis.fetch;
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
  const env = {
    SENTRY_DSN: 'https://public@o1.ingest.sentry.io/1',
    SENTRY_ENVIRONMENT: 'production-v3-api',
    allowedAppKey: APP_KEY,
    alchemyEthMainnet: ALCHEMY_KEY,
  };

  const logged = { url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` };
  const handler = {
    async fetch(_request: Request, _env: typeof env, _ctx: unknown): Promise<Response> {
      await fetch(logged.url, { method: 'POST', body: '{}' });
      console.warn('calling', logged);
      // As handler.ts logRpcError does.
      console.warn('json-rpc error:', { rpc: JSON.stringify({ method: 'eth_call', params: [BODY_MARKER] }) });
      throw new Error(`upstream failed: ${logged.url}`);
    },
  };
  const worker = Sentry.withSentry(
    (env: Parameters<typeof sentryOptions>[0]) => ({ ...sentryOptions(env), transport, tracesSampleRate: 1.0 }),
    handler,
  );
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} };
  try {
    await assert.rejects(worker.fetch!(
      new Request(`https://node-provider-v3-api.example/ethereum-mainnet/${APP_KEY}`, {
        method: 'POST',
        body: '{}',
      }) as any,
      env,
      ctx as any,
    ));
    await Promise.allSettled(pending);
    await Sentry.flush(2000);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(envelopes.some(body => body.includes('"type":"event"')), 'error event sent');
  assert.ok(envelopes.some(body => body.includes('upstream failed')), 'error message sent');
  assert.ok(envelopes.some(body => body.includes('[Filtered]')), 'keys replaced, not dropped');
  for (const body of envelopes) {
    assert.ok(!body.includes(APP_KEY), 'no app key in envelope');
    assert.ok(!body.includes(ALCHEMY_KEY), 'no Alchemy key in envelope');
    assert.ok(!body.includes(BODY_MARKER), 'no logged RPC body in envelope');
  }
  const upstream = outgoing.find(request => request.url.includes('alchemy'));
  assert.equal(upstream?.headers['sentry-trace'], undefined, 'no trace header upstream');
  assert.equal(upstream?.headers['baggage'], undefined, 'no baggage header upstream');
  assert.equal(logged.url, `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, 'logged object unchanged');
});
