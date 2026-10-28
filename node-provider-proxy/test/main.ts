import test from 'node:test';
import { strict as assert } from 'node:assert';

/*
 * In-memory KV test double.
 *
 * Replaces @miniflare/kv + @miniflare/storage-memory + @miniflare/shared
 * (Miniflare v2, EOL). Miniflare v3+ removed these standalone synchronous
 * classes (its KV is async-only via a workerd instance), and the tests here
 * construct KV synchronously and introspect the backing storage directly
 * (entry.expiration), so we ship a tiny shim covering exactly the surface used:
 * KVNamespace get / put (with expirationTtl) / delete over a MemoryStorage Map
 * of StoredValueMeta.
 */
type StoredValueMeta<Meta = unknown> = {
  value: Uint8Array;
  expiration?: number; // epoch seconds
  metadata?: Meta;
};

class MemoryStorage {
  constructor(readonly map: Map<string, StoredValueMeta> = new Map()) {}
}

const KV_ENCODER = new TextEncoder();
const KV_DECODER = new TextDecoder();

class KVNamespace<_Key extends string = string> {
  constructor(private readonly storage: MemoryStorage) {}

  async get(key: string): Promise<string | null> {
    const entry = this.storage.map.get(key);
    if (!entry) return null;
    if (entry.expiration !== undefined && entry.expiration * 1000 <= Date.now()) {
      this.storage.map.delete(key);
      return null;
    }
    return KV_DECODER.decode(entry.value);
  }

  async put(
    key: string,
    value: string,
    options: { expirationTtl?: number; expiration?: number; metadata?: unknown } = {},
  ): Promise<void> {
    const entry: StoredValueMeta = {
      value: KV_ENCODER.encode(typeof value === 'string' ? value : String(value)),
    };
    if (options.expiration !== undefined) {
      entry.expiration = options.expiration;
    } else if (options.expirationTtl !== undefined) {
      entry.expiration = Math.floor(Date.now() / 1000) + options.expirationTtl;
    }
    if (options.metadata !== undefined) entry.metadata = options.metadata;
    this.storage.map.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.storage.map.delete(key);
  }
}

import * as jsonRpc      from 'json-rpc';
import * as KnownNetwork from '@compound-finance/well-known-networks';

import * as providers from '../src/providers.js';

import Api, { Env } from '../src/index.js';

import * as mock from 'testutil.mock';

/*
 * security headers expected on every response, kept in sync with
 * SECURITY_HEADERS in src/index.ts. Names are lower-cased to match the
 * normalized keys produced by `new Map(response.headers)`.
 */
const SECURITY_HEADER_ENTRIES: [ string, string ][] = [
  [ 'strict-transport-security',    'max-age=63072000; includeSubDomains; preload' ],
  [ 'content-security-policy',      "default-src 'none'; frame-ancestors 'none'"   ],
  [ 'x-content-type-options',       'nosniff'                                      ],
  [ 'x-frame-options',              'DENY'                                         ],
  [ 'referrer-policy',              'no-referrer'                                  ],
  [ 'cross-origin-resource-policy', 'cross-origin'                                 ],
];

function assertSecurityHeaders(response: Response) {
  for (const [ name, value ] of SECURITY_HEADER_ENTRIES) {
    assert.equal(
      response.headers.get(name),
      value,
      `response has expected '${name}' header`,
    );
  }
}

function makeTestEnv({ storage }: {
  storage?: Map<string, StoredValueMeta<unknown>>,
}): Env {
  return {
    allowedAppKey: '',
    allowedHosts: [],
    alchemyArbMainnet: 'alc-arb',
    alchemyEthMainnet: 'alc-eth',
    alchemyPolygonMainnet: 'alc-polygon',
    alchemyBaseMainnet: 'alc-base',
    alchemyScrollMainnet: 'alc-scroll',
    alchemyOptMainnet: 'alc-optimism',
    alchemyMantleMainnet: 'alc-mantle',
    alchemyLineaMainnet: 'alc-linea',
    alchemyUnichainMainnet: 'alc-unichain',
    alchemyRoninMainnet: 'alc-ronin',
    quicknodeEthMainnet: 'qn-eth',
    quicknodeEthMainnetSubdomain: 'qn-eth-sub',
    kv: new KVNamespace(new MemoryStorage(storage ?? new Map())) as any,
    settings: {
      // use short backoffs and expiries in test, to avoid stalls
      defaultFallbackExpirationTtlSeconds:   60, // 60s fallback TTL
      defaultRetryAfterUpstreamErrorSeconds: 10, // 10s Retry-After
      // mask upstream errors so test environment is similar to production
      maskUpstreamErrors: true,
      // do not retry with active fallback on behalf of the test
      retryWithActiveFallback: false,
      // do not retry only failed RPCs from a batch on behalf of the test
      retryIndividualFailedRpcs: false,
    },
  };
}

// before each test, replace the global fetch with a fresh mock
declare var fetch: mock.Fetch;
test.beforeEach(() => globalThis.fetch = mock.fetch({}));
// after each test, check that the fetch mock is satisfied
test.afterEach(() => fetch.satisfy(assert));

