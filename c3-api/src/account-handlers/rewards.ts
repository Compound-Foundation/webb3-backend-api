import * as Eth                from '../../lib/eth-constants.js';
import * as Fallible           from '../../lib/fallible/fallible.js';
import { snakeifyCamelObject } from '../../lib/camel-snake.js';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import type { CatalogMarket } from '../registry/catalog.js';

import { unreachedMarket } from '../market.js';
import { AccountRouteData } from '../router.js';

import { Context } from './handlers.js';

import * as cometRewards        from '../../lib/computations/comet-rewards.js';
import * as accountComputations from '../../lib/computations/account.js';

/*
 * The markets whose account rewards the registry says are claimable, grouped
 * by the rewards contract that holds them.
 *
 * The grouping is not cosmetic: one Sleuth query reads the reward configs of
 * every market it is given from a single CometRewards, so markets that do not
 * share one must not be batched together. Networks without rewards used to be
 * excluded by name; the version now states it per market.
 */
function rewardGroups(
  catalog: AccountRouteData['catalog'],
  networks: KnownNetwork.Name[],
): Array<{ network: KnownNetwork.Name, contracts: CatalogMarket['comet'][] }> {
  return networks.flatMap(network => {
    const byRewards = new Map<string, CatalogMarket['comet'][]>();
    for (const entry of catalog.marketsOn(network)) {
      const rewards = entry.market.contracts.rewards;
      if (!entry.market.capabilities.accountRewards || rewards === null) {
        continue;
      }
      byRewards.set(rewards, [ ...(byRewards.get(rewards) ?? []), entry.comet ]);
    }
    return [ ...byRewards.values() ].map(contracts => ({ network, contracts }));
  });
}

async function rewardsSummary(
  { apiHost, nodeHost, nodeKey, account, catalog }: AccountRouteData,
  context: Context
): Promise<Response> {
  // every mainnet: testnets are not served, and the router refuses a request to include them
  const allNetworks = KnownNetwork.getNames();

  const evaluator = context.evaluator;

  const groups = rewardGroups(catalog, allNetworks);

  const accountRewards = await Promise.all(groups.map(async ({ network, contracts }) => {
    const rewards = await evaluator.evaluate(evaluator.pipe1([
      { ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network } },
      latestBlock => {
          const configs = { apiHost, nodeHost, nodeKey, network, block: latestBlock, cometMarkets: contracts };
          /*
           * The index the reward configurations are read on starts at the
           * earliest market of the group, so it refuses the latest block
           * only when the chain has reached none of them: each is then
           * answered as a market the chain has not reached (market.ts).
           */
          if (!cometRewards.getRewardConfigsSleuth.index.covers(configs)) {
            return evaluator.split(contracts.map(contract => evaluator.value(unreachedMarket(contract, latestBlock))));
          }
          const getRewardConfigsSleuth = Fallible.must(cometRewards.getRewardConfigsSleuth.index.project(configs));

          return evaluator.pipe1([
            { getRewardConfigsSleuth },
            rewardConfigs => {
              return evaluator.split(rewardConfigs.map((rewardConfig, index) =>{
                /*
                 * Asked before what the contract pays, which is read only
                 * where the chain has reached another market of the contract:
                 * a market it has not reached is an error either way.
                 */
                const origin = { apiHost, nodeHost, nodeKey, account, network, contract: contracts[index], block: latestBlock };
                if (!accountComputations.accountRewards.index.covers(origin)) {
                  return evaluator.value(unreachedMarket(contracts[index], latestBlock));
                }
                if (rewardConfig.rewardConfig.rewardToken === Eth.NullAddress) {
                  return evaluator.value('SKIP' as const);
                }
                const accountRewards = Fallible.must(accountComputations.accountRewards.index.project(origin));
                return evaluator.pull1({ accountRewards });
              }));
            }
          ]);
      },
    ]));

    type NotSkip = Exclude<(typeof rewards[number]), 'SKIP'>;

    return rewards
      .filter((r): r is NotSkip => r !== 'SKIP')
      // a market whose rewards could not be valued has no amounts to format
      .map((reward) => reward.status === 'error' ? reward : ({
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

export { rewardGroups, rewardsSummary };
