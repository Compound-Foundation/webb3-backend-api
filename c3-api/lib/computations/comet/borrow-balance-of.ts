import { BigFixnum }    from '../../bigfixnum.js';
import * as abiFunction from '../abi-function.js';
import * as Eth from '../../eth-constants.js';

import { totalSupply } from './total-supply.js';

type BorrowBalanceOf = abiFunction.Spec<{
  name: 'borrowBalanceOf',
  expects: {
    address: Eth.Address
  },
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<BorrowBalanceOf>({});
const borrowBalanceOf = implement({
  version: 1,
  signature: `function borrowBalanceOf(address) view returns (uint256)`,
  parameters: ({ address }) => [ address ],
  parser: totalSupply['parser']
});

export { BorrowBalanceOf, borrowBalanceOf };
