import * as Eth      from '../../eth-constants.js';
import * as Fallible from '../../fallible/fallible.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import * as governanceModel from '../governance.js';

import { formatTransactionHistoryAction } from './action.js';
import {
  TransactionHistoryAction,
  RawTransactionHistoryAction,
  FormattedTransactionHistoryAction,
} from './action.js';

const ItemTypes = <const>({
  Unit:           'Unit',
  Bulk:           'Bulk',
  Multi:          'Multi',
  Liquidation:    'Liquidation',
  RepaySupply:    'RepaySupply',
  WithdrawBorrow: 'WithdrawBorrow',
  Migrator:       'Migrator',
});

type ItemType = typeof ItemTypes[keyof typeof ItemTypes];

type RawTransactionHistoryItem = {
  network:         KnownNetwork.Name,
  blockNumber:     number,
  transactionHash: Eth.TransactionHash,
  actions:         RawTransactionHistoryAction[],
};

type TransactionHistoryItem =
  RawTransactionHistoryItem &
{
  itemType:  ItemType,
  actions:   TransactionHistoryAction[],
  timestamp: number,
  initiatedBy: {
    address: Eth.Address
  },
};

type FormattedTransactionHistoryItem = {
  item_type: ItemType,
  timestamp: number,
  transaction_hash: string,
  actions: FormattedTransactionHistoryAction[],
  network: {
    chain_id: number,
    alias: string,
  },
  initiated_by: governanceModel.Profile,
};

function formatTransactionHistoryItem(
  item: TransactionHistoryItem,
  profilesAcrossNetworks: {
    [key: string]: governanceModel.Profile;
  },
): FormattedTransactionHistoryItem {
  const lookupKey = item.initiatedBy.address.toLowerCase();
  return {
    transaction_hash: item.transactionHash,
    timestamp: item.timestamp,
    network: {
      chain_id: Fallible.must(KnownNetwork.lookup({ name: item.network })).chainId,
      alias: item.network,
    },
    initiated_by: profilesAcrossNetworks[lookupKey] ?? governanceModel.defaultProfile(item.initiatedBy.address),
    item_type: item.itemType,
    actions: item.actions.map((a: TransactionHistoryAction) => formatTransactionHistoryAction(a, profilesAcrossNetworks)),
  };
}

export type {
  ItemType,
  TransactionHistoryItem,
  RawTransactionHistoryItem,
  FormattedTransactionHistoryItem,
};

export {
  ItemTypes,
  formatTransactionHistoryItem,
}
