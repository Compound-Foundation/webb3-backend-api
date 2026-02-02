import { BigFixnum }    from '../../bigfixnum.js';
import * as abiFunction from '../abi-function.js';

import { Comet } from '../../well-known/contracts/types.js';

type TotalSupply = abiFunction.Spec<{
  name: 'totalSupply',
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<TotalSupply>({});
const totalSupply = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function totalSupply() view returns (uint256)`,
  parser: ([ u256 ], { contract }) => {
    if (!Comet.is(contract)) {
      throw new Error(`invariant violated: contract is not a Comet contract`);
    }
    return BigFixnum.from({ value: u256, decimals: contract.base.asset.decimals });
  },
});

export { TotalSupply, totalSupply };
