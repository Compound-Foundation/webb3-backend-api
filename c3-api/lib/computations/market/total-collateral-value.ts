import { BigFixnum } from '../../bigfixnum.js';
import * as Compute  from '../../symbolic/computation.js';

import type {
  NumAssets,
  AssetPrice,
  AssetTotalCollateral,
} from '../comet.js';

type TotalCollateralValue = Compute.Spec<{
  name: 'totalCollateralValue',
  depends: [ AssetTotalCollateral, NumAssets, AssetPrice ],
  expects: NumAssets['expects'],
  returns: BigFixnum,
}>;

const { implement, join, pipe1, pull } = Compute.Functor<TotalCollateralValue>({});
const totalCollateralValue = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  compute({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) {
    return pipe1([
      { numAssets: { apiHost, nodeHost, nodeKey, blockNumber, contract, network } },
      numAssets => join([
        Array.from({ length: numAssets }, (_, assetNumber) => {
          return pull({
            assetTotalCollateral: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network },
            assetPrice: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network },
          });
        }),
        results => results.reduce(
          (sum: BigFixnum, { assetTotalCollateral, assetPrice }) => {
            return sum.add(assetTotalCollateral.mul(assetPrice));
          },
          BigFixnum.from({ value: 0 }),
        ),
      ]),
    ]);
  },
});

export { TotalCollateralValue, totalCollateralValue };
