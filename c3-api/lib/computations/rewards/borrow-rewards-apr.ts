import * as Eth     from '../../eth-constants.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { RegistryComet } from '../../model/comet-registry.js';

import type { GetPrice     } from '../comet/get-price.js';
import type { BasePrice    } from '../comet/base-price.js';
import type { BaseUsdPrice } from '../comet/base-usd-price.js';
import type { TotalBorrow  } from '../comet/total-borrow.js';

import type { TotalsBasic                } from './totals-basic.js';
import type { BaseMinForRewards          } from './base-min-for-rewards.js';
import type { BorrowRewardsRatePerSecond } from './borrow-rewards-rate-per-second.js';

import { type AprRead, basePriceLookup, basePriceOf, rewardsAprOf } from './rewards-apr.js';

type BorrowRewardsApr = Compute.Spec<{
  name: 'borrowRewardsApr',
  depends: [
    // comet
    GetPrice,
    BasePrice,
    BaseUsdPrice,
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

const { implement, pipe } = Compute.Functor<BorrowRewardsApr>({});
const borrowRewardsApr = implement({
  // 4: where the feed the registry version names reverts, the base price is read from the one the Comet names
  version: 4,
  compute({ apiHost, nodeHost, nodeKey, rewardsTokenPriceFeed, blockNumber, contract, network }) {
    const frame = { apiHost, nodeHost, nodeKey, blockNumber, contract, network };
    return pipe([
      {
        totalsBasic: frame,
        baseMinForRewards: frame,
        getPrice: { ...frame, priceFeed: rewardsTokenPriceFeed },
        ...basePriceLookup(frame),
        totalBorrow: frame,
        borrowRewardsRatePerSecond: frame,
      },
      reads => rewardsAprOf({
        rewardPrice:   reads.getPrice,
        basePrice:     basePriceOf(reads),
        principal:     reads.totalsBasic.totalBorrowBase,
        total:         reads.totalBorrow,
        baseMin:       reads.baseMinForRewards,
        ratePerSecond: reads.borrowRewardsRatePerSecond,
      }),
    ]);
  }
});

export { BorrowRewardsApr, borrowRewardsApr };
