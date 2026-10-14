import { BigNumber } from '@ethersproject/bignumber';

import * as Eth         from '../../eth-constants.js';
import * as abiFunction from '../abi-function.js';

const AssetInfoStructAbi = `tuple(
  uint8 offset,
  address asset,
  address priceFeed,
  uint64 scale,
  uint64 borrowCollateralFactor,
  uint64 liquidateCollateralFactor,
  uint64 liquidationFactor,
  uint128 supplyCap
)`;
type AssetInfo = abiFunction.Spec<{
  name: 'assetInfo',
  expects: { assetNumber: number },
  returns: {
    asset: Eth.Address,
    scale: BigNumber,
    priceFeed: Eth.Address,
  },
}>;

const { implement } = abiFunction.Functor<AssetInfo>({});
const assetInfo = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function getAssetInfo(uint8) view returns (${AssetInfoStructAbi} memory)`,
  parameters: ({ assetNumber }) => [ assetNumber ],
  // TODO(jordan): validate that asset, priceFeed, and scale are correct
  parser: ([{ asset, priceFeed, scale }]) => ({ asset, priceFeed, scale }),
});

export { AssetInfo, assetInfo };
