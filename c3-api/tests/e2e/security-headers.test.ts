import t, { Test } from 'tap';
import { makeTestEnv } from '../util/test-env.js';
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

const testEnv: Env = makeTestEnv({
  'MEMORY_CACHE_SEED': 'security-headers',
  // an administrative route spends from the address limiter before anything else, which has to answer here
  'REGISTRY_ADMIN_AUTH_RATE_LIMITER': { limit: async () => ({ success: true }) },
});

function assertSecurityHeaders(t: Test, response: Response) {
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

/*
 * The registry answers its own preflight, because its administrative routes
 * must not advertise cross-origin access, and the legacy routes answer every
 * other path's. A path that only looks like a registry path is a legacy
 * route's, and is answered as one.
 */
t.test(`a path that only looks like a registry path still gets a preflight`, async t => {
  for (const path of [ '/registry/v1x', '/registry/v1beta/markets', '/registry', '/registry/v2/active' ]) {
    const response = await C3Api.fetch(new Request(`http://test.local${path}`, { method: 'OPTIONS' }), testEnv);

    t.equal(response.status, 204, `${path} is answered as a preflight`);
    t.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    t.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET');
  }

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

/*
 * The CORS headers a browser reads, by the kind of route that answered. They
 * are written out here rather than taken from cors.ts, so a change to what a
 * route answers a browser with fails this test instead of following along.
 */
const READABLE: Record<string, string> = {
  'Access-Control-Allow-Origin':   '*',
  'Access-Control-Expose-Headers': 'ETag, X-Registry-Version, X-Registry-Checksum, X-Registry-Stale, Retry-After',
};

const CORS = {
  legacy:          READABLE,
  legacyPreflight: { ...READABLE, 'Access-Control-Allow-Methods': 'GET' },
  public:          READABLE,
  publicPreflight: {
    ...READABLE,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
    'Access-Control-Max-Age':       '86400',
  },
  // an administrative route answers none, to a preflight as to anything else
  admin:           {},
};

const CORS_HEADER_NAMES = [
  'Access-Control-Allow-Origin',
  'Access-Control-Expose-Headers',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Headers',
  'Access-Control-Max-Age',
];

function corsOf(response: Response): Record<string, string> {
  return Object.fromEntries(CORS_HEADER_NAMES.flatMap(name => {
    const value = response.headers.get(name);
    return value === null ? [] : [ [ name, value ] ];
  }));
}

// the failure a route answers with here is logged; nothing here is about it
function quiet(t: Test): void {
  const error = console.error;
  const warn  = console.warn;
  console.error = () => {};
  console.warn  = () => {};
  t.teardown(() => {
    console.error = error;
    console.warn  = warn;
  });
}

/*
 * A response takes its CORS headers from the router that answered it: the
 * registry sets its own on every registry path — none at all on an
 * administrative one — and the entrypoint sets the legacy routes' on every
 * other path. Neither overwrites the other's, so what a route answers with is
 * what its router decided.
 *
 * The values alone cannot show that neither overwrites the other's: the
 * public registry headers are the legacy routes' own, so an entrypoint that
 * set them again over the registry's would leave every value as it found it.
 * So every header set is watched as well, and no CORS header may be set over
 * one the response already carries.
 */
t.test(`every response carries the CORS headers of its route, and no others`, async t => {
  quiet(t);
  const overwritten: string[] = [];
  const answer = async (path: string, method: string = 'GET') => {
    const { set } = Headers.prototype;
    Headers.prototype.set = function (this: Headers, name: string, value: string) {
      if (/^access-control-/i.test(name) && this.has(name)) {
        overwritten.push(`${method} ${path}: ${name}`);
      }
      set.call(this, name, value);
    };
    try {
      return await C3Api.fetch(new Request(`http://test.local${path}`, { method }), testEnv);
    } finally {
      Headers.prototype.set = set;
    }
  };

  t.same(corsOf(await answer('/not-a-real-endpoint')), CORS.legacy, 'a legacy route');
  t.same(corsOf(await answer('/legacy/mainnet/gas-price', 'OPTIONS')), CORS.legacyPreflight, 'and the preflight of one');
  t.same(corsOf(await answer('/registry/v1x')), CORS.legacy, 'a path that only looks like a registry path is a legacy route');

  // D1 does not exist in Node, so a registry read fails here: with the headers of its route
  const read = await answer('/registry/v1/active');
  t.equal(read.status, 500, 'a public registry read that fails');
  t.same(corsOf(read), CORS.public, 'carries the public registry headers');
  t.same(corsOf(await answer('/registry/v1/active', 'OPTIONS')), CORS.publicPreflight,
    'and its preflight the public registry preflight');
  for (const path of [ '/registry/v1', '/registry/v1/', '/registry/v1/nothing-here' ]) {
    const unknown = await answer(path);
    t.equal(unknown.status, 404, `${path} is no registry route`);
    t.same(corsOf(unknown), CORS.public, 'and is refused with the public registry headers');
  }

  const admin = await answer('/registry/v1/admin/versions');
  t.equal(admin.status, 403, 'an administrative route of an environment without a token');
  t.same(corsOf(admin), CORS.admin, 'carries none');
  t.same(corsOf(await answer('/registry/v1/admin/versions', 'OPTIONS')), CORS.admin, 'and nor does its preflight');
  for (const path of [ '/registry/v1/admin', '/registry/v1/admin/', '/registry/v1/admin/nothing-here', '/registry/v1/administrator' ]) {
    const unknown = await answer(path);
    t.equal(unknown.status, 404, `${path}, under the administrative prefix, is no route`);
    t.same(corsOf(unknown), CORS.admin, 'and carries none either');
  }

  for (const response of [ read, admin ]) {
    assertSecurityHeaders(t, response);
  }

  t.same(overwritten, [], 'and no response had a CORS header set over one it already carried');

  t.end();
});

/*
 * Every header of an answer, as a client reads it: the security headers, the
 * CORS headers of its route, and what the route itself said. An answer that
 * read no registry version names none.
 */
t.test(`an answer carries exactly the headers of its route`, async t => {
  quiet(t);
  const lowercased = (headers: Record<string, string>) => Object.fromEntries(
    Object.entries(headers).map(([ name, value ]) => [ name.toLowerCase(), value ]),
  );
  const secured = lowercased(EXPECTED_SECURITY_HEADERS);
  const json    = { 'content-type': 'application/json; charset=utf-8' };
  const headersOf = async (path: string, method: string, status: number) => {
    const response = await C3Api.fetch(new Request(`http://test.local${path}`, { method }), testEnv);
    t.equal(response.status, status, `${method} ${path} answers ${status}`);
    return Object.fromEntries(response.headers);
  };

  t.same(await headersOf('/not-a-real-endpoint', 'GET', 404), { ...secured, ...lowercased(CORS.legacy), ...json },
    'a legacy route that matches nothing');
  t.same(
    await headersOf(`/market/mainnet/0xc3d688b66703497daa19211eedff47f25384cdc3/sumary`, 'GET', 400),
    { ...secured, ...lowercased(CORS.legacy), 'content-type': 'text/plain;charset=UTF-8' },
    'a legacy route refusing a malformed path',
  );
  t.same(await headersOf('/legacy/mainnet/gas-price', 'OPTIONS', 204), { ...secured, ...lowercased(CORS.legacyPreflight) },
    'a legacy preflight');
  t.same(await headersOf('/registry/v1x', 'OPTIONS', 204), { ...secured, ...lowercased(CORS.legacyPreflight) },
    'and the preflight of a path that only looks like a registry path');
  t.same(await headersOf('/registry/v1/active', 'GET', 500), { ...secured, ...lowercased(CORS.public), ...json },
    'a public registry read that failed');
  t.same(await headersOf('/registry/v1/active', 'OPTIONS', 204), { ...secured, ...lowercased(CORS.publicPreflight) },
    'a public registry preflight');
  t.same(await headersOf('/registry/v1/nothing-here', 'GET', 404), { ...secured, ...lowercased(CORS.public), ...json },
    'a registry path no route takes');
  t.same(await headersOf('/registry/v1/admin/versions', 'GET', 403), { ...secured, ...json },
    'an administrative route refusing a caller');
  t.same(await headersOf('/registry/v1/admin/versions', 'OPTIONS', 204), secured,
    'and an administrative preflight');

  t.end();
});
