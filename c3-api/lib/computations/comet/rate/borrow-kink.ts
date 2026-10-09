import { BigNumber }    from '@ethersproject/bignumber';

import * as Fallible from "../../../fallible/fallible";
import * as Key from "../../../symbolic/key";

import * as abiFunction from '../../abi-function.js';

type BorrowKink = abiFunction.Spec<{
  name: 'borrowKink',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<BorrowKink>({});

const borrowKink = implement({
  version: 1,
  signature: `function borrowKink() returns (uint)`,
  key(name, { blockNumber, ...context }) {
    const { blockNumber: projected } = Fallible.must(this.index.project({ blockNumber, ...context }));
    return Key.toKey(name, { block: projected, ...context });
  },
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { BorrowKink, borrowKink };
