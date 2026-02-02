import * as Eth      from '../../eth-constants.js';
import { BigNumber } from '../../bignumber.js';
import { BigFixnum } from '../../bigfixnum.js';

import * as abiFunction from '../abi-function.js';

import type {
  ERC20,
  StandaloneContract,
} from '../../well-known/contracts/types.js';

type Erc20Balance = abiFunction.Spec<{
  name: 'erc20Balance',
  expects: {
    account:  Eth.Address,
    contract: Eth.Contract<StandaloneContract<ERC20>>,
  },
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<Erc20Balance>({});

const erc20Balance = implement({
  version: 1,
  signature: `function balanceOf(address) view returns (uint)`,
  parameters: ({ account }) => [ account ],
  parser: ([ u256 ], { contract }) => BigFixnum.from({
    value:    BigNumber.from(u256),
    decimals: contract.decimals,
  }),
});

export { Erc20Balance, erc20Balance };
