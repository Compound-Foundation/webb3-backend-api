import * as Eth     from '../../eth-constants.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { RegistryComet } from '../../model/comet-registry.js';

import type { GetPrice     } from '../comet/get-price.js';
import type { BasePrice    } from '../comet/base-price.js';
import type { BaseUsdPrice } from '../comet/base-usd-price.js';
import type { TotalSupply  } from '../comet/total-supply.js';

import type { TotalsBasic                } from './totals-basic.js';
import type { BaseMinForRewards          } from './base-min-for-rewards.js';
import type { SupplyRewardsRatePerSecond } from './supply-rewards-rate-per-second.js';

import { type AprRead, basePriceLookup, basePriceOf, rewardsAprOf } from './rewards-apr.js';

type SupplyRewardsApr = Compute.Spec<{
  name: 'supplyRewardsApr',
  depends: [
    // comet
    GetPrice,
    BasePrice,
    BaseUsdPrice,
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

const { implement, pipe } = Compute.Functor<SupplyRewardsApr>({});
const supplyRewardsApr = implement({
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
        totalSupply: frame,
        supplyRewardsRatePerSecond: frame,
      },
      reads => rewardsAprOf({
        rewardPrice:   reads.getPrice,
        basePrice:     basePriceOf(reads),
        principal:     reads.totalsBasic.totalSupplyBase,
        total:         reads.totalSupply,
        baseMin:       reads.baseMinForRewards,
        ratePerSecond: reads.supplyRewardsRatePerSecond,
      }),
    ]);
  }
});

export { SupplyRewardsApr, supplyRewardsApr };
