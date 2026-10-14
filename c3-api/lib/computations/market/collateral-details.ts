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

import type { Collateral } from './collaterals.js';

/*
 * Every collateral asset of a market, in the order the Comet numbers them:
 * what it is, how much of it the market holds, and its price or why that
 * could not be read. The summary's collateral value and its report of which
 * collateral could not be priced both come from this one pass, so each read
 * is made once — an evaluator that does not remember what it computed would
 * otherwise make every one of them twice.
 *
 * What a collateral is — its token and its symbol — is what the registry
 * version says, never what the token answers: a token whose symbol() answers
 * a bytes32, as MKR's does, would otherwise fail the summary of its whole
 * network, and the version read it once, either way, when it was imported.
 * What the market holds of it, and the feed it is priced with, are the
 * Comet's at the block summarized (asset-price.ts). A collateral the Comet
 * had not listed yet at that block is left out, as is one the version does
 * not describe: until a version does, nothing says what it is.
 */
type CollateralDetails = Compute.Spec<{
  name: 'collateralDetails',
  depends: [ NumAssets, AssetInfo, AssetTotalCollateral, AssetPrice ],
  // a Comet the registry materialized, whose version states what its collateral is and how it is priced
  expects: Omit<NumAssets['expects'], 'contract'> & { contract: RegistryComet },
  returns: Collateral[],
}>;

const { implement, join, pipe, pipe1, value } = Compute.Functor<CollateralDetails>({});
const collateralDetails = implement({
  // 2: without each collateral's reserves, supply cap and factors
  version: 2,
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
                    totalCollateral: BigFixnum.from({ value: 0 }),
                    price: {
                      status:  'error',
                      message: `asset ${assetNumber} of the Comet is ${asset}, not the ${position.token.symbol} the registry version describes`,
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

export { CollateralDetails, collateralDetails };
