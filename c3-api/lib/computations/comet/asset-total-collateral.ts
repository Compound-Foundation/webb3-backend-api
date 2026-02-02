import { BigFixnum }    from '../../bigfixnum.js';
import * as abiFunction from '../abi-function.js';

import type { AssetInfo } from './asset-info.js';

type AssetTotalCollateral = abiFunction.Spec<{
  name: 'assetTotalCollateral',
  depends: [ AssetInfo ],
  expects: { assetNumber: number },
  returns: BigFixnum,
}>;

const { implement, pipe1 } = abiFunction.Functor<AssetTotalCollateral>({});
const assetTotalCollateral = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function totalsCollateral(address) view returns (uint128)`,
  parameters: ({ apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network }) => [
    pipe1([
      { assetInfo: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network } },
      ({ asset }) => asset,
    ]),
  ],
  parser: ([ u128 ], { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network }) => pipe1([
    { assetInfo: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network } },
    ({ scale: multiplier }) => BigFixnum.from({ multiplier, value: u128 }),
  ]),
});

export { AssetTotalCollateral, assetTotalCollateral };
