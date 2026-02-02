import * as Key   from '../key.js';
import * as Index from '../index.js';
import * as Redex from '../redex.js';

import * as Debug    from '../../debug-log.js';
import * as Fallible from '../../fallible/fallible.js';

import type * as Base from './base.js';

import type * as Json from '../../json-types.js';
import type * as Type from '../../type-utilities.js';

/*
 * A Batch computation typically represents some batchable I/O, such as an
 * HTTP request. Where possible, a batch computation may be deferred by an
 * evaluator until many similar computations are ready to be batched
 * together, substantially reducing I/O overhead.
 *
 * Batch computations split their input into the 'frame' in which the
 * batch is set, and the 'item' type of each element of the batch. In the
 * case of e.g. an HTTP POST request, the 'frame' is the URL, and the
 * 'item' of the batch would be the request body. A single keep-alive
 * connection socket could then be used to rapidly batch together the POST
 * requests; or even better, HTTP/2 multiplexing could be used.
 *
 * Batch computations may compute many results in a single call to
 * compute. Note that the derived type Batch.Payload must be used to
 * downcast from Spec['expects'] in cases where Batch.is(...) is used to
 * type-guard generic computations.
 *
 */

const BatchType = Symbol('computation:batch');
type  BatchType = typeof BatchType;

// A batch computation spec extends the base.spec with a symbol type tag.
interface SpecBase extends Base.Spec {
  item:  Key.ProducesKey;
  frame: Key.ProducesKey;
  [BatchType]: true;
};

// A batch computation spec includes a symbol type tag.
type Spec<
  Spec
    extends {
      name:     string,
      frame:    Key.ProducesKey,
      item:     Key.ProducesKey,
      returns:  Json.Representable[],
      depends?: SpecBase[],
    }
    = any
> = (
  unknown extends Spec ? SpecBase : (
    & Base.Spec<{
        name: Spec['name'],
        depends: Type.OrDefault<Spec['depends'], []>,
        expects: Batch<Spec>,
        returns: Spec['returns'],
      }>
    & {
        [BatchType]: true,
        frame: Spec['frame'],
        item:  Spec['item'],
      }
  )
);

// Any item in a batch computation must return a Promise.
type Returns<Spec extends SpecBase> = Promise<ReturnsAwaited<Spec>>;
/* NOTE(jordan): syntactically, TypeScript mandates that any async
 * function MUST have a return type written wrapped in the global
 * Promise<T> type. In order to satisfy that (somewhat arbitrary)
 * syntactic constraint, we have the ReturnsAwaited type which we can
 * infer in Batch.Functor.implement, and then wrap in a Promise to satisfy
 * the expected return type of the Batch.Returns and the syntactic
 * constraint enforced by the compiler.
 */
type ReturnsAwaited<Spec extends SpecBase> = (
  Base.Returns<Spec, Spec['depends']>
);

// A batch is comprised of the Spec['frame'] and an array of Spec['item']
type Batch<Spec extends Pick<SpecBase, 'item' | 'frame'>> = {
  frame: Spec['frame'],
  items: Spec['item'][],
};

/*
 * A batch computation implements compute in options.
 */
interface Options<
    Spec   extends SpecBase,
    Return extends ReturnsAwaited<Spec> = unknown[],
  >
  extends Omit<Base.Options<Spec, Return, Batch<Spec>>, 'index'>
{
  compute: (batch: Batch<Spec>, debug: Debug.Logger) => Promise<Fallible.Outcome.OrJust<Return, Base.Failure>>;
  //
  key?:    (name: string, batch: Batch<Spec>) => Type.MaybeAsync<string>;
}

/*
 * A batch computation includes the compute method from options, and must
 * include the [BatchType] tag set to true. A batch computation index is
 * On<...> the derived Batch.Payload type, as opposed to the more-general
 * base type; this allows the index to decompose a batch into its frame
 * and items.
 */
interface Implementation<
    Spec   extends SpecBase,
    Return extends ReturnsAwaited<Spec> = unknown[],
  >
  extends Base.Implementation<Spec, Return>
{
  [BatchType]: true,
  index: Index.On<Batch<Spec>>,
  compute: (context: Spec['expects'], debug: Debug.Logger, name: Spec['name']) => Promise<Fallible.Outcome.Of<Return, Base.Failure>>;
}

/*
 * NOTE(jordan): we still need to figure out a correct, efficient caching
 * strategy for batched computations. Right now the only clearly correct
 * strategy is: do not cache them.
 *
 * Batches aggregate I/O from potentially many upstream computations. What
 * if some of that I/O is not idempotent and should not be cached?
 *
 * Even if every item of the batch performs idempotent I/O (ha!) and the
 * batch is theoretically cacheable, what if the order of items varies
 * slightly? Two batches with the same items in a different order _should_
 * be equivalent, otherwise those items cannot go into the same batch --
 * that is, they cannot be processed concurrently. So then, how do we sort
 * the items of a batch? Or do we (for some reason) consider that the
 * order of items in a batch might be significant somehow to the result?
 *
 * Until we can address these open-ended questions,
 *   - Batch computations cannot be configured with a custom index.
 *   - The default index used by Batch computations will not include
 *     anything, which will prevent batches from being cached.
 *
 * NOTE that items within a batch can and will still be cached.
 *
 */
const defaultIndex = Index.Make<any>({
  covers:   ()    => true,
  includes: ()    => false,
  project:  batch => batch,
});

/*
 * A batch computation implements a compute that MUST be async and
 * operates on batches of items having the same frame.
 */
function Functor<Spec extends SpecBase>({}: {}) {
  return {
    ...Redex.Factories<Spec['depends']>(),
    implement<Return extends ReturnsAwaited<Spec>>(
      {
        compute,
        version,
        key = Key.toKey,
      }: Options<Spec, Return>
    ): Implementation<Spec, Return> {
      return {
        version,
        [BatchType]: true,
        index: defaultIndex,
        //
        key(name, context) {
          if (!isPayload<Spec>(context)) {
            throw new Error(`Batch.key: invalid payload for context`);
          }
          return key(name, context);
        },
        async compute(context, debug) {
          if (!isPayload<Spec>(context)) {
            throw new Error(`Batch.compute: invalid payload for context`);
          }
          return Fallible.Outcome.OrJust.ensureWrapped(
            await compute(context, debug)
          );
        }
      };
    },
  };
}

/*
 * Batch.is(...) narrows the type of any Base.Implementation to an
 * instance of Batch.Implementation by detecting the presence of the
 * BatchType type tag symbol.
 */
function is(computation: Base.Implementation<any>)
  : computation is Implementation<any>
{
  return BatchType in computation
      && (computation as any)[BatchType];
}

/*
 * Batch.isPayload(...) narrows the type of any Spec['expects'] to a
 * Batch.Payload by detecting the presence of the 'frame' and 'items'
 * properties.
 */
function isPayload<Scope extends Base.Spec = Base.Spec>
  (payload: Scope['expects'])
  : payload is Batch<Extract<Scope, Spec>>
{
  return typeof(payload) === 'object'
      && ('frame' in payload)
      && ('items' in payload)
  ;
}

export { BatchType, Functor, is, isPayload };
export type { Spec, Returns, Options, Implementation };
export type { Batch as Payload };
