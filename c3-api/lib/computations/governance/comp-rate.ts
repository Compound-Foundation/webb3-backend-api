import { BigFixnum } from '../../bigfixnum.js';
import { BigNumber } from '../../bignumber.js';
import * as Eth      from '../../eth-constants.js';

import * as Index from '../../symbolic/index.js';

import * as abiFunction from '../abi-function.js';

type CompRate = abiFunction.Spec<{
  name: 'compRate',
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<CompRate>({});
const compRate = implement({
  version: 1,
  index: Index.Everything,
  signature: `function compRate() view returns (uint256)`,
  parser: ([ u256 ], { network }) => BigFixnum.from({
    value: BigNumber.from(u256),
    decimals: Eth.wellKnownContractsByNetwork[network]['COMP']['default'].decimals
  }),
});

export { CompRate, compRate };
