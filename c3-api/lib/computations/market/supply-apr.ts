import { BigFixnum } from '../../bigfixnum.js';
import * as Compute  from '../../symbolic/computation.js';
import * as Constant from '../../constants.js';

import type { SupplyRatePerSecond }  from '../comet.js';

type SupplyApr = Compute.Spec<{
  name: 'supplyApr',
  depends: [ SupplyRatePerSecond ],
  expects: SupplyRatePerSecond['expects'],
  returns: BigFixnum,
}>;

const { implement, pipe1 } = Compute.Functor<SupplyApr>({});
const supplyApr = implement({
  version: 1,
  compute(ctx) {
    return pipe1([
      { supplyRatePerSecond: ctx },
      rate => rate.mul(Constant.secondsPerYear)
    ]);
  }
});

export { SupplyApr, supplyApr };
