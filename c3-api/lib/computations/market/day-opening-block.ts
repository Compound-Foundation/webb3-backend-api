import * as Eth     from '../../eth-constants.js';
import * as Key     from '../../symbolic/key.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { Redex }       from '../../symbolic/redex.js';
import type { EthGetBlock } from '../evm/eth-get-block.js';

/*
 * The first block of a UTC day on a network: the block at which a market's
 * history describes that day.
 *
 * The days of a history used to sit a fixed number of blocks apart, counted
 * from an average block time per network (eth-constants.ts). An average that
 * no longer holds puts every past day on the wrong block, and a cold cache
 * shows it for all of them at once: with Base's blocks 0.2 s apart rather
 * than the 2 s of its average, thirty days back from the latest block landed
 * within its last three days. So the block is found from the blocks' own
 * timestamps instead, by searching for the first one at or after the day's
 * 00:00:00 UTC.
 */
type DayOpeningBlock = Compute.Spec<{
  name: 'dayOpeningBlock';
  depends: [ EthGetBlock ];
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    network: KnownNetwork.Name;
    // the UTC day, YYYY-MM-DD, which has begun by `latestBlock`
    date: string;
    // where the search starts; it is not part of the key
    latestBlock: Eth.Block.WithTimestamp;
  };
  returns: {
    number: number;
    timestamp: number;
    date: string;
  };
}>;

type Point = { number: number; timestamp: number };

const { implement, pipe1, value } = Compute.Functor<DayOpeningBlock>({});

const SECONDS_PER_DAY = 60 * 60 * 24;

/*
 * The reads one search may make. Halving alone finds a block among 2^64 in as
 * many, and interpolation, which halving only backs up, usually needs a
 * handful.
 */
const MAX_READS = 64;

function dayStart(date: string): number {
  const milliseconds = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(milliseconds) || Eth.Timestamp.toDateString(milliseconds / 1000) !== date) {
    throw new Error(`dayOpeningBlock: not a UTC date: ${date}`);
  }
  return milliseconds / 1000;
}

/*
 * The next block to read, strictly between the bounds the reads have found:
 * `lo`, the latest block read before the day began, and `hi`, the earliest
 * read at or after it.
 *
 * Without a block before the day yet, it steps down from `hi` by the time
 * left to the day's start at `secondsPerBlock`. Between two bounds it
 * interpolates by their timestamps, or halves the range when the last
 * interpolation did not halve it, so that a chain whose block time changed
 * within the range still takes a bounded number of reads.
 */
function nextGuess(
  target: number,
  lo: Point | null,
  hi: Point,
  secondsPerBlock: number,
  halve: boolean,
): number {
  if (lo === null) {
    const blocks = Math.ceil((hi.timestamp - target) / secondsPerBlock);
    return Math.max(0, hi.number - Math.max(1, blocks));
  }
  if (halve) {
    return Math.floor((lo.number + hi.number) / 2);
  }
  const interpolated = lo.number + Math.floor(
    (target - lo.timestamp) * (hi.number - lo.number) / (hi.timestamp - lo.timestamp)
  );
  return Math.min(hi.number - 1, Math.max(lo.number + 1, interpolated));
}

const dayOpeningBlock = implement({
  version: 1,
  /*
   * A day is kept once it has ended by the latest block, when its first
   * block can no longer change; the day that is still running is searched
   * again on every request that asks for it.
   */
  index: Index.Make<DayOpeningBlock['expects']>({
    covers: ({ date, latestBlock }) => dayStart(date) <= latestBlock.timestamp,
    includes: ({ date, latestBlock }) => dayStart(date) + SECONDS_PER_DAY <= latestBlock.timestamp,
    project: context => context,
  }),
  key(name, { network, date }) {
    return Key.toKey(name, { date, network });
  },
  compute({ apiHost, nodeHost, nodeKey, network, date, latestBlock }) {
    const target = dayStart(date);
    if (latestBlock.timestamp < target) {
      throw new Error(`dayOpeningBlock: ${date} has not begun by block ${latestBlock.number} on ${network}`);
    }
    const found = ({ number, timestamp }: Point) => (
      { number, timestamp, date: Eth.Timestamp.toDateString(timestamp) }
    );
    // the average block time of the network, until two reads measure the chain's own
    const estimated = Eth.estimateSecondsTakenForBlock(network, latestBlock);

    /*
     * One read per step, until the bounds are adjacent: `hi` is then the
     * first block at or after the day's start. `previousHi` is the upper
     * bound before the last one, from which the rate below `hi` is measured
     * while no block before the day has been read; `previousWidth` is the
     * range before the last read.
     */
    const step = (
      lo: Point | null,
      hi: Point,
      previousHi: Point | null,
      previousWidth: number | null,
      reads: number,
    ): Redex<EthGetBlock, DayOpeningBlock['returns']> => {
      if ((lo !== null && hi.number - lo.number <= 1) || hi.number === 0) {
        // block 0 at or after the day's start: the chain began on the day, or after it
        return value(found(hi));
      }
      if (reads >= MAX_READS) {
        throw new Error(`dayOpeningBlock: no first block of ${date} on ${network} after ${reads} reads`);
      }
      const measured = previousHi === null ? NaN : (
        (previousHi.timestamp - hi.timestamp) / (previousHi.number - hi.number)
      );
      const secondsPerBlock = Number.isFinite(measured) && measured > 0 ? measured : estimated;
      const width = lo === null ? null : hi.number - lo.number;
      const halve = width !== null && previousWidth !== null && width > previousWidth / 2;
      const guess = nextGuess(target, lo, hi, secondsPerBlock, halve);
      return pipe1([
        { ethGetBlock: { apiHost, nodeHost, nodeKey, network, blockReference: guess } },
        block => {
          // a node that answers another block than the one asked for would never close the range
          if (block.number !== guess) {
            throw new Error(`dayOpeningBlock: asked ${network} for block ${guess}, answered block ${block.number}`);
          }
          const point = { number: block.number, timestamp: block.timestamp };
          return point.timestamp >= target
            ? step(lo, point, hi, width, reads + 1)
            : step(point, hi, previousHi, width, reads + 1);
        },
      ]);
    };

    return step(null, { number: latestBlock.number, timestamp: latestBlock.timestamp }, null, null, 0);
  },
});

export {
  DayOpeningBlock,
  dayOpeningBlock,
  nextGuess,
};
