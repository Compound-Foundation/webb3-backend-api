import * as Eth     from '../../eth-constants.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { RegistryComet } from '../../model/comet-registry.js';

import type { CometBasePrice } from './comet-base-price.js';
import { reportRevert, type GetPrice, type PriceRead } from './get-price.js';

/*
 * The base asset's price in the unit the market's own feeds answer in, or
 * why it could not be read.
 *
 * It is read first from the feed the registry version names for the base
 * asset, at the scale the import read from it: what the Comet answered
 * baseTokenPriceFeed() with then, which the market rewards report as the
 * market's feed and the chain drift check holds against what the Comet
 * answers now — one feed for all three. The rewards keep naming it as
 * the market's feed even where the price was read through the Comet's
 * (market-rewards.ts).
 *
 * Where that feed does not answer at the block — a block before it was
 * deployed, or one after Chainlink retired it while the version still names
 * it — the price is read through the feed the Comet names at that block
 * (comet-base-price.ts), as a remapped collateral falls back on the feed it
 * replaces (asset-price.ts). Its revert is expected there, so it is reported
 * only where neither answers: a feed the Comet has moved off is not logged
 * while the Comet's answers, and the chain drift check is what raises it.
 */
type BasePrice = Compute.Spec<{
  name: 'basePrice',
  depends: [ GetPrice, CometBasePrice ],
  expects: {
    apiHost:     string,
    nodeHost:    string,
    nodeKey:     string,
    network:     KnownNetwork.Name,
    // a Comet the registry materialized, whose version names its base feed
    contract:    RegistryComet,
    blockNumber: Eth.BlockNumber,
  },
  returns: PriceRead,
}>;

const { implement, pipe1 } = Compute.Functor<BasePrice>({});
const basePrice = implement({
  // 3: where the feed the version names reverts, the feed the Comet names at that block
  version: 3,
  compute: ({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) => {
    const frame = { apiHost, nodeHost, nodeKey, network, contract, blockNumber };
    return pipe1([
      { getPrice: { ...frame, priceFeed: contract.base.priceFeed, unreported: true } },
      own => own.status === 'success' ? own : pipe1([
        { cometBasePrice: frame },
        (comet): PriceRead => {
          if (comet.status === 'success') {
            return comet;
          }
          reportRevert(own.message, contract.base.priceFeed.address, contract.address, network, blockNumber);
          return own;
        },
      ]),
    ]);
  },
});

export { BasePrice, basePrice };
