import { BigNumber }    from '@ethersproject/bignumber';

import * as abiFunction from '../../abi-function.js';

type BorrowPerSecondInterestRateSlopeHigh = abiFunction.Spec<{
  name: 'borrowPerSecondInterestRateSlopeHigh',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<BorrowPerSecondInterestRateSlopeHigh>({});

const borrowPerSecondInterestRateSlopeHigh = implement({
  version: 1,
  signature: `function borrowPerSecondInterestRateSlopeHigh() returns (uint)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { BorrowPerSecondInterestRateSlopeHigh, borrowPerSecondInterestRateSlopeHigh };
