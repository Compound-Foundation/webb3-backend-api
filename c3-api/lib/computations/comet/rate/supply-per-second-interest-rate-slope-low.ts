import { BigNumber }    from '@ethersproject/bignumber';

import * as abiFunction from '../../abi-function.js';

type SupplyPerSecondInterestRateSlopeLow = abiFunction.Spec<{
  name: 'supplyPerSecondInterestRateSlopeLow',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<SupplyPerSecondInterestRateSlopeLow>({});

const supplyPerSecondInterestRateSlopeLow = implement({
  version: 1,
  signature: `function supplyPerSecondInterestRateSlopeLow() returns (uint)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { SupplyPerSecondInterestRateSlopeLow, supplyPerSecondInterestRateSlopeLow };
