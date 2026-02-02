import { BorrowApr            } from './market/borrow-apr.js';
import { SupplyApr            } from './market/supply-apr.js';
import { MarketSummary        } from './market/market-summary.js';
import { MarketDaySummary     } from './market/market-day-summary.js';
import { TotalCollateralValue } from './market/total-collateral-value.js';
import { MarketMinutelySummary } from './market/market-minutely-summary.js';

import { HistoricalMarketDaySummaries }
  from './market/historical-market-day-summaries.js';

export type Market = (
  | BorrowApr
  | SupplyApr
  | MarketSummary
  | MarketDaySummary
  | TotalCollateralValue
  | HistoricalMarketDaySummaries
  | MarketMinutelySummary
);

export { BorrowApr, borrowApr         } from './market/borrow-apr.js';
export { SupplyApr, supplyApr         } from './market/supply-apr.js';
export { MarketSummary, marketSummary } from './market/market-summary.js';
export {
  TotalCollateralValue,
  totalCollateralValue,
} from './market/total-collateral-value.js';
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
