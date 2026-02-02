import * as Eth      from '../../eth-constants.js';
import * as Fallible from '../../fallible/fallible.js';
import { sha256    } from '../../hash.js';
import { BigFixnum } from '../../bigfixnum.js';

import {
  ItemTypes,
  TransactionHistoryItem,
  RawTransactionHistoryItem,
} from '../../model/transaction-history/item.js';

import {
  EventTypes,
  ActionTypes,
  ActionTypeForEventType,
  TransactionHistoryAction,
  RawTransactionHistoryAction,
} from '../../model/transaction-history/action.js';

import * as Key     from '../../symbolic/key.js';
import * as Redex   from '../../symbolic/redex.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import { Comet } from '../../well-known/contracts/types.js';
import * as ContractUtils from '../../well-known/contracts/utils.js';
import * as KnownNetwork from '../../well-known/networks/network.js';

import type * as evm   from '../evm.js';
import type * as comet from '../comet.js';

type EnrichTransactionHistoryItem = Compute.Spec<{
  name: 'enrichTransactionHistoryItem',
  expects: {
    apiHost:        string,
    nodeHost:       string,
    nodeKey:        string,
    network:        KnownNetwork.Name,
    accountAddress: Eth.Address,
    item:           RawTransactionHistoryItem,
  },
  depends: [
    evm.EthGetBlock,
    comet.BalanceOf,
    comet.BorrowBalanceOf,
  ],
  returns: TransactionHistoryItem,
}>;

function isBulker(address: Eth.Address | null, network: KnownNetwork.Name) {
  return address !== null
    && ('Bulker' in Eth.wellKnownContractsByNetwork[network])
    && (address.toLowerCase() in (Eth.wellKnownContractsByNetwork[network] as any)[ 'Bulker' ]);
}

function isLiquidate(actions: RawTransactionHistoryAction[]) {
  return !!actions.find(({ eventType }) => eventType === EventTypes.AbsorbDebt)
      && !!actions.find(({ eventType }) => eventType === EventTypes.AbsorbCollateral);
}

function onlyDefiSaverActions(actions: RawTransactionHistoryAction[]) {
  return actions.every(({ defiSaverAddress }) => defiSaverAddress !== Eth.NullAddress);
}

function onlyMigratorActions(actions: RawTransactionHistoryAction[]) {
  return actions.every(({ migratorAddress }) => migratorAddress !== Eth.NullAddress);
}

const { implement, pipe1, pipe, value, join } = Compute.Functor<EnrichTransactionHistoryItem>({});

const enrichTransactionHistoryItem = implement({
  version: 5,
  index: Index.Make<EnrichTransactionHistoryItem['expects']>(Index.Everything),
  async key(name, { network, accountAddress, item }) {
    return Key.toKey(name, {
      network,
      accountAddress,
      itemHash: await sha256(Key.toKey('', item)),
    });
  },
  compute({ apiHost, nodeHost, nodeKey, network, item: rawItem }, debug) {
    return pipe1([
      {
        ethGetBlock: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          blockReference: rawItem.blockNumber,
          showTransactionDetails: true,
        },
      },
      block => join([
        rawItem.actions.map(rawAction => (
          enrichAction(
            apiHost,
            nodeHost,
            nodeKey,
            rawAction,
            { pipe, value },
            { network, block }
          )
        )),
        (enrichedActions): TransactionHistoryItem => {
          if (!Eth.Block.hasTransactionDetails(block)) {
            const message = `invariant violated: missing transaction details`;
            debug.error(message, { block });
            throw new Error(message);
          }
          const transaction = block.transactions.find(
            ({ hash }) => hash === rawItem.transactionHash
          );
          if (!transaction) {
            const message = `invariant violated: transaction not found in block`;
            debug.error(message, { block, transaction: rawItem.transactionHash });
            throw new Error(message);
          }
          const actions = enrichedActions.flat();
          const itemType = (
            (actions.length < 2)                  ? ItemTypes.Unit
            : isBulker(transaction.to, network)   ? ItemTypes.Bulk
            : isLiquidate(actions)                ? ItemTypes.Liquidation
            : ItemTypes.Multi
          );
          // If all actions are defi saver actions, then the transaction initiatedBy field will be replaced with the defi saver address
          // If all actions are migrator actions, then the transaction initiatedBy field will be replaced with the migrator address
          const initiatedBy = (
              onlyDefiSaverActions(actions) ? { address: actions[0].defiSaverAddress }
            : onlyMigratorActions(actions)  ? { address: actions[0].migratorAddress  }
            : { address: transaction.from }
          );
          return {
            itemType,
            actions,
            initiatedBy,
            timestamp:       block.timestamp,
            network:         rawItem.network,
            transactionHash: rawItem.transactionHash,
            blockNumber:     rawItem.blockNumber,
          };
        }
      ])
    ]);
  }
});

