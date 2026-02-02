import * as Eth from '../../eth-constants.js';
import { BigFixnum } from '../../bigfixnum.js';
import * as Fallible from '../../fallible/fallible.js';

import * as Index from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as cometModel from '../../model/comet.js';
import * as cometRewardsModel from '../../model/comet-rewards.js';
import { RawTransactionHistoryItem } from '../../model/transaction-history/item.js';
import { RawTransactionHistoryAction } from '../../model/transaction-history/action.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import {
  Contract,
  getTokenSymbol,
  getTokenDecimals,
  getBaseTokenAddress,
} from '../../well-known/contracts/utils.js';

import type * as evm from '../evm.js';

type RawTransactionHistoryItems = Compute.Spec<{
  name: 'rawTransactionHistoryItems',
  expects: {
    accountAddress: Eth.Address,
    proxyAddresses: Eth.Address[],
    apiHost: string,
    nodeHost: string,
    nodeKey: string,
    network: KnownNetwork.Name,
    blockNumber: Eth.BlockNumber,
    marketContracts: Contract[],
    rewardsContract: Contract,
  },
  depends: [ evm.EthGetLogs ],
  returns: RawTransactionHistoryItem[],
}>;

const {
  join,
  pull1,
  implement,
} = Compute.Functor<RawTransactionHistoryItems>({});

// Identify if the decoded log is migrator actions
function isMigratorAddress(address: Eth.Address, network: KnownNetwork.Name) {
  return address !== null
    && ('CompoundMigrator' in Eth.wellKnownContractsByNetwork[network])
    && (address.toLowerCase() in (Eth.wellKnownContractsByNetwork[network] as any)['CompoundMigrator']);
}

