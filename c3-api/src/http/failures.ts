import * as jsonRpc from '../../lib/json-rpc.js';

import { isRegistryUnavailable } from '../registry/cache.js';

import { ApiError, isApiError, nodeUnavailable } from './errors.js';

/*
 * What a failure means to a client on every route, legacy or registry, or
 * null for any other failure.
 *
 * What a handler raised to say something — a market without rewards, a
 * cursor of another version — says it. A registry that could not be read is a
 * 503: after the cutover there is no static market list to answer from, and
 * why it could not be read is the log's to say, never the client's. So is a
 * node provider that did not serve the request, which a client may ask
 * again; a call the contract reverted is its answer, not the node's failure.
 *
 * The registry's routes read more into a failure (asApiError). The legacy
 * routes read nothing more, and answer anything else with a 500.
 */
function knownFailure(error: unknown): ApiError | null {
  if (isApiError(error)) {
    return error;
  }
  if (isRegistryUnavailable(error)) {
    return new ApiError('UPSTREAM_UNAVAILABLE', `the comet registry could not be read`);
  }
  if (jsonRpc.isNotServed(error)) {
    return nodeUnavailable(error);
  }
  return null;
}

export { knownFailure };
