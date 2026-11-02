import { BigNumber }    from '@ethersproject/bignumber';

import * as abiFunction from '../../abi-function.js';

type SupplyKink = abiFunction.Spec<{
  name: 'supplyKink',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<SupplyKink>({});

const supplyKink = implement({
  version: 1,
  signature: `function supplyKink() returns (uint)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { SupplyKink, supplyKink };
