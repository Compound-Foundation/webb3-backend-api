import { BigFixnum } from '../../bigfixnum.js';
import * as Eth      from '../../eth-constants.js';
import * as Compute  from '../../symbolic/computation.js';
import * as Constant from '../../constants.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { RegistryComet } from '../../model/comet-registry.js';

import type { GetPrice, PriceRead } from '../comet/get-price.js';
import type { BasePrice    } from '../comet/base-price.js';
import type { TotalBorrow  } from '../comet/total-borrow.js';

import type { AprRead                    } from './supply-rewards-apr.js';
import type { TotalsBasic                } from './totals-basic.js';
import type { BaseMinForRewards          } from './base-min-for-rewards.js';
import type { BorrowRewardsRatePerSecond } from './borrow-rewards-rate-per-second.js';

import { usdBasePriceFeedFor } from './base-price-feed.js';

type BorrowRewardsApr = Compute.Spec<{
  name: 'borrowRewardsApr',
  depends: [
    // comet
    GetPrice,
    BasePrice,
    TotalBorrow,
    // rewards
    TotalsBasic,
    BaseMinForRewards,
    BorrowRewardsRatePerSecond,
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

const { implement, pipe, pipe1 } = Compute.Functor<BorrowRewardsApr>({});
const borrowRewardsApr = implement({
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
        totalBorrow: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
        borrowRewardsRatePerSecond: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
      },
      ({
        totalBorrow,
        baseMinForRewards,
        borrowRewardsRatePerSecond,
        //
        getPrice: rewardsTokenPrice,
        totalsBasic: { totalBorrowBase },
      }) => pipe1([
        basePriceComputation,
        (basePrice: PriceRead): AprRead => {
          if (rewardsTokenPrice.status === 'error') {
            return rewardsTokenPrice;
          }
          if (basePrice.status === 'error') {
            return basePrice;
          }
          if (totalBorrowBase.lte(baseMinForRewards)) {
            return { status: 'success', apr: BigFixnum.from({ value: 0 }) };
          }
          const borrowValue = basePrice.price.mul(totalBorrow);
          const rewardsValueAnnual = rewardsTokenPrice.price
            .mul(borrowRewardsRatePerSecond)
            .mul(Constant.secondsPerYear);
          return { status: 'success', apr: rewardsValueAnnual.div(borrowValue) };
        },
      ])
    ]);
  }
});

export { BorrowRewardsApr, borrowRewardsApr };
