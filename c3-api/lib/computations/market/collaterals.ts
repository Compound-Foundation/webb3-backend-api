import * as Eth     from '../../eth-constants.js';
import * as Compute from '../../symbolic/computation.js';

import { BigFixnum } from '../../bigfixnum.js';

import type { RegistryComet } from '../../model/comet-registry.js';
import { checksumAddress, normalizeAddress } from '../../model/comet-registry.js';

import type {
  AssetInfo,
  AssetPrice,
  AssetTotalCollateral,
  NumAssets,
} from '../comet.js';
import type { AssetPriceRead } from '../comet/asset-price.js';

/*
 * Every collateral asset of a market, in the order the Comet numbers them:
 * what it is, how much of it the market holds, and its price or why that
 * could not be read, with the exception of the registry that priced it, or
 * the remap that fell back on the feed it replaces (asset-price.ts). The
 * summary's collateral value, the value of each collateral, and its report of
 * which collateral could not be priced all come from this one pass, so each
 * read is made once — an evaluator that does not remember what it computed
 * would otherwise make every one of them twice.
 *
 * What a collateral is — its token and its symbol — is what the registry
 * version says, never what the token answers: a token whose symbol() answers
 * a bytes32, as MKR's does, would otherwise fail the summary of its whole
 * network, and the version read it once, either way, when it was imported.
 * What the market holds of it, and the feed it is priced with, are the
 * Comet's at the block summarized, which for a past block may be a feed the
 * market has since moved off (asset-price.ts). A collateral the Comet had not
 * listed yet at that block is left out, as is one the version does not
 * describe: until a version does, nothing says what it is.
 */
type Collateral = { asset: Eth.Address, symbol: string } & (
  // the Comet holds another asset at the collateral's index, so what it holds of this one was not read, nor its price
  | { totalCollateral: null, price: Extract<AssetPriceRead, { status: 'error' }> }
  | { totalCollateral: BigFixnum, price: AssetPriceRead }
);

type Collaterals = Compute.Spec<{
  name: 'collaterals',
  depends: [ NumAssets, AssetInfo, AssetTotalCollateral, AssetPrice ],
  // a Comet the registry materialized, whose version states what its collateral is and how it is priced
  expects: Omit<NumAssets['expects'], 'contract'> & { contract: RegistryComet },
  returns: Collateral[],
}>;

const { implement, join, pipe, pipe1, value } = Compute.Functor<Collaterals>({});
const collaterals = implement({
  // 4: where a remap fell back, its price naming the remap
  version: 4,
  compute({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) {
    const frame = { apiHost, nodeHost, nodeKey, blockNumber, contract, network };
    return pipe1([
      { numAssets: frame },
      numAssets => join([
        contract.registry.market.collateralAssets
          .filter(position => position.assetIndex < numAssets)
          .map(position => {
            const assetNumber = position.assetIndex;
            const identity    = { asset: checksumAddress(position.token.address), symbol: position.token.symbol };
            return pipe1([
              { assetInfo: { ...frame, assetNumber } },
              /*
               * A Comet keeps an asset at its index, so another asset there
               * is a version that no longer describes the market: what the
               * Comet holds there is not the token reported, and is neither
               * named nor valued as it.
               */
              ({ asset }) => normalizeAddress(asset) !== position.token.address
                ? value<Collateral>({
                    ...identity,
                    totalCollateral: null,
                    price: {
                      status:    'error',
                      message:   `asset ${assetNumber} of the Comet is ${asset}, not the ${position.token.symbol} the registry version describes`,
                      exception: null,
                    },
                  })
                : pipe([
                    {
                      assetTotalCollateral: { ...frame, assetNumber },
                      assetPrice:           { ...frame, assetNumber },
                    },
                    ({ assetTotalCollateral, assetPrice }): Collateral => ({
                      ...identity,
                      totalCollateral: assetTotalCollateral,
                      price:           assetPrice,
                    }),
                  ]),
            ]);
          }),
        results => results as Collateral[],
      ]),
    ]);
  },
});

/*
 * What the market holds of a collateral at its price, in the unit its feed
 * answers in, or null where either was not read: the one product the totals
 * and the value of each collateral are made of (market-latest-summary.ts), so
 * the values that are known add up to the total, but for a price a remap's
 * fallback gave, which the totals count and no value is made of.
 */
function quotedOf({ totalCollateral, price }: Collateral): BigFixnum | null {
  return totalCollateral === null || price.status === 'error' ? null : totalCollateral.mul(price.price);
}

// what the market holds of the collaterals that could be priced, in the unit their feeds answer in
function collateralValue(collaterals: Collateral[]): BigFixnum {
  return collaterals.reduce((sum, collateral) => {
    const quoted = quotedOf(collateral);
    return quoted === null ? sum : sum.add(quoted);
  }, BigFixnum.from({ value: 0 }));
}

export { Collateral, Collaterals, collateralValue, collaterals, quotedOf };
