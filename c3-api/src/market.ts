import * as Eth      from '../lib/eth-constants.js';
import * as Fallible from '../lib/fallible/fallible.js';

import * as Index from '../lib/symbolic/index.js';

import * as KnownNetwork from '../lib/well-known/networks/network.js';

import * as evm     from '../lib/computations/evm.js';
import * as market  from '../lib/computations/market.js';
import * as rewards from '../lib/computations/rewards.js';

import { snakeifyCamelObject } from '../lib/camel-snake.js';
import { throttle }            from '../lib/throttle.js';

import { checksumAddress, type RegistryComet } from '../lib/model/comet-registry.js';
import type { MarketIdentity } from '../lib/computations/market/market-summary.js';

import { ApiError } from './http/errors.js';
import type { Catalog } from './registry/catalog.js';
import { chainTokens, summaryHeaders, withTokenFields } from './registry/summary-tokens.js';

import {
  AllNetworks,
  AllContracts,
  type MarketRouteData,
  type Context as RouterContext,
  type MarketContext,
} from './router.js';

type Dependencies = (
  | evm.Evm
  | market.MarketDaySummary
  | market.HistoricalMarketDaySummaries
  | market.MarketRewards
  | market.MarketMinutelySummary
  | rewards.RewardsSummary
);

/*
 * The markets of one network, as the activated registry lists them.
 *
 * A market route either names one Comet, which the router already resolved
 * through the same catalog, or asks for all of them. "All" means every market
 * the version still serves, deprecated ones included: a position in a
 * deprecated market must keep reporting.
 */
function marketsOf(catalog: Catalog, network: KnownNetwork.Name): RegistryComet[] {
  return catalog.marketsOn(network).map(entry => entry.comet);
}

/*
 * The networks a market route reads: the one it names, or for every network,
 * every mainnet. Testnets are not served — the router refuses a request that
 * names one or asks to include them (testnets.ts) — so a handler here only
 * ever reads mainnets, and evaluates in the mainnet storage.
 */
function networksOf(network: MarketRouteData['network']): KnownNetwork.Name[] {
  return network === AllNetworks ? KnownNetwork.getNames() : [ network ];
}

/*
 * A market whose creation block is past the latest block of its network.
 * Every index of a market starts at its creation block, so no computation
 * can sample this one. Writing an overlay holds the block against the chain
 * (admin.ts), but a version can hold one that write never checked: an
 * overlay written before it did, inherited by an import, or a row changed in
 * the database. Validation does not read the chain, so such a version can be
 * switched on.
 *
 * A route answers the market as `error`, naming the block, the way it
 * answers a market whose price reverts, and answers the other markets as it
 * reads them. Nothing else that fails one market is answered so: it still
 * fails the route.
 */
type UnreachedMarket = MarketIdentity & { status: 'error', message: string };

function unreachedMarket(contract: RegistryComet, latestBlock: Pick<Eth.Block, 'number'>): UnreachedMarket {
  const message = `creationBlock ${contract.creation.block.number} is past the latest block, ${latestBlock.number}`;
  reportUnreached(contract, message);
  return { chainId: contract.registry.chainId, comet: { address: contract.address }, status: 'error', message };
}

/*
 * When this isolate reports each market the chain has not reached, by
 * network and Comet. Every route that lists the market answers it on every
 * request, and a line for each would bury everything else in the log: one a
 * minute per market names it for as long as it lasts, as a feed that reverts
 * is named (get-price.ts).
 */
const due = throttle(60_000);

function reportUnreached(contract: RegistryComet, message: string): void {
  if (!due(`${contract.network}:${contract.address.toLowerCase()}`)) {
    return;
  }
  console.warn(`creation block not reached: ${contract.address} on ${contract.network}: ${message}`);
}

/*
 * A market of the summary with what the active registry version says of it,
 * as /registry/v1/active serves the market: what the website keys, names and
 * lists the market by. Nothing is read for them, so every market the summary
 * answers has them, whatever its status, one the chain has not reached too.
 * They are added here, not cached with what was read: the cache keys leave
 * the labels out (catalog.ts, marketDigest), and a version that changes one
 * is answered at once. Every other route names the Comet by its address
 * alone, and only the rewards routes answer some of the rest, in fields of
 * their own: the rewards contract and the labels (market-rewards.ts).
 *
 * An address is checksummed, as the Comet's is, where the version stores it
 * lowercase. A contract or a slug the version has none of is left out, never
 * null, as the summary leaves out whatever it cannot give.
 */
