import * as Eth                from '../../lib/eth-constants.js';
import * as Fallible           from '../../lib/fallible/fallible.js';
import { snakeifyCamelObject } from '../../lib/camel-snake.js';
import { throttle }            from '../../lib/throttle.js';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import type { MarketIdentity } from '../../lib/computations/market/market-summary.js';
import type { PriceError } from '../../lib/computations/comet/get-price.js';
import { normalizeAddress } from '../../lib/model/comet-registry.js';
import type { RegistryComet } from '../../lib/model/comet-registry.js';

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

/*
 * Whether an account's rewards in a market are read, from the token its
 * rewards contract pays now and the one the registry version describes:
 *
 * - `none`: the contract pays nothing for the market, so nothing is owed or
 *   can be claimed there, and the market is left out, as it always was;
 * - `read`: it pays the token the version describes, which the amounts are
 *   read, scaled, priced and labelled as;
 * - otherwise it pays another token. A version imported from this contract
 *   cannot get here — CometRewards sets a market's token once
 *   (`AlreadyConfigured`), and the import reads it there — but the check
 *   stays, because an amount of one token scaled and priced as another would
 *   be a wrong number. The market is answered in the error envelope of a
 *   market whose rewards cannot be valued, until a version describes what it
 *   pays.
 */
type RewardsInclusion = 'none' | 'read' | MarketIdentity & PriceError;

function rewardsInclusion(comet: RegistryComet, paid: Eth.Address): RewardsInclusion {
  if (paid === Eth.NullAddress) {
    return 'none';
  }
  const described = comet.registry.market.rewardAsset?.token;
  if (described === undefined) {
    // validation gives a reward token to every market whose account rewards are served
    throw new Error(`invariant violated: ${comet.address} pays no reward token`);
  }
  if (normalizeAddress(paid) === described.address) {
    return 'read';
  }
  reportMismatch(comet, paid);
  return {
    chainId: comet.registry.chainId,
    comet:   { address: comet.address },
    status:  'error',
    message: `the rewards contract pays ${paid}, not the ${described.symbol} the registry version describes`,
  };
}

/*
 * When this isolate reports each market whose rewards contract pays another
 * token than the version describes. That never happens to a version imported
 * from the contract, so the line says the version was not built from it; the
 * chain drift check does not read reward tokens, so the line is what tells an
 * operator to import the market again. Once a minute per market names it for
 * as long as it lasts, as a feed that reverts is named (get-price.ts).
 */
const due = throttle(60_000);

function reportMismatch(comet: RegistryComet, paid: Eth.Address): void {
  if (!due(`${comet.network}:${comet.address.toLowerCase()}`)) {
    return;
  }
  console.warn(`reward token differs from the registry: ${comet.address} on ${comet.network} pays ${paid}, the version describes ${comet.registry.market.rewardAsset?.token.address}`);
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
                const inclusion = rewardsInclusion(contracts[index]!, rewardConfig.rewardConfig.rewardToken);
                if (inclusion === 'none') {
                  return evaluator.value('SKIP' as const);
                }
                if (inclusion !== 'read') {
                  return evaluator.value(inclusion);
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

export { rewardGroups, rewardsInclusion, rewardsSummary };
