import * as Eth from '../../eth-constants.js';
import { BigFixnum } from '../../bigfixnum.js';
import * as Fallible from '../../fallible/fallible.js';

import * as Index from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';
import * as Key from '../../symbolic/key.js';

import * as cometModel from '../../model/comet.js';
import * as cometRewardsModel from '../../model/comet-rewards.js';
import { RawTransactionHistoryItem } from '../../model/transaction-history/item.js';
import { RawTransactionHistoryAction } from '../../model/transaction-history/action.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import { Contract } from '../../well-known/contracts/utils.js';

import { checksumAddress } from '../../model/comet-registry.js';
import type { RegistryLookup } from '../../model/registry-lookup.js';

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
    // the one registry version this request resolves tokens against
    catalog: RegistryLookup,
  },
  depends: [ evm.EthGetLogs ],
  returns: RawTransactionHistoryItem[],
}>;

const {
  join,
  pull1,
  implement,
} = Compute.Functor<RawTransactionHistoryItems>({});

/*
 * The tokens an event names, as the pinned version describes them.
 *
 * An event carries an address and a raw amount; the symbol and the scale it
 * has to be read at come from the registry. A token no version describes — an
 * asset of a market outside the registry, or one added on chain but not yet
 * imported — keeps the defaults this code has always used, so an unknown
 * token is reported rather than dropped.
 */
const UNKNOWN_DECIMALS = 18;

/*
 * A token's own symbol can be the same as another's, or one its issuer has
 * since renamed: bridged USDC calls itself USDC beside native USDC. Where the
 * network's presentation renames it, history says what the website says.
 */
function tokenSymbol(catalog: RegistryLookup, network: KnownNetwork.Name, address: Eth.Address): string {
  const token = catalog.tokenAt(network, address) ?? catalog.baseTokenAt(network, address);
  if (token === null) {
    return '';
  }
  return catalog.renamedSymbolAt(network, token.address) ?? token.symbol;
}

function tokenDecimals(catalog: RegistryLookup, network: KnownNetwork.Name, address: Eth.Address): number {
  return catalog.tokenAt(network, address)?.decimals
      ?? catalog.baseTokenAt(network, address)?.decimals
      ?? UNKNOWN_DECIMALS;
}

/*
 * Checksummed, as the addresses a decoded log carries are: one history page
 * must not name some tokens in one form and some in another.
 */
function baseTokenAddress(catalog: RegistryLookup, network: KnownNetwork.Name, address: Eth.Address): Eth.Address {
  const token = catalog.baseTokenAt(network, address);
  return token === null ? '0x0' : checksumAddress(token.address) as Eth.Address;
}

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
  catalog,
}: {
  log: Eth.Event.Log,
  network: KnownNetwork.Name,
  contractAddress: Eth.Address,
  proxyAddresses: Eth.Address[],
  catalog: RegistryLookup,
}): RawTransactionHistoryAction | null {
  const lowerCasedProxyAddresses = proxyAddresses.map(address => address.toLowerCase());
  const decoded = coders.decode(log);
  switch (decoded.name) {
    case 'Supply': {
      return {
        eventType: decoded.name,
        token: {
          address: baseTokenAddress(catalog, network, contractAddress),
          symbol: tokenSymbol(catalog, network, contractAddress),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: tokenDecimals(catalog, network, contractAddress),
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
          symbol: tokenSymbol(catalog, network, decoded.body.asset),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: tokenDecimals(catalog, network, decoded.body.asset),
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
          address: baseTokenAddress(catalog, network, contractAddress),
          symbol: tokenSymbol(catalog, network, contractAddress),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: tokenDecimals(catalog, network, contractAddress),
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
          symbol: tokenSymbol(catalog, network, decoded.body.asset),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: tokenDecimals(catalog, network, decoded.body.asset),
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
          address: baseTokenAddress(catalog, network, contractAddress),
          symbol: tokenSymbol(catalog, network, contractAddress), //Base asset
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: tokenDecimals(catalog, network, contractAddress),
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
          symbol: tokenSymbol(catalog, network, decoded.body.asset),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: tokenDecimals(catalog, network, decoded.body.asset),
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
          symbol: tokenSymbol(catalog, network, decoded.body.asset),
        },
        amount: BigFixnum.from({
          value: decoded.body.collateralAbsorbed,
          decimals: tokenDecimals(catalog, network, decoded.body.asset),
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
          address: baseTokenAddress(catalog, network, contractAddress),
          symbol: tokenSymbol(catalog, network, contractAddress),
        },
        amount: BigFixnum.from({
          value: decoded.body.basePaidOut,
          decimals: tokenDecimals(catalog, network, contractAddress),
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
          symbol: tokenSymbol(catalog, network, decoded.body.token),
        },
        amount: BigFixnum.from({
          value: decoded.body.amount,
          decimals: tokenDecimals(catalog, network, decoded.body.token),
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
  // 6: keyed by what history reads, so a change to a feed or an exception keeps the items
  version: 6,
  index: Index.TransactionHistoryIndex,
  /*
   * The items read one network's markets and tokens, so a change elsewhere
   * keeps them. The contracts are named by address: their creation blocks
   * are in the network's history key, and a market's own cache key also
   * covers its feeds and exceptions, which no item reads.
   */
  key(name, { catalog, marketContracts, rewardsContract, ...context }) {
    return Key.toKey(name, {
      ...context,
      marketContracts: marketContracts.map(contract => contract.address.toLowerCase()),
      rewardsContract: rewardsContract.address.toLowerCase(),
      registry:        catalog.historyKeyFor(context.network),
    });
  },
  compute({ 
    accountAddress,
    proxyAddresses,
    apiHost,
    nodeHost,
    nodeKey,
    network,
    blockNumber,
    marketContracts,
    rewardsContract,
    catalog,
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
            catalog,
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
  tokenSymbol,
};
