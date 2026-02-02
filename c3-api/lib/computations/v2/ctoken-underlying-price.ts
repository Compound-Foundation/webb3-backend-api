import * as Eth      from '../../eth-constants.js';
import * as abiFunction from '../abi-function.js';
import * as v2 from '../../model/v2.js';

import * as Index from '../../symbolic/index.js';

import type {
  CTokenv2,
  StandaloneContract,
} from '../../well-known/contracts/types.js';
import { BigNumber } from '../../bignumber.js';

type CTokenUnderlyingPrice = abiFunction.Spec<{
  name: 'cTokenUnderlyingPrice',
  expects: {
    cTokenContract:  Eth.Contract<StandaloneContract<CTokenv2>>,
  },
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<CTokenUnderlyingPrice>({});

const cTokenUnderlyingPrice = implement({
  version: 1,
  index: Index.Everything, // TODO: HourlyBlockIndex
  signature: `function cTokenUnderlyingPrice(address) returns (${v2.ctokens.CTokenUnderlyingPriceStruct})`,
  parameters: ({ cTokenContract }) => [ cTokenContract.address ],
  parser: ([ val ]) => BigNumber.from(val.underlyingPrice),
});

export { CTokenUnderlyingPrice, cTokenUnderlyingPrice };
