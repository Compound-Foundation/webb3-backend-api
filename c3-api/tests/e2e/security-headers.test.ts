import t from 'tap';
import { MemoryKv } from '../util/kv.js';
import C3Api, { Env } from '../../entrypoint.js';
import '../../shim/node-self.js';

/*
 * The security headers the security team recommended be present on every
 * response from the worker. Kept in sync with SECURITY_HEADERS in
 * entrypoint.ts.
 */
const EXPECTED_SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security':    'max-age=63072000; includeSubDomains; preload',
  'Content-Security-Policy':      "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options':       'nosniff',
  'X-Frame-Options':              'DENY',
  'Referrer-Policy':              'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

const testEnv: Env = {
  'TALLY_API_KEY': 'test',
  'V3_API_HOST': 'test',
  'NODE_PROXY_HOST': 'test',
  'NODE_PROXY_KEY': 'test',
  'ENVIRONMENT': 'test',
  'MEMORY_CACHE_SEED': 'security-headers',
  'kv_testnet':  MemoryKv({}),
  'kv_mainnet': MemoryKv({}),
};

function assertSecurityHeaders(t: Tap.Test, response: Response) {
  for (const [ name, value ] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
    t.equal(
      response.headers.get(name),
      value,
      `response has expected '${name}' header`,
    );
  }
}

t.test(`OPTIONS preflight response includes security headers`, async t => {
  const request  = new Request(`http://test.local/legacy/mainnet/gas-price`, {
    method: 'OPTIONS',
  });
  const response = await C3Api.fetch(request, testEnv);

  t.equal(response.status, 204, 'preflight returns 204');
  t.equal(
    response.headers.get('Access-Control-Allow-Origin'),
    '*',
    'preflight allows cross-origin requests',
  );
  assertSecurityHeaders(t, response);

  t.end();
});

t.test(`GET response includes security headers`, async t => {
  // an unknown path resolves to a deterministic 404 without any network
  // calls, which is sufficient to exercise the main response branch.
  const request  = new Request(`http://test.local/not-a-real-endpoint`);
  const response = await C3Api.fetch(request, testEnv);

  t.equal(response.status, 404, 'unknown route returns 404');
  t.equal(
    response.headers.get('Access-Control-Allow-Origin'),
    '*',
    'response allows cross-origin requests',
  );
  assertSecurityHeaders(t, response);

  t.end();
});
