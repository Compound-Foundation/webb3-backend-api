import { BigFixnum } from '../../bigfixnum.js';
import * as Compute  from '../../symbolic/computation.js';
import * as Constant from '../../constants.js';

import type { BorrowRatePerSecond } from '../comet.js';

type BorrowApr = Compute.Spec<{
  name: 'borrowApr',
  depends: [ BorrowRatePerSecond ],
  expects: BorrowRatePerSecond['expects'],
  returns: BigFixnum,
}>;

const { implement, pipe1 } = Compute.Functor<BorrowApr>({});
const borrowApr = implement({
  version: 1,
  compute(ctx) {
    return pipe1([
      { borrowRatePerSecond: ctx },
      rate => rate.mul(Constant.secondsPerYear)
    ]);
  }
});

export { BorrowApr, borrowApr };