function createTransactionAction({
  log,
  network,
  contractAddress,
  proxyAddresses,
}: {
  log: Eth.Event.Log,
  network: KnownNetwork.Name,
  contractAddress: Eth.Address,
  proxyAddresses: Eth.Address[],
}): RawTransactionHistoryAction | null {
  const lowerCasedProxyAddresses = proxyAddresses.map(address => address.toLowerCase());
  const decoded = coders.decode(log);
  switch (decoded.name) {
    case 'Supply': {
      return {
        eventType: decoded.name,
        token: {
          address: getBaseTokenAddress(network, contractAddress),
          symbol: getTokenSymbol(network, contractAddress),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: getTokenDecimals(network, contractAddress),
        }),
        contract: {
          address: contractAddress,
        },
        // Comet process supply event and updates `dst` address balance
        account: {
          address: decoded.body.dst,
        },
        defiSaverAddress: lowerCasedProxyAddresses.find(address => address === decoded.body.from.toLowerCase() || address === decoded.body.dst.toLowerCase()) as Eth.Address ?? Eth.NullAddress,
        migratorAddress: isMigratorAddress(decoded.body.from, network) ? decoded.body.from : Eth.NullAddress,
      };
    }
    case 'SupplyCollateral': {
      return {
        eventType: decoded.name,
        token: {
          address: decoded.body.asset,
          symbol: getTokenSymbol(network, decoded.body.asset),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: getTokenDecimals(network, decoded.body.asset),
        }),
        contract: {
          address: contractAddress,
        },
        // Comet process supplyCollateral event and updates `dst` address balance
        account: {
          address: decoded.body.dst,
        },
        defiSaverAddress: lowerCasedProxyAddresses.find(address => address === decoded.body.from.toLowerCase() || address === decoded.body.dst.toLowerCase()) as Eth.Address ?? Eth.NullAddress,
        migratorAddress: isMigratorAddress(decoded.body.from, network) ? decoded.body.from : Eth.NullAddress,
      };
    }
    case 'Withdraw': {
      return {
        eventType: decoded.name,
        token: {
          address: getBaseTokenAddress(network, contractAddress),
          symbol: getTokenSymbol(network, contractAddress),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: getTokenDecimals(network, contractAddress),
        }),
        contract: {
          address: contractAddress,
        },
        // Comet process withdraw event and updates `src` address balance
        account: {
          address: decoded.body.src,
        },
        defiSaverAddress: lowerCasedProxyAddresses.find(address => address === decoded.body.src.toLowerCase() || address === decoded.body.to.toLowerCase()) as Eth.Address ?? Eth.NullAddress,
        migratorAddress: isMigratorAddress(decoded.body.to, network) ? decoded.body.to : Eth.NullAddress,
      };
    }
    case 'WithdrawCollateral': {
      return {
        eventType: decoded.name,
        token: {
          address: decoded.body.asset,
          symbol: getTokenSymbol(network, decoded.body.asset),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: getTokenDecimals(network, decoded.body.asset),
        }),
        contract: {
          address: contractAddress,
        },
        // Comet process withdrawCollateral event and updates `src` address balance
        account: {
          address: decoded.body.src,
        },
        defiSaverAddress: lowerCasedProxyAddresses.find(address => address === decoded.body.src.toLowerCase() || address === decoded.body.to.toLowerCase()) as Eth.Address ?? Eth.NullAddress,
        migratorAddress: isMigratorAddress(decoded.body.to, network) ? decoded.body.to : Eth.NullAddress,
      };
    }
    case 'Transfer': {
      // If it's just minting / burning, we don't want to show it
      if (decoded.body.from === Eth.NullAddress || decoded.body.to === Eth.NullAddress) {
        return null;
      }
      return {
        eventType: decoded.name,
        token: {
          address: getBaseTokenAddress(network, contractAddress),
          symbol: getTokenSymbol(network, contractAddress), //Base asset
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: getTokenDecimals(network, contractAddress),
        }),
        contract: {
          address: contractAddress,
        },
        account: {
          address: decoded.body.from,
        },
        defiSaverAddress: lowerCasedProxyAddresses.find(address => address === decoded.body.from.toLowerCase() || address === decoded.body.to.toLowerCase()) as Eth.Address ?? Eth.NullAddress,
        migratorAddress: Eth.NullAddress,
      };
    }
    case 'TransferCollateral': {
      return {
        eventType: decoded.name,
        token: {
          address: decoded.body.asset,
          symbol: getTokenSymbol(network, decoded.body.asset),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: getTokenDecimals(network, decoded.body.asset),
        }),
        contract: {
          address: contractAddress,
        },
        account: {
          address: decoded.body.from,
        },
        defiSaverAddress: lowerCasedProxyAddresses.find(address => address === decoded.body.from.toLowerCase() || address === decoded.body.to.toLowerCase()) as Eth.Address ?? Eth.NullAddress,
        migratorAddress: Eth.NullAddress,
      };
    }
    case 'AbsorbCollateral': {
      return {
        eventType: decoded.name,
        token: {
          address: decoded.body.asset,
          symbol: getTokenSymbol(network, decoded.body.asset),
        },
        amount: BigFixnum.from({
          value: decoded.body.collateralAbsorbed,
          decimals: getTokenDecimals(network, decoded.body.asset),
        }),
        contract: {
          address: contractAddress,
        },
        account: {
          address: decoded.body.borrower,
        },
        defiSaverAddress: Eth.NullAddress,
        migratorAddress: Eth.NullAddress,
      };
    }
    case 'AbsorbDebt': {
      return {
        eventType: decoded.name,
        token: {
          address: getBaseTokenAddress(network, contractAddress),
          symbol: getTokenSymbol(network, contractAddress),
        },
        amount: BigFixnum.from({
          value: decoded.body.basePaidOut,
          decimals: getTokenDecimals(network, contractAddress),
        }),
        contract: {
          address: contractAddress,
        },
        account: {
          address: decoded.body.borrower,
        },
        defiSaverAddress: Eth.NullAddress,
        migratorAddress: Eth.NullAddress,
      };
    }
    case 'RewardClaimed': {
      return {
        eventType: 'RewardClaimed',
        token: {
          address: decoded.body.token,
          symbol: getTokenSymbol(network, decoded.body.token),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: getTokenDecimals(network, decoded.body.token),
        }),
        contract: {
          address: contractAddress,
        },
        // RewardClaimed is calculated based on `src` address
        account: {
          address: decoded.body.src,
        },
        defiSaverAddress: lowerCasedProxyAddresses.find(address => address === decoded.body.src.toLowerCase() || address === decoded.body.recipient.toLowerCase()) as Eth.Address ?? Eth.NullAddress,
        migratorAddress: Eth.NullAddress,
      };
    }
  }
};

