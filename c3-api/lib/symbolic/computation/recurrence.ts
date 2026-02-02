import * as Json     from '../../json-types.js';
import * as Debug    from '../../debug-log.js';
import * as Fallible from '../../fallible/fallible.js';

import * as Key   from '../key.js';
import * as Redex from '../redex.js';
import * as Index from '../index.js';

import type * as Base     from './base.js';
import type * as TypeSpec from './spec.js';

import type { MaybeAsync, Expand } from '../../type-utilities.js';

/*
 * A Recurrence is a computation that depends on its previous results.
 *
 * Recurrence specifications split their Spec['expects'] into a basis,
 * which is the unchanging part of the computation context during
 * recursion, and a cursor, which is enumerated backwards to obtain
 * previous results during computation.
 *
 * The name 'basis' is inspired by linear algebra: it's sort of like the
 * set of 'basis vectors' whose coefficients are held constant over the
 * course of a computation. Whereas the 'cursor' is the index of the
 * result at a single step.
 *
 * For example: a basis may be an Ethereum contract address, and the
 * cursor could be the blockNumber at which the contract is invoked.
 *
 */

// A recurrence computation spec extends the base.spec with a cursor type.
interface SpecBase extends Base.Spec {
  cursor: Key.Struct;
};

// A recurrence computation spec splits its expects into basis and cursor.
type Spec<
  Spec
    extends {
      name:     string,
      basis:    Key.Struct,
      cursor:   Key.Struct,
      returns:  Json.Representable,
      depends?: Base.Spec[],
    }
    = any
> = (
  unknown extends Spec ? SpecBase : (
    & { cursor: Spec['cursor'] }
    & Base.Spec<(// so that the spec is still a valid Base.Spec,
        & Spec   // cursor and basis are recombined into expects.
        & { expects: (Spec['cursor'] & Spec['basis']) }
      )>
  )
);

// A recurrence computation may return a recursive redex.
type Returns<Spec extends Base.Spec> = (
  Base.Returns<Spec, (Spec | Spec['depends'])>
);

/*
 * A recurrence computation may, with restrictions, be computed by
 * returning a recursive redex. By various mechanisms below, the following
 * constraints are held:
 *  - A recurrence MUST be computed as a pipe of its previous value
 *  - A recurrence MUST depend on EXACTLY one preceding value and cursor
 *
 * The above two constraints are reflected in the type PipePreceding.
 * Moreover,
 *  - A recurrence is implemented with a compute function that MUST return
 *    a PipePreceding recursive redex.
 *  - ONLY the PipePreceding redex is allowed to be recursive.
 *
 * The above two constraints are reflected in the Functor function below.
 *
 * NOTE that these constraints artificially limit the lookback distance of
 * a recurrence computation to one recursive step.
 *
 * TODO(jordan): lift lookback distance limitation. At the very least we
 * should be able to compute the fibonnaci sequence!
 *
 */

/*
 * PipePreceding is a factory for a recursive pipe that looks up the
 * result at the immediately preceding indexed point in the domain of a
 * recurrence computation.
 */
type PipePreceding<Spec extends SpecBase> = Expand<(
  (lookupPreceding: Redex.LookupObject<Spec>, factories: Redex.Factories<Spec>) => (
    Redex.Redex<Spec['depends'], TypeSpec.Returns<Spec, (Spec['depends'] | Spec)>>
  )
)>;

/*
 * fromPrevious is a special redex factory-factory that is only usable by
 * recurrence computations. It returns a PipePreceding factory, which is
 * specially handled by the Functor implement method below by way of a
 * wrapper around the compute method of the recurrence.
 *
 * fromPrevious handles as much of boilerplate structure of constructing a
 * recursive redex as possible, abstracting away the tedious bits to make
 * life easier for implementors.
 */
