import { BigFixnum } from '../../bigfixnum.js';
import * as Eth      from '../../eth-constants.js';
import * as Compute  from '../../symbolic/computation.js';
import * as Constant from '../../constants.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { GetPrice     } from '../comet/get-price.js';
import type { BasePrice    } from '../comet/base-price.js';
import type { TotalBorrow  } from '../comet/total-borrow.js';

import type { TotalsBasic                } from './totals-basic.js';
import type { BaseMinForRewards          } from './base-min-for-rewards.js';
import type { BorrowRewardsRatePerSecond } from './borrow-rewards-rate-per-second.js';

import { Contract } from '../../well-known/contracts/utils.js';

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
    contract: Contract, // comet contract
    blockNumber: Eth.BlockNumber,
    rewardsTokenPriceFeed: {
      address:  Eth.Address,
      decimals: number,
    },
  },
  returns: BigFixnum;
}>;

const { implement, pipe, pipe1 } = Compute.Functor<BorrowRewardsApr>({});
const borrowRewardsApr = implement({
  version: 1,
  compute({ apiHost, nodeHost, nodeKey, rewardsTokenPriceFeed, blockNumber, contract, network }) {
    let basePriceComputation: {basePrice?: any, getPrice?: any} = { 
      basePrice: { apiHost, nodeHost, nodeKey, blockNumber, contract, network  }
    };

    if (contract.displayName === 'cWETHv3' && (network === 'base-mainnet' || network === 'arbitrum-mainnet' || network === 'optimism-mainnet' || network === 'unichain-mainnet')) {
      const wethUsdPriceFeed = (
        Eth.wellKnownContractsByNetwork[network]['PriceFeed']['WETH-USD']
      );

      basePriceComputation = {
        getPrice: { apiHost, nodeHost, nodeKey, priceFeed: wethUsdPriceFeed, blockNumber, contract, network },
      };
    }
    else if (contract.displayName === 'cwstETHv3' && network === 'ethereum-mainnet') {
      const wstETHUsdPriceFeed = (
        Eth.wellKnownContractsByNetwork[network]['PriceFeed']['wstETH-USD']
      );

      basePriceComputation = {
        getPrice: { apiHost, nodeHost, nodeKey, priceFeed: wstETHUsdPriceFeed, blockNumber, contract, network },
      };
    }
    else if (contract.displayName === 'cUSDev3' && network === 'mantle-mainnet') {
      const uSDeUsdPriceFeed = (
        Eth.wellKnownContractsByNetwork[network]['PriceFeed']['cUSDev3-USD']
      );

      basePriceComputation = {
        getPrice: { apiHost, nodeHost, nodeKey, priceFeed: uSDeUsdPriceFeed, blockNumber, contract, network },
      };
    }
    else if (contract.displayName === 'cWBTCv3' && network === 'ethereum-mainnet') {
      const wBtcUsdPriceFeed = (
        Eth.wellKnownContractsByNetwork[network]['PriceFeed']['WBTC-USD']
      );

      basePriceComputation = {
        getPrice: { apiHost, nodeHost, nodeKey, priceFeed: wBtcUsdPriceFeed, blockNumber, contract, network },
      };
    }

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
        basePrice => {
          if (totalBorrowBase.lte(baseMinForRewards)) {
            return BigFixnum.from({ value: 0 });
          }
          const borrowValue = basePrice.mul(totalBorrow);
          const rewardsValueAnnual = rewardsTokenPrice
            .mul(borrowRewardsRatePerSecond)
            .mul(Constant.secondsPerYear);
          return rewardsValueAnnual.div(borrowValue);
        },
      ])
    ]);
  }
});

export { BorrowRewardsApr, borrowRewardsApr };
