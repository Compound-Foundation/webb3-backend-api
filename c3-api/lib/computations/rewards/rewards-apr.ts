import type { BigNumber } from '@ethersproject/bignumber';

import { BigFixnum } from '../../bigfixnum.js';
import * as Constant from '../../constants.js';

import type { PriceError, PriceRead } from '../comet/get-price.js';
import type { BasePrice    } from '../comet/base-price.js';
import type { BaseUsdPrice } from '../comet/base-usd-price.js';

import { usdBasePriceFeedFor } from './base-price-feed.js';

/*
 * A rewards rate, or why a price it is measured in could not be read.
 */
type AprRead = { status: 'success', apr: BigFixnum } | PriceError;

/*
 * The base price an APR divides by, in the unit its reward feed answers in
 * (usdBasePriceFeedFor): the market's own base price, or the USD price of its
 * base asset, which BaseUsdPrice reads from the feed usdBasePriceFeedFor
 * names. A step names each of its reads by computation, and the APR's one
 * step reads the reward price with getPrice already: as a computation of its
 * own, the base price joins that step, and its node round, rather than taking
 * a round of its own once the rest is in.
 */
function basePriceLookup(
  frame: BasePrice['expects'],
): { basePrice: BasePrice['expects'] } | { baseUsdPrice: BaseUsdPrice['expects'] } {
  return usdBasePriceFeedFor(frame.contract) === null ? { basePrice: frame } : { baseUsdPrice: frame };
}

function basePriceOf(read: { basePrice: PriceRead } | { baseUsdPrice: PriceRead }): PriceRead {
  return 'basePrice' in read ? read.basePrice : read.baseUsdPrice;
}

/*
 * The annual value of the rewards one side of a market pays, over the value
 * of that side. A price that could not be read is the answer, the reward
 * price's before the base price's, even where the rate would be 0.
 */
function rewardsAprOf({ rewardPrice, basePrice, principal, total, baseMin, ratePerSecond }: {
  rewardPrice:   PriceRead,
  basePrice:     PriceRead,
  // totalsBasic's totalSupplyBase or totalBorrowBase: what baseMinForRewards is held against
  principal:     BigNumber,
  // totalSupply or totalBorrow: the side's present amount of the base asset, which is valued
  total:         BigFixnum,
  baseMin:       BigNumber,
  ratePerSecond: BigFixnum,
}): AprRead {
  if (rewardPrice.status === 'error') {
    return rewardPrice;
  }
  if (basePrice.status === 'error') {
    return basePrice;
  }
  if (principal.lte(baseMin)) {
    return { status: 'success', apr: BigFixnum.from({ value: 0 }) };
  }
  const value              = basePrice.price.mul(total);
  const rewardsValueAnnual = rewardPrice.price.mul(ratePerSecond).mul(Constant.secondsPerYear);
  return { status: 'success', apr: rewardsValueAnnual.div(value) };
}

export { AprRead, basePriceLookup, basePriceOf, rewardsAprOf };
