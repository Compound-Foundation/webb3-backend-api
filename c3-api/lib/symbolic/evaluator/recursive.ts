import * as Flags    from '../../flags.js';
import * as Debug    from '../../debug-log.js';
import * as Fallible from '../../fallible/fallible.js';

import * as Redex   from '../redex.js';
import * as Cache   from '../cache.js';
import * as Compute from '../computation.js';

import type * as Eval from './base.js';

/*
 * The RecursiveEvaluator is an attempt at the simplest possible
 * implementation of an Evaluator.
 *
 * In order to allow step-by-step evalution, the 'recursion' is explicitly
 * trampolined -- that is, every invocation returns the input for the next
 * invocation. So rather than call itself, the evalution step function
 * expects to be called repeatedly in a loop on its own output.
 *
 * It is trampolined by maintaining the callstack in memory as the
 * StepState. If JavaScript had Scheme-like continuations, this
 * implemention could be trivially rewritten using that construct.
 *
 * Even with this added complexity, it remains at roughly 79 lines of
 * implementation code (not counting comments). By comparison, the more
 * featureful and elaborate workingset evaluator is easily over 300 lines
 * of implementation code, and the workingset module contains almost 700
 * total lines of code, comments, and declarations -- and mostly, code.
 *
 * So, while it is less simple than the uninterruptible naiive recursive
 * implementation (which cannot be performed step-by-step), the
 * RecursiveEvaluator still comes near to the goal of the simplest
 * possible implementation.
 */

/*
 * RecursiveEvaluator implements the base type without extension.
 */
interface Implementation<Scope extends Compute.Spec>
  extends Eval.Implementation<Scope>
{}

/*
 * RecursiveEvaluator factory function. Given Evaluator.Parameters,
 * returns an instance of Evaluator.Implementation that is effectively a
 * trampolined version of a simple recursive implementation.
 */
function RecursiveEvaluator<
    ScopeRoots extends Compute.Spec,
    Scope      extends Compute.Spec = (ScopeRoots | ScopeRoots['depends']),
  >
(...[
    computations,
    {
      flags = {},
      cache = Cache.NoopCache,
      debug = Debug.MakeLogger([]),
    }
  ]: Eval.Parameters<Scope>
): Implementation<Scope> {
  const implementation: Implementation<Scope> = {
    /*
     * properties
     */
    cache,
    computations,
    debug: debug.scope('eval'),
    flags: Flags.defaults(flags),
    ...Redex.Factories<Scope>(),
    /*
     * evaluation methods
     */
    step,
    async evaluate<Rx extends Redex.Redex<Scope>>(redex: Rx)
      : Promise<Redex.Returns<Rx>>
    {
      let state = await this.init(redex);
      while (!this.settled(state)) {
        state = await this.step(state);
      }
      if (!this.done(state)) {
        this.debug.error(`evaluate: settled but not done`, { state });
        throw new Error(`evaluate: settled but not done`);
      }
      return this.unwrap(state);
    },
    /*
     * state management methods
     */
    async init<Rx extends Redex.Redex<Scope, any>>(redex: Rx)
      : Promise<StepState<Scope, Redex.Returns<Rx>>>
    {
      return { stack: [ [ redex, /* retrieved */ [], false ] ] };
    },
    unwrap<Return>(state: StepState.Done<Scope, Return>)
      : Return
    {
      return state.result;
    },
    done<Return>(state: StepState<Scope, Return>)
      : state is StepState.Done<Scope, Return>
    {
      return this.settled(state) && 'result' in state;
    },
    settled<State extends StepState<Scope>>(state: State)
      : boolean
    {
      return state.stack.length === 0;
    },
  };
  /*
   * annoying self-binding for evaluate so it can be destructured.
   */
  implementation.evaluate = implementation.evaluate.bind(implementation);
  return implementation;
}

/*
 * Recursive StepState maintains a stack of in-progress computations.
 *
 * It does not maintain a full catalog of all the work 'done,' unlike
 * workingset. It's forgetful, so to speak. Will always resort to cache.
 *
 * The 'latest' block for example may get recomputed. Same semantics as
 * before. Backwards compatible.
 */
interface StepState<
    Scope extends Compute.Spec,
    Return = unknown,
  >
  extends Eval.EventualResult<Return>
{
  stack: Array<[
    redex:     Redex.Redex<Scope>,
    retrieved: (Redex.ResolvedLookup<Scope> | Scope['returns'])[],
    key:       string | false,
  ]>;
  result?: Return;
}
namespace StepState {
  export interface Done<
      Scope extends Compute.Spec,
      Return = unknown
    >
    extends StepState<Scope, Return>
  {
    // no longer optional
    result: Return;
  }
}

/*
 * propagate(stack, next) pushes the 'next' result onto the retrieved
 * arguments list of the top item on the stack (the 'head').
 *
 * in other words, it propagates the result from a dependency back up the
 * stack to its dependent parent expression.
 */
function propagate<Scope extends Compute.Spec, Return>(
  stack: StepState<Scope, Return>['stack'],
  next: unknown
): StepState<Scope, Return> {
  const [ [ redex, retrieved, key ], ...tail ] = stack;
  return { stack: [ [ redex, [ ...retrieved, next ], key ], ...tail ] };
}

