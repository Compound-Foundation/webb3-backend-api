import type { BigNumber } from '@ethersproject/bignumber';

import * as Compute from '../../symbolic/computation.js';

import { BigFixnum } from '../../bigfixnum.js';

import type { RegistryComet } from '../../model/comet-registry.js';
import { checksumAddress, normalizeAddress } from '../../model/comet-registry.js';

import type {
  AssetInfo,
  AssetPrice,
  AssetTotalCollateral,
  CollateralReserves,
  NumAssets,
} from '../comet.js';

import type { Collateral } from './collaterals.js';

/*
 * Every collateral asset of a market, in the order the Comet numbers them:
 * what it is, how much of it the market holds, its price or why that could
 * not be read, and the parameters the Comet keeps for it. The summary's
 * collateral value and its report of which collateral could not be priced
 * both come from this one pass, so each read is made once — an evaluator
 * that does not remember what it computed would otherwise make every one of
 * them twice.
 *
 * What a collateral is — its token and its symbol — is what the registry
 * version says, never what the token answers: a token whose symbol() answers
 * a bytes32, as MKR's does, would otherwise fail the summary of its whole
 * network, and the version read it once, either way, when it was imported.
 * What the market holds of it, its parameters, and the feed it is priced
 * with, are the Comet's at the block summarized (asset-price.ts). A
 * collateral the Comet had not listed yet at that block is left out, as is
 * one the version does not describe: until a version does, nothing says what
 * it is.
 *
 * The cap and the factors are what getAssetInfoByAddress(asset) answers. The
 * Comet finds that by looping over getAssetInfo(i) and answers its struct,
 * so they are taken from the read of the index that already names the asset
 * and its feed: no call of their own, and none that reverts, as that one
 * does, for a token the Comet does not hold. The reserves are asked for by
 * the address that read answered, which a revert names in the log
 * (reserves.ts).
 */
type CollateralParameters = {
  reserves:                  BigNumber | null, // null where the Comet's read of them reverted
  supplyCap:                 BigNumber,
  borrowCollateralFactor:    BigNumber,
  liquidateCollateralFactor: BigNumber,
  liquidationFactor:         BigNumber,
};

type CollateralDetail = Collateral & {
  // null where the Comet holds another asset at the index the version describes
  parameters: CollateralParameters | null,
};

type CollateralDetails = Compute.Spec<{
  name: 'collateralDetails',
  depends: [ NumAssets, AssetInfo, AssetTotalCollateral, AssetPrice, CollateralReserves ],
  // a Comet the registry materialized, whose version states what its collateral is and how it is priced
  expects: Omit<NumAssets['expects'], 'contract'> & { contract: RegistryComet },
  returns: CollateralDetail[],
}>;

const { implement, join, pipe, pipe1, value } = Compute.Functor<CollateralDetails>({});
const collateralDetails = implement({
  version: 1,
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
               * named nor valued as it, nor reported with its parameters.
               */
              info => normalizeAddress(info.asset) !== position.token.address
                ? value<CollateralDetail>({
                    ...identity,
                    totalCollateral: BigFixnum.from({ value: 0 }),
                    price: {
                      status:  'error',
                      message: `asset ${assetNumber} of the Comet is ${info.asset}, not the ${position.token.symbol} the registry version describes`,
                    },
                    parameters: null,
                  })
                : pipe([
                    {
                      assetTotalCollateral: { ...frame, assetNumber },
                      assetPrice:           { ...frame, assetNumber },
                      collateralReserves:   { ...frame, asset: info.asset },
                    },
                    ({ assetTotalCollateral, assetPrice, collateralReserves }): CollateralDetail => ({
                      ...identity,
                      totalCollateral: assetTotalCollateral,
                      price:           assetPrice,
                      parameters: {
                        reserves:                  collateralReserves,
                        supplyCap:                 info.supplyCap,
                        borrowCollateralFactor:    info.borrowCollateralFactor,
                        liquidateCollateralFactor: info.liquidateCollateralFactor,
                        liquidationFactor:         info.liquidationFactor,
                      },
                    }),
                  ]),
            ]);
          }),
        results => results as CollateralDetail[],
      ]),
    ]);
  },
});

export type { CollateralDetail };
export { CollateralDetails, collateralDetails };
