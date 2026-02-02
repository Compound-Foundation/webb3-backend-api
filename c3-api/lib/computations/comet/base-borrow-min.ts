import { BigFixnum }    from '../../bigfixnum.js';
import * as abiFunction from '../abi-function.js';

import { totalSupply } from './total-supply.js';

type BaseBorrowMin = abiFunction.Spec<{
  name: 'baseBorrowMin',
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<BaseBorrowMin>({});
const baseBorrowMin = implement({
  version: 1,
  signature: `function baseBorrowMin() view returns (uint)`,
  parser: totalSupply['parser'],
});

export { BaseBorrowMin, baseBorrowMin };
