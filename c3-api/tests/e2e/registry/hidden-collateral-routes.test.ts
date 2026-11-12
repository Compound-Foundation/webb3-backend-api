import { registryHarness } from '../../util/registry-harness.js';

import { HIDDEN_COLLATERALS, decisionRouteScenarios } from './decision-scenarios.js';

/*
 * What the hidden collateral routes refuse, through the real worker: a caller
 * without the token, a malformed request, a chain, a Comet or a collateral
 * the active registry does not hold, a registry with nothing active, and a
 * database without the migration. Every refusal writes nothing. The routes of
 * every kind of decision refuse alike, so the scenarios are
 * decision-scenarios.ts's, run here for hidden collaterals.
 */
decisionRouteScenarios(await registryHarness({ admin: true }), HIDDEN_COLLATERALS);