/*
 * REFACTOR?(jordan): this can be refactored into an independent
 * computation to split complexity and responsibility a little better.
 */
function enrichAction
  (
    apiHost: string,
    nodeHost: string, 
    nodeKey: string,
    rawAction: RawTransactionHistoryAction,
    { pipe, value }: Pick<Redex.Factories<EnrichTransactionHistoryItem['depends']>, 'pipe' | 'value'>,
    { network, block: { number: blockNumber } }: {
      network:        KnownNetwork.Name,
      block:          Eth.Block,
    }
  )
  : Redex.Redex<EnrichTransactionHistoryItem['depends'], TransactionHistoryAction[]>
{
  const { eventType } = rawAction;
  const contract = Fallible.must(ContractUtils.lookupInWellKnown(
    { network, address: rawAction.contract.address },
    Eth.wellKnownContractsByNetwork
  ));
  // Read balanceOf and borrowBalanceOf from the previous block
  // If read the current block the Comet state has already been updated, which is too late.
  if (eventType === EventTypes.Supply || eventType === EventTypes.Withdraw) {
    if (!Comet.is(contract)) {
      throw new Error(`invariant violated: Supply or Withdraw from non-Comet contract`);
    }
    return pipe([
      {
        balanceOf: { apiHost, nodeHost, nodeKey, network, contract, address: rawAction.account.address, blockNumber },
        borrowBalanceOf: { apiHost, nodeHost, nodeKey, network, contract, address: rawAction.account.address, blockNumber },
      },
      ({ balanceOf: supplyBalance, borrowBalanceOf: borrowBalance }) => {
        const borrowing = borrowBalance.gt(supplyBalance);
        const supplying = supplyBalance.gt(borrowBalance);
        const epsilon   = BigFixnum.from({
          value: 1,
          decimals: contract.base.asset.decimals,
        });
        // if they`re equal, then neither borrowing nor supplying is true
        switch (eventType) {
          case EventTypes.Supply: {
            // if, after a supply, you're not supplying, it was a repay
            if (!supplying)
              return [{ ...rawAction, actionType: ActionTypes.Repay }];
            // otherwise, if you're supplying, part of it may be a repay
            const netRepay = rawAction.amount.sub(supplyBalance);
            // if the netRepay is <= epsilon, it's just a supply
            if (netRepay.lte(epsilon)) {
              return [{ ...rawAction, actionType: ActionTypes.Supply }];
            }
            // but if the netRepay is > epsilon, it's both
            return [
              { ...rawAction, actionType: ActionTypes.Repay,  amount: netRepay      },
              { ...rawAction, actionType: ActionTypes.Supply, amount: supplyBalance },
            ];
          }
          case EventTypes.Withdraw: {
            // if not borrowing after a withdraw, it's just a withdraw
            if (!borrowing) {
              return [{ ...rawAction, actionType: ActionTypes.Withdraw }];
            }
            // otherwise, if you're borrowing, part of it may be withdraw
            const netWithdraw = rawAction.amount.sub(borrowBalance);
            // if the netWithdraw is <= epsilon, it's just a borrow
            if (netWithdraw.lte(epsilon)) {
              return [{ ...rawAction, actionType: ActionTypes.Borrow }];
            }
            // but if the netWithdraw is > epsilon, it's both
            return [
              { ...rawAction, actionType: ActionTypes.Withdraw, amount: netWithdraw   },
              { ...rawAction, actionType: ActionTypes.Borrow,   amount: borrowBalance },
            ];
          }
        }
      }
    ]);
  } else if (eventType === EventTypes.AbsorbDebt) {
    // AbsorbDebt need to spin additional supply as Liquidation refund if after absorb debt user position became supplying
    if (!Comet.is(contract)) {
      throw new Error(`invariant violated: Supply or Withdraw from non-Comet contract`);
    }
    return pipe([
      {
        balanceOf: { apiHost, nodeHost, nodeKey, network, contract, address: rawAction.account.address, blockNumber },
        borrowBalanceOf: { apiHost, nodeHost, nodeKey, network, contract, address: rawAction.account.address, blockNumber },
      },
      ({ balanceOf: supplyBalance, borrowBalanceOf: borrowBalance }) => {
        const supplying = supplyBalance.gt(borrowBalance);
        if (supplying) {
          return [
            { ...rawAction, actionType: ActionTypeForEventType[eventType], amount: rawAction.amount.sub(supplyBalance) }, 
            { ...rawAction, actionType: ActionTypes.Refund, eventType: EventTypes.Supply, amount: supplyBalance }
          ];
        } else {
          return [{ ...rawAction, actionType: ActionTypeForEventType[eventType] }];
        }
      }
    ]);
  } else {
    return value([{ ...rawAction, actionType: ActionTypeForEventType[eventType] }]);
  }
}

export {
  EnrichTransactionHistoryItem,
  enrichTransactionHistoryItem,
};
