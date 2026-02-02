import * as Eth      from '../../eth-constants.js';
import { BigNumber } from '../../bignumber.js';
import { BigFixnum } from '../../bigfixnum.js';

import * as Index from '../../symbolic/index.js';

import * as abiFunction from '../abi-function.js';

import type { CTokenv2, StandaloneContract } from '../../well-known/contracts/types.js';

type CompSupplySpeeds = abiFunction.Spec<{
  name: 'compSupplySpeeds',
  expects: {
    cToken:  Eth.Contract<StandaloneContract<CTokenv2>>,
    contract: Eth.Contract<StandaloneContract>, // Comptroller
  },
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<CompSupplySpeeds>({});

const compSupplySpeeds = implement({
  version: 1,
  index: Index.Everything,
  signature: `function compSupplySpeeds(address) view returns (uint)`,
  parameters: ({ cToken }) => [ cToken.address ],
  parser: ([ u256 ], { network }) => BigFixnum.from({
    value:    BigNumber.from(u256),
    decimals: Eth.wellKnownContractsByNetwork[network]['COMP']['default'].decimals,
  }),
});

export { CompSupplySpeeds, compSupplySpeeds };
