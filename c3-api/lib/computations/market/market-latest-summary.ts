import * as Eth     from '../../eth-constants.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import * as Fallible     from '../../fallible/fallible.js';

import type { BigFixnum } from '../../bigfixnum.js';
import type { RegistryComet } from '../../model/comet-registry.js';

import type {
  BasePrice,
  BaseUsdPrice,
  PriceError,
  PriceRead,
  RateCurve,
  RateModel,
  Reserves,
  TotalBorrow,
  TotalSupply,
  Utilization,
} from '../comet.js';

import type { BorrowApr } from './borrow-apr.js';
import type { SupplyApr } from './supply-apr.js';
import { collateralValue } from './collaterals.js';
import type { CollateralDetail, CollateralDetails } from './collateral-details.js';
import type { MarketIdentity, MarketSummary } from './market-summary.js';

/*
 * The summary of a market at the latest block, as the summary route answers
 * it: what marketSummary reports, and beside it the market's reserves, its
 * interest rate model, and for each collateral its price in USD, what the
 * market holds of it and what the Comet keeps for it — each of these but the
 * price an integer, unscaled, as the Comet stores it.
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
 * be read, and its base asset's USD price where that could not. The reserves
 * of the market, or of a collateral, are left out where the Comet's read of
 * them reverted (reserves.ts); a collateral's USD price where its price, or
 * what converts it, could not be read; and what the market holds of a
 * collateral and what the Comet keeps for it where the Comet holds another
 * asset at its index (collateral-details.ts).
 *
 * A collateral's USD price is its price (asset-price.ts), which is in the
 * unit the market's own feeds answer in: USD where the registry quotes the
 * market in USD, as it does AERO's, and otherwise the unit of its base
 * asset — ETH for a WETH market, BTC for the WBTC market — which the base
 * asset's USD price converts (base-usd-price.ts). The quote decides, never
 * which feeds there are. A zero price is zero in any unit and is not
 * converted, so a feed the registry prices at zero reports zero even where
 * the conversion could not be read.
 */
type CollateralSummary = (
  & { address: Eth.Address, symbol: string }
  & ({ status: 'success' } | PriceError)
  & { priceUsd?: string }
  // all of them, or none where the Comet holds another asset at the collateral's index
  & (CollateralRaw | { [Field in keyof CollateralRaw]?: never })
);

// what the market holds of a collateral and what the Comet keeps for it, unscaled as the Comet stores them
type CollateralRaw = {
  totalSupply:               string,
  reserves?:                 string, // absent where the Comet's read of them reverted
  supplyCap:                 string,
  borrowCollateralFactor:    string,
  liquidateCollateralFactor: string,
  liquidationFactor:         string,
};

type RateCurveSummary = {
  kink:      string,
  base:      string,
  slopeLow:  string,
  slopeHigh: string,
};

// what the summary reports of a market however its base asset was priced
type Reported = {
  borrowApr:              string,
  supplyApr:              string,
  totalCollateralValue:   string,
  utilization:            string,
  collateralAssetSymbols: string[],
  reserves?:              string, // absent where the Comet's read of them reverted
  rateModel:              { borrow: RateCurveSummary, supply: RateCurveSummary },
  collaterals:            CollateralSummary[],
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
    Reserves,
    RateModel,
    CollateralDetails,
  ],
  expects: MarketSummary['expects'],
  returns: (
    | MarketIdentity & { status: 'success' | 'partially' } & Reported & Priced
    | MarketIdentity & PriceError & Reported & Partial<Priced>
  ),
}>;

// a collateral's price in USD, or null where its price, or what converts it, could not be read
function usdPriceOf(price: PriceRead, contract: RegistryComet, baseUsdPrice: PriceRead): BigFixnum | null {
  if (price.status === 'error') {
    return null;
  }
  if (contract.registry.market.collateralValueQuote === 'usd' || price.price.value.isZero()) {
    return price.price;
  }
  return baseUsdPrice.status === 'success' ? price.price.mul(baseUsdPrice.price) : null;
}

/*
 * A price is written with a decimal point, as base_usd_price is: "42.0" and
 * "0.0", never "42" or "0". A fixed_price an operator stated at no decimals
 * would otherwise be written as an integer where it is not converted.
 */
function decimalOf(price: BigFixnum): string {
  return price.scaleToDecimals(Math.max(price.decimals, 1)).toString();
}

function collateralSummary(
  { asset, symbol, totalCollateral, price, parameters }: CollateralDetail,
  priceUsd: BigFixnum | null,
): CollateralSummary {
  return {
    address: asset,
    symbol,
    ...(price.status === 'success'
      ? { status: 'success' as const }
      : { status: 'error' as const, message: price.message }),
    ...(priceUsd === null ? {} : { priceUsd: decimalOf(priceUsd) }),
    ...(parameters === null ? {} : {
      // the integer the Comet answered, which the amount keeps as its value beside its scale
      totalSupply:               totalCollateral.value.toString(),
      ...(parameters.reserves === null ? {} : { reserves: parameters.reserves.toString() }),
      supplyCap:                 parameters.supplyCap.toString(),
      borrowCollateralFactor:    parameters.borrowCollateralFactor.toString(),
      liquidateCollateralFactor: parameters.liquidateCollateralFactor.toString(),
      liquidationFactor:         parameters.liquidationFactor.toString(),
    }),
  };
}

const curveOf = ({ kink, base, slopeLow, slopeHigh }: RateCurve): RateCurveSummary => ({
  kink:      kink.toString(),
  base:      base.toString(),
  slopeLow:  slopeLow.toString(),
  slopeHigh: slopeHigh.toString(),
});

const { implement, pipe } = Compute.Functor<MarketLatestSummary>({});
const marketLatestSummary = implement({
  version: 1,
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
        reserves:          read,
        rateModel:         read,
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
        reserves,
        rateModel,
        collateralDetails,
      }): MarketLatestSummary['returns'] => {
        const identity = {
          chainId,
          comet: {
            address: contract.address,
          },
        };
        const collaterals = collateralDetails.map(collateral => (
          collateralSummary(collateral, usdPriceOf(collateral.price, contract, baseUsdPrice))
        ));
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
          ...(reserves === null ? {} : { reserves: reserves.toString() }),
          rateModel: {
            borrow: curveOf(rateModel.borrow),
            supply: curveOf(rateModel.supply),
          },
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

export type {
  CollateralSummary,
  RateCurveSummary,
};

export {
  MarketLatestSummary,
  marketLatestSummary,
};
