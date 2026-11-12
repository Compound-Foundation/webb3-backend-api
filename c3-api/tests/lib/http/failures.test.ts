import t from 'tap';

import { readFileSync } from 'node:fs';

import * as jsonRpc from '../../../lib/json-rpc.js';
import { ApiError, noActiveVersion } from '../../../src/http/errors.js';
import { knownFailure } from '../../../src/http/failures.js';
import { RegistryUnavailable } from '../../../src/registry/cache.js';
import { asApiError } from '../../../src/registry/router.js';

import { sourceFiles } from '../../util/sources.js';

/*
 * What a failure means to a client. Every route reads a few failures the same
 * way (knownFailure); a registry route reads more into one (asApiError), and
 * a legacy route answers anything else with a 500.
 */

// all of an answer a client sees: its status, the envelope's code, message and details, and its headers
function seen(error: ApiError | null): object | null {
  return error === null ? null : {
    status:  error.status,
    code:    error.code,
    message: error.message,
    details: error.details,
    headers: error.headers,
  };
}

t.test('what a handler raised to say something says it, on every route', async t => {
  const refused = new ApiError('REWARDS_NOT_AVAILABLE', 'Rewards are not available for this market');
  t.equal(knownFailure(refused), refused, 'as it is');
  t.equal(asApiError(refused), refused, 'on a registry route too');
});

t.test('a registry that could not be read is a 503 that says nothing of why', async t => {
  const unavailable = new RegistryUnavailable(
    `the deprecated collateral decisions could not be read`,
    new Error('D1_ERROR: Network connection lost.'),
  );
  const answer = {
    status:  503,
    code:    'UPSTREAM_UNAVAILABLE',
    message: 'the comet registry could not be read',
    details: undefined,
    headers: {},
  };
  t.same(seen(knownFailure(unavailable)), answer, 'on every route, whatever could not be read');
  t.same(seen(asApiError(unavailable)), answer, 'a registry route included');
});

t.test('a node provider that did not serve a request is a 503, after the wait it asked for', async t => {
  const limited = new jsonRpc.NotServed('JSON-RPC request failed: HTTP 503', { status: 503, retryAfter: 5 });
  const answer  = {
    status:  503,
    code:    'UPSTREAM_UNAVAILABLE',
    message: 'a node provider did not answer',
    details: undefined,
    headers: { 'Retry-After': '5' },
  };
  t.same(seen(knownFailure(limited)), answer, 'on every route');
  t.same(seen(asApiError(limited)), answer, 'a registry route included');

  const unreached = new jsonRpc.NotServed('JSON-RPC request failed: fetch failed');
  t.same(knownFailure(unreached)?.headers, {}, 'and with no wait when nothing answered to ask for one');
});

/*
 * A registry route reads an outage of the database into a message. A legacy
 * route does not: what fails it there is KV, Tally or a computation, and a
 * message that says `unavailable` of itself is still a fault, a 500.
 */
t.test('a fault that says unavailable is a 500 on a legacy route, and an outage on a registry route', async t => {
  const refused = new Error('KV GET failed: 503 Service Unavailable');
  t.equal(knownFailure(refused), null, 'a legacy route answers it 500');
  t.same(seen(asApiError(refused)), {
    status:  503,
    code:    'UPSTREAM_UNAVAILABLE',
    message: 'a service the registry depends on did not answer',
    details: undefined,
    headers: {},
  }, 'while a registry route answers it as a service that did not answer');

  const fault = new Error('the request could not be completed');
  t.equal(knownFailure(fault), null, 'and a fault that says nothing of the kind is a 500 on every route');
  t.equal(asApiError(fault), null, 'a registry route included');
});

/*
 * Nothing active is what D1 said, on every route that asked: the market
 * routes, the registry's active reads, and the token policy and deprecated
 * collateral routes. It is one answer, so it is built in one place.
 */
t.test('nothing active is one answer, built in one place', async t => {
  const inactive = noActiveVersion();
  t.same(seen(inactive), {
    status:  503,
    code:    'REGISTRY_NOT_ACTIVE',
    message: 'No active registry snapshot is available',
    details: undefined,
    headers: {},
  }, 'a 503 with a code of its own');
  t.equal(knownFailure(inactive), inactive, 'which every route answers as it is');

  const sources = sourceFiles();
  t.ok(sources.length > 200, 'every source file is read');
  const building = sources.filter(path => /ApiError\(\s*['"`]REGISTRY_NOT_ACTIVE/.test(readFileSync(path, 'utf8')));
  t.same(building, [ 'src/http/errors.ts' ], 'only noActiveVersion() builds it');
});
