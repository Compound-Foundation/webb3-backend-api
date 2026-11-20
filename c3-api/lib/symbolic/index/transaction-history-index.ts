import * as Index from '../index.js';
import * as Eth from '../../eth-constants.js';
import * as Fallible from '../../fallible/fallible.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

/*
 * The block the ranges of a group of contracts are counted from: the earliest
 * creation among them. A block is a point of the index only as counted from
 * this one, so a position kept as a block keeps its meaning only while this
 * block stays where it was.
 */
function firstBlockOf({ marketContracts, rewardsContract }: {
  marketContracts: Eth.Contract[],
  rewardsContract: Eth.Contract,
}): Eth.BlockNumber {
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
}

/*
 * The blocks one range of a network's history spans: about three to four
 * weeks, or more where a network had a larger range already. The size sets
 * what reading a history costs: a page reads a bounded number of ranges, the
 * newest range is read from the node again on every page, since it is never
 * cached, and a node refuses a range that holds too many logs.
 *
 * The sizes are written out, not computed from block times: the ranges are a
 * grid that cached ranges and cursors are kept against, while block times
 * drift. A new size moves the grid. The key of rawTransactionHistoryItems
 * names the size, so a range cached in another size is never read as one of
 * this size, and the cursors kept with the old size, which name it, are
 * ended. The block times below are as measured in October 2026, but Base's,
 * which its Denim upgrade set to 0.2 s on 2026-11-05.
 *
 * Mantle, Ronin, Unichain, Linea and Scroll serve no history yet. Their node
 * reads at most 10,000 blocks a call, so they need ranges split, or another
 * source, before they do: a first page without `markets[]` reads every
 * stream, so one whose ranges the node refuses fails the history of every
 * account.
 */
const STRIDES: { [N in KnownNetwork.Name]: number } = {
  'ethereum-mainnet': 1_000_000,  // 12 s: about 20 weeks
  'polygon-mainnet':  2_000_000,  // 1.5 s: about 5 weeks
  'arbitrum-mainnet': 10_000_000, // 0.28 s: about 5 weeks
  'optimism-mainnet': 1_000_000,  // 2 s: about 23 days
  'base-mainnet':     10_000_000, // 0.2 s since 2026-11-05: about 23 days (231 at the 2 s before)
  'mantle-mainnet':   1_000_000,  // 2 s: about 23 days
  'ronin-mainnet':    1_000_000,  // 2 s: about 23 days
  'unichain-mainnet': 2_000_000,  // 1 s: about 23 days
  'linea-mainnet':    250_000,    // 8.5 to 9.3 s: about 25 days
  'scroll-mainnet':   250_000,    // 7.7 to 8.1 s: about 23 days
  // testnets, whose history is never served
  'ethereum-sepolia': 50_000,
  'polygon-mumbai':   50_000,
  'arbitrum-goerli':  50_000,
  'optimism-goerli':  50_000,
  'base-goerli':      50_000,
  'base-sepolia':     50_000,
  'linea-goerli':     50_000,
};

function strideOf(network: KnownNetwork.Name): number {
  return STRIDES[network];
}

type TransactionHistoryContext = {
  accountAddress: Eth.Address,
  network: KnownNetwork.Name,
  blockNumber: Eth.BlockNumber,
  marketContracts: Eth.Contract[],
  rewardsContract: Eth.Contract,
};

// Index helper for getting transaction history
const TransactionHistoryIndex = Index.BlockNumberRange<TransactionHistoryContext>({
  start: firstBlockOf,
  stride: ({ network }) => strideOf(network),
});

/*
 * The block the range below the one that ends at `blockNumber` ends at, or
 * null when the range that ends there is the oldest, which starts at the
 * first block (rangeStartOf): read from the newest range down, a history is
 * read to its first block once this is null.
 */
function precedingRangeEnd(context: TransactionHistoryContext): Eth.BlockNumber | null {
  const preceding = TransactionHistoryIndex.preceding(context);
  return Fallible.isFailure(preceding) || preceding.blockNumber <= firstBlockOf(context)
    ? null
    : preceding.blockNumber;
}

/*
 * The block the range that ends at `blockNumber` starts at: the block after
 * the end of the range below it, so the block a range ends at is read by
 * that range alone, and an item there is answered once. The oldest range
 * starts at the first block itself, which no range below it reads.
 */
function rangeStartOf(context: TransactionHistoryContext): Eth.BlockNumber {
  const below = precedingRangeEnd(context);
  return below === null ? firstBlockOf(context) : below + 1;
}

export { TransactionHistoryIndex, firstBlockOf, precedingRangeEnd, rangeStartOf, strideOf };
