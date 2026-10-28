import { sha256Hex } from '../../lib/hash.js';

import { ApiError } from './errors.js';

/*
 * Bearer authentication for the administrative registry routes.
 *
 * The worker stores only the SHA-256 of the admin token, so a leaked
 * configuration does not hand over the token itself, and the comparison is
 * fixed-time: comparing digests with === would leak, through timing, how much
 * of a guess was correct.
 */
function equalsFixedTime(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/*
 * A 401 names the scheme that would be accepted, as RFC 9110 requires of it,
 * and says when the token that was presented is the problem (RFC 6750): a
 * client is told what to send rather than only that it was refused.
 */
function unauthorized(message: string, challenge: string): ApiError {
  return new ApiError('UNAUTHORIZED', message, undefined, { 'WWW-Authenticate': challenge });
}

/*
 * The credentials as RFC 6750 writes them: the scheme, in any case, one space
 * or more, and the token, with nothing after it. Headers.get has already
 * dropped the whitespace around the value.
 */
const BEARER = /^bearer +(\S+)$/i;

function bearerToken(request: Request): string {
  const match = BEARER.exec(request.headers.get('authorization') ?? '');
  if (match === null) {
    throw unauthorized(`a bearer token is required`, 'Bearer');
  }
  return match[1]!;
}

/*
 * What an authenticated request is allowed to be charged as: a short prefix
 * of the token's digest. It identifies the credential for rate limiting and
 * diagnostics without being the token, or enough of its digest to be one.
 */
type Credential = {
  fingerprint: string,
};

const FINGERPRINT_LENGTH = 16;

/*
 * Verifies the request against the configured token hash. An environment
 * without a configured hash refuses every administrative request rather than
 * defaulting to open: an unconfigured admin API is a closed one.
 */
async function authenticateAdmin(request: Request, tokenHash: string | undefined): Promise<Credential> {
  const configured = (tokenHash ?? '').trim().toLowerCase();
  if (configured.length === 0) {
    throw new ApiError('FORBIDDEN', `the administrative API is not configured in this environment`);
  }
  // a value that is no hash matches no token, and a 401 would send the operator after the token
  if (!/^[0-9a-f]{64}$/.test(configured)) {
    throw new ApiError(
      'FORBIDDEN',
      `the administrative API is misconfigured in this environment: COMET_REGISTRY_ADMIN_TOKEN_HASH is not 64 hex digits`,
    );
  }
  const presented = await sha256Hex(bearerToken(request));
  if (!equalsFixedTime(presented, configured)) {
    throw unauthorized(`the bearer token is not valid`, 'Bearer error="invalid_token"');
  }
  return { fingerprint: presented.slice(0, FINGERPRINT_LENGTH) };
}

export type { Credential };
export { authenticateAdmin, sha256Hex };
