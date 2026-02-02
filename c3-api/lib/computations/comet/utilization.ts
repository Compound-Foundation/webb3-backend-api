import { BigNumber }    from '@ethersproject/bignumber';
import * as abiFunction from '../abi-function.js';

type Utilization = abiFunction.Spec<{
  name: 'utilization',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<Utilization>({});
const utilization = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function getUtilization() returns (uint256)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { Utilization, utilization };
