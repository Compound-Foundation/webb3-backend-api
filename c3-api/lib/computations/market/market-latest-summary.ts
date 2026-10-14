import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import * as Fallible     from '../../fallible/fallible.js';

import type {
  BasePrice,
  BaseUsdPrice,
  PriceError,
  TotalBorrow,
  TotalSupply,
  Utilization,
} from '../comet.js';

import type { BorrowApr } from './borrow-apr.js';
import type { SupplyApr } from './supply-apr.js';
import { type Collateral, collateralValue } from './collaterals.js';
import type { CollateralDetails } from './collateral-details.js';
import type { CollateralStatus, MarketIdentity, MarketSummary } from './market-summary.js';

/*
 * The summary of a market at the latest block, as the summary route answers
 * it: what marketSummary reports, with its collateral as the registry version
 * describes it (collateral-details.ts).
 *
 * It is a computation of its own because a day of the history is the whole
 * of a marketSummary (market-day-summary.ts): a field, a read or a status
 * added there would be in every day of the history, and read for each one.
 * The history keeps marketSummary as it was.
 *
 * Each field is reported where the reads it is made of were, and left out
 * where they were not. A market whose base asset could not be priced is an
 * error, as in marketSummary, but reports everything that does not need the
 * price that failed: it leaves out its totals where its base price could not
 * be read, and its base asset's USD price where that could not.
 */

// what the summary reports of a market however its base asset was priced
type Reported = {
  borrowApr:              string,
  supplyApr:              string,
  totalCollateralValue:   string,
  utilization:            string,
  collateralAssetSymbols: string[],
  collaterals:            CollateralStatus[],
};

// what is made of the prices of the base asset: the totals of its base price, and its USD price
type Priced = {
  totalBorrowValue: string,
  totalSupplyValue: string,
  baseUsdPrice:     string,
};

type MarketLatestSummary = Compute.Spec<{
  name: 'marketLatestSummary',
  depends: [
    BasePrice,
    BaseUsdPrice,
    BorrowApr,
    SupplyApr,
    TotalBorrow,
    TotalSupply,
    Utilization,
    CollateralDetails,
  ],
  expects: MarketSummary['expects'],
  returns: (
    | MarketIdentity & { status: 'success' | 'partially' } & Reported & Priced
    | MarketIdentity & PriceError & Reported & Partial<Priced>
  ),
}>;

function collateralSummary({ asset, symbol, price }: Collateral): CollateralStatus {
  return {
    address: asset,
    symbol,
    ...(price.status === 'success'
      ? { status: 'success' as const }
      : { status: 'error' as const, message: price.message }),
  };
}

const { implement, pipe } = Compute.Functor<MarketLatestSummary>({});
const marketLatestSummary = implement({
  // 2: without reserves, the rate model or each collateral's price and parameters
  version: 2,
  compute({ apiHost, nodeHost, nodeKey, network, contract, block }) {
    const { chainId } = Fallible.must(
      KnownNetwork.lookup({ name: network })
    );
    const read = { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network };

    return pipe([
      {
        basePrice:         read,
        baseUsdPrice:      read,
        borrowApr:         read,
        supplyApr:         read,
        totalBorrow:       read,
        totalSupply:       read,
        utilization:       read,
        collateralDetails: read,
      },
      ({
        basePrice,
        baseUsdPrice,
        borrowApr,
        supplyApr,
        totalBorrow,
        totalSupply,
        utilization,
        collateralDetails,
      }): MarketLatestSummary['returns'] => {
        const identity = {
          chainId,
          comet: {
            address: contract.address,
          },
        };
        const collaterals = collateralDetails.map(collateralSummary);
        const fields: Reported & Partial<Priced> = {
          borrowApr: borrowApr.toString(),
          supplyApr: supplyApr.toString(),
          ...(basePrice.status === 'success' ? {
            totalBorrowValue: totalBorrow.mul(basePrice.price).toString(),
            totalSupplyValue: totalSupply.mul(basePrice.price).toString(),
          } : {}),
          totalCollateralValue: collateralValue(collateralDetails).toString(),
          utilization: utilization.toString(),
          ...(baseUsdPrice.status === 'success' ? { baseUsdPrice: baseUsdPrice.price.toString() } : {}),
          collateralAssetSymbols: collateralDetails.map(({ symbol }) => symbol),
          collaterals,
        };
        if (basePrice.status === 'error') {
          return { ...identity, status: 'error', message: basePrice.message, ...fields };
        }
        if (baseUsdPrice.status === 'error') {
          return { ...identity, status: 'error', message: baseUsdPrice.message, ...fields };
        }
        return {
          ...identity,
          status: collaterals.some(collateral => collateral.status === 'error') ? 'partially' : 'success',
          // both prices were read, so the fields carry the totals and the base asset's USD price
          ...(fields as Reported & Priced),
        };
      },
    ]);
  },
});

export {
  MarketLatestSummary,
  marketLatestSummary,
};
