import { BigNumber }    from '@ethersproject/bignumber';

import * as abiFunction from '../../abi-function.js';

type BorrowPerSecondInterestRateSlopeLow = abiFunction.Spec<{
  name: 'borrowPerSecondInterestRateSlopeLow',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<BorrowPerSecondInterestRateSlopeLow>({});

const borrowPerSecondInterestRateSlopeLow = implement({
  version: 1,
  signature: `function borrowPerSecondInterestRateSlopeLow() returns (uint)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { BorrowPerSecondInterestRateSlopeLow, borrowPerSecondInterestRateSlopeLow };
