import * as Key   from '../key.js';
import * as Index from '../index.js';
import * as Redex from '../redex.js';

import * as Fallible from '../../fallible/fallible.js';

import type * as Base from './base.js';
import type * as Type from '../../type-utilities.js';

/*
 * Immediate Computation
 *
 * An immediate computation can be step-evaluated immediately. It returns
 * a result of type Spec['returns'], or a Redex that reduces to one, or a
 * Promise that resolves to either of the aforementioned.
 *
 * An immediate computation SHOULD be stateless and idempotent.
 *
 */

// An immediate computation spec is just a base spec.
export type { Spec } from './base.js';

/*
 * An immediate computation may only return redexes with scope limited to
 * its specified dependencies in Spec['depends'].
 *
 * It MUST NOT return a recursive redex referencing itself.
 */
type Returns<Spec extends Base.Spec> = (
  Base.Returns<Spec, Spec['depends']>
);

/*
 * An immediate computation implements compute directly in options.
 *
 * NOTE: its Return Scope is restricted to Spec['depends'], and as such it
 * is compile-time enforced that it must not return a recursive Redex.
 */
interface Options<
    Spec   extends Base.Spec,
    Return extends Returns<Spec> = unknown,
  >
  extends Type.Required<
    Base.Options<Spec, Return>,
    | 'compute'
  >
{}

// An immediate computation simply implements the base implementation.
export type { Implementation } from './base.js';

/*
 * An immediate computation Functor is used to construct an implementation
 * module from an Immediate.Spec with properly-scoped Redex factories.
 */
function Functor<Spec extends Base.Spec>({}: {}) {
  return {
    ...Redex.Factories<Spec['depends']>(),
    implement<Return extends Returns<Spec>>(
      {
        compute,
        version,
        key   = Key.toKey,
        index = Index.Nothing,
      }: Options<Spec, Return>
    ): Base.Implementation<Spec, Return> {
      return {
        key,
        index,
        version,
        async compute(context, debug) {
          return Fallible.Outcome.OrJust.ensureWrapped(
            await compute.call(this, context, debug)
          );
        },
      };
    },
  };
}

export { Functor };
export type { Returns, Options };
