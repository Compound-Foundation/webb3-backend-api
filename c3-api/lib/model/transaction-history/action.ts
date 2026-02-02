import { BigFixnum } from '../../bigfixnum.js';
import * as Eth from '../../eth-constants.js';
import * as governanceModel from '../governance.js';

const ActionTypes = <const>({
  // rewards actions
  Claim: 'Claim',
  // market actions
  Repay:    'Repay',
  Supply:   'Supply',
  Borrow:   'Borrow',
  Seized:   'Seized',
  Transfer: 'Transfer',
  Withdraw: 'Withdraw',
  Refund:   'Refund',
  // NOTE(jordan): these actions are potentially complex and TBD
  // 'approve',   // may require us to track ERC-20 approvals, complex
});

type ActionTypes = typeof ActionTypes;
type ActionType  = ActionTypes[keyof ActionTypes];

const EventTypes = <const>({
  // rewards events
  RewardClaimed: 'RewardClaimed',
  // market events
  Supply:             'Supply',
  Transfer:           'Transfer',
  Withdraw:           'Withdraw',
  AbsorbDebt:         'AbsorbDebt',
  AbsorbCollateral:   'AbsorbCollateral',
  SupplyCollateral:   'SupplyCollateral',
  TransferCollateral: 'TransferCollateral',
  WithdrawCollateral: 'WithdrawCollateral',
  // NOTE(jordan): Approval is TBD for now
  // 'Approval',
});

type EventTypes = typeof EventTypes;
type EventType  = EventTypes[keyof EventTypes];

const ActionTypeForEventType = <const>({
  Supply:             ActionTypes.Supply,
  Transfer:           ActionTypes.Transfer,
  Withdraw:           ActionTypes.Withdraw,
  AbsorbDebt:         ActionTypes.Repay,
  RewardClaimed:      ActionTypes.Claim,
  AbsorbCollateral:   ActionTypes.Seized,
  SupplyCollateral:   ActionTypes.Supply,
  TransferCollateral: ActionTypes.Transfer,
  WithdrawCollateral: ActionTypes.Withdraw,
});

type RawTransactionHistoryAction = {
  eventType: EventType,
  contract: {
    address: Eth.Address,
  },
  amount: BigFixnum,
  token: {
    symbol: string,
    address: Eth.Address,
  },
  // Need to record account address, as account might be DefiSaver proxy or User. Not just transaction sender.
  account: {
    address: Eth.Address,
  },
  defiSaverAddress: Eth.Address,
  // Annotate if the action is part of migrator actions
  migratorAddress: Eth.Address,
};

type TransactionHistoryAction = RawTransactionHistoryAction & {
  actionType: ActionType,
};

type FormattedTransactionHistoryAction = {
  action_type: ActionType,
  event_type: EventType,
  amount: string,
  contract: {
    address: Eth.Address
  },
  token: {
    symbol: string,
    address: Eth.Address,
  },
  account: {
    address: Eth.Address,
  }, 
};

function formatTransactionHistoryAction
  (
    action: TransactionHistoryAction, 
    profilesAcrossNetworks: {
      [ key: string ]: governanceModel.Profile;
    }
  )
  : FormattedTransactionHistoryAction
{
  const lookupKey = action.account.address.toLowerCase();
  return {
    action_type: action.actionType,
    event_type:  action.eventType,
    contract:    action.contract,
    token:       action.token,
    amount:      action.amount.toString(),
    account:     profilesAcrossNetworks[lookupKey] ?? governanceModel.defaultProfile(action.account.address),
  };
}

export type {
  EventType,
  ActionType,
  TransactionHistoryAction,
  RawTransactionHistoryAction,
  FormattedTransactionHistoryAction,
};

export {
  EventTypes,
  ActionTypes,
  ActionTypeForEventType,
  formatTransactionHistoryAction,
};
