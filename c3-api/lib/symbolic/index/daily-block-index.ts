import * as Eth         from '../../eth-constants.js';
import * as Perspective from '../../perspective.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import * as Index from '../index.js';

const BlockIndexOnIntervalSeconds = (intervalSeconds: number) => Index.NumericRange.on<{
  block:    Eth.Block,
  network:  KnownNetwork.Name,
  contract: Eth.Contract,
}>({
  /* the reference block number is a reasonable range maximum since we
   * project down
   */
  end:    ({ block          }) => block.number,
  start:  ({ contract       }) => contract.creation.block.number,
  stride: ({ network, block }) => {
    const estimatedBlocksPerSecond = (
      1 / Eth.estimateSecondsTakenForBlock(network, block)
    );
    return Math.round(estimatedBlocksPerSecond * intervalSeconds);
  },
  numericPerspective: Perspective.on<{ block: Eth.Block }>().make({
    reveal: ({ block: { number } }) => number,
    impose: (reference, number) => ({ ...reference, block: { number } }),
  }),
});

const DailyBlockIndex  = BlockIndexOnIntervalSeconds(60 * 60 * 24);
const HourlyBlockIndex = BlockIndexOnIntervalSeconds(60 * 60);
const MinutelyBlockIndex = BlockIndexOnIntervalSeconds(60);

export {
  DailyBlockIndex,
  HourlyBlockIndex,
  MinutelyBlockIndex,
  BlockIndexOnIntervalSeconds,
};
