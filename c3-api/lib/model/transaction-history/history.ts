import * as governanceModel from '../governance.js';
import {
  TransactionHistoryItem,
  FormattedTransactionHistoryItem,
} from './item';

import { formatTransactionHistoryItem } from './item.js';

type TransactionHistoryResponse = {
  done: boolean,
  cursor: string,
  itemCount: number,
  itemLimit: number,
  items: TransactionHistoryItem[],
};

type FormattedTransactionHistoryResponse = {
  done: boolean,
  cursor: string,
  item_count: number,
  item_limit: number,
  items: FormattedTransactionHistoryItem[],
};

function formatTransactionHistoryResponse(response: TransactionHistoryResponse,
  profilesAcrossNetworks: {
    [key: string]: governanceModel.Profile;
  }): FormattedTransactionHistoryResponse {
  return {
    done: response.done,
    cursor: response.cursor,
    item_count: response.itemCount,
    item_limit: response.itemLimit,
    items: response.items.map(
      (item) => formatTransactionHistoryItem(item, profilesAcrossNetworks)
    ),
  };
}

export type {
  TransactionHistoryResponse,
  FormattedTransactionHistoryResponse
};

export {
  formatTransactionHistoryResponse,
}