function described<Summary extends MarketIdentity>({ chainId, comet, ...summary }: Summary, contract: RegistryComet) {
  const market         = contract.registry.market;
  const rewardsAddress = contract.rewards?.contract.address;
  const { bulker } = market.contracts;
  return {
    chainId,
    comet: {
      ...comet,
      ...(rewardsAddress === undefined ? {} : { rewards: rewardsAddress }),
      ...(bulker         === null      ? {} : { bulker: checksumAddress(bulker) }),
    },
    deploymentKey:   market.deploymentKey,
    displayName:     market.displayName,
    baseAssetName:   market.baseAsset.displayName,
    isWrappedNative: market.baseAsset.isWrappedNative,
    ...(market.slug === null ? {} : { slug: market.slug }),
    isDefault:       market.isDefault,
    isInstitutional: market.isInstitutional,
    ...summary,
  };
}

async function latestSummary(
  { apiHost, nodeHost, nodeKey, network, contract, catalog }: MarketRouteData,
  context: MarketContext,
): Promise<Response> {
  const selectedNetworks = networksOf(network);
  // once for every network, while their latest blocks are read
  const decisions = context.decisions();

  const { evaluate, pipe1, split, value } = context.evaluator;

  const summary = await Promise.all(
    selectedNetworks.map(async (network) => {
      const selectedContracts =
        contract === AllContracts
          ? marketsOf(catalog, network)
          : [contract];

      if (selectedContracts.length === 0) {
        return [];
      }

      /*
       * One evaluation per network, not per market. Its markets share the
       * latest block, read once, and every round of their reads reaches the
       * node as one batch: four calls to the node provider proxy per network,
       * whatever its market count. An evaluation per market made four for
       * every market, and all networks at once took 116 — each call a round
       * trip of its own, and a subrequest, of which an invocation has 10,000
       * on the Workers Paid plan stage and production run on, and 50 on the
       * Free plan (README, "Workers Plan"). The header of each market's
       * block, which dates the value of its collateral, rides in the first
       * round of its reads, once for the markets read at the same block.
       *
       * Networks stay separate evaluations: within one, the batches of
       * different networks would go to the node one after another. The
       * decisions are read meanwhile, and each collateral is decided by them
       * and by its value in its market once both are in (summary-tokens.ts).
       */
      const [ entries, read ] = await Promise.all([
        evaluate(pipe1([
          { ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: "latest", network } },
          (latestBlock) => split(selectedContracts.map((contract) => {
            const origin = { apiHost, nodeHost, nodeKey, network, contract, block: latestBlock };
            if (!market.marketMinutelySummary.index.covers(origin)) {
              return value(described(unreachedMarket(contract, latestBlock), contract));
            }
            const projected = Fallible.must(market.marketMinutelySummary.index.project(origin));
            projected.block.timestamp = latestBlock.timestamp;
            return pipe1([ { marketMinutelySummary: projected }, computed => described(computed, contract) ]);
          })),
        ])),
        decisions,
      ]);
      const tokens = chainTokens(catalog, network, selectedContracts[0]!.registry.chainId, read);

      return entries.map((entry, index) => snakeifyCamelObject(withTokenFields(entry, selectedContracts[index]!, tokens)));
    })
  );

  /*
   * A list in every form, one market's too: a network's markets are the
   * active version's, and an answer that became an object at one market
   * would change its shape with an activation.
   */
  const flattedSummary = summary.flat();
  const headers = summaryHeaders(await decisions);
  return new Response(JSON.stringify(flattedSummary), { headers });
}

async function latestRewardsSummary(
  { apiHost, nodeHost, nodeKey, network, contract }: MarketRouteData,
  context: RouterContext,
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

  const { evaluate, pipe1, pull1, value } = context.evaluator;

  /*
   * A market the version gives no rewards has no reward price to value them
   * with, and nothing stands in for the feed it lacks. The route says so, in
   * the error envelope, where the dapp-data route leaves such a market out of
   * its list.
   *
   * The feed is the one the version states for the token the market pays,
   * read from the version's description of the market as the rewards of the
   * dapp-data route read it (marketRewards), so both value the token alike.
   */
  const { capabilities, rewardAsset } = contract.registry.market;
  const rewardsTokenPriceFeed = rewardAsset?.priceFeed ?? null;
  if (!capabilities.rewards || rewardsTokenPriceFeed === null) {
    throw new ApiError('REWARDS_NOT_AVAILABLE', `Rewards are not available for this market`);
  }

  const rewardsSummary = await evaluate(pipe1([
    { ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network } },
    latestBlock => {
      const origin = { apiHost, nodeHost, nodeKey, network, contract, rewardsTokenPriceFeed, block: latestBlock };
      // this route names no market in its answer, so its error is the status alone
      if (!rewards.rewardsSummary.index.covers(origin)) {
        const { status, message } = unreachedMarket(contract, latestBlock);
        return value({ status, message });
      }
      const projected = Fallible.must(rewards.rewardsSummary.index.project(origin));
      return pull1({ rewardsSummary: projected });
    },
  ]));
  const snaked = snakeifyCamelObject(rewardsSummary);
  return new Response(JSON.stringify(snaked));
}

