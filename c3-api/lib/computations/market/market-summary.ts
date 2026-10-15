import * as Eth     from '../../eth-constants.js';
import * as Key     from '../../symbolic/key.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import * as Fallible from "../../fallible/fallible.js";

import type { RegistryComet } from '../../model/comet-registry.js';

import {
  Utilization,
  type BasePrice,
  type TotalBorrow,
  type TotalSupply,
  type BaseUsdPrice,
} from '../comet.js';

import type { BorrowApr } from './borrow-apr.js';
import type { SupplyApr } from './supply-apr.js';
import { type Collateral, type Collaterals, collateralValue } from './collaterals.js';

/*
 * How much of a market could be priced. Every read of a price goes through
 * the feed's latestRoundData, which reverts once Chainlink retires the feed:
 *
 * - success:   every price was read.
 * - partially: the base asset was priced, and at least one collateral was
 *              not; the totals leave that collateral out, and `collaterals`
 *              says which it was.
 * - error:     the base asset could not be priced, so nothing of the market
 *              can be valued; only what identifies it is reported.
 */
type MarketIdentity = {
  chainId: number,
  comet: {
    address: Eth.Address,
  },
};

type CollateralStatus = (
  & { address: Eth.Address, symbol: string }
  & ({ status: 'success' } | { status: 'error', message: string })
);

type MarketSummary = Compute.Spec<{
  name: 'marketSummary',
  depends: [
    BasePrice,
    BaseUsdPrice,
    BorrowApr,
    SupplyApr,
    TotalBorrow,
    TotalSupply,
    Collaterals,
    Utilization,
  ],
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    block:    Eth.Block,       // block at which to compute summary
    network:  KnownNetwork.Name, // network on which market is deployed
    contract: RegistryComet,     // comet contract for the market
  },
  returns: (
    | MarketIdentity & {
        status:  'error',
        message: string,
      }
    | MarketIdentity & {
        status: 'success' | 'partially',
        supplyApr: string,
        borrowApr: string,
        totalBorrowValue: string,
        totalSupplyValue: string,
        totalCollateralValue: string,
        utilization: string,
        baseUsdPrice: string,
        collateralAssetSymbols: string[],
        collaterals: CollateralStatus[],
      }
  ),
}>;

function collateralStatusOf({ asset, symbol, price }: Collateral): CollateralStatus {
  return {
    address: asset,
    symbol,
    ...(price.status === 'success'
      ? { status: 'success' as const }
      : { status: 'error' as const, message: price.message }),
  };
}

const { implement, pipe } = Compute.Functor<MarketSummary>({});
const marketSummary = implement({
  // 6: every price read reports a status instead of failing the summary
  version: 6,
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
        collaterals: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        utilization: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
      },
      ({
        borrowApr,
        supplyApr,
        basePrice,
        baseUsdPrice,
        totalBorrow,
        totalSupply,
        collaterals,
        utilization,
      }): MarketSummary['returns'] => {
        const identity = {
          chainId,
          comet: {
            address: contract.address,
          },
        };
        if (basePrice.status === 'error') {
          return { ...identity, status: 'error', message: basePrice.message };
        }
        if (baseUsdPrice.status === 'error') {
          return { ...identity, status: 'error', message: baseUsdPrice.message };
        }
        const statuses = collaterals.map(collateralStatusOf);
        return {
          ...identity,
          status: statuses.some(collateral => collateral.status === 'error') ? 'partially' : 'success',
          borrowApr: borrowApr.toString(),
          supplyApr: supplyApr.toString(),
          totalBorrowValue: totalBorrow.mul(basePrice.price).toString(),
          totalSupplyValue: totalSupply.mul(basePrice.price).toString(),
          totalCollateralValue: collateralValue(collaterals).toString(),
          utilization: utilization.toString(),
          baseUsdPrice: baseUsdPrice.price.toString(),
          collateralAssetSymbols: collaterals.map(({ symbol }) => symbol),
          collaterals: statuses,
        };
      },
    ]);
  },
});

export type {
  CollateralStatus,
  MarketIdentity,
};

export {
  MarketSummary,
  collateralStatusOf,
  marketSummary,
};
