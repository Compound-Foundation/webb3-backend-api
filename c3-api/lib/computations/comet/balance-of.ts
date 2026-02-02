import { BigFixnum }    from '../../bigfixnum.js';
import * as abiFunction from '../abi-function.js';
import * as Eth from '../../eth-constants.js';
import * as Key from '../../symbolic/key.js';

import { totalSupply } from './total-supply.js';

type BalanceOf = abiFunction.Spec<{
  name: 'balanceOf',
  expects: {
    address: Eth.Address
  },
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<BalanceOf>({});
const balanceOf = implement({
  version: 1,
  signature: `function balanceOf(address) view returns (uint256)`,
  key(name, { address, ...context }) {
    return Key.toKey(name, { address: address, ...context });
  },
  parameters: ({ address }) => [address],
  parser: totalSupply['parser']
});

export { BalanceOf, balanceOf };
