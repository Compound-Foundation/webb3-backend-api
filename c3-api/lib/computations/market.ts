import { BorrowApr            } from './market/borrow-apr.js';
import { SupplyApr            } from './market/supply-apr.js';
import { MarketSummary        } from './market/market-summary.js';
import { MarketDaySummary     } from './market/market-day-summary.js';
import { Collaterals          } from './market/collaterals.js';
import { VersionedCollaterals } from './market/collateral-details.js';
import { MarketLatestSummary  } from './market/market-latest-summary.js';
import { MarketMinutelySummary } from './market/market-minutely-summary.js';

import { HistoricalMarketDaySummaries }
  from './market/historical-market-day-summaries.js';

export type Market = (
  | BorrowApr
  | SupplyApr
  | MarketSummary
  | MarketDaySummary
  | Collaterals
  | VersionedCollaterals
  | MarketLatestSummary
  | HistoricalMarketDaySummaries
  | MarketMinutelySummary
);

export { BorrowApr, borrowApr         } from './market/borrow-apr.js';
export { SupplyApr, supplyApr         } from './market/supply-apr.js';
export { MarketSummary, marketSummary } from './market/market-summary.js';
export {
  Collaterals,
  collaterals,
} from './market/collaterals.js';
export {
  VersionedCollaterals,
  versionedCollaterals,
} from './market/collateral-details.js';
export {
  MarketLatestSummary,
  marketLatestSummary,
} from './market/market-latest-summary.js';
export {
  MarketDaySummary,
  marketDaySummary,
} from './market/market-day-summary.js';
export {
  HistoricalMarketDaySummaries,
  historicalMarketDaySummaries,
} from './market/historical-market-day-summaries.js';
export {
  MarketRewards,
  marketRewards,
} from './market/market-rewards.js';
export {
  MarketMinutelySummary,
  marketMinutelySummary,
} from './market/market-minutely-summary.js';
