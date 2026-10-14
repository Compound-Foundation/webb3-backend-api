import { BigNumber }    from '@ethersproject/bignumber';

import * as abiFunction from '../../abi-function.js';

type BorrowPerSecondInterestRateBase = abiFunction.Spec<{
  name: 'borrowPerSecondInterestRateBase',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<BorrowPerSecondInterestRateBase>({});

const borrowPerSecondInterestRateBase = implement({
  version: 1,
  signature: `function borrowPerSecondInterestRateBase() returns (uint)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { BorrowPerSecondInterestRateBase, borrowPerSecondInterestRateBase };
