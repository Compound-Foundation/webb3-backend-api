import * as Eth      from '../../eth-constants.js';
import * as Fallible from '../../fallible/fallible.js';

import { BigFixnum } from '../../bigfixnum.js';

import type { RegistryComet } from '../../model/comet-registry.js';

import * as Key     from '../../symbolic/key.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import {
  GetPrice,
  BaseBorrowMin,
  BaseUsdPrice,
  type PriceError,
  type PriceRead,
} from '../comet.js';

import type { MarketIdentity } from './market-summary.js';

import {
  BorrowRewardsApr,
  SupplyRewardsApr,
} from '../rewards.js';
import { convertsRewardPriceToUsd } from '../rewards/base-price-feed.js';

type MarketRewards = Compute.Spec<{
  name: 'marketRewards';
  depends: [BaseBorrowMin, SupplyRewardsApr, BorrowRewardsApr, GetPrice, BaseUsdPrice];
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    block: Eth.Block;
    network: KnownNetwork.Name; // network on which market is deployed
    contract: RegistryComet; // comet contract for the market
  };
  // a price the rewards are valued in that reverts leaves only what identifies the market
  returns: MarketIdentity & PriceError | {
    status: 'success';
    chainId: number;
    comet: {
      address: Eth.Address;
    };
    cometRewards: {
      address: Eth.Address;
    };
    baseAsset: {
      address: string;
      decimals: number;
      description: string | null;
      symbol: string;
      minBorrow: string;
      priceFeed: string;
    };
    rewardAsset: {
      address: string;
      decimals: number;
      description: string | null;
      price: string;
      symbol: string;
    };
    earnRewardsApr: string;
    borrowRewardsApr: string;
  };
}>;

/*
 * The base asset of a market as its reviewed decisions name it, not as its
 * token reports itself on chain. Tokens get renamed — Tether's USDT is USD₮0
 * on Arbitrum and USDT0 on Polygon — and bridged USDC calls itself plain USDC
 * beside the native market of the same network, so the on-chain symbol would
 * give two markets of one network the same label.
 */
function baseAssetLabel(contract: RegistryComet): { symbol: string, description: string } {
  const market = contract.registry.market;
  return {
    symbol:      market.displayName,
    description: market.baseAsset.displayName,
  };
}

