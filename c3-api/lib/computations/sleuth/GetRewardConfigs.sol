// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

interface CometRewards {
  struct RewardConfig {
    address token;
    uint64 rescaleFactor;
    bool shouldUpscale;
  }

  function rewardConfig(address comet) external view returns (RewardConfig memory);
}

contract GetRewardConfigs {
    
  function query(CometRewards rewardsContract, address[] memory cometMarkets) public view returns (CometRewards.RewardConfig[] memory) {
    uint numCometMarkets = cometMarkets.length;

    CometRewards.RewardConfig[] memory rewardConfigs = new CometRewards.RewardConfig[](numCometMarkets);
    for (uint8 i = 0; i < numCometMarkets; i++) {
      rewardConfigs[i] = rewardsContract.rewardConfig(cometMarkets[i]);
    }
    return rewardConfigs;
  }
}