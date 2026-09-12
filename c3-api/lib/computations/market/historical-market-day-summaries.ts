import * as Eth      from '../../eth-constants.js';
import * as Key      from '../../symbolic/key.js';
import * as Index    from '../../symbolic/index.js';
import * as Compute  from '../../symbolic/computation.js';
import * as Fallible from '../../fallible/fallible.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import { MarketDaySummary } from './market-day-summary.js';
import { Comet, StandaloneContract } from '../../well-known/contracts/types.js';

type HistoricalMarketDaySummaries = Compute.Spec<{
  name: 'historicalMarketDaySummaries';
  depends: [ MarketDaySummary ];
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    network:    KnownNetwork.Name;
    contract:   Eth.Contract<StandaloneContract<Comet>>;
    daysBack:   number;
    startBlock: Eth.Block;
  };
  returns: MarketDaySummary['returns'][];
}>;

const {
  implement,
  join,
  pull1,
} = Compute.Functor<HistoricalMarketDaySummaries>({});

const historicalMarketDaySummaries = implement({
  version: 6,
  index: Index.Everything,
  /*
   * Key the computation by the startBlock's projection onto the daily
   * block grid, matching the block-number keying of the underlying
   * marketDaySummary. The key changes exactly when the grid gains a new
   * sample point, so a cached series is reused until there is genuinely
   * new data to compute. (Date-derived keys were retired for the same
   * reason as in marketDaySummary: a date estimate can name a date before
   * the grid has advanced into it, caching stale data under it forever.)
   */
  key(name, { startBlock, ...context }) {
    const { block, ...indexedContext } = Fallible.must(
      Index.DailyBlockIndex.project({ ...context, block: startBlock })
    );
    return Key.toKey(name, { ...indexedContext, startBlock: block.number });
  },
  /*
   * Compute `daysBack` of market-day-summaries, starting from the day
   * represented by the `startBlock` projected onto the market-day-summary
   * index (which may in fact end up being on the previous day).
   */
  compute({ apiHost, nodeHost, nodeKey, network, contract, daysBack, startBlock }) {
    const origin: MarketDaySummary['expects'] = (
      { apiHost, nodeHost, nodeKey, network, contract, block: startBlock }
    );
    /*
     * respect the timestamp, if any, provided by the input startBlock.
     */
    const originTimestamp = (
      startBlock.timestamp
      ?? Eth.estimateBlockTimestamp(network, startBlock)
    );
    /*
     * NOTE(jordan): when the contract is not yet a full day old, we run
     * into an interesting situation, because the only reasonable value
     * for daysBack is 0, and enumerate({point}, 0) will give []. Whereas
     * enumerate({point}, -1) where {point} is >= the index {start} point,
     * always gives [ {start} ]; which more likely matches the intent of
     * the caller, who wants as much data as available, and if it's 0
     * daysBack, then at least that should give data for today. This is an
     * odd translation between intent -- give me N days of data -- and a
     * reasonable response to an edge case in the way of enumerate(x, 0),
     * which is, after all, asking to enumerate 0 results. So it becomes
     * "give me N days of data, or at least 1 days anyway, so that I don't
     * just enumerate nothing."
     */
    daysBack = Math.max(daysBack, 1);
    /* Use DailyBlockIndex to enumerate 30 deterministic daily block
     * samples. If the index cannot enumerate that far back, turn the
     * Failure into an exception with Fallible.must.
     */
    const dailyBlocks = (
      Fallible.must(Index.DailyBlockIndex.enumerate(origin, -daysBack))
      /*
       * We force timestamp estimates for preceding blocks to be exactly
       * 86,400 seconds apart -- or, exactly one day -- so that historical
       * summaries will not expose any time skew errors in results. In
       * other words: we hide the underlying error from users.
       *
       * NOTE that we must estimate the timestamps before reversing the
       * result, because the start timestamp applies specifically to the
       * origin point -- the startBlock.
       */
      .map((context, index) => {
        const timestamp = originTimestamp - (60 * 60 * 24 * index);
        const date = Eth.Timestamp.toDateString(timestamp);
        return { ...context, block: { ...context.block, timestamp, date } };
      })
      /*
       * We reverse() because we are enumerating backwards, but we want
       * our results to be ordered by date.
       */
      .reverse()
    );
    /*
     * Compute market day summary at selected points, then restamp each
     * result with this enumeration's date and timestamp labels. A cached
     * marketDaySummary keeps whatever labels its first caller attached,
     * which may anchor to an older origin; restamping keeps every
     * response's labels consistent with each other (exactly one day
     * apart, anchored at the origin), so no two buckets in a series can
     * ever share a date.
     */
    return join([
      dailyBlocks.map(({ block }) => pull1({
        marketDaySummary: { apiHost, nodeHost, nodeKey, network, contract, block }
      })),
      (summaries) => summaries.map((summary, index) => ({
        ...summary,
        date: dailyBlocks[index].block.date,
        timestamp: dailyBlocks[index].block.timestamp,
      })),
    ]);
  },
});

export {
  HistoricalMarketDaySummaries,
  historicalMarketDaySummaries,
};
