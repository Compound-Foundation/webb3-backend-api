import t from 'tap';
import { MemoryKv } from '../util/kv.js';
import C3Api, { Env } from '../../entrypoint.js';
import * as Rate from '../../lib/rate-limit.js';
import '../../shim/node-self.js';

/*
 * records the keys it is asked about and allows only the first `allowed`
 * calls
 */
function countingLimiter(allowed: number): Rate.Limiter & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      return { success: keys.length <= allowed };
    },
  };
}

function testEnv(limiter?: Rate.Limiter): Env {
  return {
    'TALLY_API_KEY': 'test',
    'V3_API_HOST': 'test',
    'NODE_PROXY_HOST': 'test',
    'NODE_PROXY_KEY': 'test',
    'ENVIRONMENT': 'test',
    'MEMORY_CACHE_SEED': 'rate-limit',
    'kv_testnet':  MemoryKv({}),
    'kv_mainnet': MemoryKv({}),
    ...(limiter === undefined ? {} : { 'RATE_LIMITER': limiter }),
  };
}

/*
 * an unknown path resolves to a deterministic 404 without any network
 * calls, so a 404 means the request got past the limit
 */
function request(ip = '203.0.113.7', method = 'GET'): Request {
  return new Request(`http://test.local/not-a-real-endpoint`, {
    method,
    headers: { 'CF-Connecting-IP': ip },
  });
}

t.test(`over the limit returns 429 with Retry-After, CORS and security headers`, async t => {
  const env = testEnv(countingLimiter(1));

  const first   = await C3Api.fetch(request(), env);
  const limited = await C3Api.fetch(request(), env);

  t.equal(first.status, 404, 'first request is served');
  t.equal(limited.status, 429, 'second request is limited');
  t.equal(limited.headers.get('Retry-After'), '60');
  t.equal(limited.headers.get('Cache-Control'), 'no-store');
  t.equal(limited.headers.get('Access-Control-Allow-Origin'), '*');
  t.equal(
    limited.headers.get('Strict-Transport-Security'),
    'max-age=63072000; includeSubDomains; preload',
  );
  t.same(await limited.json(), { error: 'Too many requests' });

  t.end();
});

t.test(`OPTIONS preflights are limited too`, async t => {
  const response = await C3Api.fetch(request('203.0.113.7', 'OPTIONS'), testEnv(countingLimiter(0)));

  t.equal(response.status, 429);
  t.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  t.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');

  t.end();
});

t.test(`a request without CF-Connecting-IP is counted under one shared key`, async t => {
  const limiter = countingLimiter(10);

  await C3Api.fetch(new Request(`http://test.local/not-a-real-endpoint`), testEnv(limiter));

  t.same(limiter.keys, [ 'unknown' ]);

  t.end();
});

t.test(`the limit is keyed on CF-Connecting-IP, IPv6 by /64`, async t => {
  const limiter = countingLimiter(10);
  const env     = testEnv(limiter);

  await C3Api.fetch(request('198.51.100.1'), env);
  await C3Api.fetch(request('2001:db8:1:2:aaaa::1'), env);

  t.same(limiter.keys, [ '198.51.100.1', '2001:db8:1:2::/64' ]);

  t.end();
});

t.test(`the request is served when the limiter throws`, async t => {
  const env = testEnv({
    limit: async () => { throw new Error('binding down'); },
  });

  const response = await C3Api.fetch(request(), env);

  t.equal(response.status, 404);

  t.end();
});

t.test(`the request is served when no limiter is bound`, async t => {
  const response = await C3Api.fetch(request(), testEnv());

  t.equal(response.status, 404);

  t.end();
});
