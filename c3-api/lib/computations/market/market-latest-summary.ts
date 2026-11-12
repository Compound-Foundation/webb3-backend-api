import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import * as Fallible     from '../../fallible/fallible.js';

import { BigFixnum } from '../../bigfixnum.js';

import type { BlockRefV1, CollateralValueStatusV1, PriceExceptionV1 } from '../../model/comet-registry.js';

import type {
  BasePrice,
  BaseUsdPrice,
  PriceError,
  TotalBorrow,
  TotalSupply,
  Utilization,
} from '../comet.js';
import { convertsToUsd } from '../comet/base-usd-price.js';
import { reportRevert } from '../comet/get-price.js';
import type { EthGetBlockHeader } from '../evm/eth-get-block-header.js';

import type { BorrowApr } from './borrow-apr.js';
import type { SupplyApr } from './supply-apr.js';
import { type Collateral, type Collaterals, collateralValue, quotedOf } from './collaterals.js';
import { collateralStatusOf, type CollateralStatus, type MarketIdentity, type MarketSummary } from './market-summary.js';

/*
 * The summary of a market at the latest block, as the summary route answers
 * it: what marketSummary reports, and the base price its totals are valued
 * at; and, for discovery, what the market holds of each collateral in USD and
 * the block it read that at (summary-tokens.ts), which the route answers in
 * fields of its own.
 *
 * It is a computation of its own because a day of the history is the whole
 * of a marketSummary (market-day-summary.ts): a field, a read or a status
 * added there would be in every day of the history, and read for each one.
 *
 * Each field is reported where the reads it is made of were, and left out
 * where they were not. A market whose base asset could not be priced is an
 * error, as in marketSummary, but reports everything that does not need the
 * price that failed, where marketSummary reports only what identifies it: it
 * leaves out its base price and its totals where the base price could not be
 * read, its base asset's USD price where that could not, and a total in USD
 * where the total could not, or, on a market quoted in its base asset, the
 * USD price that converts it.
 *
 * A collateral's value is what the market holds of it, at its price, converted
 * to USD as the totals are: so the values that are known add up to
 * totalCollateralValueUsd, where that is reported, but where a remap fell
 * back (below). What the market holds none of is worth nothing, whatever its
 * price says or fails to say, and a price of zero is nothing in USD whatever
 * converts it. A value is null where the Comet holds another asset at the
 * collateral's index, where its price could not be read, or where what
 * converts it to USD could not.
 *
 * A remap whose replacement reverts at the block while the feed it replaces
 * answers leaves its collateral's value null, naming the remap, while the
 * totals count the collateral at that feed's price, as the history does
 * (asset-price.ts): the remap retired that feed, and what it still answers
 * must not decide whether discovery shows a token, which shows one whose
 * value is not known (token-visibility.ts). The block is within a minute of
 * the latest, after the replacement was deployed — the registry read its
 * decimals on chain when an overlay named it — so the replacement has stopped
 * answering, and this summary reports its revert as a feed that reverts is
 * reported (get-price.ts): naming the replacement and the Comet, at the
 * block, with the replacement's own message, once a minute per network and
 * feed, whatever the market holds of the collateral. Where neither answers,
 * the price read has reported the replacement already, and its price carries
 * nothing to report. marketSummary reads the same prices and reports nothing
 * of them: the history it makes reads days older than the replacement too,
 * where its revert is expected. The report is made as the summary is
 * computed, so a minute already cached (market-minutely-summary.ts) reports
 * nothing, as it reads no feed.
 */

// a price exception of the registry as a summary names it, whatever the version that answers says of it besides
type AppliedException<Kind extends PriceExceptionV1['kind'] = PriceExceptionV1['kind']> = Pick<Extract<PriceExceptionV1, { kind: Kind }>, 'kind' | 'priceFeedAddress'>;

// nothing held names no exception, whatever priced it; a remap that fell back is named where it leaves the value unknown, to say why
type CollateralValue = (
  | { valueUsd: null, exception: null }
  | { valueUsd: null, exception: AppliedException<'deprecated_price_remap'> }
  | { valueUsd: BigFixnum, exception: AppliedException | null }
);

type ValuedCollateral = CollateralStatus & CollateralValue;

// what the summary reports of a market however its base asset was priced
type Reported = {
  borrowApr:              string,
  supplyApr:              string,
  totalCollateralValue:   string,
  utilization:            string,
  collateralAssetSymbols: string[],
  collaterals:            ValuedCollateral[],
  // the block the market was read at, or null where the node did not give its header
  marketBlock:            BlockRefV1 | null,
};

// what is made of the prices of the base asset
type Priced = {
  totalBorrowValue:        string,
  totalSupplyValue:        string,
  totalBorrowValueUsd:     string,
  totalSupplyValueUsd:     string,
  totalCollateralValueUsd: string,
  baseUsdPrice:            string,
  basePrice:               string,
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
    Collaterals,
    EthGetBlockHeader,
  ],
  expects: MarketSummary['expects'],
  returns: (
    | MarketIdentity & { status: 'success' | 'partially' } & Reported & Priced
    | MarketIdentity & PriceError & Reported & Partial<Priced>
  ),
}>;

