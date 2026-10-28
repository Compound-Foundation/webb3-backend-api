import t, { Test } from 'tap';

import * as Flags      from '../../../lib/flags.js';
import * as Debug      from '../../../lib/debug-log.js';
import * as Fallible   from '../../../lib/fallible/fallible.js';
import * as Index      from '../../../lib/symbolic/index.js';
import * as Compute    from '../../../lib/symbolic/computation.js';
import * as Workingset from '../../../lib/symbolic/evaluator/workingset.js';

function expectState<Scope extends Compute.Spec = Compute.Spec>(
  t:        Test,
  message:  string,
  state:    Workingset.StepState<Scope>,
  expected: Workingset.StepState.ForTest<Scope>,
) {
  return t.test(message, t => {
    t.equal(
      state.stuck,
      expected.stuck,
      `expected state to ${expected.stuck ? 'not ' : ''} be stuck`
    );
    t.strictSame(state.done, expected.done, `expected work is done`);
    //
    t.equal(
      state.todo.length,
      expected.todo.length,
      `expected ${expected.todo.length} tasks left todo`
    );
    for (let index = 0; index < expected.todo.length; index++) {
      const actualTodo = state.todo[index];
      const expectTodo = expected.todo[index];
      if (!t.equal(actualTodo[0], expectTodo[0], `same work item type`)) {
        continue;
      }
      const type = expectTodo[0];
      const fields = Workingset.WorkItem.fieldNames(expectTodo);
      t.equal(
        actualTodo[1],
        expectTodo[1],
        `same ${type} work item ${fields[1]}`
      );
      t.equal(
        actualTodo[2],
        expectTodo[2],
        `same ${type} work item ${fields[2]}`
      );
      if (actualTodo[0] === 'redex') {
        t.strictSame(
          actualTodo[3].slice(0, -1), // drop receiver off the end of body
          expectTodo[3],
          `same ${type} work item ${fields[3]} (ignoring receiver)`
        );
      } else if (actualTodo.length > 3) {
        t.strictSame(
          actualTodo[3],
          expectTodo[3],
          `same ${type} work item ${fields[3]}`
        );
      }
    }
    //
    t.end();
  });
};

type Increment = Compute.Spec<{
  name: 'increment',
  expects: number,
  returns: number,
}>;

const increment = Compute.Functor<Increment>({}).implement({
  version: 1,
  /* NOTE(jordan): custom key function ensures test is independent of the
   * default Key.toKey algorithm changing.
   */
  key: (name, context) => `${name}:${context}`,
  compute: v => v + 1,
});

t.test('WorkingsetEvaluator: step-by-step { increment: 3 }', async t => {
  const steps: Workingset.StepState.ForTest<Increment>[] = [
    // our initial state shows that we will increment:3
    {
      stuck: false,
      pend: [],
      done: {},
      todo: [
        [ 'redex', 'ROOT', false, [ [[ 'increment', 'increment-v1:3' ]] ] ],
        [ 'computation', 'increment', 3 ],
      ],
    },
    // our next state shows that evaluation is complete
    {
      stuck: false,
      pend: [],
      todo: [],
      done: { 'increment-v1:3': 4, ROOT: 4 },
    },
  ];
  const evaluator = Workingset.Evaluator<Increment>({ increment }, {
    flags: Flags.parse(process.env),
  });
  // initial state
  let state = await evaluator.init(evaluator.pull1({ increment: 3 }));
  expectState(t, `initial state is as expected`, state, steps[0]);
  // step 1: finished evaluating
  state = await evaluator.step(state);
  expectState(t, `after 1 step 'increment' is complete`, state, steps[1]);
  // property: evaluate(rx) is the same as stepping until todo.length == 0
  t.strictSame(
    state.done.ROOT,
    await evaluator.evaluate(evaluator.pull1({ increment: 3 })),
    `after 1 step, state.done.ROOT is the same as what 'evaluate' returns`
  );
  // property: stepping a finished state does nothing
  state = await evaluator.step(state);
  expectState(t, `stepping after done does nothing`, state, steps[1]);
});

t.test('WorkingsetEvaluator: detects stuck states', async t => {
  const evaluator = Workingset.Evaluator<Increment>({ increment }, {
    flags: Flags.parse(process.env),
  });
  // our initial state is not stuck, but it will get stuck on a bad lookup
  let state: Workingset.StepState<Increment> = {
    stuck: false,
    pend: [],
    done: {},
    todo: [[ 'redex', 'ROOT', false, [[[ 'increment', 'increment-v1:3' ]], v => v ]]],
  };
  // and once we try to evaluate one step, we can't make progress
  state = await evaluator.step(state);
  expectState(t, `gets stuck if no work item can progress`, state, {
    stuck: true,
    pend: [],
    done: {},
    todo: [[ 'redex', 'ROOT', false, [ [[ 'increment', 'increment-v1:3' ]] ] ]],
  });
});

