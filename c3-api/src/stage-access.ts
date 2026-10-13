/*
 * Access gate for non-production deployments.
 *
 * The stage worker serves the same data as production and spends the
 * production RPC quota through its service binding, so it must not answer
 * anonymous requests. Every environment other than the ones listed in
 * UNGATED_ENVIRONMENTS requires the caller to present STAGE_ACCESS_KEY in
 * the STAGE_ACCESS_HEADER request header.
 *
 * The gate fails closed: an unknown or missing ENVIRONMENT is gated, and a
 * gated deployment without a STAGE_ACCESS_KEY secret rejects every request.
 */

const STAGE_ACCESS_HEADER = 'X-Stage-Access-Key';

const UNGATED_ENVIRONMENTS: readonly string[] = [ 'production', 'local', 'test' ];

interface StageAccessEnv {
  ENVIRONMENT?:      string,
  STAGE_ACCESS_KEY?: string,
}

const encoder = new TextEncoder();

/*
 * Compares the SHA-256 digests of both values so that the comparison time
 * depends on neither the length nor the content of the expected key.
 */
async function keysMatch(presented: string, expected: string): Promise<boolean> {
  const [ presentedDigest, expectedDigest ] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const presentedBytes = new Uint8Array(presentedDigest);
  const expectedBytes  = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let i = 0; i < expectedBytes.length; i++) {
    difference |= presentedBytes[i] ^ expectedBytes[i];
  }
  return difference === 0;
}

/*
 * Returns true when the request can reach the API in this environment.
 */
async function isStageAccessAllowed(request: Request, env: StageAccessEnv): Promise<boolean> {
  if (env.ENVIRONMENT !== undefined && UNGATED_ENVIRONMENTS.includes(env.ENVIRONMENT)) {
    return true;
  }
  const expectedKey = env.STAGE_ACCESS_KEY;
  if (expectedKey === undefined || expectedKey === '') {
    return false;
  }
  const presentedKey = request.headers.get(STAGE_ACCESS_HEADER);
  if (presentedKey === null) {
    return false;
  }
  return keysMatch(presentedKey, expectedKey);
}

export {
  STAGE_ACCESS_HEADER,
  isStageAccessAllowed,
};
