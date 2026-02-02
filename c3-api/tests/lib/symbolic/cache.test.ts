import t from 'tap';

import { MemoryKv  } from '../../util/kv.js';

import * as Flags    from '../../../lib/flags.js';
import { BigNumber } from '../../../lib/bignumber.js';
import { BigFixnum } from '../../../lib/bigfixnum.js';

import * as Evaluator from '../../../lib/symbolic/evaluator.js';
import {
  Cache,
  MemoryCache,
  WorkersKvCache,
} from '../../../lib/symbolic/cache.js';

import {
  getNum,
  GetNum,
  getNumDefaultCache,
  GetNumDefaultCache,
} from '../../util/get-num.js';

const simpleCases = {
  'number':  123.789,
  'string':  'hello, world',
  'boolean': false,
  'array':   [ 123.789, 'abc', false ],
  'object':  { a: { b: { c: [ false, 7, 14.1 ], d: 'abc' } } },
};

async function testGetsWhatWasPut(
  t: Tap.Test,
  cache: Cache,
  cases: { [key: string]: any },
) {
  return Promise.all(Object.entries(cases).map(async ([ key, value ]) => {
    await cache.put(key, value);
    t.strictSame(await cache.get(key), value);
  }));
}

t.test('WorkersKvCache wraps a Workers KVNamespace', async t => {
  const cache = new WorkersKvCache(MemoryKv({}));
  await testGetsWhatWasPut(t, cache, { testKey: 5 });
});

t.test('WorkersKvCache parses JSON', async t => {
  const cache = new WorkersKvCache(MemoryKv({}));
  await testGetsWhatWasPut(t, cache, { ...simpleCases });
});

t.test('WorkersKvCache supports custom JSON revivers', async t => {
  const cache = new WorkersKvCache(MemoryKv({}), [BigNumber.JsonReviver]);
  await testGetsWhatWasPut(t, cache, {
    ...simpleCases,
    bignumber: BigNumber.from('123784590732891047839207587341493021849'),
  });
  t.ok(BigNumber.isBigNumber(await cache.get('bignumber')));
});

t.test('Only cache on indices', async t => {
  const cache = new MemoryCache({}, [
    BigNumber.JsonReviver,
    BigFixnum.JsonReviver,
  ]);
  const { evaluate, pull1, split } = Evaluator.instantiate<GetNum>({ getNum }, {
    cache,
    flags: Flags.parse(process.env),
  });

  // Evaluate 4 inputs across the following index.
  const indexParams = {start: 0, end: 10, stride: 5}
  const results = await evaluate(split([
    pull1({ getNum: { ...indexParams, val: 5  } }),
    pull1({ getNum: { ...indexParams, val: 7  } }),
    pull1({ getNum: { ...indexParams, val: 10 } }),
    pull1({ getNum: { ...indexParams, val: 15 } }),
  ]));

  // Should get all 4 values back as expected.
  t.same(results, [ 5, 7, 10, 15 ]);

  // Only the inputs that fall on the index (5, 10) should get cached.
  const key = (val: number) => getNum.key('getNum-v1', { ...indexParams, val });
  t.equal(await cache.get(await key(5)),     5);
  t.equal(await cache.get(await key(10)),   10);
  t.equal(await cache.get(await key(7)),  null);
  t.equal(await cache.get(await key(15)), null);
});

t.test('cache none when using default index', async t => {
  const cache = new MemoryCache({}, [
    BigNumber.JsonReviver,
    BigFixnum.JsonReviver,
  ]);
  const { evaluate, pull1, split } = Evaluator.instantiate<GetNumDefaultCache>(
    { getNumDefaultCache },
    {
      cache,
      flags: Flags.parse(process.env),
    }
  );

  // Evaluate 4 inputs across the following index.
  const results = await evaluate(split([
    pull1({ getNumDefaultCache: { val: 5  } }),
    pull1({ getNumDefaultCache: { val: 7  } }),
    pull1({ getNumDefaultCache: { val: 10 } }),
    pull1({ getNumDefaultCache: { val: 15 } }),
  ]));

  // Should get all 4 values back as expected.
  t.same(results, [ 5, 7, 10, 15 ]);

  // Should cache no results
  t.same(Object.keys(cache.store), []);
});
