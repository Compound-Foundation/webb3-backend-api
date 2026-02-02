import { BigFixnum }    from '../../bigfixnum.js';
import * as abiFunction from '../abi-function.js';

import type { Utilization } from './utilization.js';
import { supplyRatePerSecond } from './supply-rate-per-second.js';

type BorrowRatePerSecond = abiFunction.Spec<{
  name: 'borrowRatePerSecond',
  depends: [ Utilization ],
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<BorrowRatePerSecond>({});
const borrowRatePerSecond = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function getBorrowRate(uint) returns (uint)`,
  parameters: supplyRatePerSecond['parameters'],
  parser: supplyRatePerSecond['parser'],
});

export { BorrowRatePerSecond, borrowRatePerSecond };
