import { BigFixnum }    from '../../bigfixnum.js';
import * as abiFunction from '../abi-function.js';

import type { Utilization } from './utilization.js';

type SupplyRatePerSecond = abiFunction.Spec<{
  name: 'supplyRatePerSecond',
  depends: [ Utilization ],
  returns: BigFixnum,
}>;

const { implement, pipe1 } = abiFunction.Functor<SupplyRatePerSecond>({});
const supplyRatePerSecond = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function getSupplyRate(uint) returns (uint)`,
  parameters: ctx => [ pipe1([{ utilization: ctx }, u => u.toString()]) ],
  parser: ([ u256 ]) => BigFixnum.from({ decimals: 18, value: u256 }),
});

export { SupplyRatePerSecond, supplyRatePerSecond };