const rawTransactionHistoryItems = implement({
  version: 4,
  index: Index.TransactionHistoryIndex,
  compute({ 
    accountAddress,
    proxyAddresses,
    apiHost,
    nodeHost,
    nodeKey,
    network,
    blockNumber,
    marketContracts,
    rewardsContract 
  }) {
    const contracts: Contract[] = [...marketContracts, rewardsContract];
    const precedingResult = Index.TransactionHistoryIndex.preceding({
      network,
      blockNumber,
      accountAddress,
      marketContracts,
      rewardsContract,
    });
    const previousBlockNumber = (() => {
      if (Fallible.isFailure(precedingResult)) {
        // If there is no preceding result, just return the earliest creation block number of the contracts
        const earliestCreationBlockNumber = contracts.reduce((earliestCreationBlockNumber, contract) => {
          const creationBlockNumber = contract.creation.block.number;
          if (creationBlockNumber < earliestCreationBlockNumber) {
            return creationBlockNumber;
          } else {
            return earliestCreationBlockNumber;
          }
        }, Infinity);
        return earliestCreationBlockNumber;
      } else {
        return precedingResult.blockNumber;
      }
    })();

    return join([
      [
        pull1({
          ethGetLogs: {
            apiHost,
            nodeHost,
            nodeKey,
            network,
            addresses: contracts.map(contract => contract.address),
            blockRange: [ previousBlockNumber, blockNumber ],
            filter: [
              [
                coders.topics.Supply,             // [from] dst
                coders.topics.Transfer,           // [from] to
                coders.topics.Withdraw,           // [src] to
                coders.topics.RewardClaimed,      // [src] recipient
                coders.topics.SupplyCollateral,   // [from] dst
                coders.topics.TransferCollateral, // [from] to
                coders.topics.WithdrawCollateral, // [src] to
              ],
              accountAddress.toLowerCase(),
            ],
          },
        }),
        pull1({
          ethGetLogs: {
            apiHost,
            nodeHost,
            nodeKey,
            network,
            addresses: contracts.map(contract => contract.address),
            blockRange: [previousBlockNumber, blockNumber],
            filter: [
              [
                coders.topics.Supply,             // from [dst]
                coders.topics.Transfer,           // from [to]
                coders.topics.Withdraw,           // src [to]
                coders.topics.AbsorbDebt,         // absorber [borrower]
                coders.topics.RewardClaimed,      // src [recipient]
                coders.topics.AbsorbCollateral,   // absorber [borrower]
                coders.topics.SupplyCollateral,   // from [dst]
                coders.topics.TransferCollateral, // from [to]
                coders.topics.WithdrawCollateral, // src [to]
              ],
              '*',
              accountAddress.toLowerCase(),
            ],
          },
        }),
      ],
      ([ fromSrc, toDst ]) => {
        const allLogs = fromSrc.concat(toDst);
        const txLogs: { [hash: string]: Eth.Event.Log[] } = {};
        for (const log of allLogs) {
          if (!(log.transactionHash in txLogs)) {
            txLogs[log.transactionHash] = [];
          }
          const matchingLog = (
            txLogs[log.transactionHash]
              .find(({ logIndex }) => logIndex === log.logIndex)
          );
          if (!matchingLog) {
            txLogs[log.transactionHash].push(log);
          }
        }
        //
        const finalLogs = Object.values(txLogs)
          .map(byHash => byHash.sort((a, b) => {
            return parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16);
          }))
          .flat()
          .sort((a, b) => {
            return parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16);
          });
        //
        const items: RawTransactionHistoryItem[] = [];
        let prevHash = `0x0`;
        for (let i = 0; i < finalLogs.length; i++) {
          const log = finalLogs[i];
          if (!Eth.parseAddress(log.address)){
            throw new Error(`log address invalid: ${log.address}`);
          }
          const action = createTransactionAction({
            log,
            network,
            contractAddress: log.address, // log.address is contract address in string, but we know it must be an Eth.Address
            proxyAddresses,
          });
          // createTransactionAction will return null, if detected the derived action is minting / burning of cTokens
          // If action === null, we skip this action
          if (action === null) {
            continue;
          }

          if (!Eth.isTransactionHash(log.transactionHash)) {
            throw new Error(`Invariant violated: log transaction hash invalid.`);
          }
          const curHash = log.transactionHash;
          if (curHash == prevHash) {
            // Merge with previous actions
            const prevItem = items[items.length - 1];
            prevItem.actions.push(action);
          } else {
            // Push as new unit action
            items.push({
              transactionHash: log.transactionHash,
              network,
              actions: [action],
              blockNumber: parseInt(log.blockNumber, 16),
            });
          }
          prevHash = curHash;
        }
        return items;
      },
    ]);
  },
});

const coders = Eth.Event.Coder.fromSignatures([
  cometModel.events.Supply,
  cometModel.events.Transfer,
  cometModel.events.Withdraw,
  cometModel.events.SupplyCollateral,
  cometModel.events.TransferCollateral,
  cometModel.events.WithdrawCollateral,
  cometModel.events.AbsorbCollateral,
  cometModel.events.AbsorbDebt,
  cometRewardsModel.events.RewardsClaimed,
]);

export {
  RawTransactionHistoryItems,
  rawTransactionHistoryItems,
};
