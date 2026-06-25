import test from 'node:test';
import { strict as assert } from 'node:assert';

import { KVNamespace   } from '@miniflare/kv';
import { MemoryStorage } from '@miniflare/storage-memory';
import type { StoredValueMeta } from '@miniflare/shared';

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
 * - fallback to alchemyEthMainnet -> 503, Retry-After 0
 *   - persist fallback to alchemyEthMainnet on subsequent requests
 *   - expire fallback to alchemyEthMainnet
 * - fail w/ no available fallback -> 503, Retry-After >=10s
 * - provider should receive a single request for one-item batch, no batch
 * - manual json filter object for active-fallback should work
 */

// FIXME: this test fails: right now the API throws an uncaught exception
test.skip('missing provider secret causes 500', async () => {
  const env = makeTestEnv({});
  delete (env as any)['alchemyEthMainnet'];
  const endpoint = `http://node-provider.test.local`;
  const request  = new Request(endpoint, {
  });
  const response = await Api.fetch(request, env);
  assert.equal(response.status, 500);
  const bodyText = await response.text();
  assert.match(bodyText, /alchemyEthMainnet not found/);
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
