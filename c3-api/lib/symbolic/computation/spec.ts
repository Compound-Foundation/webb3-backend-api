import * as Key   from '../key.js';
import * as Redex from '../redex.js';

import type * as Json from '../../json-types.js';
import type * as Type from '../../type-utilities.js';

/*
 * Computations are spec'ed in type-space before they are implemented by
 * using type constructors that guarantee Specs satisfy certain
 * constraints.
 *
 * These constraints are, namely:
 *  - A computation MUST have a Json.Representable return type.
 *  - A computation MUST specify a name which may be used to refer to it.
 *  - A computation MUST numerate its dependencies, if any, up-front.
 *  - A computation's expected input MUST produce a unique string key,
 *      making memoization and cache key construction trivial.
 *      (More-or-less this means inputs MUST be 'plain' data.)
 *
 * NOTE return type is constrained by construction. See Spec below.
 */
interface SpecBase {
  name:    string;
  depends: SpecBase;
  expects: Key.ProducesKey;
  returns: unknown;
}

type Spec<
  Spec
    extends {
      name:     string,
      returns:  Json.Representable,
      depends?: SpecBase[],
      expects?: Key.ProducesKey,
    }
    = any
> = (
  /*
   * If Spec is any (e.g. if it is not given), return SpecBase. This
   * allows Compute.Spec to act as type-constructor for derived spec types
   * but also as a base constraint if no derived type is given. ie.
   *    Compute.Spec      →   SpecBase
   *    Compute.Spec<S>   →   derived spec type S
   *
   * Moreover, an advantage over just defaulting the type parameter:
   *    Compute.Spec<any>       →   SpecBase
   *    Compute.Spec<unknown>   →   SpecBase
   *
   * NOTE that conditional types of the form `unknown extends T` are
   * satisfied if and only if T is either any or unknown.
   * cf:
   *  https://www.typescriptlang.org/docs/handbook/type-compatibility.html
   *       #any-unknown-object-void-undefined-null-and-never-assignability
   */
  unknown extends Spec ? SpecBase : {
    name:    Spec['name'],
    expects: Spec['expects'],
    depends: FlattenDepends<Type.OrDefault<Spec['depends'], []>[number]>,
    returns: Spec['returns'],
  }
);

/*
 * FlattenDepends flattens nested dependencies at type construction,
 * ensuring that even if spec dependency trees get really deep, type
 * recursion will never exceed 1-2 steps because we flattened the tree
 * up-front. This greatly improves the performance of compiler type
 * hinting during development, and also makes types easier to read.
 */
type FlattenDepends<T extends SpecBase> = Type.Expand<(
  | T
  | (T['depends'] extends never ? never : FlattenDepends<T['depends']>)
)>;

/*
 * Spec.Returns<Spec> expresses the set of possible return types for a
 * computation givens its Spec; namely: either an instance of the
 * Spec['returns'], or a Redex that will reduce to Spec['returns'], either
 * of which may be wrapped in an asynchronous Promise.
 *
 * The allowed Scope for a returned Redex may be optionally specified as a
 * second type parameter. It must at minimum include Spec['depends'].
 */
type Returns<
  Spec  extends SpecBase,
  Scope extends Spec['depends'],
> = (
  | Spec['returns']
  | Redex.Redex<Scope, Spec['returns']>
);

export {
  Spec,
  Returns,
};