/*
 * cases
 *
 * - block methods other than POST -> 405
 * - fail malformed path -> 400
 * - fail unrecognized network -> 404
 * - if a ProviderSecret is missing, bail -> 500 unknown error
 * - respond to OPTIONS with CORS headers
 * - include proper CORS headers on 200s
 * - block invalid JSON-RPC payload, w/o sending to provider -> 400
 * - respond to eth_chainId, w/o sending to provider
 * - fallback to alchemyEthMainnet -> 503, Retry-After as configured
 *   - persist fallback to alchemyEthMainnet on subsequent requests
 *   - expire fallback to alchemyEthMainnet
 * - fail w/ no available fallback -> 503, Retry-After >=10s
 * - provider should receive a single request for one-item batch, no batch
 * - manual json filter object for active-fallback should work
 */

/*
 * A missing secret is a fault of the deployment. The client is answered as
 * for any unexpected error, with the usual headers, and the log names the
 * secret: a caller is not told which secret the proxy lacks.
 */
test('missing provider secret causes 500', async t => {
  const env = makeTestEnv({});
  delete (env as any)['alchemyEthMainnet'];
  const logged  = t.mock.method(console, 'error', () => {});
  const request = jsonRpc.preparePost({
    endpoint: 'http://node-provider.test.local/ethereum-mainnet',
    call: { method: 'eth_blockNumber', params: [] },
  });
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'unexpected error');
  assertSecurityHeaders(response);
  assert.match(
    logged.mock.calls.map(call => call.arguments.map(String).join(' ')).join('\n'),
    /alchemyEthMainnet not found in environment/,
  );
});

test.todo('methods other than POST cause 405', async () => {
  const url = `http://node-provider.test.local/ethereum-mainnet`;
  const request = new Request(url, {
  });
  const response = await Api.fetch(request, makeTestEnv({}));
  assert.equal(response.status, 405);
});

test('malformed path causes 400', async () => {
  const badPath = 'http://node-provider.test.local/zz/y/too/many';
  const request = new Request(badPath, {
    method: 'POST',
  });
  const response = await Api.fetch(request, makeTestEnv({}));
  assert.equal(response.status, 400);
});

test('unrecognized network causes 404', async () => {
  const badPath = 'http://node-provider.test.local/nochain-nonetwork';
  const request = new Request(badPath, {
    method: 'POST',
  });
  const response = await Api.fetch(request, makeTestEnv({}));
  assert.equal(response.status, 404);
});

test('bad app key but non configured app key is authorized', async () => {
  const badKey = 'http://node-provider.test.local/ethereum-mainnet/badkey';
  const request = new Request(badKey, {
    method: 'POST',
  });
  const response = await Api.fetch(request, makeTestEnv({}));
  assert.equal(response.status, 400);
});

test('bad app key causes 401', async () => {
  const env = makeTestEnv({});
  env['allowedAppKey'] = 'test_key_12345678901';

  const badKey = 'http://node-provider.test.local/ethereum-mainnet/badkey';
  const request = new Request(badKey, {
    method: 'POST',
  });
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 401);
});

test('configured key but no sent key causes 401', async () => {
  const env = makeTestEnv({});
  env['allowedAppKey'] = 'test_key_12345678901';

  const noKey = 'http://node-provider.test.local/ethereum-mainnet';
  const request = new Request(noKey, {
    method: 'POST',
  });
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 401);
});

test('non configured allowed hosts is authorized', async () => {
  const allowableRequest = 'http://node-provider.test.local/ethereum-mainnet';
  const request = new Request(allowableRequest, {
    method: 'POST',
    headers: {
      'Host': 'http://localhost',
    },
  });
  const response = await Api.fetch(request, makeTestEnv({}));
  assert.equal(response.status, 400);
});

test('bad origin causes 401', async () => {
  const env = makeTestEnv({});
  env['allowedHosts'] = ['example.com'];

  const badRequest = 'http://node-provider.test.local/ethereum-mainnet/badkey';
  const request = new Request(badRequest, {
    method: 'POST',
    headers: {
      'origin': 'http://localhost',
    },
  });
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 401);
});

test('allowed host with valid origin header is allowed', async () => {
  const env = makeTestEnv({});
  env['allowedHosts'] = ['example.com'];

  const noKey = 'http://node-provider.test.local/ethereum-mainnet';
  const request = new Request(noKey, {
    method: 'POST',
    headers: {
      'origin': 'https://example.com',
    },
  });
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 400);
});

test('allowed hosts with valid origin header is allowed', async () => {
  const env = makeTestEnv({});
  env['allowedHosts'] = ['localhost', 'example.com'];

  const noKey = 'http://node-provider.test.local/ethereum-mainnet';
  const request = new Request(noKey, {
    method: 'POST',
    headers: {
      'origin': 'https://example.com',
    },
  });
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 400);
});

