import { BigFixnum } from '../../bigfixnum.js';
import * as Compute  from '../../symbolic/computation.js';

import type { Address, PriceExceptionV1, PriceFeedV1, RegistryAnnotation, RegistryComet } from '../../model/comet-registry.js';

import type { AssetInfo } from './asset-info.js';
import { reportRevert, type GetPrice, type PriceError } from './get-price.js';

/*
 * The price of a collateral asset, or why it could not be read: one
 * collateral whose feed reverts leaves the rest of its market readable.
 *
 * A price names the exception of the registry it was priced by: one that
 * states it, or a remap whose replacement answered. A price read from a feed
 * the Comet names, and a price that could not be read, name none. A price a
 * remap's fallback gave, which is read from the feed the Comet names as well,
 * names the remap all the same, and carries what the replacement reverted
 * with: whether to value by it, and whether to report the revert, are its
 * reader's to decide (PricePlan).
 */
type RemapException = Extract<PriceExceptionV1, { kind: 'deprecated_price_remap' }>;

type AssetPriceRead = (
  | { status: 'success', price: BigFixnum, exception: PriceExceptionV1 | null }
  // a price a remap's fallback gave
  | { status: 'success', price: BigFixnum, exception: RemapException, replacementRevert: { feed: Address, message: string } }
  | PriceError & { exception: null }
);

type AssetPrice = Compute.Spec<{
  name: 'assetPrice',
  depends: [ AssetInfo, GetPrice ],
  // a Comet the registry materialized, whose version states how each of its feeds is priced
  expects: Omit<AssetInfo['expects'], 'contract'> & { contract: RegistryComet },
  returns: AssetPriceRead,
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
 * How the version prices one feed: a zero or fixed price stated by the
 * registry replaces the read altogether, since the feed it describes
 * is known not to answer; a remap reads the feed it names instead,
 * and falls back on the feed it replaces, which still answers at a
 * block before the replacement was deployed. Whether that answer is one to
 * use is the reader's to decide: the totals of the summaries count it as they
 * count the answer of any feed the Comet names, and the value of a
 * collateral that discovery decides by does not, since a feed the remap
 * retired is no feed to show a token by (market-latest-summary.ts). So is
 * whether the replacement's revert is one to report: the latest summary reads
 * a block after the replacement was deployed, where a revert means it has
 * stopped answering, and reports it; the history reads days older than the
 * replacement too, where its revert is expected, and does not.
 */
type PricePlan = (
  | { fixed: BigFixnum, exception: PriceExceptionV1 }
  | { read: PriceFeedV1, fallback: null, exception: null }
  | { read: PriceFeedV1, fallback: PriceFeedV1, exception: RemapException }
);

function pricePlanOf(annotation: RegistryAnnotation, feed: PriceFeedV1): PricePlan {
  const exception = exceptionFor(annotation, feed.address);
  if (exception === null) {
    return { read: feed, fallback: null, exception };
  }
  switch (exception.kind) {
    case 'zero_price':
      return { fixed: BigFixnum.from({ decimals: feed.decimals, value: 0 }), exception };
    case 'fixed_price':
      return { fixed: BigFixnum.from({ decimals: exception.price.decimals, value: exception.price.value }), exception };
    case 'deprecated_price_remap':
      return { read: exception.replacementPriceFeed, fallback: feed, exception };
  }
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

const { implement, pipe1 } = Compute.Functor<AssetPrice>({});
const assetPrice = implement({
  // 4: where a remap fell back, naming the remap beside what its replacement reverted with
  version: 4,
  compute: ({ apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network }) => pipe1([
    { assetInfo: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network } },
    ({ priceFeed }) => {
      const annotation = contract.registry;
      const plan       = pricePlanOf(annotation, { address: priceFeed, decimals: decimalsOf(annotation, priceFeed) });
      if ('fixed' in plan) {
        return { status: 'success', price: plan.fixed, exception: plan.exception };
      }

      const frame = { apiHost, nodeHost, nodeKey, network, contract, blockNumber };
      const { read, fallback, exception } = plan;
      if (fallback === null) {
        return pipe1([ { getPrice: { ...frame, priceFeed: read } }, (price): AssetPriceRead => ({ ...price, exception: null }) ]);
      }
      /*
       * A remap reads its replacement. At a block before the replacement was
       * deployed — a day of history older than it — the replacement reverts,
       * and the feed the Comet named at that block is read instead. A revert
       * there is expected, so neither read reports its own, and the
       * replacement is reported here only when neither answers. At the
       * latest block the replacement answers, and nothing more is read,
       * unless it has stopped answering: the feed it replaces is then read
       * as at an older block. Wherever that feed answers, its price names the
       * remap it fell back from and carries the replacement's revert, for the
       * reader to value by and to report or not (PricePlan): the latest
       * summary reports it and leaves the collateral's value unknown, and the
       * history does neither (market-latest-summary.ts).
       */
      const unreported = { ...frame, unreported: true } as const;
      return pipe1([
        { getPrice: { ...unreported, priceFeed: read } },
        replaced => replaced.status === 'success' ? { ...replaced, exception } : pipe1([
          { getPrice: { ...unreported, priceFeed: fallback } },
          (own): AssetPriceRead => {
            if (own.status === 'success') {
              return { ...own, exception, replacementRevert: { feed: read.address, message: replaced.message } };
            }
            reportRevert(replaced.message, read.address, contract.address, network, blockNumber);
            return { ...replaced, exception: null };
          },
        ]),
      ]);
    },
  ]),
});

export type { AssetPriceRead };
export { AssetPrice, assetPrice, decimalsOf, exceptionFor };