/*
 * An indexed computation, and a cache that takes a while to answer and
 * records how it was read, to see how a step reads the cache.
 */
type Double = Compute.Spec<{
  name: 'double',
  expects: number,
  returns: number,
}>;

const double = Compute.Functor<Double>({}).implement({
  version: 1,
  index: Index.Everything,
  key: (name, context) => `${name}:${context}`,
  compute: v => v * 2,
});

/*
 * Also indexed, and it answers a miss with a redex: the case where a key
 * two items share, both missing, used to be read twice.
 */
type Quadruple = Compute.Spec<{
  name: 'quadruple',
  depends: [ Double ],
  expects: number,
  returns: number,
}>;

let quadrupled = 0;
const { implement: implementQuadruple, pull1: pullDouble } = Compute.Functor<Quadruple>({});
const quadruple = implementQuadruple({
  version: 1,
  index: Index.Everything,
  key: (name, context) => `${name}:${context}`,
  compute: v => {
    quadrupled++;
    return pullDouble({ double: v * 2 });
  },
});

function slowCache(stored: Record<string, number>, failing: string[] = []) {
  const cache = {
    debug: Debug.MakeLogger([]),
    reads: [] as string[],
    inFlight: 0,
    mostInFlight: 0,
    async get<T>(key: string): Promise<T | null> {
      cache.reads.push(key);
      cache.mostInFlight = Math.max(cache.mostInFlight, ++cache.inFlight);
      await new Promise(resolve => setTimeout(resolve, 10));
      cache.inFlight--;
      if (failing.includes(key)) {
        throw new Error(`cache read failed: ${key}`);
      }
      return (stored[key] ?? null) as T | null;
    },
    async put() {},
  };
  return cache;
}

t.test('WorkingsetEvaluator: a step reads the cache of all its computations at once', async t => {
  quadrupled = 0;
  const cache = slowCache({ 'double-v1:1': 20 });
  const evaluator = Workingset.Evaluator<Quadruple | Increment>(
    { double, quadruple, increment },
    { flags: Flags.parse(process.env), cache },
  );
  const results = await evaluator.evaluate(evaluator.split([
    evaluator.pull1({ double: 1 }),
    evaluator.pull1({ double: 2 }),
    evaluator.pull1({ double: 3 }),
    evaluator.pull1({ quadruple: 5 }),
    evaluator.pull1({ quadruple: 5 }),
    // not indexed, so never read from the cache
    evaluator.pull1({ increment: 7 }),
    // needs double:1 in the next step, which is done by then
    evaluator.pull1({ quadruple: 0.5 }),
  ]));

  t.strictSame(results, [ 20, 4, 6, 20, 20, 8, 20 ], 'a cached result is used, and the rest are computed');
  t.strictSame(
    cache.reads.sort(),
    [ 'double-v1:1', 'double-v1:10', 'double-v1:2', 'double-v1:3', 'quadruple-v1:0.5', 'quadruple-v1:5' ],
    'each key is read once: one two items share, one already done, and none that is not indexed',
  );
  t.equal(quadrupled, 2, 'a key two items share is computed once');
  t.equal(cache.mostInFlight, 5, 'and every read of a step is in flight together');
});

t.test('WorkingsetEvaluator: a failed cache read still fails the evaluation', async t => {
  const unobserved: unknown[] = [];
  const record = (reason: unknown) => { unobserved.push(reason); };
  process.on('unhandledRejection', record);
  t.teardown(() => { process.off('unhandledRejection', record); });

  const cache = slowCache({}, [ 'double-v1:1', 'double-v1:2' ]);
  const evaluator = Workingset.Evaluator<Double>({ double }, { flags: Flags.parse(process.env), cache });
  await t.rejects(
    evaluator.evaluate(evaluator.split([ evaluator.pull1({ double: 1 }), evaluator.pull1({ double: 2 }) ])),
    /cache read failed/,
  );
  // let every read settle, including the one the step never got to
  await new Promise(resolve => setTimeout(resolve, 50));
  t.strictSame(unobserved, [], 'no read rejects unobserved');
});

/*
 * A node error reaches an evaluation as a computation that throws, or as a
 * receiver that throws on what a batched call answered, as ethCall's does.
 * Either fails the whole evaluation, whichever item of a split it is in:
 * the summary and dapp-data routes and account rewards evaluate their lists
 * on this evaluator, and a list is never answered without a market whose
 * read failed.
 */
