import * as Eth      from '../../eth-constants.js';
import * as Key      from '../../symbolic/key.js';
import * as Index    from '../../symbolic/index.js';
import * as Compute  from '../../symbolic/computation.js';
import * as Fallible from '../../fallible/fallible.js';

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
const marketDaySummary = implement({
  version: 5,
  index: Index.DailyBlockIndex,
  /*
   * Key the computation by the materialized `date' of the block,
   * not based on the exact block number or timestamp.
   */
  key(name, context) {
    const { block, ...indexedContext } = (
      Fallible.must(this.index.project(context))
    );
    const date = (
      context.block.date
      ?? Eth.Timestamp.toDateString(
        Eth.Block.hasTimestamp(context.block)
          ? Eth.estimateBlockTimestampRelative(context.network, block, context.block)
          : Eth.estimateBlockTimestamp(context.network, block)
      )
    );
    return Key.toKey(name, { date, ...indexedContext });
  },
  /*
   * Compute a market-day-summary at the requested block.
   */
  compute(context) {
    /*
     * Project the input context onto the nearest indexed point, then
     * compute a market-summary at that block. This ensures that a
     * market-day-summary always computes the same block for the same day.
     */
    const { apiHost, nodeHost, nodeKey, network, contract, block } = (
      Fallible.must(this.index.project(context))
    );
    /*
     * NOTE: be wary of timestamp skew and possible misattributed dates.
     * These estimates will vary in accuracy by network, by contract, and
     * over time.
     *
     * NOTE that the caller is welcome to provide a custom timestamp or
     * date estimate, or both, and the market-day-summary computation will
     * not override it.
     */
    const timestamp = (
      Eth.Block.hasTimestamp(context.block)
        ? Eth.estimateBlockTimestampRelative(context.network, block, context.block)
        : Eth.estimateBlockTimestamp(context.network, block)
    );
    const date = (
      context.block.date
      ?? Eth.Timestamp.toDateString(timestamp)
    );
    return pipe1([
      { marketSummary: { apiHost, nodeHost, nodeKey, network, contract, block } },
      summary => ({ ...summary, timestamp, date }),
    ]);
  },
});

export {
  MarketDaySummary,
  marketDaySummary,
};
