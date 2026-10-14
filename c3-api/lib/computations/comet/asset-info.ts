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
    // the risk parameters, unscaled as the Comet stores them: the factors at 1e18, the cap in the asset's units
    borrowCollateralFactor: BigNumber,
    liquidateCollateralFactor: BigNumber,
    liquidationFactor: BigNumber,
    supplyCap: BigNumber,
  },
}>;

const { implement } = abiFunction.Functor<AssetInfo>({});
const assetInfo = implement({
  // 1: the risk parameters of the asset beside its token, feed and scale
  version: 1,
  signature: `function getAssetInfo(uint8) view returns (${AssetInfoStructAbi} memory)`,
  parameters: ({ assetNumber }) => [ assetNumber ],
  // TODO(jordan): validate that asset, priceFeed, and scale are correct
  parser: ([{ asset, priceFeed, scale, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor, supplyCap }]) => ({
    asset,
    priceFeed,
    scale,
    borrowCollateralFactor:    BigNumber.from(borrowCollateralFactor),
    liquidateCollateralFactor: BigNumber.from(liquidateCollateralFactor),
    liquidationFactor:         BigNumber.from(liquidationFactor),
    supplyCap:                 BigNumber.from(supplyCap),
  }),
});

export { AssetInfo, assetInfo };