t.test('WorkingsetEvaluator: a computation that throws fails the evaluation', async t => {
  type Read = Compute.Spec<{ name: 'read', expects: number, returns: number }>;
  const read = Compute.Functor<Read>({}).implement({
    version: 1,
    compute: v => {
      if (v === 2) {
        throw new Error('the node did not answer');
      }
      return v;
    },
  });
  const evaluator = Workingset.Evaluator<Read>({ read }, { flags: Flags.parse(process.env) });
  await t.rejects(
    evaluator.evaluate(evaluator.split([ 1, 2, 3 ].map(v => evaluator.pull1({ read: v })))),
    /the node did not answer/,
  );
});

t.test('WorkingsetEvaluator: a receiver that throws fails the evaluation', async t => {
  type Checked = Compute.Spec<{ name: 'checked', depends: [ Increment ], expects: number, returns: number }>;
  const { implement, pipe1 } = Compute.Functor<Checked>({});
  const checked = implement({
    version: 1,
    compute: v => pipe1([ { increment: v }, result => {
      if (v === 2) {
        throw new Error('call error: header not found');
      }
      return result;
    } ]),
  });
  const evaluator = Workingset.Evaluator<Checked>({ checked, increment }, { flags: Flags.parse(process.env) });
  await t.rejects(
    evaluator.evaluate(evaluator.split([ 1, 2, 3 ].map(v => evaluator.pull1({ checked: v })))),
    /header not found/,
  );
});

t.test('WorkingsetEvaluator: a computation that fails says why', async t => {
  type Refuse = Compute.Spec<{ name: 'refuse', expects: number, returns: number }>;
  const refuse = Compute.Functor<Refuse>({}).implement({
    version: 1,
    compute: () => Fallible.Outcome.Of.Failure({
      type:    'Fetch.InsufficientQuota',
      error:   new Error('request quota exhausted'),
      details: { quota: { requested: { subrequests: 1 }, resources: { subrequests: 0 }, allocated: {} } },
    } as const),
  });
  const evaluator = Workingset.Evaluator<Refuse>({ refuse }, { flags: Flags.parse(process.env) });
  const error = await evaluator.evaluate(evaluator.pull1({ refuse: 1 })).then(() => null, (error: Error) => error);

  t.equal(error?.message, 'Failure: Fetch.InsufficientQuota');
  t.match((error?.cause as { error: Error }).error.message, /request quota exhausted/, 'and keeps what failed as its cause');

  for (const payload of [ 'contract not found', null ]) {
    type Untyped = Compute.Spec<{ name: 'untyped', expects: number, returns: number }>;
    const untyped = Compute.Functor<Untyped>({}).implement({
      version: 1,
      compute: () => [ false, payload ] as unknown as number,
    });
    const untypedEvaluator = Workingset.Evaluator<Untyped>({ untyped }, { flags: Flags.parse(process.env) });
    const untypedError = await untypedEvaluator.evaluate(untypedEvaluator.pull1({ untyped: 1 })).then(() => null, (error: Error) => error);
    t.equal(untypedError?.message, 'Failure: unknown', `a failure without a type (${JSON.stringify(payload)}) still fails plainly`);
    t.equal(untypedError?.cause, payload);
  }
});

/*
 * A failure is logged once, by whoever answers it: the router, under the
 * request's id. Tracing the evaluator (DEBUG=eval) shows it once more, with
 * the state the evaluation failed in; the step that ran the computation does
 * not write it a third time.
 */
t.test('WorkingsetEvaluator: a computation that fails is not logged by the step that ran it', async t => {
  const lines: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.teardown(() => { console.error = consoleError; });

  type Refuse = Compute.Spec<{ name: 'refuse', expects: number, returns: number }>;
  const refuse = Compute.Functor<Refuse>({}).implement({
    version: 1,
    compute: () => Fallible.Outcome.Of.Failure({
      type:    'Fetch.InsufficientQuota',
      error:   new Error('request quota exhausted'),
      details: { quota: { requested: { subrequests: 1 }, resources: { subrequests: 0 }, allocated: {} } },
    } as const),
  });
  const debug     = Debug.MakeLogger([]).configure({ DEBUG: 'eval' });
  const evaluator = Workingset.Evaluator<Refuse>({ refuse }, { flags: Flags.parse(process.env), debug });

  await t.rejects(evaluator.evaluate(evaluator.pull1({ refuse: 1 })), /Failure: Fetch.InsufficientQuota/);
  t.equal(lines.filter(line => line.includes('Failure: Fetch.InsufficientQuota')).length, 1,
    'the trace names the failure once, beside the state it failed in');
});
