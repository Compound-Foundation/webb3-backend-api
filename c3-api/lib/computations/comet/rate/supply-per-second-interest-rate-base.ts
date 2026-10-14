import { BigNumber }    from '@ethersproject/bignumber';

import * as abiFunction from '../../abi-function.js';

type SupplyPerSecondInterestRateBase = abiFunction.Spec<{
  name: 'supplyPerSecondInterestRateBase',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<SupplyPerSecondInterestRateBase>({});

const supplyPerSecondInterestRateBase = implement({
  version: 1,
  signature: `function supplyPerSecondInterestRateBase() returns (uint)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { SupplyPerSecondInterestRateBase, supplyPerSecondInterestRateBase };