const { implement, pipe } = Compute.Functor<MarketRewards>({});
const marketRewards = implement({
  // 5: a price that reverts is reported as the market's status
  version: 5,
  index: Index.MinutelyBlockIndex,
  key(name, { block, ...context }) {
    const { block: projected } = Fallible.must(this.index.project({ block, ...context }));
    // the summary reports the market's labels, which its contract's key leaves out
    const { symbol, description } = baseAssetLabel(context.contract);
    return Key.toKey(name, { block: projected.number, label: `${symbol}|${description}`, ...context });
  },
  compute({ apiHost, nodeHost, nodeKey, contract, network, block }) {
    const projected = Fallible.must(this.index.project({
        apiHost, nodeHost, nodeKey, contract, network, block
      }));
    const blockNumber = projected.block.number;
    const { chainId } = Fallible.must(
      KnownNetwork.lookup({ name: network })
    );

    const market      = contract.registry.market;
    const rewardAsset = market.rewardAsset;

    /*
     * The token the market pays and the contract that pays it. A market the
     * rewards are valued for has both: the routes ask only about markets
     * whose rewards or account rewards are served, and a version serves
     * neither without a reward token, which only a rewards contract names.
     */
    const rewards = contract.rewards;
    if (rewards?.asset === undefined) {
      throw new Error(`invariant violated: ${contract.address} pays no reward token`);
    }
    const rewardToken = rewards.asset;

    /*
     * The feed that prices the reward token, as the registry states it. A
     * market without one — Scroll, which has no COMP feed — is reported with
     * no reward price and no reward rate rather than by name. A reward price
     * its feed states in the market's base asset is converted to USD, so every
     * market reports its reward price in the same unit (base-price-feed.ts).
     */
    const rewardPriceFeed = rewardAsset?.priceFeed ?? null;
    const convertsToUsd   = convertsRewardPriceToUsd(contract);

    const baseBorrowMin = { apiHost, nodeHost, nodeKey, contract, network, blockNumber };

    /*
     * Aggregate and format summary data for display.
     */
    const summary = (
      { baseBorrowMin, supplyRewardsApr, borrowRewardsApr }: {
        baseBorrowMin:    BigFixnum,
        supplyRewardsApr: BigFixnum,
        borrowRewardsApr: BigFixnum,
      },
      rewardAssetPrice: string,
    ): MarketRewards['returns'] => {
      const baseAsset = baseAssetLabel(contract);
      const rewardAssetDescription =
        (rewardToken.description as string | undefined) ?? null;

      return {
        status: 'success',
        chainId,
        comet: {
          address: contract.address,
        },
        cometRewards: {
          address: rewards.contract.address,
        },
        baseAsset: {
          address: contract.base.asset.address,
          decimals: contract.base.asset.decimals,
          description: baseAsset.description,
          symbol: baseAsset.symbol,
          minBorrow: baseBorrowMin.toString(),
          priceFeed: contract.base.priceFeed.address,
        },
        rewardAsset: {
          address: rewardToken.address,
          decimals: rewardToken.decimals,
          description: rewardAssetDescription,
          price: rewardAssetPrice,
          symbol: rewardToken.symbol,
        },
        earnRewardsApr: supplyRewardsApr.toString(),
        borrowRewardsApr: borrowRewardsApr.toString(),
      };
    };

    /*
     * Without a feed there is nothing to value the rewards in, and nothing
     * for the APR computations to read. Only the minimum borrow is read; the
     * rates are zero.
     */
    if (rewardPriceFeed === null) {
      const none = BigFixnum.from({ value: 0 });
      return pipe([
        { baseBorrowMin },
        ({ baseBorrowMin }) => summary({ baseBorrowMin, supplyRewardsApr: none, borrowRewardsApr: none }, '0.0'),
      ]);
    }

    const apr = { apiHost, nodeHost, nodeKey, contract, network, blockNumber, rewardsTokenPriceFeed: rewardPriceFeed };
    const reads = {
      baseBorrowMin,
      supplyRewardsApr: apr,
      borrowRewardsApr: apr,
      getPrice: {
        apiHost,
        nodeHost,
        nodeKey,
        contract,
        network,
        priceFeed: rewardPriceFeed,
        blockNumber,
      },
    };

    /*
     * The first price that reverts is the market's answer, in the order the
     * rewards are valued: the reward price, the rates measured with it, and
     * the USD price that converts it.
     */
    const reported = (
      { getPrice: rewardAssetPrice, baseBorrowMin, supplyRewardsApr, borrowRewardsApr }: {
        getPrice:         PriceRead,
        baseBorrowMin:    BigFixnum,
        supplyRewardsApr: SupplyRewardsApr['returns'],
        borrowRewardsApr: BorrowRewardsApr['returns'],
      },
      baseAssetUsdPrice: PriceRead | null,
    ): MarketRewards['returns'] => {
      const failure = ({ status, message }: PriceError): MarketRewards['returns'] => (
        { chainId, comet: { address: contract.address }, status, message }
      );
      if (rewardAssetPrice.status === 'error') {
        return failure(rewardAssetPrice);
      }
      if (supplyRewardsApr.status === 'error') {
        return failure(supplyRewardsApr);
      }
      if (borrowRewardsApr.status === 'error') {
        return failure(borrowRewardsApr);
      }
      const results = { baseBorrowMin, supplyRewardsApr: supplyRewardsApr.apr, borrowRewardsApr: borrowRewardsApr.apr };
      if (baseAssetUsdPrice === null) {
        return summary(results, rewardAssetPrice.price.toString());
      }
      return baseAssetUsdPrice.status === 'error'
        ? failure(baseAssetUsdPrice)
        : summary(results, rewardAssetPrice.price.mul(baseAssetUsdPrice.price).toString());
    };

    /*
     * The USD price that converts the reward price is read beside the rest,
     * not once both rates are in: a round of its own would hold up every
     * market of its network, which are read together.
     */
    if (!convertsToUsd) {
      return pipe([ reads, results => reported(results, null) ]);
    }
    return pipe([
      { ...reads, baseUsdPrice: { apiHost, nodeHost, nodeKey, contract, network, blockNumber } },
      ({ baseUsdPrice, ...results }) => reported(results, baseUsdPrice),
    ]);
  },
});

export { MarketRewards, baseAssetLabel, marketRewards };
