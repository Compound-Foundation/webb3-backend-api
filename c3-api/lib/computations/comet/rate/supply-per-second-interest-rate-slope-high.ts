import { BigNumber }    from '@ethersproject/bignumber';

import * as abiFunction from '../../abi-function.js';

type SupplyPerSecondInterestRateSlopeHigh = abiFunction.Spec<{
  name: 'supplyPerSecondInterestRateSlopeHigh',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<SupplyPerSecondInterestRateSlopeHigh>({});

const supplyPerSecondInterestRateSlopeHigh = implement({
  version: 1,
  signature: `function supplyPerSecondInterestRateSlopeHigh() returns (uint)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { SupplyPerSecondInterestRateSlopeHigh, supplyPerSecondInterestRateSlopeHigh };
