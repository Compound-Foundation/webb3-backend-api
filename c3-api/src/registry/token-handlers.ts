import { jsonResponse } from '../http/json.js';

import { RegistryContext, chainIdOf } from './handlers.js';
import { readTokenPolicies } from './token-policy-repository.js';
import { registryHeaders } from './version-headers.js';

/*
 * A network's tokens with the token policy in force for each. One token's
 * policy and the list of every token's are answered as every kind of decision
 * is (decision-handlers.ts).
 *
 * A policy belongs to no registry version, but whether a token may carry one
 * is decided by the active version, so the answer names that version, in
 * headers and in the body, as the other registry routes do.
 */

async function getTokenPolicies(context: RegistryContext, chainId: string): Promise<Response> {
  const policies = await readTokenPolicies(context.db, chainIdOf(chainId));
  return jsonResponse(policies, { headers: registryHeaders(policies.registryVersion) });
}

export { getTokenPolicies };
