import t from 'tap';

import { MemoryCache } from '../../../lib/symbolic/cache.js';
import * as Evaluator  from '../../../lib/symbolic/evaluator.js';

import * as Flags    from '../../../lib/flags.js';
import { BigNumber } from '../../../lib/bignumber.js';
import { BigFixnum } from '../../../lib/bigfixnum.js';

import '../../../shim/node-self.js';
import { AddDownToFive, addDownToFive } from '../../util/add-down-to-five.js';
import { AddDownToNum, addDownToNum } from '../../util/add-down-to-num.js';

const { evaluate, pull1 } = Evaluator.instantiate<AddDownToFive | AddDownToNum>(
  { addDownToFive, addDownToNum },
  {
    cache: new MemoryCache({}, [
      BigNumber.JsonReviver,
      BigFixnum.JsonReviver,
    ]),
    flags: Flags.parse(process.env),
  }
);

t.test('Aggregates values recursively', async (t) => {
  const actualSum = await evaluate(pull1({ addDownToFive: { val: 8 } }));
  t.equal(actualSum, 8 + 7 + 6);
});

t.test('Skips when cursor is equal to base/start case', async (t) => {
  const actualSum = await evaluate(pull1({ addDownToFive: { val: 5 } }));
  t.equal(actualSum, 0);
});

t.test('Fails loudly when cursor is out of bounds', async (t) => {
  t.rejects(evaluate(pull1({ addDownToFive: { val: 4 } })));
});

t.test('Recurses upon an index instanstiated from the context', async (t) => {
  const actualSum = await evaluate(pull1({ addDownToNum: { start: 10, val: 15 } }));
  t.equal(actualSum, 65);
});
