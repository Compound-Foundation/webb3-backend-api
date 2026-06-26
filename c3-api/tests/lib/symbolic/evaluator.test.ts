import t, { Test } from 'tap';

import * as Flags      from '../../../lib/flags.js';
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