// JSON-RPC validation and behavior
test('invalid JSON-RPC payload', async () => {
  const url = 'http://node-provider.test.local/ethereum-mainnet';
  const request = new Request(url, {
    method: 'POST',
    body: JSON.stringify({ params: {}, method: 5 }),
  });
  const response = await Api.fetch(request, makeTestEnv({}));
  assert.equal(response.status, 400);
  const bodyText = await response.text();
  assert.match(bodyText, /invalid json-rpc/i);
});

test('one-item batch RPCs are unwrapped', async () => {
  const env = makeTestEnv({});
  const endpoint = 'http://node-provider.test.local/ethereum-mainnet';
  const request = jsonRpc.preparePostBatch({
    endpoint,
    calls: [{ method: 'eth_blockNumber', params: [] }],
  });
  const rpcResponse: jsonRpc.Response = {
    id: 0,
    jsonrpc: '2.0',
    result: '0x123',
  };
  const endpoints = providers.instantiate(env);
  fetch.expect(endpoints['ethereum-mainnet'][0].uri, {
    method: 'POST',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/json',
    },
    body: {
      type: 'json',
      value: { id: 0, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] },
    },
  })
    .returns(JSON.stringify(rpcResponse));
  const response = await Api.fetch(request, env);
  const bodyText = await response.text();
  assert.deepEqual(bodyText, JSON.stringify([ rpcResponse ]));
});

test('a large batch goes upstream in pieces and comes back in order', async () => {
  const env = makeTestEnv({});
  const endpoint = 'http://node-provider.test.local/ethereum-mainnet';
  const calls: jsonRpc.Call[] = Array.from({ length: 250 }, (_, index) => (
    { method: 'eth_getBalance', params: [ `0x${index.toString(16).padStart(40, '0')}`, 'latest' ] }
  ));
  const request = jsonRpc.preparePostBatch({ endpoint, calls });
  const endpoints = providers.instantiate(env);
  // 100, 100 and 50 calls, each answered in reverse to show order is restored
  for (const [ start, end ] of [ [ 0, 100 ], [ 100, 200 ], [ 200, 250 ] ]) {
    const piece = calls.slice(start, end).map((call, offset) => ({ id: start + offset, jsonrpc: '2.0', ...call }));
    fetch.expect(endpoints['ethereum-mainnet'][0].uri, {
      method: 'POST',
      body: { type: 'json', value: piece },
    })
      .returns(JSON.stringify(piece.map(({ id }) => ({ id, jsonrpc: '2.0', result: `0x${id.toString(16)}` })).reverse()));
  }
  const response = await Api.fetch(request, env);
  const responses = await response.json() as jsonRpc.Response[];
  assert.equal(responses.length, 250);
  assert.deepEqual(responses.map(({ id }) => id), calls.map((_, index) => index));
  assert.deepEqual(responses.map(({ result }) => result), calls.map((_, index) => `0x${index.toString(16)}`));
});

/*
 * A batch of 250 balance reads, and the pieces of 100, 100 and 50 calls the
 * proxy sends it upstream in, as a provider receives them.
 */
function balanceBatch(network: string) {
  const calls: jsonRpc.Call[] = Array.from({ length: 250 }, (_, index) => (
    { method: 'eth_getBalance', params: [ `0x${index.toString(16).padStart(40, '0')}`, 'latest' ] }
  ));
  const pieces = [ [ 0, 100 ], [ 100, 200 ], [ 200, 250 ] ].map(([ start, end ]) => (
    calls.slice(start, end).map((call, offset) => ({ ...call, id: start + offset, jsonrpc: '2.0' as const }))
  ));
  return {
    calls,
    pieces,
    request: jsonRpc.preparePostBatch({ endpoint: `http://node-provider.test.local/${network}`, calls }),
  };
}

// a provider's answer to a piece: every balance is the call's id
function answersTo(piece: jsonRpc.Request[]): string {
  return JSON.stringify(piece.map(({ id }) => ({ id, jsonrpc: '2.0', result: `0x${id.toString(16)}` })));
}

/*
 * With no other provider, nothing can answer the calls of a piece that
 * failed, and an answer made up for them would read as the node failing each
 * call. The batch fails whole, to be retried, once every piece has been
 * answered or has failed: none is left in flight when the proxy answers.
 */
test('a failed piece fails the batch when no other provider can answer it', async () => {
  const env = makeTestEnv({});
  env.settings = { ...env.settings, retryIndividualFailedRpcs: true };
  // scroll has a single provider, so there is nothing to fall back on
  const { pieces, request } = balanceBatch('scroll-mainnet');
  const endpoints = providers.instantiate(env);
  for (const [ index, piece ] of pieces.entries()) {
    const expectation = fetch.expect(endpoints['scroll-mainnet'][0].uri, {
      method: 'POST',
      body: { type: 'json', value: piece },
    });
    if (index === 0) {
      expectation.returns('bad gateway', { status: 502 });
    } else {
      expectation.returns(answersTo(piece));
    }
  }
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), `${env.settings.defaultRetryAfterUpstreamErrorSeconds}`);
  assert.equal(await response.text(), 'upstream error');
});

