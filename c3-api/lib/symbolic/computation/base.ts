import * as Debug    from '../../debug-log.js';
import * as Fallible from '../../fallible/fallible.js';

import * as Index    from '../index.js';
import * as TypeSpec from './spec.js';

import type { MaybeAsync } from '../../type-utilities.js';
import type { InsufficientQuota } from '../../request-counting-fetch.js';

/*
 * A computation may fail with a Fetch.InsufficientQuota failure type.
 */
type Failure = (
  | InsufficientQuota
);

/*
 * Every computation defines a derived Options type. Instances of the
 * computation kind are implemented by constructing instances of the
 * derived Options type and passing these into an implementation factory.
 *
 * The derived Options type may specialize on derived types of various
 * spec fields. This enables a "correct-by-construction" approach to
 * writing kind-specific implementations, which cleanly generalize to a
 * common simplified interface (ie, Base.Implementation).
 *
 * Every computation's Options type MAY permit configuration of:
 *   - an index ...              on the kind-specific Spec['expects'] type
 *   - a compute function ...    of the kind-specific Spec['expects'] type
 *   - a unique key function ... of the kind-specific Spec['expects'] type
 *
 * If a derived Options type leaves any property as optional, then a
 * default WILL be assumed during implementation. Defaults may vary by
 * computation kind.
 *
 * NOTE that the resulting Implementation will always generalize Options
 * properties back to depending only on base types. Type-guards may be
 * defined for the computation kind to performed checked downcasts back to
 * the derived types used during construction.
 */
interface Options<
    Spec    extends TypeSpec.Spec,
    Return  extends TypeSpec.Returns<Spec, Spec['depends']> = unknown,
    // Return  extends Returns.ForOptions<Spec> = unknown,
    Context extends Spec['expects'] = Spec['expects'],
    Derived
      extends Implementation<Spec, Return>
            = Implementation<Spec, Return>,
  >
{
  version:  number;
  key?:     (this: Derived, name: string, context: Context) => MaybeAsync<string>;
  index?:   Index.On<Context>;
  compute?: (this: Derived, context: Context, debug: Debug.Logger) => (
    MaybeAsync<Fallible.Outcome.OrJust<Return, Failure>>
  );
}

/*
 * Every computation MUST implement:
 *  - an index ...              on Spec['expects']
 *  - a compute function ...    of Spec['expects'] that may return a redex
 *  - a unique key function ... of Spec['expects']
 */
interface Implementation<
    Spec   extends TypeSpec.Spec,
    Return extends TypeSpec.Returns<Spec, Spec['depends']> = unknown,
  >
{
  version: number;
  key:     (name: string, context: Spec['expects']) => MaybeAsync<string>;
  index:   Index.On<Spec['expects']>;
  compute: (context: Spec['expects'], debug: Debug.Logger, name: Spec['name']) => (
    MaybeAsync<Fallible.Outcome.Of<Return, Failure>>
  );
}

export type {
  Options,
  Failure,
  Implementation,
};

// re-export relevant members of the spec module for convenience.
export type { Spec, Returns } from './spec.js';
