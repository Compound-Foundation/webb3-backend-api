import * as Eth                from '../../lib/eth-constants.js';
import * as Fallible           from '../../lib/fallible/fallible.js';
import { snakeifyCamelObject } from '../../lib/camel-snake.js';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';
import { getCometContractsForNetwork } from '../../lib/well-known/contracts/utils.js';

import { AccountRouteData } from '../router.js';

import { Context } from './handlers.js';

import * as cometRewards        from '../../lib/computations/comet-rewards.js';
import * as accountComputations from '../../lib/computations/account.js';

async function rewardsSummary(
  { apiHost, nodeHost, nodeKey, account, testnets }: AccountRouteData,
  context: Context
): Promise<Response> {
  const allNetworks = KnownNetwork.getNames({
    includeTestnets: testnets === 'include',
  });

  const evaluator = context.evaluator;

  const accountRewards = await Promise.all(allNetworks.map(async (network) => {
    const contracts = getCometContractsForNetwork(network);

    if (contracts.length === 0) {
      return [];
    }

    if (network === 'ronin-mainnet' || network === 'scroll-mainnet') {
      return [];
    }

    const rewards = await evaluator.evaluate(evaluator.pipe1([
      { ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network } },
      latestBlock => {

          const getRewardConfigsSleuth = Fallible.must(cometRewards.getRewardConfigsSleuth.index.project({
            apiHost,
            nodeHost,
            nodeKey, 
            network,            
            block: latestBlock,
            cometMarkets: contracts
          }));

          return evaluator.pipe1([
            { getRewardConfigsSleuth },
            rewardConfigs => {
              return evaluator.split(rewardConfigs.map((rewardConfig, index) =>{
                if (rewardConfig.rewardConfig.rewardToken === Eth.NullAddress) {
                  return evaluator.value('SKIP' as const);
                }
                const accountRewards = Fallible.must(accountComputations.accountRewards.index.project({
                  apiHost,
                  nodeHost,
                  nodeKey,
                  account,
                  network,
                  contract: contracts[index],
                  block: latestBlock,
                }));
                return evaluator.pull1({ accountRewards });
              }));
            }
          ]);
      },
    ]));

    type NotSkip = Exclude<(typeof rewards[number]), 'SKIP'>;

    return rewards
      .filter((r): r is NotSkip => r !== 'SKIP')
      .map((reward) => ({
        ...reward,
        amountOwed: reward.amountOwed.toString(),
        walletBalance: reward.walletBalance.toString(),
        supplyBalance: reward.supplyBalance.toString(),
        borrowBalance: reward.borrowBalance.toString(),
      }))
      .map(snakeifyCamelObject);
  }));

  const flattedAccountRewards = accountRewards.flat();
  return new Response(JSON.stringify(flattedAccountRewards));
}

export { rewardsSummary };
