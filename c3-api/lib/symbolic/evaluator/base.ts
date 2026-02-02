import * as Flags from '../../flags.js';
import * as Debug from '../../debug-log.js';

import * as Cache   from '../cache.js';
import * as Redex   from '../redex.js';
import * as Compute from '../computation.js';

/*
 * Computations<Scope> constructs a typed map from computation names to
 * implementations. Every computation specified by the Scope union type
 * must have a corresponding entry mapping from name -> implementation.
 */
type Computations<Scope extends Compute.Spec> = {
  [Name in Scope['name']]: (
    Compute.Implementation<Extract<Scope, { name: Name }>>
  );
};

/*
 * An Evaluator can provide enhanced functionality if given certain
 * optional pieces of shared contextual state: a cache, a debug logger,
 * and any number of environmental flag settings.
 *
 * Functionality should gracefully degrade if no context is available.
 */
interface Context {
  cache?: Cache.Cache;
  debug?: Debug.Logger;
  flags?: Flags.SomeFlags;
}

/*
 * Evaluators are type-parameterized on the Scope of computations they are
 * capable of evaluating. An evaluator is initialized by providing it with
 * implementations for all in-scope computations, and all computations
 * depended upon within that scope, in one mapping. A context, which may
 * be empty, must also be provided, giving access to any shared state the
 * evaluator is meant to use.
 */
type Parameters<Scope extends Compute.Spec> = (
  readonly [ Computations<Scope>, Context ]
);

const HiddenDone   = Symbol('hidden type information');
const HiddenResult = Symbol('hidden type information');

interface EventualResult<Result = unknown> {
  [HiddenResult]?: Result;
}

interface CertainResult<Result = unknown> extends EventualResult<Result> {
  [HiddenDone]?: true;
}

interface Implementation<Scope extends Compute.Spec>
  extends Redex.Factories<Scope>
{
  /*
   * properties
   */
  cache: Cache.Cache;
  debug: Debug.Logger;
  flags: Flags.FullFlags;
  computations: Computations<Scope>;
  /*
   * state management methods
   */
  init<Rx extends Redex.Redex<Scope>>(redex: Rx): Promise<EventualResult<Redex.Returns<Rx>>>;
  done<Return>(state: EventualResult<Return>): state is CertainResult<Return>;
  settled(state: EventualResult): boolean;
  unwrap<Return>(state: CertainResult<Return>): Return;
  /*
   * evaluation methods
   */
  step<Return>(state: EventualResult<Return>): Promise<EventualResult<Return>>;
  evaluate<Rx extends Redex.Redex<Scope>>(redex: Rx)
    : Promise<Redex.Returns<Rx>>;
}

export {
  Context,
  Parameters,
  Computations,
  Implementation,
  //
  CertainResult,
  EventualResult,
};
