import { BigFixnum } from '../../bigfixnum.js';
import * as Eth      from '../../eth-constants.js';
import * as Compute  from '../../symbolic/computation.js';
import * as Constant from '../../constants.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { RegistryComet } from '../../model/comet-registry.js';

import type { GetPrice, PriceError, PriceRead } from '../comet/get-price.js';
import type { BasePrice    } from '../comet/base-price.js';
import type { TotalSupply  } from '../comet/total-supply.js';

import type { TotalsBasic                } from './totals-basic.js';
import type { BaseMinForRewards          } from './base-min-for-rewards.js';
import type { SupplyRewardsRatePerSecond } from './supply-rewards-rate-per-second.js';
import { usdBasePriceFeedFor } from './base-price-feed.js';

/*
 * A rewards rate, or why a price it is measured in could not be read.
 */
type AprRead = { status: 'success', apr: BigFixnum } | PriceError;

type SupplyRewardsApr = Compute.Spec<{
  name: 'supplyRewardsApr',
  depends: [
    // comet
    GetPrice,
    BasePrice,
    TotalSupply,
    // rewards
    TotalsBasic,
    BaseMinForRewards,
    SupplyRewardsRatePerSecond,
  ],
  expects: {
    apiHost: string,
    nodeHost: string,
    nodeKey: string,
    network: KnownNetwork.Name,
    contract: RegistryComet, // comet contract
    blockNumber: Eth.BlockNumber,
    rewardsTokenPriceFeed: {
      address:  Eth.Address,
      decimals: number,
    },
  },
  returns: AprRead;
}>;

const { implement, pipe, pipe1 } = Compute.Functor<SupplyRewardsApr>({});
const supplyRewardsApr = implement({
  // 2: a price that reverts is answered, not thrown
  version: 2,
  compute({ apiHost, nodeHost, nodeKey, rewardsTokenPriceFeed, blockNumber, contract, network }) {
    /*
     * The base price in the unit the reward feed answers in: the market's own
     * base price, or its USD feed where the reward price is in USD and the
     * market quotes its base asset.
     */
    const usdBasePriceFeed = usdBasePriceFeedFor(contract);
    const basePriceComputation: { basePrice?: any, getPrice?: any } = usdBasePriceFeed === null
      ? { basePrice: { apiHost, nodeHost, nodeKey, blockNumber, contract, network } }
      : { getPrice:  { apiHost, nodeHost, nodeKey, priceFeed: usdBasePriceFeed, blockNumber, contract, network } };

    return pipe([
      {
        totalsBasic: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
        baseMinForRewards: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
        getPrice: { apiHost, nodeHost, nodeKey, priceFeed: rewardsTokenPriceFeed, blockNumber, contract, network },
        totalSupply: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
        supplyRewardsRatePerSecond: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
      },
      ({
        totalSupply,
        baseMinForRewards,
        supplyRewardsRatePerSecond,
        //
        getPrice: rewardsTokenPrice,
        totalsBasic: { totalSupplyBase },
      }) => pipe1([
        basePriceComputation,
        (basePrice: PriceRead): AprRead => {
          if (rewardsTokenPrice.status === 'error') {
            return rewardsTokenPrice;
          }
          if (basePrice.status === 'error') {
            return basePrice;
          }
          if (totalSupplyBase.lte(baseMinForRewards)) {
            return { status: 'success', apr: BigFixnum.from({ value: 0 }) };
          }

          const supplyValue = basePrice.price.mul(totalSupply);
          const rewardsValueAnnual = rewardsTokenPrice.price
            .mul(supplyRewardsRatePerSecond)
            .mul(Constant.secondsPerYear);

          return { status: 'success', apr: rewardsValueAnnual.div(supplyValue) };
        },
      ])
    ]);
  }
});

export { AprRead, SupplyRewardsApr, supplyRewardsApr };
