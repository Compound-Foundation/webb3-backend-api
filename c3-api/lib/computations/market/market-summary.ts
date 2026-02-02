import * as Eth     from '../../eth-constants.js';
import * as Key     from '../../symbolic/key.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import * as Fallible from "../../fallible/fallible.js";

import {
  Utilization,
  type BasePrice,
  type TotalBorrow,
  type TotalSupply,
  type BaseUsdPrice,
} from '../comet.js';

import type { BorrowApr } from './borrow-apr.js';
import type { SupplyApr } from './supply-apr.js';
import type { TotalCollateralValue } from './total-collateral-value.js';
import { Comet, StandaloneContract } from '../../well-known/contracts/types.js';
import { CollateralAssetSymbols } from '../comet/collateral-asset-symbols.js';

type MarketSummary = Compute.Spec<{
  name: 'marketSummary',
  depends: [
    BasePrice,
    BaseUsdPrice,
    BorrowApr,
    SupplyApr,
    TotalBorrow,
    TotalSupply,
    TotalCollateralValue,
    CollateralAssetSymbols,
    Utilization,
  ],
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    block:    Eth.Block,       // block at which to compute summary
    network:  KnownNetwork.Name, // network on which market is deployed
    contract: Eth.Contract<StandaloneContract<Comet>>,    // comet contract for the market
  },
  returns: {
    chainId: number;
    comet: {
      address: Eth.Address;
    };
    supplyApr: string,
    borrowApr: string,
    totalBorrowValue: string,
    totalSupplyValue: string,
    totalCollateralValue: string,
    utilization: string,
  },
}>;

const { implement, pipe } = Compute.Functor<MarketSummary>({});
const marketSummary = implement({
  version: 5,
  /*
   * validate that the block requested does not predate the market
   * contract creation block.
   */
  index: Index.Make<MarketSummary['expects']>({
    project: context => context,
    includes(context) {
      return this.covers(context);
    },
    covers({ contract, block }) {
      return block.number >= contract.creation.block.number;
    },
  }),
  /*
   * Key the computation by just block number, omit the timestamp.
   */
  key(name, { block, ...context }) {
    return Key.toKey(name, { block: block.number, ...context });
  },
  /*
   * Compute a market summary at the requested sampleBlock.
   */
  compute({ apiHost, nodeHost, nodeKey, network, contract, block }) {
    const { chainId } = Fallible.must(
      KnownNetwork.lookup({ name: network })
    );

    /*
     * Aggregate and format summary data for display.
     */
    return pipe([
      {
        borrowApr: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        supplyApr: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        basePrice: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        baseUsdPrice: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        totalBorrow: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        totalSupply: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        totalCollateralValue: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        collateralAssetSymbols: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        utilization: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
      },
      ({
        borrowApr,
        supplyApr,
        basePrice,
        baseUsdPrice,
        totalBorrow,
        totalSupply,
        totalCollateralValue,
        collateralAssetSymbols,
        utilization,
      }) => {
        return {
          chainId,
          comet: {
            address: contract.address,
          },
          borrowApr: borrowApr.toString(),
          supplyApr: supplyApr.toString(),
          totalBorrowValue: totalBorrow.mul(basePrice).toString(),
          totalSupplyValue: totalSupply.mul(basePrice).toString(),
          totalCollateralValue: totalCollateralValue.toString(),
          utilization: utilization.toString(),
          baseUsdPrice: baseUsdPrice.toString(),
          collateralAssetSymbols: collateralAssetSymbols,
        };
      },
    ]);
  },
});

export {
  MarketSummary,
  marketSummary,
};
