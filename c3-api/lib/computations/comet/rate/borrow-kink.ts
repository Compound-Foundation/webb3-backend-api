import { BigNumber }    from '@ethersproject/bignumber';

import * as abiFunction from '../../abi-function.js';

type BorrowKink = abiFunction.Spec<{
  name: 'borrowKink',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<BorrowKink>({});

const borrowKink = implement({
  version: 1,
  signature: `function borrowKink() returns (uint)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { BorrowKink, borrowKink };
