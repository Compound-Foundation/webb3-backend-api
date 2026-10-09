import { BigNumber }    from '@ethersproject/bignumber';

import * as Fallible from "../../../fallible/fallible";
import * as Key from "../../../symbolic/key";

import * as abiFunction from '../../abi-function.js';

type BorrowPerSecondInterestRateBase = abiFunction.Spec<{
  name: 'borrowPerSecondInterestRateBase',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<BorrowPerSecondInterestRateBase>({});

const borrowPerSecondInterestRateBase = implement({
  version: 1,
  signature: `function borrowPerSecondInterestRateBase() returns (uint)`,
  key(name, { blockNumber, ...context }) {
    const { blockNumber: projected } = Fallible.must(this.index.project({ blockNumber, ...context }));
    return Key.toKey(name, { block: projected, ...context });
  },
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { BorrowPerSecondInterestRateBase, borrowPerSecondInterestRateBase };