async function historicalSummary(
  { apiHost, nodeHost, nodeKey, network, contract, catalog }: MarketRouteData,
  context: RouterContext,
): Promise<Response> {
  const selectedNetworks = networksOf(network);

  // Local testing can really hammer rpc requests when trying to
  // test locally so force to 1 day back to save on billing when testing.
  let desiredDaysBack = 30;
  if(context.flags.environment && context.flags.environment === 'local') {
    desiredDaysBack = 1;
  } else if(context.flags.environment && context.flags.environment === 'stage') {
    desiredDaysBack = 2;
  }

  /*
   * The days of a market are one evaluation, and every round of its reads
   * reaches the node as one batch: three calls to the node provider proxy
   * per market — one more where a feed the version remaps to reverts —
   * beside one per network for its latest block. Unbatched, every read would
   * be a call of its own, thousands for a market's 30 days, and a cold
   * history of every market would run past the 10,000 subrequests an
   * invocation has (README, "Workers Plan").
   *
   * Markets stay separate evaluations, where the summary evaluates a whole
   * network as one: a batch holds the days of one market, some 1,500 reads
   * for the largest, which the node provider proxy sends on in pieces of 100.
   */
  const { evaluate, pull1 } = context.evaluator;

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
  const backfilled = (days: market.MarketDaySummary['returns'][]) => {
    while (days.length < desiredDaysBack) {
      const adjustedTimestamp =
        days[0].timestamp - 60 * 60 * 24;
      days.unshift({
        ...days[0],
        date: Eth.Timestamp.toDateString(adjustedTimestamp),
        timestamp: adjustedTimestamp,
      });
    }
    return days;
  };

  const historicalSummary = await Promise.all(
    selectedNetworks.map(async (network) => {
      const selectedContracts =
        contract === AllContracts
          ? marketsOf(catalog, network)
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
          /*
           * A market the chain has not reached has no day the index can
           * sample. It reports the day of the latest block as `error`, which
           * the backfill makes as many days as every other market reports.
           */
          if (!Index.DailyBlockIndex.covers({ network, contract, block: latestBlock })) {
            const { timestamp, date } = latestBlock;
            return backfilled([ { ...unreachedMarket(contract, latestBlock), timestamp, date } ]);
          }

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

          return backfilled(historicalSummary);
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
  { apiHost, nodeHost, nodeKey, network, contract, catalog }: MarketRouteData,
  context: RouterContext,
): Promise<Response> {
  const selectedNetworks = networksOf(network);

  const evaluator = context.evaluator;

  const marketRewards = await Promise.all(
    selectedNetworks.map(async (networkName) => {
      /*
       * Only markets whose rewards the registry says are usable. A market
       * without a reward price feed cannot be valued, which is why the whole
       * of Scroll and Ronin used to be excluded by name here; the version now
       * states it per market.
       */
      const selectedContracts = (contract === AllContracts ? marketsOf(catalog, networkName) : [ contract ])
        .filter(selected => selected.registry.market.capabilities.rewards);

      if (selectedContracts.length === 0) {
        return [];
      }

      const rewards = await evaluator.evaluate(
        evaluator.split(selectedContracts.map((selectedContract) =>
          evaluator.pipe1([
            { ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network: networkName } },
            (latestBlock) => {
              const origin = { apiHost, nodeHost, nodeKey, block: latestBlock, network: networkName, contract: selectedContract };
              if (!market.marketRewards.index.covers(origin)) {
                return evaluator.value(unreachedMarket(selectedContract, latestBlock));
              }
              const projected = Fallible.must(market.marketRewards.index.project(origin));
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
  unreachedMarket,
  historicalSummary,
  latestRewardsSummary,
};
