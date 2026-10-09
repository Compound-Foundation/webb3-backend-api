import { BigNumber }    from '@ethersproject/bignumber';

import * as Fallible from "../../../fallible/fallible";
import * as Key from "../../../symbolic/key";

import * as abiFunction from '../../abi-function.js';

type SupplyPerSecondInterestRateBase = abiFunction.Spec<{
  name: 'supplyPerSecondInterestRateBase',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<SupplyPerSecondInterestRateBase>({});

const supplyPerSecondInterestRateBase = implement({
  version: 1,
  signature: `function supplyPerSecondInterestRateBase() returns (uint)`,
  key(name, { blockNumber, ...context }) {
    const { blockNumber: projected } = Fallible.must(this.index.project({ blockNumber, ...context }));
    return Key.toKey(name, { block: projected, ...context });
  },
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { SupplyPerSecondInterestRateBase, supplyPerSecondInterestRateBase };