/*
 * A provider that fails one piece of a batch has still answered the others.
 * Those answers are kept, and only the failed piece's calls are asked of the
 * fallback provider, which takes over the network for the next requests as
 * it does when a whole request fails. Either setting that has the proxy retry
 * for its clients does so: retrying the calls that failed, or retrying a
 * request that failed.
 */
for (const retry of [ 'retryIndividualFailedRpcs', 'retryWithActiveFallback' ] as const) {
  test(`a failed piece is asked of the fallback provider, and the answered pieces are kept (${retry})`, async () => {
    const env = makeTestEnv({});
    env.settings = { ...env.settings, [retry]: true };
    const { calls, pieces, request } = balanceBatch('ethereum-mainnet');
    const [ primary, fallback ] = providers.instantiate(env)['ethereum-mainnet'];
    fetch.expect(primary.uri, { method: 'POST', body: { type: 'json', value: pieces[0] } })
      .returns('bad gateway', { status: 502 });
    for (const piece of pieces.slice(1)) {
      fetch.expect(primary.uri, { method: 'POST', body: { type: 'json', value: piece } })
        .returns(answersTo(piece));
    }
    fetch.expect(fallback.uri, { method: 'POST', body: { type: 'json', value: pieces[0] } })
      .returns(answersTo(pieces[0]));
    const response = await Api.fetch(request, env);
    assert.equal(response.status, 200);
    const responses = (await response.json() as jsonRpc.Response[]).sort((a, b) => Number(a.id) - Number(b.id));
    assert.deepEqual(responses.map(({ id }) => id), calls.map((_, index) => index));
    assert.deepEqual(responses.map(({ result }) => result), calls.map((_, index) => `0x${index.toString(16)}`));
    const active = await env.kv.get(`provider:default:ethereum-mainnet:active-fallback`);
    assert.deepEqual(JSON.parse(active!), fallback);
  });

  test(`a failed piece the fallback provider fails too fails the batch (${retry})`, async () => {
    const env = makeTestEnv({});
    env.settings = { ...env.settings, [retry]: true };
    const { pieces, request } = balanceBatch('ethereum-mainnet');
    const [ primary, fallback ] = providers.instantiate(env)['ethereum-mainnet'];
    fetch.expect(primary.uri, { method: 'POST', body: { type: 'json', value: pieces[0] } })
      .returns('bad gateway', { status: 502 });
    for (const piece of pieces.slice(1)) {
      fetch.expect(primary.uri, { method: 'POST', body: { type: 'json', value: piece } })
        .returns(answersTo(piece));
    }
    fetch.expect(fallback.uri, { method: 'POST', body: { type: 'json', value: pieces[0] } })
      .returns('bad gateway', { status: 502 });
    const response = await Api.fetch(request, env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), `${env.settings.defaultRetryAfterUpstreamErrorSeconds}`);
  });
}

/*
 * A batch whose every piece failed is a request that failed whole, and is
 * answered as one: the fallback provider takes over the next requests, but
 * is not asked this one's calls. Retrying the calls that failed is for a
 * batch the provider answered in part; retrying a request that failed whole
 * is retryWithActiveFallback, off here.
 */
test('a batch whose every piece failed fails whole, and its calls are not retried', async () => {
  const env = makeTestEnv({});
  env.settings = { ...env.settings, retryIndividualFailedRpcs: true };
  const { pieces, request } = balanceBatch('ethereum-mainnet');
  const [ primary, fallback ] = providers.instantiate(env)['ethereum-mainnet'];
  for (const piece of pieces) {
    fetch.expect(primary.uri, { method: 'POST', body: { type: 'json', value: piece } })
      .returns('bad gateway', { status: 502 });
  }
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), `${env.settings.defaultRetryAfterUpstreamErrorSeconds}`);
  assert.deepEqual(fetch.unexpected.map(({ url }) => url), [], 'the fallback provider is not asked');
  const active = await env.kv.get(`provider:default:ethereum-mainnet:active-fallback`);
  assert.deepEqual(JSON.parse(active!), fallback);
});

/*
 * The fallback provider can fail part of what it is asked again, too. What it
 * answers is kept: a call of the failed piece that it answered is answered,
 * and a call the first provider failed keeps that provider's error, masked,
 * as it would with no fallback to ask.
 */
