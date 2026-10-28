import { BigFixnum } from '../../bigfixnum.js';
import * as Compute  from '../../symbolic/computation.js';

import type { Address, PriceExceptionV1, RegistryAnnotation, RegistryComet } from '../../model/comet-registry.js';

import type { AssetInfo } from './asset-info.js';
import { reportRevert, type GetPrice, type PriceRead } from './get-price.js';

/*
 * The price of a collateral asset, or why it could not be read: one
 * collateral whose feed reverts leaves the rest of its market readable.
 */
type AssetPrice = Compute.Spec<{
  name: 'assetPrice',
  depends: [ AssetInfo, GetPrice ],
  // a Comet the registry materialized, whose version states how each of its feeds is priced
  expects: Omit<AssetInfo['expects'], 'contract'> & { contract: RegistryComet },
  returns: PriceRead,
}>;

/*
 * What the version says about the feed a Comet reports for this asset.
 *
 * A feed that reverts, or that was retired with a last known answer, is an
 * exception the registry carries for its network: the operator reviewed it,
 * recorded why, and the version states it. Before the registry these were
 * branches on network and feed address compiled into this computation, which
 * meant a deprecated feed could only be handled by shipping a new Worker.
 */
function exceptionFor(annotation: RegistryAnnotation, priceFeed: Address): PriceExceptionV1 | null {
  const address = priceFeed.toLowerCase();
  return annotation.priceExceptions.find(exception => exception.priceFeedAddress === address) ?? null;
}

/*
 * The scale of that feed, as the registry read it on chain. Every price is
 * read at it, and a zero price is stated at it.
 *
 * A Comet reports the feed it prices an asset with at the block it is asked
 * at, and at a historical block that may be a feed the market has since moved
 * off, which the version does not describe. Such a feed is read at eight
 * decimals: Comet refuses a price feed of any other scale, and it is what
 * every caller assumed before the registry existed.
 */
const ASSUMED_DECIMALS = 8;

function decimalsOf(annotation: RegistryAnnotation, priceFeed: Address): number {
  const address = priceFeed.toLowerCase();
  const market  = annotation.market;
  const feeds = [
    market.baseAsset.priceFeed,
    ...(market.baseAsset.usdPriceFeed === null ? [] : [ market.baseAsset.usdPriceFeed ]),
    ...market.collateralAssets.map(asset => asset.priceFeed),
  ];
  return feeds.find(feed => feed.address === address)?.decimals ?? ASSUMED_DECIMALS;
}

const { implement, pipe1, pull1 } = Compute.Functor<AssetPrice>({});
const assetPrice = implement({
  // 2: a remap reads the Comet's own feed where its replacement reverts
  version: 2,
  compute: ({ apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network }) => pipe1([
    { assetInfo: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network } },
    ({ priceFeed }) => {
      const annotation = contract.registry;
      const exception  = exceptionFor(annotation, priceFeed);
      const own        = { address: priceFeed, decimals: decimalsOf(annotation, priceFeed) };

      if (exception !== null) {
        switch (exception.kind) {
          case 'zero_price':
            return { status: 'success', price: BigFixnum.from({ decimals: own.decimals, value: 0 }) };
          case 'fixed_price':
            return { status: 'success', price: BigFixnum.from({ decimals: exception.price.decimals, value: exception.price.value }) };
          case 'deprecated_price_remap': {
            /*
             * A remap reads its replacement. At a block before the replacement
             * was deployed — a day of history older than it — the replacement
             * reverts, and the feed the Comet named at that block is read
             * instead. A revert there is expected, so the replacement is
             * reported only when neither answers. At the latest block the
             * replacement answers, and nothing more is read.
             */
            const read        = { apiHost, nodeHost, nodeKey, network, contract, blockNumber, unreported: true } as const;
            const replacement = exception.replacementPriceFeed;
            return pipe1([
              { getPrice: { ...read, priceFeed: replacement } },
              replaced => replaced.status === 'success' ? replaced : pipe1([
                { getPrice: { ...read, priceFeed: own } },
                (fallback): PriceRead => {
                  if (fallback.status === 'success') {
                    return fallback;
                  }
                  reportRevert(replaced.message, replacement.address, contract.address, network, blockNumber);
                  return replaced;
                },
              ]),
            ]);
          }
        }
      }

      return pull1({
        getPrice: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          contract,
          blockNumber,
          priceFeed: own,
        },
      });
    },
  ]),
});

export { AssetPrice, assetPrice, exceptionFor };
