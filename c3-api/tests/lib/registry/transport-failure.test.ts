import t from 'tap';

import { isUnreachable } from '../../../src/registry/cache.js';
import { RegistryError, RegistryErrorCode, isTransportFailure } from '../../../src/registry/errors.js';
import { ERROR_STATUS } from '../../../src/registry/router.js';

/*
 * Which failures a root's five attempts are spent on.
 *
 * The line is whether the failure says anything about the root. A source or a
 * provider that did not answer, and a Worker that ran out of what it is
 * given, say nothing: the same work was interrupted. A document that does not
 * parse, or a contract that is not deployed, will say the same thing next
 * time and is worth an attempt.
 */
t.test('a carrier that did not answer is not the root being wrong', async t => {
  for (const code of [ 'CHAIN_REQUEST_FAILED', 'SOURCE_REQUEST_FAILED' ] as const) {
    t.equal(isTransportFailure(new RegistryError(code, 'did not answer')), true, `${code} is the carrier`);
  }

  for (const message of [
    'Too many subrequests.',
    'Worker exceeded CPU time limit.',
    'network connection lost',
    'fetch failed',
    'The request timed out',
  ]) {
    t.equal(isTransportFailure(new Error(message)), true, `"${message}" is the carrier`);
  }
});

t.test('what the source or the chain said about the root is the root', async t => {
  for (const code of [
    'ROOT_DOCUMENT_INVALID',
    'ROOT_NETWORK_UNSUPPORTED',
    'ROOT_DUPLICATE',
    'CHAIN_CONTRACT_MISSING',
    'CHAIN_CALL_REVERTED',
    'CHAIN_RESPONSE_INVALID',
    'SOURCE_CONTENT_TOO_LARGE',
    'SOURCE_COMMIT_UNREACHABLE',
  ] as const) {
    t.equal(isTransportFailure(new RegistryError(code, 'about the root')), false, `${code} is worth an attempt`);
  }

  t.equal(isTransportFailure(new Error('no such column: markets.slug')), false,
    'and so is a programming error, which must not look like a hiccup');
  t.equal(isTransportFailure('not an error at all'), false);
});

/*
 * A timeout is told by a message that says something timed out. A fault
 * that only names a timeout setting would otherwise give a root its attempt
 * back, and be answered as a service that did not answer.
 */
t.test('a timeout is the carrier, and a fault that names one is not', async t => {
  for (const message of [
    'The request timed out',
    'D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.',
  ]) {
    t.equal(isTransportFailure(new Error(message)), true, `"${message}" is the carrier`);
    t.equal(isUnreachable(new Error(message)), true, 'and the database not answering');
  }

  const fault = new TypeError(`Cannot read properties of undefined (reading 'timeoutMs')`);
  t.equal(isTransportFailure(fault), false, 'a fault that names a timeout setting is not the carrier');
  t.equal(isUnreachable(fault), false, 'nor the database not answering');
});

// every failure D1's documentation says to retry, in its own words
t.test('a failure D1 says to retry is the database not answering', async t => {
  for (const message of [
    'D1_ERROR: D1 DB reset because its code was updated.',
    'D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.',
    'D1_ERROR: Network connection lost.',
    'D1_ERROR: Replica disconnected from primary.',
    'D1_ERROR: Internal error in D1 DB storage caused object to be reset.',
    'D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node.',
    `D1_ERROR: Can't read from request stream because client disconnected.`,
  ]) {
    t.equal(isUnreachable(new Error(message)), true, `"${message}" is the database not answering`);
  }
});

/*
 * A carrier failure gives the root its attempt back, so a code that joins
 * the set, or a new code, has to be decided here: ERROR_STATUS names every
 * code there is.
 */
t.test('only the source and the node provider not answering are the carrier', async t => {
  const carriers = Object.keys(ERROR_STATUS)
    .filter(code => isTransportFailure(new RegistryError(code as RegistryErrorCode, 'x')))
    .sort();
  t.same(carriers, [ 'CHAIN_REQUEST_FAILED', 'SOURCE_REQUEST_FAILED' ]);
});
