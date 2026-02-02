import * as Eth      from '../lib/eth-constants.js';
import * as Fallible from '../lib/fallible/fallible.js';

import * as Index from '../lib/symbolic/index.js';

import * as KnownNetwork from '../lib/well-known/networks/network.js';

import * as evm     from '../lib/computations/evm.js';
import * as market  from '../lib/computations/market.js';
import * as rewards from '../lib/computations/rewards.js';

import { snakeifyCamelObject } from '../lib/camel-snake.js';

import { Comet, StandaloneContract } from '../lib/well-known/contracts/types.js'
import { getCometContractsForNetwork } from '../lib/well-known/contracts/utils.js';

import {
  AllNetworks,
  AllContracts,
  type MarketRouteData,
  type Context               as RouterContext,
  type UninstantiatedContext as UninstantiatedRouterContext,
} from './router.js';

interface Context
  extends RouterContext
{}

type Dependencies = (
  | evm.Evm
  | market.MarketDaySummary
  | market.HistoricalMarketDaySummaries
  | market.MarketRewards
  | market.MarketMinutelySummary
  | rewards.RewardsSummary
);

async function latestSummary(
  { apiHost, nodeHost, nodeKey, network, contract, queryParams }: MarketRouteData,
  context: UninstantiatedRouterContext,
): Promise<Response> {
  const includeTestnets = queryParams.get('testnets') === 'include';
  const allNetworks = KnownNetwork.getNames({ includeTestnets });
  const selectedNetworks = network === AllNetworks ? allNetworks : [network];

  if (contract !== AllContracts && !Comet.is(contract)) {
    return new Response(
      JSON.stringify({
        error: `Invalid contract address for network`,
      }),
      { status: 400 }
    );
  }

  const networkEnv = (
    network === AllNetworks || !KnownNetwork.isNameOfTestnet(network) ? 'mainnet' : 'testnet'
  );

  const { evaluate, pipe1, pull1 } = context.instantiateEvaluator(networkEnv, {
    flags: {
      ...context.flags,
      batchingEnabled: true,
      evaluatorAlgorithm: 'workingset',
    },
  });

  const summary = await Promise.all(
    selectedNetworks.map(async (network) => {
      const selectedContracts =
        contract === AllContracts
          ? getCometContractsForNetwork(network)
          : [contract];

      if (selectedContracts.length === 0) {
        return [];
      }

      const summary = await Promise.all(
        selectedContracts.map(async (contract) =>
          evaluate(
            pipe1([
              { ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: "latest", network } },
              (latestBlock) => {
                const projected = Fallible.must(market.marketMinutelySummary.index.project(
                  { apiHost, nodeHost, nodeKey, network, contract, block: latestBlock }
                ));
                projected.block.timestamp = latestBlock.timestamp;
                return pull1({ marketMinutelySummary: projected });
              },
            ])
          )
        )
      );

      return summary.map(snakeifyCamelObject);
    })
  );

  const flattedSummary = summary.flat();

  // This keeps backwards compatibility
  if (flattedSummary.length === 1) {
    return new Response(JSON.stringify(flattedSummary[0]))
  } else {
    return new Response(JSON.stringify(flattedSummary));
  }
}

async function latestRewardsSummary(
  { apiHost, nodeHost, nodeKey, network, contract }: MarketRouteData,
  context: UninstantiatedRouterContext,
): Promise<Response> {
  if (network === AllNetworks) {
    return new Response(
      JSON.stringify({
        error: `Invalid network name for route`,
      }),
      { status: 400 }
    );
  }

  if (contract === AllContracts) {
    return new Response(
      JSON.stringify({
        error: `Invalid contract specifier for route`,
      }),
      { status: 400 }
    );
  }

  const networkEnv = (
    KnownNetwork.isNameOfTestnet(network) ? 'testnet' : 'mainnet'
  );

  const { evaluate, pipe1, pull1 } = context.instantiateEvaluator(networkEnv, {
    flags: {
      ...context.flags,
      batchingEnabled: true,
      evaluatorAlgorithm: 'workingset',
    },
  });

  /*
   * FIXME: this can still be improved by using types in MarketRouteData
   */
  const rewardsTokenPriceFeed = (
    (contract as unknown as StandaloneContract<Comet>)
    .rewards.priceFeed
  );
  const rewardsSummary = await evaluate(pipe1([
    { ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network } },
    latestBlock => {
      const projected = Fallible.must(rewards.rewardsSummary.index.project({
        apiHost,
        nodeHost,
        nodeKey,
        network,
        contract,
        rewardsTokenPriceFeed,
        block: latestBlock,
      }));
      return pull1({ rewardsSummary: projected });
    },
  ]));
  const snaked = snakeifyCamelObject(rewardsSummary);
  return new Response(JSON.stringify(snaked));
}

