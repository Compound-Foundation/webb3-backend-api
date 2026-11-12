import * as Eth from "../../eth-constants.js";
import * as Compute from "../../symbolic/computation.js";

import * as KnownNetwork from "../../well-known/networks/network.js";

import type { MarketV1, RegistryComet } from "../../model/comet-registry.js";

import type { BasePrice } from "./base-price.js";
import type { GetPrice, PriceRead } from "./get-price.js";

type BaseUsdPrice = Compute.Spec<{
  name: "baseUsdPrice";
  depends: [GetPrice, BasePrice];
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    blockNumber: Eth.BlockNumber; // block at which to compute summary
    network: KnownNetwork.Name; // network on which market is deployed
    contract: RegistryComet; // comet contract for the market, whose version states its quote
  };
  returns: PriceRead;
}>;

/*
 * Whether what a market quotes is converted to USD. It is the one rule of
 * every reader of a quote — the base asset's USD price, the totals in USD of
 * a summary and the value of each of its collaterals, and a rewards APR — so
 * they cannot disagree about a market. There is no default, so a quote added
 * to PRICE_QUOTES does not compile until it is decided here.
 */
function convertsToUsd(market: Pick<MarketV1, "collateralValueQuote">): boolean {
  switch (market.collateralValueQuote) {
    case "usd":
      return false;
    case "base":
      return true;
  }
}

/*
 * The USD feed of a market quoted in its base asset: the feed every value the
 * market quotes is converted to USD with, which its Comet does not name.
 * Validation refuses such a market without one (base-usd-feed-matches-quote).
 */
function usdPriceFeedOf(contract: RegistryComet): RegistryComet["base"]["priceFeed"] {
  if (contract.base.usdPriceFeed === undefined) {
    throw new Error(`invariant violated: ${contract.address} is quoted in its base asset without a USD feed`);
  }
  return contract.base.usdPriceFeed;
}

/*
 * The registry states the unit a market's own feeds answer in, and the quote
 * decides how the base asset is priced in USD, never whether a feed is there.
 * A market quoted in USD prices it with its base price: the same read, which
 * falls back on the feed the Comet names where the version's reverts
 * (base-price.ts), so the two prices answer alike, and the version's feed is
 * reported only where neither answers. One quoted in its base asset converts
 * that unit through its USD feed, which has nothing to fall back on.
 */
const { implement, pull1 } = Compute.Functor<BaseUsdPrice>({});
const baseUsdPrice = implement({
  // 2: a market quoted in USD reads its base price, and falls back with it on the feed the Comet names
  version: 2,
  compute: ({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) => {
    const frame = { apiHost, nodeHost, nodeKey, network, contract, blockNumber };
    return convertsToUsd(contract.registry.market)
      ? pull1({ getPrice: { ...frame, priceFeed: usdPriceFeedOf(contract) } })
      : pull1({ basePrice: frame });
  },
});

export { BaseUsdPrice, baseUsdPrice, convertsToUsd, usdPriceFeedOf };
