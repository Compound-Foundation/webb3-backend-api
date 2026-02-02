import { BigNumber } from '@ethersproject/bignumber';

import * as abiFunction from '../abi-function.js';

type BaseTrackingBorrowSpeed = abiFunction.Spec<{
  name: 'baseTrackingBorrowSpeed',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<BaseTrackingBorrowSpeed>({});
const baseTrackingBorrowSpeed = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function baseTrackingBorrowSpeed() view returns (uint256)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { BaseTrackingBorrowSpeed, baseTrackingBorrowSpeed };
