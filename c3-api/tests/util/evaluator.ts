import * as Debug    from '../../lib/debug-log.js';
import * as Flags    from '../../lib/flags.js';
import { BigNumber } from '../../lib/bignumber.js';
import { BigFixnum } from '../../lib/bigfixnum.js';

import * as Compute    from '../../lib/symbolic/computation.js';
import * as Evaluator  from '../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../lib/symbolic/cache.js';
import type { Cache }  from '../../lib/symbolic/cache.js';

/*
 * The real evaluator over computations a test stands in for: what a test
 * asserts is what the evaluator makes of what each computation answered.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

// a computation that answers from the test, given whatever it was asked for
function stub(answer: (context: any) => unknown) {
  return Compute.Functor<any>({}).implement({ version: 0, compute: context => answer(context) });
}

// a cache of computations kept in memory, which revives the values computations answer
const memoryCache = () => new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);

type Options = {
  algorithm?: Flags.FullFlags['evaluatorAlgorithm'],
  batching?:  boolean,
  // a test that reads what was cached, or shares it between evaluators, passes its own
  cache?:     Cache,
};

/*
 * An evaluator over `computations` as the routes that read many markets at
 * once run theirs (ROUTE_EVALUATOR_FLAGS), unless a test names its algorithm
 * or its batching, and with a cache of its own unless a test passes one.
 */
function evaluatorOver(computations: Record<string, unknown>, {
  algorithm = Flags.ROUTE_EVALUATOR_FLAGS.evaluatorAlgorithm,
  batching  = Flags.ROUTE_EVALUATOR_FLAGS.batchingEnabled,
  cache     = memoryCache(),
}: Options = {}) {
  return Evaluator.instantiate<any>(computations as any, {
    cache,
    debug,
    flags: { ...flags, evaluatorAlgorithm: algorithm, batchingEnabled: batching },
  });
}

export { evaluatorOver, memoryCache, stub };
