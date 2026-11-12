import { BigFixnum } from '../../lib/bigfixnum.js';

import type { VisibilityV1 } from '../../lib/model/comet-registry.js';

/*
 * Whether discovery shows the token of a collateral in its market: where the
 * market's Comet hides it, it is not shown (`hidden`), whatever else holds,
 * hiding a collateral being a decision about discovery alone and so asked
 * first; otherwise, where the Comet has it deprecated, it is not shown either
 * (`deprecated`), as the market no longer offers it. Any other is shown when
 * an administrator marked it strategic on its chain, or when what the market
 * holds of it is worth at least USD 250,000. The comparison is exact, in
 * fixed point, never in a float. What other markets of the chain hold of the
 * token, or decide about it, takes no part, and every market the version
 * serves is decided so, whatever its status.
 *
 * A collateral whose value cannot be read is shown: leaving it out
 * would keep from discovery an asset someone may hold, and showing
 * it is the safe answer to not knowing. A collateral the market holds
 * none of is worth nothing, whatever its price says, and so is below
 * the threshold (market-latest-summary.ts). A strategic token is shown
 * whatever its value says.
 *
 * The markets still take a token kept out as collateral, and the app keeps
 * showing it to a user who holds some, so that it can be withdrawn.
 */
const THRESHOLD_USD = BigFixnum.from({ value: 250000 });

// what keeps a token out of discovery, if anything; not null, which /summary gives a decision it could not read
type Exclusion = 'hidden' | 'deprecated' | 'none';

function exclusionHere({ isHidden, isDeprecated }: { isHidden: boolean, isDeprecated: boolean }): Exclusion {
  return isHidden ? 'hidden' : isDeprecated ? 'deprecated' : 'none';
}

// of a value, the rule reads only whether it is known and what it is worth
function visibilityOf(exclusion: Exclusion, isStrategic: boolean, valueUsd: BigFixnum | null): VisibilityV1 {
  if (exclusion !== 'none') {
    return { isVisible: false, visibilityReason: exclusion };
  }
  if (isStrategic) {
    return { isVisible: true, visibilityReason: 'strategic' };
  }
  if (valueUsd === null) {
    return { isVisible: true, visibilityReason: 'data_unavailable' };
  }
  return valueUsd.gte(THRESHOLD_USD)
    ? { isVisible: true,  visibilityReason: 'collateral_threshold' }
    : { isVisible: false, visibilityReason: 'below_threshold' };
}

/*
 * What discovery says of a token in one market, by its Comet's decisions about
 * the collateral, the chain's strategic marks and what the market holds of
 * it, where a kind of decision may not have been read (null): what the rule
 * answers whichever way an unread decision went. Where every answer gives the
 * same reason, that answer is said, the reason saying whether the token is
 * shown; where they agree only on whether it is shown, that alone is said, a
 * key being left out only where an unread decision could change it; elsewhere
 * nothing is.
 */
function visibilityHere(
  { isHidden, isDeprecated, isStrategic }: { isHidden: boolean | null, isDeprecated: boolean | null, isStrategic: boolean | null },
  valueUsd: BigFixnum | null,
): Partial<VisibilityV1> {
  const either     = (decision: boolean | null) => decision === null ? [ true, false ] : [ decision ];
  const exclusions = either(isHidden).flatMap(hiding => either(isDeprecated).map(deprecating => (
    exclusionHere({ isHidden: hiding, isDeprecated: deprecating })
  )));
  const answers    = exclusions.flatMap(exclusion => either(isStrategic).map(strategic => visibilityOf(exclusion, strategic, valueUsd)));
  const [ first ]  = answers;
  const agreed     = (part: keyof VisibilityV1) => answers.every(answer => answer[part] === first[part]);
  return agreed('visibilityReason') ? first : agreed('isVisible') ? { isVisible: first.isVisible } : {};
}

export type { Exclusion };
export { visibilityHere, visibilityOf };