// a collateral's value by the rules above, given what converts a total to USD, or null where that could not be read
function valueOf(collateral: Collateral, inUsd: ((total: BigFixnum) => BigFixnum) | null): CollateralValue {
  const { totalCollateral, price } = collateral;
  if (totalCollateral !== null && totalCollateral.value.isZero()) {
    return { valueUsd: BigFixnum.from({ value: 0 }), exception: null };
  }
  if ('replacementRevert' in price) {
    return { valueUsd: null, exception: { kind: price.exception.kind, priceFeedAddress: price.exception.priceFeedAddress } };
  }
  const quoted   = quotedOf(collateral);
  const valueUsd = quoted === null ? null : quoted.value.isZero() ? quoted : inUsd === null ? null : inUsd(quoted);
  if (valueUsd === null || price.exception === null) {
    return { valueUsd, exception: null };
  }
  return { valueUsd, exception: { kind: price.exception.kind, priceFeedAddress: price.exception.priceFeedAddress } };
}

// how a value was read, as /summary says it (collateral_value_status): the value alone decides it
function valueStatusOf({ valueUsd, exception }: CollateralValue): CollateralValueStatusV1 {
  return valueUsd === null ? 'unavailable' : exception === null ? 'fresh' : 'exception';
}

const { implement, pipe } = Compute.Functor<MarketLatestSummary>({});
const marketLatestSummary = implement({
  // 9: an empty market's APRs come from its Comet's rate model (#23); 8 is that rule over another shape
  version: 9,
  compute({ apiHost, nodeHost, nodeKey, network, contract, block }) {
    const { chainId } = Fallible.must(
      KnownNetwork.lookup({ name: network })
    );
    const read = { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network };

    return pipe([
      {
        basePrice:    read,
        baseUsdPrice: read,
        borrowApr:    { apiHost, nodeHost, nodeKey, block, contract, network },
        supplyApr:    { apiHost, nodeHost, nodeKey, block, contract, network },
        totalBorrow:  read,
        totalSupply:  read,
        utilization:  read,
        collaterals:  read,
        // beside the reads of the first round, and once for every market read at the same block
        ethGetBlockHeader: { apiHost, nodeHost, nodeKey, network, blockNumber: block.number },
      },
      ({
        basePrice,
        baseUsdPrice,
        borrowApr,
        supplyApr,
        totalBorrow,
        totalSupply,
        utilization,
        collaterals: held,
        ethGetBlockHeader: header,
      }): MarketLatestSummary['returns'] => {
        // a remap's replacement that has stopped answering is reported, and its revert answered in nothing (above)
        for (const { price } of held) {
          if ('replacementRevert' in price) {
            reportRevert(price.replacementRevert.message, price.replacementRevert.feed, contract.address, network, block.number);
          }
        }
        const totals = basePrice.status === 'success'
          ? { borrow: totalBorrow.mul(basePrice.price), supply: totalSupply.mul(basePrice.price) }
          : null;
        const totalCollateral = collateralValue(held);
        // what converts a total to USD, as marketSummary converts it (inUsd), or null where that could not be read
        const inUsd = !convertsToUsd(contract.registry.market)
          ? (total: BigFixnum) => total
          : baseUsdPrice.status === 'success' ? (total: BigFixnum) => total.mul(baseUsdPrice.price) : null;
        const identity = {
          chainId,
          comet: {
            address: contract.address,
          },
        };
        const collaterals = held.map((collateral): ValuedCollateral => ({ ...collateralStatusOf(collateral), ...valueOf(collateral, inUsd) }));
        const fields: Reported & Partial<Priced> = {
          borrowApr: borrowApr.toString(),
          supplyApr: supplyApr.toString(),
          ...(totals === null ? {} : {
            totalBorrowValue: totals.borrow.toString(),
            totalSupplyValue: totals.supply.toString(),
          }),
          totalCollateralValue: totalCollateral.toString(),
          ...(totals === null || inUsd === null ? {} : {
            totalBorrowValueUsd: inUsd(totals.borrow).toString(),
            totalSupplyValueUsd: inUsd(totals.supply).toString(),
          }),
          ...(inUsd === null ? {} : { totalCollateralValueUsd: inUsd(totalCollateral).toString() }),
          utilization: utilization.toString(),
          ...(baseUsdPrice.status === 'success' ? { baseUsdPrice: baseUsdPrice.price.toString() } : {}),
          /*
           * What the totals are valued at, which marketSummary keeps to itself.
           * Only it turns any total back into an amount of the base asset: the
           * USD price is the same number only on a market quoted in USD, while
           * both are read through one feed, and on the WBTC market, whose feeds
           * answer in BTC, it is the price of BTC.
           */
          ...(basePrice.status === 'success' ? { basePrice: basePrice.price.toString() } : {}),
          collateralAssetSymbols: held.map(({ symbol }) => symbol),
          collaterals,
          marketBlock: header,
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
          // both prices were read, so the fields carry the totals, in the market's unit and in USD, and both prices
          ...(fields as Reported & Priced),
        };
      },
    ]);
  },
});

export type {
  CollateralValue,
};

export {
  MarketLatestSummary,
  marketLatestSummary,
  valueStatusOf,
};
