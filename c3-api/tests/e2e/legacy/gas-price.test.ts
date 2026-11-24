import t from 'tap';

import C3Api from '../../../entrypoint.js';

import * as mock        from '../../util/mock/mock.js';
import { consoleLines } from '../../util/console.js';
import { makeTestEnv }  from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * /legacy/mainnet/gas-price is retired. It answers 410 in the envelope every
 * route answers a failure with, says since when in its Deprecation header,
 * and carries the CORS and security headers of every legacy route. It reads
 * nothing to say so: every request leaves through a fetch mock that refuses
 * all of them, and the database fails any read in Node. A 410 is the
 * client's to read, so nothing is logged about it.
 */
const PATH = '/legacy/mainnet/gas-price';

// 2026-11-06T00:00:00Z, as RFC 9745 writes the header: `@` and the seconds since the epoch
const DEPRECATION = '@1793923200';

const HEADERS: Record<string, string> = {
  'content-type':                  'application/json; charset=utf-8',
  'deprecation':                   DEPRECATION,
  'access-control-allow-origin':   '*',
  'access-control-expose-headers': 'ETag, X-Registry-Version, X-Registry-Checksum, X-Registry-Stale, Retry-After',
  'strict-transport-security':     'max-age=63072000; includeSubDomains; preload',
  'content-security-policy':       "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options':        'nosniff',
  'x-frame-options':               'DENY',
  'referrer-policy':               'no-referrer',
  'cross-origin-resource-policy':  'cross-origin',
};

declare var fetch: mock.Fetch;
const fetchBefore = globalThis.fetch;
t.beforeEach(() => {
  globalThis.fetch = mock.fetch({});
});
t.teardown(() => {
  globalThis.fetch = fetchBefore;
});

t.test(`GET ${PATH} answers 410 Gone, and reads nothing`, async t => {
  const logged   = consoleLines(t, [ 'error', 'warn' ]);
  const env      = makeTestEnv({ MEMORY_CACHE_SEED: 'legacy-gas-price' });
  const response = await C3Api.fetch(new Request(`https://api.test.local${PATH}`), env);

  t.equal(response.status, 410, 'the route is gone');
  t.same(Object.fromEntries(response.headers), HEADERS,
    'as JSON, with the instant it was deprecated and the headers of every legacy route, and no registry version');

  const body = await response.json() as { error: Record<string, unknown> };
  t.match(body, { error: { code: 'GONE', message: `${PATH} is retired`, requestId: /^[0-9a-f-]{36}$/ } },
    'in the envelope, with a request id');
  t.same(Object.keys(body.error), [ 'code', 'message', 'requestId' ], 'and no details');

  t.same(fetch.unexpected.map(request => request.url), [], 'no request left the worker');
  t.same(logged, [], 'and nothing was logged');
});