test('what the fallback provider answers of the calls it is asked is kept', async t => {
  const env = makeTestEnv({});
  env.settings = { ...env.settings, retryIndividualFailedRpcs: true };
  // an errored call is logged each time it is found, 200 times here
  t.mock.method(console, 'warn', () => {});
  const { calls, pieces, request } = balanceBatch('ethereum-mainnet');
  const [ primary, fallback ] = providers.instantiate(env)['ethereum-mainnet'];
  const unserved = { code: -32000, message: 'header not found' };
  // the first piece is answered with an error for every call, the second fails, the third is answered
  fetch.expect(primary.uri, { method: 'POST', body: { type: 'json', value: pieces[0] } })
    .returns(JSON.stringify(pieces[0].map(({ id }) => ({ id, jsonrpc: '2.0', error: unserved }))));
  fetch.expect(primary.uri, { method: 'POST', body: { type: 'json', value: pieces[1] } })
    .returns('bad gateway', { status: 502 });
  fetch.expect(primary.uri, { method: 'POST', body: { type: 'json', value: pieces[2] } })
    .returns(answersTo(pieces[2]));
  // the 200 calls asked again go in two pieces: the fallback fails the errored calls and answers the others
  fetch.expect(fallback.uri, { method: 'POST', body: { type: 'json', value: pieces[0] } })
    .returns('bad gateway', { status: 502 });
  fetch.expect(fallback.uri, { method: 'POST', body: { type: 'json', value: pieces[1] } })
    .returns(answersTo(pieces[1]));
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 200);
  const responses = (await response.json() as jsonRpc.Response[]).sort((a, b) => Number(a.id) - Number(b.id));
  assert.deepEqual(responses.map(({ id }) => id), calls.map((_, index) => index));
  assert.deepEqual(
    responses.slice(0, 100).map(({ error }) => error),
    pieces[0].map(() => ({ code: -32000, message: 'upstream error' })),
  );
  assert.deepEqual(
    responses.slice(100).map(({ result }) => result),
    calls.slice(100).map((_, index) => `0x${(100 + index).toString(16)}`),
  );
});

// the proxy retries for its clients only when a setting says so; both are off here
test('with retries off, a failed piece fails the batch and the fallback takes over', async () => {
  const env = makeTestEnv({});
  const { pieces, request } = balanceBatch('ethereum-mainnet');
  const [ primary, fallback ] = providers.instantiate(env)['ethereum-mainnet'];
  fetch.expect(primary.uri, { method: 'POST', body: { type: 'json', value: pieces[0] } })
    .returns('bad gateway', { status: 502 });
  for (const piece of pieces.slice(1)) {
    fetch.expect(primary.uri, { method: 'POST', body: { type: 'json', value: piece } })
      .returns(answersTo(piece));
  }
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 503);
  const active = await env.kv.get(`provider:default:ethereum-mainnet:active-fallback`);
  assert.deepEqual(JSON.parse(active!), fallback);
});

// CORS is handled correctly
test('OPTIONS requests get proper CORS headers', async () => {
  const endpoint = `http://node-provider.test.local/ethereum-mainnet`;
  const request = new Request(endpoint, {
    method: 'OPTIONS',
    headers: { origin: 'https://app.compound.finance' },
  });
  const response = await Api.fetch(request, makeTestEnv({}));
  assert.equal(response.status, 200);
  assert.deepEqual(new Map(response.headers), new Map([
    [ 'access-control-allow-origin',  'https://app.compound.finance'     ],
    [ 'access-control-allow-methods', 'POST, OPTIONS'                    ],
    [ 'access-control-allow-headers', 'Content-Type, User-Agent, Accept' ],
    ...SECURITY_HEADER_ENTRIES,
  ]));
});

test('POST requests get proper CORS headers', async () => {
  const env = makeTestEnv({});
  const endpoint = 'https://node-provider.test.local/ethereum-mainnet';
  const call: jsonRpc.Call = {
    method: 'eth_blockNumber',
    params: [],
  };
  const rpcResponse: jsonRpc.Response = {
    id: 0,
    jsonrpc: '2.0',
    result: '0xbeef',
  };
  const request = jsonRpc.preparePost({
    call,
    endpoint,
    headers: {
      origin: 'https://app.compound.finance',
      'Accept':       'application/json',
      'Content-Type': 'application/json',
    },
  });
  const endpoints = providers.instantiate(env);
  fetch.expect(endpoints['ethereum-mainnet'][0].uri, {
    method: 'POST',
    body: {
      type: 'json',
      value: { id: 0, jsonrpc: '2.0', ...call },
    },
  })
    .returns(JSON.stringify(rpcResponse), {
      headers: { 'Content-Type': 'application/json' }
    });
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(new Map(response.headers), new Map([
    [ 'content-type',                 'application/json'                 ],
    [ 'access-control-allow-origin',  'https://app.compound.finance'     ],
    [ 'access-control-allow-methods', 'POST, OPTIONS'                    ],
    [ 'access-control-allow-headers', 'Content-Type, User-Agent, Accept' ],
    ...SECURITY_HEADER_ENTRIES,
  ]));
});

// security headers are present on every response
test('OPTIONS responses include security headers', async () => {
  const endpoint = `http://node-provider.test.local/ethereum-mainnet`;
  const request = new Request(endpoint, {
    method: 'OPTIONS',
    headers: { origin: 'https://app.compound.finance' },
  });
  const response = await Api.fetch(request, makeTestEnv({}));
  assert.equal(response.status, 200);
  assertSecurityHeaders(response);
});

test('non-OPTIONS responses include security headers', async () => {
  // a malformed path resolves to a deterministic 400 without any network
  // calls, exercising the shared cors() response path.
  const badPath = 'http://node-provider.test.local/zz/y/too/many';
  const request = new Request(badPath, {
    method: 'POST',
  });
  const response = await Api.fetch(request, makeTestEnv({}));
  assert.equal(response.status, 400);
  assertSecurityHeaders(response);
});

