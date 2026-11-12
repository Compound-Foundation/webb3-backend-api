import * as Eth     from '../../eth-constants.js';
import * as Key     from '../../symbolic/key.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import * as Fallible from "../../fallible/fallible.js";

import type { BigFixnum } from '../../bigfixnum.js';
import type { RegistryComet } from '../../model/comet-registry.js';

import {
  Utilization,
  type BasePrice,
  type TotalBorrow,
  type TotalSupply,
  type BaseUsdPrice,
  type PriceError,
} from '../comet.js';
import { convertsToUsd } from '../comet/base-usd-price.js';

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
  & ({ status: 'success' } | PriceError)
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
    | MarketIdentity & PriceError
    | MarketIdentity & {
        status: 'success' | 'partially',
        supplyApr: string,
        borrowApr: string,
        totalBorrowValue: string,
        totalSupplyValue: string,
        totalCollateralValue: string,
        totalBorrowValueUsd: string,
        totalSupplyValueUsd: string,
        totalCollateralValueUsd: string,
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
  // 10: an empty market's APRs come from its Comet's rate model (#23).
  // 9 is taken by values of another shape.
  version: 10,
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
        borrowApr: { apiHost, nodeHost, nodeKey, block, contract, network },
        supplyApr: { apiHost, nodeHost, nodeKey, block, contract, network },
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
        // a price's replacementRevert is the latest summary's to report, not a day's (market-latest-summary.ts)
        const statuses = collaterals.map(collateralStatusOf);
        /*
         * The totals are in the unit the market's own feeds answer in: USD,
         * or the base asset of a market the registry says is quoted in it,
         * such as ETH for a WETH market — what they have always been, and
         * what a client that converts them itself expects. Beside each is the
         * same total in USD: as it is for a market quoted in USD, and through
         * the base asset's USD price for one quoted in its base asset, as the
         * latest summary converts the value of each collateral
         * (market-latest-summary.ts).
         */
        const quoted = {
          borrow:     totalBorrow.mul(basePrice.price),
          supply:     totalSupply.mul(basePrice.price),
          collateral: collateralValue(collaterals),
        };
        const inUsd = (value: BigFixnum) => convertsToUsd(contract.registry.market)
          ? value.mul(baseUsdPrice.price)
          : value;
        return {
          ...identity,
          status: statuses.some(collateral => collateral.status === 'error') ? 'partially' : 'success',
          borrowApr: borrowApr.toString(),
          supplyApr: supplyApr.toString(),
          totalBorrowValue: quoted.borrow.toString(),
          totalSupplyValue: quoted.supply.toString(),
          totalCollateralValue: quoted.collateral.toString(),
          totalBorrowValueUsd: inUsd(quoted.borrow).toString(),
          totalSupplyValueUsd: inUsd(quoted.supply).toString(),
          totalCollateralValueUsd: inUsd(quoted.collateral).toString(),
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
