import { BigFixnum }    from '../../bigfixnum.js';
import * as abiFunction from '../abi-function.js';

import { totalSupply } from './total-supply.js';

type TotalBorrow = abiFunction.Spec<{
  name: 'totalBorrow',
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<TotalBorrow>({});
const totalBorrow = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function totalBorrow() view returns (uint256)`,
  parser: totalSupply['parser'],
});

export { TotalBorrow, totalBorrow };
