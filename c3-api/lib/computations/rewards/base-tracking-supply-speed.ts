import { BigNumber } from '@ethersproject/bignumber';

import * as abiFunction from '../abi-function.js';

type BaseTrackingSupplySpeed = abiFunction.Spec<{
  name: 'baseTrackingSupplySpeed',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<BaseTrackingSupplySpeed>({});
const baseTrackingSupplySpeed = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function baseTrackingSupplySpeed() view returns (uint256)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { BaseTrackingSupplySpeed, baseTrackingSupplySpeed };
