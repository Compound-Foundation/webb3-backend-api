import * as Compute from '../../symbolic/computation.js';
import type { AssetInfo } from './asset-info.js';
import type { NumAssets, AssetPrice, AssetTotalCollateral, Symbol } from '../comet.js';

type CollateralAssetSymbols = Compute.Spec<{
  name: 'collateralAssetSymbols';
  depends: [AssetTotalCollateral, NumAssets, AssetPrice, AssetInfo, Symbol];
  expects: NumAssets['expects'];
  returns: string[];
}>;

const { implement, pipe1, pull1, join } = Compute.Functor<CollateralAssetSymbols>(
  {}
);
const collateralAssetSymbols = implement({
  version: 1,
  compute({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) {
    return pipe1([
      { numAssets: { apiHost, nodeHost, nodeKey, blockNumber, contract, network } },
      (numAssets) =>
        join([
          Array.from({ length: numAssets }, (_, assetNumber) => {
            return pipe1([
              {
                assetInfo: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network },
              },
              ({ asset }) =>
                pull1({
                  // @ts-expect-error Only address is required
                  symbol: { contract: {
                    address: asset,
                  }, blockNumber, network, apiHost, nodeHost, nodeKey },
                }),
            ]);
          }), 
          (symbol) => symbol as string[],
        ]
        ),
    ]);
  },
});

export { CollateralAssetSymbols, collateralAssetSymbols };