test('upstream errors are masked from clients', async () => {
  const env = makeTestEnv({});
  const endpoint = `http://node-provider.test.local/ethereum-mainnet`;
  const call: jsonRpc.Call = {
    method: 'eth_call',
    params: [
      {
        to: '0xd46e8dd67c5d32be8058bb8eb970870f07244567',
        data: '0xd46e8dd67c5d32be8d46e8dd67c5d32be8058bb8eb970870f072445675058bb8eb970870f072445675'
      },
      'latest'
    ],
  };
  const rpcResponse: jsonRpc.Response = {
    id: 0,
    jsonrpc: '2.0',
    error: { code: -11111, message: 'what up' },
  };
  const request = jsonRpc.preparePost({
    call,
    endpoint,
  });
  const endpoints = providers.instantiate(env);
  fetch.expect(endpoints['ethereum-mainnet'][0].uri, {
    method: 'POST',
    body: {
      type: 'json',
      value: { id: 0, jsonrpc: '2.0', ...call },
    },
  })
    .returns(JSON.stringify(rpcResponse));
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 200);
  const bodyText = await response.text();
  assert.equal(bodyText, JSON.stringify({
    id: 0,
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'upstream error',
    },
  }));
});

/*
 * An eth_call as a client of the proxy asks it, and the answer upstream
 * gives it: the error the call is answered with, whether a revert of the
 * contract or a failure of the node.
 */
function erroredCall(network: string, error: jsonRpc.Error) {
  const endpoint = `http://node-provider.test.local/${network}`;
  const call: jsonRpc.Call = {
    method: 'eth_call',
    params: [
      {
        to: '0xe85dc543813b8c2cfeaac371517b925a166a9293',
        data: '0x41976e09000000000000000000000000e3a409ed15cd53afdefdd191ad945cec528a2496',
      },
      'latest',
    ],
  };
  return {
    call,
    request:  jsonRpc.preparePost({ call, endpoint }),
    response: { id: 0, jsonrpc: '2.0', error } as jsonRpc.Response,
  };
}

test('reverts reach clients unmasked and are not retried', async () => {
  const env = makeTestEnv({});
  env.settings = { ...env.settings, retryIndividualFailedRpcs: true };
  const revert = { code: 3, message: 'execution reverted', data: '0x' };
  const { call, request, response: rpcResponse } = erroredCall('ethereum-mainnet', revert);
  const endpoints = providers.instantiate(env);
  // one upstream call: the fallback provider is not asked again
  fetch.expect(endpoints['ethereum-mainnet'][0].uri, {
    method: 'POST',
    body: { type: 'json', value: { id: 0, jsonrpc: '2.0', ...call } },
  })
    .returns(JSON.stringify(rpcResponse));
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), JSON.stringify(rpcResponse));
});

/*
 * The provider a call is retried on can answer it with a revert where the
 * first one failed it. That revert is the answer, as it would be from the
 * first provider, and a client masking it as an upstream error would report a
 * market it could have priced as broken.
 */
test('a revert the fallback provider answers reaches clients unmasked', async () => {
  const env = makeTestEnv({});
  env.settings = { ...env.settings, retryIndividualFailedRpcs: true };
  const revert = { code: 3, message: 'execution reverted', data: '0x' };
  const { call, request, response: failed } = erroredCall('ethereum-mainnet', { code: -32000, message: 'header not found' });
  const endpoints = providers.instantiate(env);
  const body = { type: 'json', value: { id: 0, jsonrpc: '2.0', ...call } } as const;
  fetch.expect(endpoints['ethereum-mainnet'][0].uri, { method: 'POST', body }).returns(JSON.stringify(failed));
  fetch.expect(endpoints['ethereum-mainnet'][1].uri, { method: 'POST', body }).returns(JSON.stringify({ ...failed, error: revert }));
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), JSON.stringify({ id: 0, jsonrpc: '2.0', error: revert }));
});

test('a failed rpc is still answered when no provider can retry it', async () => {
  const env = makeTestEnv({});
  env.settings = { ...env.settings, retryIndividualFailedRpcs: true };
  // scroll has a single provider, so there is nothing to fall back on
  const { call, request, response: rpcResponse } = erroredCall('scroll-mainnet', { code: -11111, message: 'what up' });
  const endpoints = providers.instantiate(env);
  fetch.expect(endpoints['scroll-mainnet'][0].uri, {
    method: 'POST',
    body: { type: 'json', value: { id: 0, jsonrpc: '2.0', ...call } },
  })
    .returns(JSON.stringify(rpcResponse));
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), JSON.stringify({
    id: 0,
    jsonrpc: '2.0',
    error: { code: -32000, message: 'upstream error' },
  }));
});