function fromPrevious<Spec extends SpecBase>(
  /*
   * fromPrevious takes an update function of the previous result and its
   * cursor position, and returns the next result of the recurrence.
   */
  update: (previous: {
    cursor: Spec['cursor'],
    value:  Spec['returns'],
  }) => Returns<Spec>
): PipePreceding<Spec> {
  /*
   * fromPrevious defers to the compute method wrapper of the Functor
   * implementation to construct a Redex.Lookup of the previous result on
   * its behalf, and for access to redex factories.
   */
  return (lookupPreceding: Redex.LookupObject<Spec>, factories: Redex.Factories<Spec>) => {
    const name   = Object.keys(lookupPreceding)[0] as Spec['name'];
    const cursor = lookupPreceding[name]! as Spec['cursor'];
    return factories.pipe([
      // Look up the preceding result...
      lookupPreceding,       // and incrementally compute the next result
      ({ [name]: value }) => update({ cursor, value })
    ]);
  };
}

/*
 * A recurrence computation must be configured with:
 *  - an IterableIndex (not just a basic Index) of its input
 *
 *  - an origin function of its zero-eth input that seeds the computation
 *    with a result at recurrence step zero
 *
 *  - a possibly-async compute function of its input that MUST return a
 *    PipePreceding redex (in other words, a Recurrence MUST actually
 *    depend on its previous result).
 */
interface Options<Spec extends SpecBase>
  extends Base.Options<Spec>
{
  index:   Index.IterableOn<Spec['expects']>;
  origin:  (context: Spec['expects']) => Spec['returns'];
  compute: (context: Spec['expects'], debug: Debug.Logger) => (
    MaybeAsync<PipePreceding<Spec>>
  );
}

/*
 * A recurrence computation includes the origin and index constraints as
 * above from Options.
 */
interface Implementation<Spec extends SpecBase>
  extends Base.Implementation<Spec, Returns<Spec>>
{
  index:  Options<Spec>['index'];
  origin: Options<Spec>['origin'];
}

/*
 * A recurrence computation Functor includes the special fromPrevious
 * redex. All base redex factories are also included, but these are
 * restricted to their normal non-recursive scope.
 *
 * The functor wraps the provided compute method to specially handle the
 * PipePreceding factory returned by Options['compute']. The wrapped
 * compute for which it constructs the necessary Redex.Lookup of the
 * preceding result, and provides a set of recursive redex factories.
 */
function Functor<Spec extends SpecBase>({}: {}) {
  return {
    ...Redex.Factories<Spec['depends']>(),
    fromPrevious,
    implement(
      {
        index,
        origin,
        version,
        compute: computeFromPrevious,
        key = Key.toKey,
      }: Options<Spec>
    ): Implementation<Spec> {
      return {
        key,
        index,
        origin,
        version,
        async compute(context, debug, name) {
          if (!this.index.covers(context)) {
            /* NOTE: Should only ever reach this if there the original
             * cursor fell out of bounds (no iteration to begin with).
             */
            throw new Error('cursor is out of bounds');
          }
          const precedingResult = this.index.preceding(context);
          // cursor is indexed and there is no preceding indexed value...
          if (this.index.includes(context) && Fallible.isFailure(precedingResult)) {
            // we are at the origin of the index
            return Fallible.Outcome.Of.Success(this.origin(context));
          } else {
            // otherwise, look up the preceding indexed result and compute
            /* NOTE(jordan): must(..) converts a failure for
             * index.preceding(..) on any context that does not satisfy
             * index.includes(..) into an exception.
             *
             * TODO?(jordan): fail more gracefully? Allow propagating
             * Fallible Outcome from computations?
             */
            const preceding = Fallible.must(precedingResult);
            const lookupPrevious = { [name]: Object.assign({}, context, preceding) };
            const update = await computeFromPrevious(context, debug);
            return Fallible.Outcome.Of.Success(
              update(
                lookupPrevious as Redex.LookupObject<Spec>,
                Redex.Factories<Spec>()
              )
            );
          }
        },
      };
    },
  };
}

export { Functor };
export type { Spec, Returns, Options, Implementation };
