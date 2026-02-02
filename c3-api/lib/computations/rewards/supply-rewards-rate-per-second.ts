import { BigFixnum } from '../../bigfixnum.js';
import * as Compute  from '../../symbolic/computation.js';

import type { TrackingIndexScale      } from './tracking-index-scale.js';
import type { BaseTrackingSupplySpeed } from './base-tracking-supply-speed.js';

type SupplyRewardsRatePerSecond = Compute.Spec<{
  name: 'supplyRewardsRatePerSecond',
  depends: [ TrackingIndexScale, BaseTrackingSupplySpeed ],
  expects: TrackingIndexScale['expects'] & BaseTrackingSupplySpeed['expects'],
  returns: BigFixnum,
}>;

const { implement, pipe } = Compute.Functor<SupplyRewardsRatePerSecond>({});
const supplyRewardsRatePerSecond = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  compute({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) {
    return pipe([
      {
        trackingIndexScale: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
        baseTrackingSupplySpeed: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
      },
      ({ trackingIndexScale, baseTrackingSupplySpeed }) => BigFixnum.from({
        value: baseTrackingSupplySpeed,
        multiplier: trackingIndexScale,
      })
    ]);
  },
});

export { SupplyRewardsRatePerSecond, supplyRewardsRatePerSecond };