// fallback tests
test('active fallback is selected by JSON filter object', async () => {
  const env = makeTestEnv({});
  const endpoints = providers.instantiate(env);

  await env.kv.put(
    `provider:default:ethereum-mainnet:active-fallback`,
    JSON.stringify(endpoints['ethereum-mainnet'][1])
  );
  fetch.expect(endpoints['ethereum-mainnet'][1].uri, {
    method: 'POST',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/json',
    },
    body: {
      type: 'json',
      value: { id: 0, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] },
    },
  })
    .returns(JSON.stringify({ id: 0, jsonrpc: '2.0', result: '0xbeef' }));
  const request = jsonRpc.preparePost({
    endpoint: `http://node-provider.test.local/ethereum-mainnet`,
    call: { method: 'eth_blockNumber', params: [] },
  });
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 200);
});

test('if provider fails, fallback with TTL', async () => {
  const storage = new Map();
  const env = makeTestEnv({ storage });
  const endpoints = providers.instantiate(env);
  fetch.expect(endpoints['ethereum-mainnet'][0].uri, {
    method: 'POST',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/json',
    },
    body: {
      type: 'json',
      value: { id: 0, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] },
    },
  })
    .returns(null, { status: 500 });
  const request = jsonRpc.preparePost({
    endpoint: `http://node-provider.test.local/ethereum-mainnet`,
    call: { method: 'eth_blockNumber', params: [] },
  });
  const response = await Api.fetch(request, env);
  // compute an epoch-seconds estimate for when the fallback should expire
  const estimatedExpirationEpochSeconds = (
    Math.floor(Date.now() / 1000)
    + env.settings.defaultFallbackExpirationTtlSeconds
  );
  assert.equal(response.status, 503);
  assert.equal(
    response.headers.get('retry-after'),
    env.settings.defaultRetryAfterUpstreamErrorSeconds.toString()
  );

  const fallback = await env.kv.get(
    `provider:default:ethereum-mainnet:active-fallback`
  );
  assert.ok(fallback);
  assert.deepEqual(JSON.parse(fallback), endpoints['ethereum-mainnet'][1]);
  const entry = storage.get('provider:default:ethereum-mainnet:active-fallback');
  assert.ok(entry, `storage entry must exist for KV key for fallback`);
  // since expiration precision is seconds, should round out the same
  assert.equal(
    Math.round(entry.expiration / 10),
    Math.round(estimatedExpirationEpochSeconds / 10),
  );

  const rpcResponse: jsonRpc.Response = { id: 0, jsonrpc: '2.0', result: '0xdead' };
  fetch.expect(endpoints['ethereum-mainnet'][1].uri, {
    method: 'POST',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/json',
    },
    body: {
      type: 'json',
      value: { id: 0, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] },
    },
  })
    .returns(JSON.stringify(rpcResponse));
  const request2 = jsonRpc.preparePost({
    endpoint: `http://node-provider.test.local/ethereum-mainnet`,
    call: { method: 'eth_blockNumber', params: [] },
  });
  const response2 = await Api.fetch(request2, env);
  assert.equal(response2.status, 200);
  const bodyText = await response2.text();
  assert.equal(bodyText, JSON.stringify(rpcResponse));
});

/*
 * An execution context as the Workers runtime gives one: its methods refuse
 * a call made off the context ('Illegal invocation'), and it holds what is
 * passed to waitUntil until the invocation ends.
 */
function makeTestContext() {
  const deferred: Promise<unknown>[] = [];
  const context = {
    waitUntil(this: unknown, promise: Promise<unknown>) {
      if (this !== context) {
        throw new TypeError('Illegal invocation');
      }
      deferred.push(promise);
    },
    passThroughOnException() {},
  };
  return { context: context as unknown as ExecutionContext, deferred };
}

// whether every deferred promise settles within a moment, which the runtime waits on
async function settles(deferred: Promise<unknown>[]): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>(resolve => { timer = setTimeout(resolve, 1000, false); });
  try {
    return await Promise.race([ Promise.all(deferred).then(() => true), late ]);
  } finally {
    clearTimeout(timer);
  }
}

// a provider that fails the request outright, on ethereum-mainnet
function failingMainnet(env: Env) {
  const endpoints = providers.instantiate(env);
  fetch.expect(endpoints['ethereum-mainnet'][0].uri, {
    method: 'POST',
    body: { type: 'json', value: { id: 0, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] } },
  })
    .returns(null, { status: 500 });
  return {
    endpoints,
    request: jsonRpc.preparePost({
      endpoint: `http://node-provider.test.local/ethereum-mainnet`,
      call: { method: 'eth_blockNumber', params: [] },
    }),
  };
}

test('the switch to a fallback is written after the response, through the context', async () => {
  const env = makeTestEnv({});
  const { context, deferred } = makeTestContext();
  const { endpoints, request } = failingMainnet(env);
  const response = await Api.fetch(request, env, context);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), `${env.settings.defaultRetryAfterUpstreamErrorSeconds}`);
  assert.equal(deferred.length, 1, 'the write is deferred');
  assert.ok(await settles(deferred), 'and settles, so the invocation is not held open');
  const active = await env.kv.get(`provider:default:ethereum-mainnet:active-fallback`);
  assert.deepEqual(JSON.parse(active!), endpoints['ethereum-mainnet'][1]);
});

