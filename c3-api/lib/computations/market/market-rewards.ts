import * as Eth      from '../../eth-constants.js';
import * as Fallible from '../../fallible/fallible.js';

import * as Key     from '../../symbolic/key.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import {
  Comet,
  PriceFeed,
  StandaloneContract,
} from '../../well-known/contracts/types.js';

import {
  GetPrice,
  BaseBorrowMin,
} from '../comet.js';

import {
  BorrowRewardsApr,
  SupplyRewardsApr,
} from '../rewards.js';

type MarketRewards = Compute.Spec<{
  name: 'marketRewards';
  depends: [BaseBorrowMin, SupplyRewardsApr, BorrowRewardsApr, GetPrice];
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    block: Eth.Block;
    network: KnownNetwork.Name; // network on which market is deployed
    contract: Eth.Contract<StandaloneContract<Comet>>; // comet contract for the market
  };
  returns: {
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

const { implement, pipe } = Compute.Functor<MarketRewards>({});
const marketRewards = implement({
  version: 3,
  index: Index.MinutelyBlockIndex,
  key(name, { block, ...context }) {
    const { block: projected } = Fallible.must(this.index.project({ block, ...context }));
    return Key.toKey(name, { block: projected.number, ...context });
  },
  compute({ apiHost, nodeHost, nodeKey, contract, network, block }) {
    const projected = Fallible.must(this.index.project({ 
        apiHost, nodeHost, nodeKey, contract, network, block 
      }));

    // scroll-mainnet does not have a real rewards contract
    if (network === 'scroll-mainnet') {
      return pipe([
        {
          baseBorrowMin: { apiHost, nodeHost, nodeKey, contract, network, blockNumber: projected.block.number },
          supplyRewardsApr: {
            apiHost,
            nodeHost,
            nodeKey, 
            contract,
            network,
            blockNumber: projected.block.number,
            rewardsTokenPriceFeed: contract.rewards.priceFeed,
          },
          borrowRewardsApr: {
            apiHost,
            nodeHost,
            nodeKey, 
            contract,
            network,
            blockNumber: projected.block.number,
            rewardsTokenPriceFeed: contract.rewards.priceFeed,
          },
        },
        ({
          baseBorrowMin,
          supplyRewardsApr,
          borrowRewardsApr,
        }) => {
          const { chainId } = Fallible.must(
            KnownNetwork.lookup({ name: network })
          );
          const baseAssetDescription =
            (contract.base.asset.description as string | undefined) ?? null;
          const rewardAssetDescription =
            (contract.rewards.asset.description as string | undefined) ?? null;

          return {
            chainId,
            comet: {
              address: contract.address,
            },
            cometRewards: {
              address: contract.rewards.contract.address,
            },
            baseAsset: {
              address: contract.base.asset.address,
              decimals: contract.base.asset.decimals,
              description: baseAssetDescription,
              symbol: contract.base.asset.symbol,
              minBorrow: baseBorrowMin.toString(),
              priceFeed: contract.base.priceFeed.address,
            },
            rewardAsset: {
              address: contract.rewards.asset.address,
              decimals: contract.rewards.asset.decimals,
              description: rewardAssetDescription,
              price: "0.0",
              symbol: contract.rewards.asset.symbol,
            },
            earnRewardsApr: supplyRewardsApr.toString(),
            borrowRewardsApr: borrowRewardsApr.toString(),
          };
        },
      ]);
    }

    const rewardsPriceFeed: Eth.Contract<StandaloneContract<PriceFeed>> =
      Eth.wellKnownContractsByNetwork[network]['PriceFeed']['COMP-USD'];

    /*
     * Aggregate and format summary data for display.
     */
    return pipe([
      {
        baseBorrowMin: { apiHost, nodeHost, nodeKey, contract, network, blockNumber: projected.block.number },
        supplyRewardsApr: {
          apiHost,
          nodeHost,
          nodeKey, 
          contract,
          network,
          blockNumber: projected.block.number,
          rewardsTokenPriceFeed: contract.rewards.priceFeed,
        },
        borrowRewardsApr: {
          apiHost,
          nodeHost,
          nodeKey, 
          contract,
          network,
          blockNumber: projected.block.number,
          rewardsTokenPriceFeed: contract.rewards.priceFeed,
        },
        getPrice: {
          apiHost,
          nodeHost,
          nodeKey, 
          contract,
          network,
          priceFeed: rewardsPriceFeed,
          blockNumber: projected.block.number,
        },
      },
      ({
        baseBorrowMin,
        supplyRewardsApr,
        borrowRewardsApr,
        getPrice: rewardAssetPrice,
      }) => {
        const { chainId } = Fallible.must(
          KnownNetwork.lookup({ name: network })
        );
        const baseAssetDescription =
          (contract.base.asset.description as string | undefined) ?? null;
        const rewardAssetDescription =
          (contract.rewards.asset.description as string | undefined) ?? null;

        return {
          chainId,
          comet: {
            address: contract.address,
          },
          cometRewards: {
            address: contract.rewards.contract.address,
          },
          baseAsset: {
            address: contract.base.asset.address,
            decimals: contract.base.asset.decimals,
            description: baseAssetDescription,
            symbol: contract.base.asset.symbol,
            minBorrow: baseBorrowMin.toString(),
            priceFeed: contract.base.priceFeed.address,
          },
          rewardAsset: {
            address: contract.rewards.asset.address,
            decimals: contract.rewards.asset.decimals,
            description: rewardAssetDescription,
            price: rewardAssetPrice.toString(),
            symbol: contract.rewards.asset.symbol,
          },
          earnRewardsApr: supplyRewardsApr.toString(),
          borrowRewardsApr: borrowRewardsApr.toString(),
        };
      },
    ]);
  },
});

export { MarketRewards, marketRewards };