/*
 * step(state) performs by single steps the evaluation of an expression.
 */
async function step<Scope extends Compute.Spec, Return>
  (this: Implementation<Scope>, state: StepState<Scope, Return>)
  : Promise<StepState<Scope, Return>>
{
  if (state.stack.length === 0) {
    this.debug.log(`◀ evaluate(recursive): step: empty stack`);
    return state;
  }
  /*
   * peek the head of the stack,
   *    split the head into redex and retrieved arguments,
   *      and split the redex into dependencies and receiver.
   */
  const [ [ redex, retrieved ]   ] = state.stack;
  const [ dependencies, receiver ] = redex.body;
  this.debug.group(`evaluate(recursive): step:`)
    .log({ depth: state.stack.length })
    .log(redex.body);
  /*
   * if all dependencies map to fully-computed arguments, we're ready to
   * invoke the receiver of the current topmost redex.
   */
  if (retrieved.length === dependencies.length) {
    const arguments_ = dependencies.map((dependency, index) => {
      const result = retrieved[index];
      if (Redex.cast<Scope>(dependency)) {
        return result;
      } else { // Redex.ResolvedLookup<Scope, Name>
        return [ /* name */ dependency[0], result ];
      }
    });
    /*
     * pop the stack and call the receiver.
     */
    const [ [ /* redex */, /* retrieved */, key ], ...tail ] = state.stack;
    const next = await receiver(arguments_);
    /*
     * if the result is a redex, we're not done evaluating this node of
     * the computation dependency tree. push 'next' back onto the stack.
     */
    if (Redex.cast<Scope>(next)) {
      this.debug.groupEnd();
      return { stack: [ [ next, [], key ], ...tail ] };
    }
    /*
     * if the result is not a redex, it is completely evaluated. cache it.
     */
    if (key) {
      this.debug.log(`▶ cache.put(${key})`);
      const putResult = await this.cache.put(key, next);
      if (Fallible.isFailure(putResult)) {
        const payload = Fallible.unwrap(putResult);
        this.debug.error(`Failure: ${payload.type}`, { failure: payload });
        throw new Error(`Failure: ${payload.type}`, { cause: payload });
      }
    }
    /*
     * if the stack is empty, it's in fact the final return result.
     */
    if (tail.length === 0) {
      this.debug.log(`◀ evaluate(recursive): step: done`);
      this.debug.groupEnd();
      return { stack: tail, result: next as Return };
    }
    /*
     * if the stack is not empty, it's the next argument of its parent.
     * propagate the result to the retrieved arguments list of the parent.
     */
    this.debug.log(`◀ evaluate(recursive): step: propagate result to parent`);
    this.debug.groupEnd();
    return propagate(tail, next);
  }
  /*
   * there are dependencies not yet computed; pick up the next one.
   */
  const nextDependency = dependencies[retrieved.length];
  /*
   * if it's a redex, push it onto the top of the stack and return.
   */
  if (Redex.cast<Scope>(nextDependency)) {
    this.debug.groupEnd();
    return { stack: [ [ nextDependency, [], false ], ...state.stack ] };
  }
  /*
   * otherwise, it's a lookup. compute the lookup key.
   */
  const [ name, context ]: Redex.Lookup<Scope> = nextDependency;
  const computation = this.computations[name];
  const versionedName = Compute.versionedName(name, computation.version);
  const dependencyKey = await computation.key(versionedName, context);
  this.debug.log(`evaluate(recursive): step: compute: ${dependencyKey}`);
  const key = computation.index.includes(context) && dependencyKey;
  /*
   * if there's a cached result for the key, propagate it and return.
   */
  if (key) {
    const cachedResult = await this.cache.get<{/*unknown*/}>(key);
    if (Fallible.isFailure(cachedResult)) {
      const payload = Fallible.unwrap(cachedResult);
      this.debug.error(`Failure: ${payload.type}`, { failure: payload });
      throw new Error(`Failure: ${payload.type}`, { cause: payload });
    }
    if (cachedResult !== null) {
      this.debug.log(`! cache hit`);
      this.debug.groupEnd();
      return propagate(state.stack, cachedResult);
    }
  }
  /*
   * if there's no cached result, compute the lookup directly.
   */
  const outcome = await computation.compute(context, this.debug, name);
  if (Fallible.isFailure(outcome)) {
    const payload = Fallible.unwrap(outcome);
    this.debug.error(`Failure: ${payload.type}`, { failure: payload });
    throw new Error(`Failure: ${payload.type}`, { cause: payload });
  }
  const next = Fallible.must(outcome);
  if (Redex.cast<Scope>(next)) {
    this.debug.groupEnd();
    return { stack: [ [ next, [], key ], ...state.stack ] };
  }
  if (key) {
    this.debug.log(`▶ cache.put(${key})`);
    const putResult = await this.cache.put(key, next);
    if (Fallible.isFailure(putResult)) {
      const payload = Fallible.unwrap(putResult);
      this.debug.error(`Failure:`, { failure: payload });
      throw new Error(`Failure: ${payload.type}`, { cause: payload });
    }
  }
  this.debug.groupEnd();
  return propagate(state.stack, next);
}

export {
  RecursiveEvaluator,
  RecursiveEvaluator as Evaluator,
};

export type {
  StepState,
  Implementation,
};
