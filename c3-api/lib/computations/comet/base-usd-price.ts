import * as Eth from "../../eth-constants.js";
import * as Compute from "../../symbolic/computation.js";

import * as KnownNetwork from "../../well-known/networks/network.js";

import type { RegistryComet } from "../../model/comet-registry.js";

import type { GetPrice, PriceRead } from "./get-price.js";

type BaseUsdPrice = Compute.Spec<{
  name: "baseUsdPrice";
  depends: [GetPrice];
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
 * The feed that prices the base asset in USD. The registry states the unit
 * a market's own feeds answer in: a market quoted in USD prices its base
 * asset in USD through its own base feed, and one quoted in its base asset
 * converts that unit through the USD feed the version names — the feed every
 * value the market quotes is converted to USD with. The quote decides, never
 * whether a feed is there; validation refuses a market quoted in its base
 * asset without one (base-usd-feed-matches-quote).
 */
function usdPriceFeedOf(contract: RegistryComet): RegistryComet["base"]["priceFeed"] {
  if (contract.registry.market.collateralValueQuote === "usd") {
    return contract.base.priceFeed;
  }
  if (contract.base.usdPriceFeed === undefined) {
    throw new Error(`invariant violated: ${contract.address} is quoted in its base asset without a USD feed`);
  }
  return contract.base.usdPriceFeed;
}

const { implement, pull1 } = Compute.Functor<BaseUsdPrice>({});
const baseUsdPrice = implement({
  // 1: a price that reverts is answered, not thrown
  version: 1,
  compute: ({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) =>
    pull1({
      getPrice: {
        apiHost,
        nodeHost,
        nodeKey,
        network,
        contract,
        blockNumber,
        priceFeed: usdPriceFeedOf(contract),
      },
    }),
});

export { BaseUsdPrice, baseUsdPrice };
