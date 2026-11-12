import { registryHarness } from '../../util/registry-harness.js';

import { TOKEN_POLICIES, decisionRouteScenarios } from './decision-scenarios.js';

/*
 * What the token policy routes refuse, through the real worker: a caller
 * without the token, a malformed request, a chain or a token the active
 * registry does not hold, a registry with nothing active, and a database
 * without the migration. Every refusal writes nothing. The routes of every
 * kind of decision refuse alike, so the scenarios are decision-scenarios.ts's,
 * run here for token policies.
 */
decisionRouteScenarios(await registryHarness({ admin: true }), TOKEN_POLICIES);
