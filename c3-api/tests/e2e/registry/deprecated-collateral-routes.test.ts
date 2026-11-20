import { registryHarness } from '../../util/registry-harness.js';

import { DEPRECATED_COLLATERALS, decisionRouteScenarios } from './decision-scenarios.js';

/*
 * What the deprecated collateral routes refuse, through the real worker: a
 * caller without the token, a malformed request, a chain, a Comet or a
 * collateral the active registry does not hold, a registry with nothing
 * active, and a database without the migration. Every refusal writes
 * nothing. The routes of every kind of decision refuse alike, so the
 * scenarios are decision-scenarios.ts's, run here for deprecated
 * collaterals.
 */
decisionRouteScenarios(await registryHarness({ admin: true }), DEPRECATED_COLLATERALS);
