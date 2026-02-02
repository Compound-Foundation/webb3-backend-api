import * as Index from '../index.js';
import * as Eth from '../../eth-constants.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

// Index helper for getting transaction history
// Hardcoded to 50k/300k blocks for mainnet/polygon-mainnet
const TransactionHistoryIndex = Index.BlockNumberRange<{
  accountAddress: Eth.Address,
  network: KnownNetwork.Name,
  blockNumber: Eth.BlockNumber,
  marketContracts: Eth.Contract[],
  rewardsContract: Eth.Contract,
}>({
  start: ({ marketContracts, rewardsContract }) => {
    const contracts = [...marketContracts, rewardsContract];
    // Find the earliest creation across all contracts
    const earliestCreation = contracts.reduce((earliest, contract) => {
      if (contract.creation.block.number < earliest.block.number) {
        return contract.creation;
      } else {
        return earliest;
      }
    }, contracts[0].creation);
    return earliestCreation.block.number;
  },
  stride: ({ network }) => {
    switch (network) {
      case 'ethereum-mainnet': return 1_000_000;
      case 'polygon-mainnet':  return 2_000_000;
      case 'arbitrum-mainnet': return 10_000_000;
      // Default to 50k blocks
      default: return 50_000;
    }
  },
});

export { TransactionHistoryIndex };
