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

import { Contract, UntypedContract } from '../../well-known/contracts/utils.js';

import { checksumAddress } from '../../model/comet-registry.js';
import type { RegistryLookup } from '../../model/registry-lookup.js';

import type * as evm from '../evm.js';
import type { Erc20Decimals } from './erc20-decimals.js';

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
  depends: [ evm.EthGetLogs, Erc20Decimals ],
  returns: RawTransactionHistoryItem[],
}>;

const {
  join,
  pull1,
  pipe_,
  implement,
} = Compute.Functor<RawTransactionHistoryItems>({});

/*
 * The tokens an event names, as the pinned version describes them.
 *
 * An event carries an address and a raw amount; the symbol and the scale it
 * has to be read at come from the registry. A token the version does not
 * describe — a collateral a market listed, or a reward token it started
 * paying, after the version's import — is read at the decimals it reports
 * itself (erc20Decimals): its scale is what makes a raw amount a number of
 * tokens, and the 18 this used to assume made a 6-decimal token's amounts a
 * trillionth of what they were. Nothing names it until a version describes
 * it, so it is reported with its address and no symbol, rather than dropped.
 */

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

function describedDecimals(catalog: RegistryLookup, network: KnownNetwork.Name, address: Eth.Address): number | null {
  return catalog.tokenAt(network, address)?.decimals
      ?? catalog.baseTokenAt(network, address)?.decimals
      ?? null;
}

// the tokens an event names by address; the others name a market's base token by its Comet
function tokensNamedBy(decoded: ReturnType<typeof coders.decode>): Eth.Address[] {
  switch (decoded.name) {
    case 'SupplyCollateral':
    case 'WithdrawCollateral':
    case 'TransferCollateral':
    case 'AbsorbCollateral':
      return [ decoded.body.asset ];
    case 'RewardClaimed':
      return [ decoded.body.token ];
    default:
      return [];
  }
}

// a token as an ethCall reads it: only its address is called
function undescribedToken(network: KnownNetwork.Name, address: Eth.Address): Contract {
  return UntypedContract('ERC20', { network, address: checksumAddress(address) as Eth.Address, block: { number: 0 } });
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
  decoded,
  network,
  contractAddress,
  proxyAddresses,
  catalog,
  decimalsOf,
}: {
  decoded: ReturnType<typeof coders.decode>,
  network: KnownNetwork.Name,
  contractAddress: Eth.Address,
  proxyAddresses: Eth.Address[],
  catalog: RegistryLookup,
  // the scale of a token's amounts: the version's, or the one an undescribed token reports
  decimalsOf: (address: Eth.Address) => number,
}): RawTransactionHistoryAction | null {
  const lowerCasedProxyAddresses = proxyAddresses.map(address => address.toLowerCase());
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
          decimals: decimalsOf(contractAddress),
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
          decimals: decimalsOf(decoded.body.asset),
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
          decimals: decimalsOf(contractAddress),
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
          decimals: decimalsOf(decoded.body.asset),
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
          decimals: decimalsOf(contractAddress),
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
          decimals: decimalsOf(decoded.body.asset),
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
          decimals: decimalsOf(decoded.body.asset),
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
          decimals: decimalsOf(contractAddress),
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
          decimals: decimalsOf(decoded.body.token),
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
  // 7: a token the version does not describe is read at the decimals it reports, not at 18
  version: 7,
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
        const decodedLogs = finalLogs.map(log => ({ log, decoded: coders.decode(log) }));
        /*
         * The tokens the logs name that the version does not describe, each
         * read once for the decimals it reports, at the block the page ends at.
         */
        const undescribed = [ ...new Set(decodedLogs
          .flatMap(({ decoded }) => tokensNamedBy(decoded))
          .filter(address => describedDecimals(catalog, network, address) === null)
          .map(address => address.toLowerCase() as Eth.Address)) ];
        return pipe_([
          undescribed.map(address => [
            'erc20Decimals',
            { apiHost, nodeHost, nodeKey, network, blockNumber, contract: undescribedToken(network, address) },
          ] as const),
          reported => {
            const scales = new Map(undescribed.map((address, index) => [ address, reported[index] as number ]));
            const decimalsOf = (address: Eth.Address) => {
              const decimals = describedDecimals(catalog, network, address) ?? scales.get(address.toLowerCase() as Eth.Address);
              if (decimals === undefined) {
                throw new Error(`invariant violated: no scale for ${address}`);
              }
              return decimals;
            };
            //
            const items: RawTransactionHistoryItem[] = [];
            let prevHash = `0x0`;
            for (let i = 0; i < decodedLogs.length; i++) {
              const { log, decoded } = decodedLogs[i];
              if (!Eth.parseAddress(log.address)){
                throw new Error(`log address invalid: ${log.address}`);
              }
              const action = createTransactionAction({
                decoded,
                network,
                contractAddress: log.address, // log.address is contract address in string, but we know it must be an Eth.Address
                proxyAddresses,
                catalog,
                decimalsOf,
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
