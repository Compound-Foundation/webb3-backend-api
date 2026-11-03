import { ApiError } from '../http/errors.js';

import { RegistryUnavailable, isRegistryUnavailable } from './cache.js';

/*
 * How a route answers a registry it cannot read: 503 either way, with a code
 * that says which — nothing is active, or the database did not answer. Why it
 * did not answer is the log's to say, never the client's.
 */
function unavailableError(error: RegistryUnavailable): ApiError {
  return error.reason === 'not_active'
    ? new ApiError('REGISTRY_NOT_ACTIVE', `No active registry snapshot is available`)
    : new ApiError('UPSTREAM_UNAVAILABLE', `the comet registry could not be read`);
}

export { RegistryUnavailable, isRegistryUnavailable, unavailableError };
