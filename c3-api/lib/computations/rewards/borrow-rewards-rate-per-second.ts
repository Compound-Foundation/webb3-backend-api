import { BigFixnum } from '../../bigfixnum.js';
import * as Compute  from '../../symbolic/computation.js';

import type { TrackingIndexScale      } from './tracking-index-scale.js';
import type { BaseTrackingBorrowSpeed } from './base-tracking-borrow-speed.js';

type BorrowRewardsRatePerSecond = Compute.Spec<{
  name: 'borrowRewardsRatePerSecond',
  depends: [ TrackingIndexScale, BaseTrackingBorrowSpeed ],
  expects: TrackingIndexScale['expects'] & BaseTrackingBorrowSpeed['expects'],
  returns: BigFixnum,
}>;

const { implement, pipe } = Compute.Functor<BorrowRewardsRatePerSecond>({});
const borrowRewardsRatePerSecond = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  compute({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) {
    return pipe([
      {
        trackingIndexScale: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
        baseTrackingBorrowSpeed: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
      },
      ({ trackingIndexScale, baseTrackingBorrowSpeed }) => BigFixnum.from({
        value: baseTrackingBorrowSpeed,
        multiplier: trackingIndexScale,
      })
    ]);
  },
});

export { BorrowRewardsRatePerSecond, borrowRewardsRatePerSecond };
