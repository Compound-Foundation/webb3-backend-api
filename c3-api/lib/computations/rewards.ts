import { TotalsBasic                } from './rewards/totals-basic.js';
import { RewardsSummary             } from './rewards/rewards-summary.js';
import { BorrowRewardsApr           } from './rewards/borrow-rewards-apr.js';
import { SupplyRewardsApr           } from './rewards/supply-rewards-apr.js';
import { BaseMinForRewards          } from './rewards/base-min-for-rewards.js';
import { TrackingIndexScale         } from './rewards/tracking-index-scale.js';
import { BaseTrackingSupplySpeed    } from './rewards/base-tracking-supply-speed.js';
import { BaseTrackingBorrowSpeed    } from './rewards/base-tracking-borrow-speed.js';
import { BorrowRewardsRatePerSecond } from './rewards/borrow-rewards-rate-per-second.js';
import { SupplyRewardsRatePerSecond } from './rewards/supply-rewards-rate-per-second.js';

export type Rewards = (
  | TotalsBasic
  | RewardsSummary
  | BorrowRewardsApr
  | SupplyRewardsApr
  | BaseMinForRewards
  | TrackingIndexScale
  | BaseTrackingBorrowSpeed
  | BaseTrackingSupplySpeed
  | BorrowRewardsRatePerSecond
  | SupplyRewardsRatePerSecond
);

export { TotalsBasic, totalsBasic             } from './rewards/totals-basic.js';
export { BorrowRewardsApr, borrowRewardsApr   } from './rewards/borrow-rewards-apr.js';
export { SupplyRewardsApr, supplyRewardsApr   } from './rewards/supply-rewards-apr.js';
export { BaseMinForRewards, baseMinForRewards } from './rewards/base-min-for-rewards.js';
export {
  RewardsSummary,
  rewardsSummary,
} from './rewards/rewards-summary.js';
export {
  TrackingIndexScale,
  trackingIndexScale,
} from './rewards/tracking-index-scale.js';
export {
  BaseTrackingSupplySpeed,
  baseTrackingSupplySpeed,
} from './rewards/base-tracking-supply-speed.js';
export {
  BaseTrackingBorrowSpeed,
  baseTrackingBorrowSpeed,
} from './rewards/base-tracking-borrow-speed.js';
export {
  BorrowRewardsRatePerSecond,
  borrowRewardsRatePerSecond,
} from './rewards/borrow-rewards-rate-per-second.js';
export {
  SupplyRewardsRatePerSecond,
  supplyRewardsRatePerSecond,
} from './rewards/supply-rewards-rate-per-second.js';
