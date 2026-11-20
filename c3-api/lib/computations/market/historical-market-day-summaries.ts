import * as Eth      from '../../eth-constants.js';
import * as Key      from '../../symbolic/key.js';
import * as Index    from '../../symbolic/index.js';
import * as Compute  from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { RegistryComet } from '../../model/comet-registry.js';

import type { MarketSummary }    from './market-summary.js';
import type { DayOpeningBlock }  from './day-opening-block.js';
import { MarketDaySummary } from './market-day-summary.js';

type HistoricalMarketDaySummaries = Compute.Spec<{
  name: 'historicalMarketDaySummaries';
  depends: [ MarketDaySummary, MarketSummary, DayOpeningBlock ];
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    network:    KnownNetwork.Name;
    contract:   RegistryComet;
    daysBack:   number;
    // the latest block: the last day of the history is its own
    startBlock: Eth.Block.WithTimestamp;
  };
  returns: MarketDaySummary['returns'][];
}>;

const {
  implement,
  pipe_,
  split,
  pipe1,
  pull1,
} = Compute.Functor<HistoricalMarketDaySummaries>({});

const SECONDS_PER_DAY = 60 * 60 * 24;

const historicalMarketDaySummaries: Compute.Implementation<HistoricalMarketDaySummaries> = implement({
  /*
   * 11: every past day is summarized at the first block of its UTC day, and
   * the last day at the start block, each with its block's own timestamp;
   * up to 9, days were a fixed number of blocks apart, by an average block
   * time per network, and their timestamps exactly 86,400 seconds apart. 10
   * is the version the token visibility stack gives this summary.
   */
  version: 11,
  index: Index.Everything,
  /*
   * One history per market and UTC day of the start block: a request later
   * the same day answers what the first one did.
   */
  key(name, { startBlock, ...context }) {
    const startDate = Eth.Timestamp.toDateString(startBlock.timestamp);
    return Key.toKey(name, { ...context, startDate });
  },
  /*
   * `daysBack` days, oldest first: the UTC days before the start block's,
   * each at its first block (dayOpeningBlock), then the start block's day at
   * the start block itself.
   *
   * A day that began before the market existed is left out, so a market
   * younger than `daysBack` days gets fewer, which the route backfills.
   */
  compute({ apiHost, nodeHost, nodeKey, network, contract, daysBack, startBlock }) {
    // at least today, for a market not yet a day old that is asked for 0 days
    const days = Math.max(daysBack, 1);
    const latestBlock = {
      number:    startBlock.number,
      timestamp: startBlock.timestamp,
      date:      Eth.Timestamp.toDateString(startBlock.timestamp),
    };
    const pastDates = Array.from({ length: days - 1 }, (_, index) => (
      Eth.Timestamp.toDateString(startBlock.timestamp - SECONDS_PER_DAY * (days - 1 - index))
    ));
    /*
     * The first blocks are asked for as lookups, not as redexes: the
     * working-set evaluator keys a redex's redex dependencies by their
     * position under the redex's own key, and the redex the receiver returns
     * is keyed the same way, so redexes on both levels would answer each
     * other's positions.
     */
    return pipe_([
      pastDates.map(date => (
        [ 'dayOpeningBlock', { apiHost, nodeHost, nodeKey, network, date, latestBlock } ] as const
      )),
      openings => split([
        ...openings
          .filter(block => block.number >= contract.creation.block.number)
          .map(block => pull1({
            marketDaySummary: { apiHost, nodeHost, nodeKey, network, contract, block },
          })),
        /*
         * The day still running is the market at the start block, which is
         * not kept as a day: the first block of that day, once it has ended,
         * describes it from then on.
         */
        pipe1([
          { marketSummary: { apiHost, nodeHost, nodeKey, network, contract, block: latestBlock } },
          summary => ({ ...summary, timestamp: latestBlock.timestamp, date: latestBlock.date }),
        ]),
      ]),
    ]);
  },
});

export {
  HistoricalMarketDaySummaries,
  historicalMarketDaySummaries,
};
