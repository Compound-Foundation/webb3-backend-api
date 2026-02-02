import { BigFixnum } from '../../bigfixnum.js';
import * as Eth      from '../../eth-constants.js';
import * as Compute  from '../../symbolic/computation.js';
import * as Constant from '../../constants.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { GetPrice     } from '../comet/get-price.js';
import type { BasePrice    } from '../comet/base-price.js';
import type { TotalSupply  } from '../comet/total-supply.js';

import type { TotalsBasic                } from './totals-basic.js';
import type { BaseMinForRewards          } from './base-min-for-rewards.js';
import type { SupplyRewardsRatePerSecond } from './supply-rewards-rate-per-second.js';
import { Contract } from '../../well-known/contracts/utils.js';

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
    contract: Contract, // comet contract
    blockNumber: Eth.BlockNumber,
    rewardsTokenPriceFeed: {
      address:  Eth.Address,
      decimals: number,
    },
  },
  returns: BigFixnum;
}>;

const { implement, pipe, pipe1 } = Compute.Functor<SupplyRewardsApr>({});
const supplyRewardsApr = implement({
  version: 1,
  compute({ apiHost, nodeHost, nodeKey, rewardsTokenPriceFeed, blockNumber, contract, network }) {
    let basePriceComputation: {basePrice?: any, getPrice?: any}  = { 
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
      const wstEthUsdPriceFeed = (
        Eth.wellKnownContractsByNetwork[network]['PriceFeed']['wstETH-USD']
      );

      basePriceComputation = {
        getPrice: { apiHost, nodeHost, nodeKey, priceFeed: wstEthUsdPriceFeed, blockNumber, contract, network },
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
        basePrice => {
          if (totalSupplyBase.lte(baseMinForRewards)) {
            return BigFixnum.from({ value: 0 });
          }

          const supplyValue = basePrice.mul(totalSupply);
          const rewardsValueAnnual = rewardsTokenPrice
            .mul(supplyRewardsRatePerSecond)
            .mul(Constant.secondsPerYear);

          return rewardsValueAnnual.div(supplyValue);
        },
      ])
    ]);
  }
});

export { SupplyRewardsApr, supplyRewardsApr };
