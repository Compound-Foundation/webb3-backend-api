import { Erc20Balance } from './account/erc20-balance.js';
import { EnrichTransactionHistoryItem } from './account/enrich-transaction-history-items.js';
import { RawTransactionHistoryItems } from './account/raw-transaction-history-items.js';
export type Account = (
  | Erc20Balance
  | EnrichTransactionHistoryItem
  | RawTransactionHistoryItems
);

export {
  Erc20Balance,
  erc20Balance,
} from './account/erc20-balance.js';

export {
  EnrichTransactionHistoryItem,
  enrichTransactionHistoryItem,
} from './account/enrich-transaction-history-items.js';

export {
  RawTransactionHistoryItems,
  rawTransactionHistoryItems,
} from './account/raw-transaction-history-items.js';

export {
  AccountRewards,
  accountRewards,
} from './account/account-rewards.js'; 
