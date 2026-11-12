import t from 'tap';

import { ApiError, failureResponse } from '../../../src/http/errors.js';
import type { ApiErrorCode } from '../../../src/http/errors.js';
import { conflict } from '../../../src/registry/errors.js';
import { asApiError } from '../../../src/registry/router.js';

/*
 * A 409 of the registry names the conflict it met in `details.code`, which is
 * what a script matches: the message is for a person, and may change. API.md
 * lists the codes, and the runbook says what to do about each.
 */
t.test('a conflict is answered as CONFLICT, naming itself beside the details the route gives', async t => {
  const message = 'the overlay of market 1/usdc is no longer the one this was decided against; read it again';
  const thrown  = conflict('OVERLAY_CHANGED', message, { current: { 'market 1/usdc': null } });

  const response = failureResponse(asApiError(thrown), thrown, {
    requestId: 'request-1',
    pathname:  '/registry/v1/admin/versions/v/markets/1/usdc/overlay',
    debug:     { error: () => undefined, warn: () => undefined },
    label:     'registry route',
  });
  t.equal(response.status, 409);
  t.same(await response.json(), {
    error: {
      code:      'CONFLICT',
      message,
      requestId: 'request-1',
      details:   { code: 'OVERLAY_CHANGED', current: { 'market 1/usdc': null } },
    },
  }, 'in the envelope every error takes');
});

/*
 * That holds only while every CONFLICT names its conflict: one that did not
 * would leave a script nothing to match but the message. ApiError takes no
 * CONFLICT without a `details.code`, so each refusal below is a type error
 * the build expects.
 */
t.test('a CONFLICT that names no conflict does not compile', async () => {
  // @ts-expect-error a CONFLICT names the conflict it met
  new ApiError('CONFLICT', 'x');
  // @ts-expect-error in details.code, whatever else its details say
  new ApiError('CONFLICT', 'x', { current: null });
  // @ts-expect-error and a code that may be CONFLICT is held to it as well
  (code: ApiErrorCode) => new ApiError(code, 'x');
});