async function historicalSummary(
  { apiHost, nodeHost, nodeKey, network, contract, queryParams }: MarketRouteData,
  context: Context,
): Promise<Response> {
  const includeTestnets = queryParams.get('testnets') === 'include';
  const allNetworks = KnownNetwork.getNames({ includeTestnets });
  const selectedNetworks = network === AllNetworks ? allNetworks : [network];

  if (contract !== AllContracts && !Comet.is(contract)) {
    return new Response(
      JSON.stringify({
        error: `Invalid contract address for network`,
      }),
      { status: 400 }
    );
  }

  // Local testing can really hammer rpc requests when trying to
  // test locally so force to 1 day back to save on billing when testing.
  let desiredDaysBack = 30;
  if(context.flags.environment && context.flags.environment === 'local') {
    desiredDaysBack = 1;
  } else if(context.flags.environment && context.flags.environment === 'stage') {
    desiredDaysBack = 2;
  }
  const { evaluate, pull1 } = context.evaluator;

  const historicalSummary = await Promise.all(
    selectedNetworks.map(async (network) => {
      const selectedContracts =
        contract === AllContracts
          ? getCometContractsForNetwork(network)
          : [contract];

      if (selectedContracts.length === 0) {
        return [];
      }

      const latestBlock = await evaluate(
        pull1({
          ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network },
        })
      );

      const summary = await Promise.all(
        selectedContracts.map(async (contract) => {
          // compute computation context from inputs... then evaluate
          const daysLimit = Fallible.must(
            Index.DailyBlockIndex.countFromStartTo({
              network,
              contract,
              block: latestBlock,
            })
          );

          const daysBack = Math.min(daysLimit, desiredDaysBack);
          const startBlock = latestBlock;
          const { block: projectedStartBlock } = Fallible.must(
            Index.DailyBlockIndex.project({
              network,
              contract,
              block: startBlock,
            })
          );

          const historicalSummary = await evaluate(
            pull1({
              historicalMarketDaySummaries: {
                apiHost,
                nodeHost,
                nodeKey,
                network,
                contract,
                daysBack,
                startBlock: {
                  ...startBlock,
                  number: projectedStartBlock.number,
                },
              },
            })
          );

          /*
           * Backfill by presuming the 1st sample extrapolates back into the past
           * prior to the contract's creation, until we have desiredDaysBack
           * buckets of data. Manually offset the timestamp by 24hrs (in seconds)
           * for each materialized backfill datum.
           *
           * NOTE that this is a frontend-friendly optimization that only applies
           * to the 'historical summary of the last N (ie. 30) days' endpoint
           * use-case; it is correct that the computation should error when you
           * ask for more data than history permits, in the general case. It would
           * just be silly to force the frontend to recreate this extrapolation
           * logic just so it can more easily display a flat line on the market
           * summary page.
           */
          while (historicalSummary.length < desiredDaysBack) {
            const adjustedTimestamp =
              historicalSummary[0].timestamp - 60 * 60 * 24;
            historicalSummary.unshift({
              ...historicalSummary[0],
              date: Eth.Timestamp.toDateString(adjustedTimestamp),
              timestamp: adjustedTimestamp,
            });
          }

          return historicalSummary;
        })
      );

      // Eacy entry of summary is an array of historical
      // summaries for each contract. Flatten it.
      return summary.flat().map(snakeifyCamelObject);
    })
  );

  const flattedSummary = historicalSummary.flat();
  return new Response(JSON.stringify(flattedSummary));
}

async function rewardsDappData(
  { apiHost, nodeHost, nodeKey, network, contract, queryParams }: MarketRouteData,
  context: UninstantiatedRouterContext,
): Promise<Response> {
  const includeTestnets = queryParams.get('testnets') === 'include';
  const allNetworks = KnownNetwork.getNames({ includeTestnets });
  const selectedNetworks = network === AllNetworks ? allNetworks : [network];

  const networkEnv = (
    selectedNetworks.some((name) => KnownNetwork.isNameOfTestnet(name))
      ? 'testnet' // at least one selectedNetwork is a testnet
      : 'mainnet' // no selected networks are testnets
  );

  if (contract !== AllContracts && !Comet.is(contract)) {
    return new Response(
      JSON.stringify({
        error: `Invalid contract address for network`,
      }),
      { status: 400 }
    );
  }

  const evaluator = context.instantiateEvaluator(networkEnv, {
    flags: {
      ...context.flags,
      batchingEnabled: true,
      evaluatorAlgorithm: 'workingset',
    },
  });

  const marketRewards = await Promise.all(
    selectedNetworks.map(async (networkName) => {
      const selectedContracts =
        contract === AllContracts
          ? getCometContractsForNetwork(networkName)
          : [ contract ];

      if (selectedContracts.length === 0) {
        return [];
      }

      if (networkName === 'ronin-mainnet' || networkName === 'scroll-mainnet') {
      return [];
    }

      const rewards = await evaluator.evaluate(
        evaluator.split(selectedContracts.map((selectedContract) =>
          evaluator.pipe1([
            { ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network: networkName } },
            (latestBlock) => {
              const projected = Fallible.must(market.marketRewards.index.project({
                apiHost,
                nodeHost,
                nodeKey,
                block: latestBlock,
                network: networkName,
                contract: selectedContract,
              }));
              return evaluator.pull1({ marketRewards: projected })
            }
          ])
        )
      ));

      return rewards.map(snakeifyCamelObject);
    })
  );

  const flattedMarketRewards = marketRewards.flat();
  return new Response(JSON.stringify(flattedMarketRewards));
}

export type {
  Dependencies,
};

export {
  latestSummary,
  rewardsDappData,
  historicalSummary,
  latestRewardsSummary,
};
