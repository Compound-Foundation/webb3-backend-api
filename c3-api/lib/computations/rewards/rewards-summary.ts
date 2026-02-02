import * as Eth      from '../../eth-constants.js';
import * as Key      from '../../symbolic/key.js';
import * as Compute  from '../../symbolic/computation.js';
import * as Index    from '../../symbolic/index.js';
import * as Fallible from '../../fallible/fallible.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import { Contract } from '../../well-known/contracts/utils.js';

import type { SupplyRewardsApr } from './supply-rewards-apr.js';
import type { BorrowRewardsApr } from './borrow-rewards-apr.js';
import type { SupplyRewardsRatePerSecond } from './supply-rewards-rate-per-second.js';
import type { BorrowRewardsRatePerSecond } from './borrow-rewards-rate-per-second.js';

type RewardsSummary = Compute.Spec<{
  name: 'rewardsSummary',
  depends: [
    SupplyRewardsApr,
    BorrowRewardsApr,
    SupplyRewardsRatePerSecond,
    BorrowRewardsRatePerSecond,
  ],
  expects: {
    apiHost: string,
    nodeHost: string,
    nodeKey: string,
    block:    Eth.Block,
    contract: Contract,
    network:  KnownNetwork.Name,
    rewardsTokenPriceFeed: {
      address:  Eth.Address,
      decimals: number,
    },
  },
  returns: {
    supplyRewardsApr: string,
    borrowRewardsApr: string,
    supplyRewardsRatePerSecond: string,
    borrowRewardsRatePerSecond: string,
  },
}>;

const { implement, pipe } = Compute.Functor<RewardsSummary>({});
const rewardsSummary = implement({
  version: 2,
  /*
   * Since RewardsSummary['expects'] is just MarketDaySummary['expects']
   * but with an added rewardsTokenPriceFeed address, we can also reuse
   * the MarketDaySummary index logic for deterministically selecting one
   * block to compute for each day.
   */
  index: Index.HourlyBlockIndex,
  /*
   * Key the computation by just block number, omit the timestamp.
   * TODO(jordan): attach a `key()` function to Eth.Block.
   */
  key(name, { block, ...context }) {
    return Key.toKey(name, { block: block.number, ...context });
  },
  compute(context) {
    /*
     * Project the input context onto the nearest indexed point, then
     * compute the rewards summary at that block. This ensures that a
     * rewards summary always computes the same block for the same day.
     */
    const { apiHost, nodeHost, nodeKey, contract, network, block, rewardsTokenPriceFeed } = (
      Fallible.must(this.index.project(context))
    );
    return pipe([
      {
        supplyRewardsApr: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network, rewardsTokenPriceFeed },
        borrowRewardsApr: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network, rewardsTokenPriceFeed },
        supplyRewardsRatePerSecond: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        borrowRewardsRatePerSecond: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
      },
      ({
        supplyRewardsApr,
        borrowRewardsApr,
        supplyRewardsRatePerSecond,
        borrowRewardsRatePerSecond,
      }) => ({
        supplyRewardsApr: supplyRewardsApr.toString(),
        borrowRewardsApr: borrowRewardsApr.toString(),
        supplyRewardsRatePerSecond: supplyRewardsRatePerSecond.toString(),
        borrowRewardsRatePerSecond: borrowRewardsRatePerSecond.toString(),
      }),
    ]);
  },
});

export {
  RewardsSummary,
  rewardsSummary,
};