test('a switch to a fallback that is not written is logged, and the answer stands', async t => {
  const env = makeTestEnv({});
  env.kv.put = async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); };
  const logged = t.mock.method(console, 'error', () => {});
  const { context, deferred } = makeTestContext();
  const { request } = failingMainnet(env);
  const response = await Api.fetch(request, env, context);
  assert.equal(response.status, 503);
  assert.ok(await settles(deferred), 'the failed write settles too');
  assert.match(
    logged.mock.calls.map(call => call.arguments.map(String).join(' ')).join('\n'),
    /deferred write failed: provider:default:ethereum-mainnet:active-fallback: KV PUT failed/,
  );
});

test('an active fallback that matches no endpoint is deleted after the response', async () => {
  const env = makeTestEnv({});
  const { context, deferred } = makeTestContext();
  const endpoints = providers.instantiate(env);
  await env.kv.put(
    `provider:default:ethereum-mainnet:active-fallback`,
    JSON.stringify({ provider: 'RetiredProvider' }),
  );
  fetch.expect(endpoints['ethereum-mainnet'][0].uri, {
    method: 'POST',
    body: { type: 'json', value: { id: 0, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] } },
  })
    .returns(JSON.stringify({ id: 0, jsonrpc: '2.0', result: '0xbeef' }));
  const request = jsonRpc.preparePost({
    endpoint: `http://node-provider.test.local/ethereum-mainnet`,
    call: { method: 'eth_blockNumber', params: [] },
  });
  const response = await Api.fetch(request, env, context);
  assert.equal(response.status, 200);
  assert.equal(deferred.length, 1, 'the delete is deferred');
  assert.ok(await settles(deferred), 'and settles');
  assert.equal(await env.kv.get(`provider:default:ethereum-mainnet:active-fallback`), null);
});

test('if provider fails with no fallback, Retry-After', async () => {
  const env = makeTestEnv({});
  const endpoints = providers.instantiate(env);
  const network: KnownNetwork.Name = 'polygon-mainnet';
  const lastEndpoint = endpoints[network][endpoints[network].length - 1];
  await env.kv.put(
    `provider:default:${network}:active-fallback`,
    JSON.stringify(lastEndpoint)
  );
  fetch.expect(lastEndpoint.uri, {
    method: 'POST',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/json',
    },
    body: {
      type: 'json',
      value: { id: 0, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] },
    },
  })
    .returns(null, {
      status: 503,
      headers: {
        'retry-after': `${env.settings.defaultRetryAfterUpstreamErrorSeconds}`
      }
    });
  const request = jsonRpc.preparePost({
    endpoint: `http://node-provider.test.local/${network}`,
    call: { method: 'eth_blockNumber', params: [] },
  });
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 503);
  assert.equal(
    response.headers.get('retry-after'),
    `${env.settings.defaultRetryAfterUpstreamErrorSeconds}`
  );
});

// every well-known network is reachable through the provider proxy
test('every well-known network is supported', async t => {
  const env = makeTestEnv({});
  const endpoints = providers.instantiate(env);
  await Promise.all(KnownNetwork.networks.map(network => {
    const canonicalName = KnownNetwork.canonicalNameOf(network);
    return t.test(`${canonicalName} is supported`, async _ => {
      const testEnv  = makeTestEnv({});
      const request  = jsonRpc.preparePost({
        endpoint: `https://node-provider.test.local/${canonicalName}`,
        call: {
          id: 15,
          method: 'eth_blockNumber',
          params: [],
        },
      });
      const rpcResponse = { id: 15, jsonrpc: '2.0', result: '0x42' };
      fetch.expect(endpoints[canonicalName][0].uri, {
        method: 'POST',
        headers: {
          'Accept':       'application/json',
          'Content-Type': 'application/json',
        },
        body: {
          type: 'json',
          value: { id: 15, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] },
        },
      })
        .returns(JSON.stringify(rpcResponse));
      const response = await Api.fetch(request, testEnv);
      const bodyText = await response.text();
      assert.equal(response.status, 200);
      assert.equal(bodyText, JSON.stringify(rpcResponse));
    });
  }));
});

// pre-empted RPCs
test('eth_chainId is pre-empted (no upstream)', async (_) => {
  const env = makeTestEnv({});
  const request = jsonRpc.preparePost({
    call: { id: 43, method: 'eth_chainId', params: [] },
    endpoint: `https://node-provider.test.local/ethereum-mainnet`,
  });
  assert(fetch.expects.length === 0,
    `api should handle eth_chainId without making any requests`
  );
  let response = await Api.fetch(request, env);
  assert.equal(response.status, 200, `response is OK`);
  let json = await response.json<object>();
  assert.ok(json, `response is not null`);
  assert.equal(typeof(json), 'object', `response is an object`);
  assert.ok('result' in json, `response must contain the field 'result'`);
  // Ethereum Chain ID should be 1 as expected.
  assert.deepEqual(json, { id: 43, jsonrpc: '2.0', result: '0x1' },
    `response should contain expected JSON-RPC response`
  );
});
