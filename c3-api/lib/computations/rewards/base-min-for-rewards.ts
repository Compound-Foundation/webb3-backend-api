import { BigNumber } from '@ethersproject/bignumber';

import * as abiFunction from '../abi-function.js';

type BaseMinForRewards = abiFunction.Spec<{
  name: 'baseMinForRewards',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<BaseMinForRewards>({});
const baseMinForRewards = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function baseMinForRewards() view returns (uint256)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { BaseMinForRewards, baseMinForRewards };
