import t from 'tap';
import * as Sentry from '@sentry/cloudflare';

import '../../shim/node-self.js';
import { MemoryKv } from '../util/kv.js';
import C3Api, { Env } from '../../entrypoint.js';

/*
 * Errors the worker turns into a 500 itself still reach Sentry. The test
 * drives the worker's real default export, and the fetch mock below plays both
 * Tally (which fails) and Sentry's ingest endpoint (which records each
 * envelope). This file runs in its own process: the SDK caches its client and
 * its fetch patch for the life of the process.
 */

const TALLY_FAILURE = 'tally-unreachable-marker';
const INGEST_HOST = 'o1.ingest.sentry.io';

const envelopes: string[] = [];

// Installed before the SDK patches fetch, and never replaced.
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (request.url.includes(INGEST_HOST)) {
    envelopes.push(await request.text());
    return new Response('{}');
  }
  if (request.url.includes('tally')) {
    throw new TypeError(`${TALLY_FAILURE}: ${request.url}`);
  }
  return new Response('{}');
};

const testEnv: Env = {
  'SENTRY_DSN': `https://public@${INGEST_HOST}/1`,
  'TALLY_API_KEY': 'tally-key-1234567890',
  'V3_API_HOST': 'test',
  'NODE_PROXY_HOST': 'test',
  'NODE_PROXY_KEY': 'test',
  'ENVIRONMENT': 'test',
  'MEMORY_CACHE_SEED': 'sentry-reporting',
  'kv_testnet': MemoryKv({}),
  'kv_mainnet': MemoryKv({}),
};

async function fetchWorker(path: string): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException() {},
  };
  const fetchWithContext = C3Api.fetch as unknown as
    (request: Request, env: Env, ctx: unknown) => Promise<Response>;
  const response = await fetchWithContext(new Request(`http://test.local/${path}`), testEnv, ctx);
  await response.text();
  await Promise.allSettled(pending);
  await Sentry.flush(2000);
  return response;
}

function tallyEvents(): string[] {
  return envelopes.filter(body => body.includes('"type":"event"') && body.includes(TALLY_FAILURE));
}

t.test('a failed Tally accounts query is reported as unhandled', async t => {
  const before = tallyEvents().length;
  const response = await fetchWorker(
    'governance/mainnet/comp/accounts?addresses=0x1111111111111111111111111111111111111111',
  );
  t.equal(response.status, 500);
  const events = tallyEvents().slice(before);
  t.equal(events.length, 1, 'one error event sent');
  t.match(events[0], /"handled":false/);
  t.match(events[0], /"type":"c3-api.tally"/);
  t.notOk(events[0]?.includes(testEnv.TALLY_API_KEY), 'no Tally key in the event');
});

t.test('a failed Tally delegates query is reported as unhandled', async t => {
  const before = tallyEvents().length;
  const response = await fetchWorker('governance/mainnet/comp/accounts');
  t.equal(response.status, 500);
  const events = tallyEvents().slice(before);
  t.equal(events.length, 1, 'one error event sent');
  t.match(events[0], /"handled":false/);
});
