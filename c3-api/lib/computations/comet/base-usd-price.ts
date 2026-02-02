import * as Eth from "../../eth-constants.js";
import * as Compute from "../../symbolic/computation.js";
import { BigFixnum } from "../../bigfixnum.js";

import * as KnownNetwork from "../../well-known/networks/network.js";

import type { GetPrice } from "./get-price.js";

import { Comet, StandaloneContract } from "../../well-known/contracts/types.js";

type BaseUsdPrice = Compute.Spec<{
  name: "baseUsdPrice";
  depends: [GetPrice];
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    blockNumber: Eth.BlockNumber; // block at which to compute summary
    network: KnownNetwork.Name; // network on which market is deployed
    contract: Eth.Contract<StandaloneContract<Comet>>; // comet contract for the market
  };
  returns: BigFixnum;
}>;

const { implement, pull1 } = Compute.Functor<BaseUsdPrice>({});
const baseUsdPrice = implement({
  version: 0,
  compute: ({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) =>
    pull1({
      getPrice: {
        apiHost,
        nodeHost,
        nodeKey,
        network,
        contract,
        blockNumber,
        priceFeed: contract.base.usdPriceFeed ?? contract.base.priceFeed,
      },
    }),
});

export { BaseUsdPrice, baseUsdPrice };
