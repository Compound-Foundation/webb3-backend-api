import * as Eth      from '../../eth-constants.js';
import { BigNumber } from '../../bignumber.js';
import { BigFixnum } from '../../bigfixnum.js';

import * as Index from '../../symbolic/index.js';

import * as abiFunction from '../abi-function.js';

import type { CTokenv2, StandaloneContract } from '../../well-known/contracts/types.js';

type CompBorrowSpeeds = abiFunction.Spec<{
  name: 'compBorrowSpeeds',
  expects: {
    cToken:  Eth.Contract<StandaloneContract<CTokenv2>>,
    contract: Eth.Contract<StandaloneContract>, // Comptroller
  },
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<CompBorrowSpeeds>({});

const compBorrowSpeeds = implement({
  version: 1,
  index: Index.Everything,
  signature: `function compBorrowSpeeds(address) view returns (uint)`,
  parameters: ({ cToken }) => [ cToken.address ],
  parser: ([ u256 ], { network }) => BigFixnum.from({
    value:    BigNumber.from(u256),
    decimals: (Eth.wellKnownContractsByNetwork[network] as any)['COMP']['default'].decimals,
  }),
});

export { CompBorrowSpeeds, compBorrowSpeeds };
