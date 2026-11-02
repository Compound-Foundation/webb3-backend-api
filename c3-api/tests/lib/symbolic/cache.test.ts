import t, { Test } from 'tap';

import { MemoryKv, refusingKv } from '../../util/kv.js';

import Quota         from '../../../lib/quota.js';
import * as Debug    from '../../../lib/debug-log.js';
import * as Flags    from '../../../lib/flags.js';
import { BigNumber } from '../../../lib/bignumber.js';
import { BigFixnum } from '../../../lib/bigfixnum.js';

import * as Evaluator from '../../../lib/symbolic/evaluator.js';
import {
  Cache,
  LayersCache,
  MemoryCache,
  QuotaCache,
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
  t: Test,
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

/*
 * The logger a request gives the cache, configured as the entrypoint
 * configures it, and the warnings it writes.
 */
function warnings(t: Test): { debug: Debug.Logger, lines: string[] } {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...parameters: unknown[]) => { lines.push(parameters.map(String).join(' ')); };
  t.teardown(() => { console.warn = warn; });
  return { debug: Debug.MakeLogger([]).configure({}), lines };
}

/*
 * A call KV refuses — a 429 when a key is written twice in a second, a 503
 * when KV does not answer — costs the computation its cache, not the request.
 */
t.test('WorkersKvCache answers a read KV refuses as a miss, and says so', async t => {
  const { debug, lines } = warnings(t);
  const kv = MemoryKv({});
  await kv.put('cached', '5');
  const cache = new WorkersKvCache(refusingKv(kv, method => method === 'get'), [], debug);

  t.equal(await cache.get('cached'), null, 'what KV holds is not read, so it is computed again');
  t.same(lines, [ 'computation cache unreadable: KV GET failed: 503 Service Unavailable: cached' ]);

  t.equal(await cache.get('cached'), null);
  t.equal(lines.length, 1, 'once a minute, not once a read: KV that does not answer refuses every one');
});

t.test('WorkersKvCache says when KV refuses a write, and the value stands', async t => {
  const { debug, lines } = warnings(t);
  const kv    = MemoryKv({});
  const cache = new WorkersKvCache(refusingKv(kv, method => method === 'put'), [], debug);

  await t.resolves(cache.put('computed', 5), 'the put is not a failure');
  t.same(lines, [ 'computation cache unwritable: KV PUT failed: 429 Too Many Requests: computed' ]);
  t.equal(await kv.get('computed'), null, 'and the value is not kept');
});

t.test('state WorkersKvCache reads and writes fails as KV does', async t => {
  const { debug, lines } = warnings(t);
  const cache = new WorkersKvCache(refusingKv(), [], debug);

  await t.rejects(cache.read('cursor'), { message: 'KV GET failed: 503 Service Unavailable' });
  await t.rejects(cache.write('cursor', { blockNumber: 1 }), { message: 'KV PUT failed: 429 Too Many Requests' });
  t.same(lines, [], 'whose caller says what it means');

  const kv     = MemoryKv({});
  const stored = new WorkersKvCache(kv, [], debug);
  await stored.write('cursor', { blockNumber: 1 });
  t.same(await stored.read('cursor'), { blockNumber: 1 }, 'and reads what it wrote while KV answers');
  t.equal(await stored.read('missing'), null);
});

/*
 * The computation cache, as the routes make it (src/evaluator.ts) and as
 * transaction history makes it, over a KV that refuses everything.
 */
t.test('an evaluation whose cache KV refuses is computed, under either evaluator', async t => {
  const { debug, lines } = warnings(t);
  const quota   = Quota.initialize({ ops: Infinity, reads: Infinity, writes: Infinity });
  const context = { start: 0, end: 10, stride: 5, val: 5 };
  for (const evaluatorAlgorithm of [ 'recursive', 'workingset' ] as const) {
    const refused = new WorkersKvCache(refusingKv(), [], debug);
    for (const cache of [
      LayersCache.of([ new MemoryCache({}), QuotaCache.wrap(quota, refused) ]),
      refused,
    ]) {
      const { evaluate, pull1 } = Evaluator.instantiate<GetNum>({ getNum }, { cache, flags: { evaluatorAlgorithm } });
      t.equal(await evaluate(pull1({ getNum: context })), 5, `computed by the ${evaluatorAlgorithm} evaluator`);
    }
  }
  const key = await getNum.key('getNum-v1', context);
  t.same(lines, [ 1, 2 ].flatMap(() => [
    `computation cache unreadable: KV GET failed: 503 Service Unavailable: ${key}`,
    `computation cache unwritable: KV PUT failed: 429 Too Many Requests: ${key}`,
  ]), 'and each namespace says once that it refused a read, and once a write');
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
