import * as Eth      from '../../eth-constants.js';
import * as Key      from '../../symbolic/key.js';
import * as Index    from '../../symbolic/index.js';
import * as Compute  from '../../symbolic/computation.js';

import type { MarketSummary } from './market-summary.js';

type MarketDaySummary = Compute.Spec<{
  name: 'marketDaySummary',
  depends: [ MarketSummary ],
  expects: MarketSummary['expects'],
  returns: (
    & MarketSummary['returns']
    & {
        date: string,
        timestamp: Eth.Timestamp,
      }
  ),
}>;

const { implement, pipe1 } = Compute.Functor<MarketDaySummary>({});

/*
 * A day whose price read reverted is cached like any other, with its status
 * (`error` or `partially`) and no expiry: a revert is the contract's answer at
 * that block (eth-call.ts). A provider that answered one falsely would leave
 * the day so until the market's digest changes (catalog.ts, marketDigest), or
 * the versions of both this summary and marketSummary, which caches the
 * summary at that block the same way.
 */
const marketDaySummary = implement({
  /*
   * 11: a day is summarized at the block it is given, the first block of its
   * UTC day (dayOpeningBlock), and reports that block's own timestamp; up to
   * 9 the block was projected onto a grid a day's worth of blocks apart, by
   * an average block time per network, and the timestamp estimated from it.
   * 10 is the version the token visibility stack gives this summary.
   */
  version: 11,
  /*
   * Every day the market has reached is kept: the history asks for a day
   * once it has ended, at the first block of the day, which does not change.
   */
  index: Index.Make<MarketDaySummary['expects']>({
    covers: ({ contract, block }) => block.number >= contract.creation.block.number,
    includes({ contract, block }) {
      return block.number >= contract.creation.block.number;
    },
    project: context => context,
  }),
  /*
   * Key the computation by the date of the block, not by its number or
   * timestamp.
   */
  key(name, { block, ...context }) {
    return Key.toKey(name, { date: dateOf(context.network, block), ...context });
  },
  /*
   * Compute a market-day-summary at the requested block.
   */
  compute({ apiHost, nodeHost, nodeKey, network, contract, block }) {
    const timestamp = block.timestamp ?? Eth.estimateBlockTimestamp(network, block);
    const date = block.date ?? Eth.Timestamp.toDateString(timestamp);
    return pipe1([
      { marketSummary: { apiHost, nodeHost, nodeKey, network, contract, block } },
      summary => ({ ...summary, timestamp, date }),
    ]);
  },
});

/*
 * The date of a block: the one it carries, or that of its timestamp, which a
 * block without one has estimated from the network's average block time.
 */
function dateOf(network: MarketDaySummary['expects']['network'], block: Eth.Block): string {
  return block.date ?? Eth.Timestamp.toDateString(
    block.timestamp ?? Eth.estimateBlockTimestamp(network, block)
  );
}

export {
  MarketDaySummary,
  marketDaySummary,
};
