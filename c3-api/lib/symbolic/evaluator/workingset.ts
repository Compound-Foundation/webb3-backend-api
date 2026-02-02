import * as Flags    from '../../flags.js';
import * as Debug    from '../../debug-log.js';
import * as Fallible from '../../fallible/fallible.js';
import { sha256 }    from '../../hash.js';

import * as Key     from '../key.js';
import * as Redex   from '../redex.js';
import * as Cache   from '../cache.js';
import * as Compute from '../computation.js';

import type * as Eval from './base.js';

interface Implementation<Scope extends Compute.Spec>
  extends Eval.Implementation<Scope>
{
  // state creation and status management: init, settled, done
  init<Rx extends Redex.Redex<Scope>>(redex: Rx)
    : Promise<StepState<Scope, Redex.Returns<Rx>>>;
  done<Return>(state: StepState<Scope, Return>)
    : state is StepState.Done<Scope, Return>;
  unwrap<Return>(state: StepState.Done<Scope, Return>)
    : Return;
  settled<Return>(state: StepState<Scope, Return>)
    : boolean;
  // stepwise state evaluation methods
  step<Return>(state: StepState<Scope, Return>)
    : Promise<StepState<Scope, Return>>;
  rewrite(roots: readonly RewriteItem<Scope>[])
    : Promise<WorkItem<Scope>[]>;
}

function WorkingsetEvaluator<
    ScopeRoots extends Compute.Spec,
    Scope      extends Compute.Spec = (ScopeRoots | ScopeRoots['depends']),
  >
(...[
    computations,
    {
      flags = {},
      cache = Cache.NoopCache,
      debug = Debug.MakeLogger([]),
    },
  ]: Eval.Parameters<Scope>
): Implementation<Scope> {
  const implementation = {
    ...Redex.Factories<Scope>(),
    //
    cache,
    computations,
    flags: Flags.defaults(flags),
    debug: debug.scope('eval'),
    //
    step,
    rewrite,
    //
    async init<Rx extends Redex.Redex<Scope>>(redex: Rx)
      : Promise<StepState<Scope, Redex.Returns<Rx>>>
    {
      const todo = [ ...(await this.rewrite([['ROOT', false, redex]])) ];
      return { todo, stuck: false, pend: [], done: {} };
    },
    settled<State extends StepState<Scope>>(state: State)
      : boolean
    {
      return state.stuck || state.todo.length === 0;
    },
    done<Return>(state: StepState<Scope, Return>)
      : state is StepState.Done<Scope, Return>
    {
      return this.settled(state) && 'ROOT' in state.done;
    },
    unwrap<Return>(state: StepState.Done<Scope, Return>): Return {
      return state.done.ROOT;
    },
    //
    async evaluate<Rx extends Redex.Redex<Scope>>(redex: Rx)
      : Promise<Redex.Returns<Rx>>
    {
      let state = await this.init(redex);
      while (!this.settled(state)) {
        try {
          this.debug.group('▶ evaluate(workingset): step');
          state = await this.step(state);
          this.debug.groupEnd(); // ▶ evaluate(workingset): step
        } catch (error) {
          this.debug.clearDanglingGroups();
          this.debug.group(`✗ ERROR: evaluate(workingset): step threw an error`)
            .error(error)
            .groupEnd();
          this.debugFailure(`✗ ERROR: evaluate(workingset): state details:`, state);
          throw error;
        }
      }
      if (!this.done(state)) {
        if (state.todo.length === 0) {
          this.debug.group(`✗ evaluate(workingset): invariant violated`)
            .error(`exhausted todo but state is not done`)
            .debug({ state })
            .groupEnd();
          throw new Error(
            `evaluate(workingset): invariant violated:`
            + ` exhausted todo but state is not done`
          );
        } else if (state.stuck) {
          this.debugFailure(`! evaluate(workingset): stuck`, state);
          throw new Error(`evaluate(workingset): stuck`);
        } else {
          this.debugFailure(`✗ evaluate(workingset): unknown failure state`, state);
          throw new Error(`evaluate(workingset): unknown failure state`);
        }
      }
      return state.done.ROOT;
    },
    //
    debugFailure(label: string, state: StepState<Scope>) {
      const doneEntries = Object.entries(state.done);
      this.debug
        .group(label)
          .group('{')
            .error(`stuck: ${state.stuck},`)
            .error(`pend: [ <${state.pend.length} items> ],`)
            .error(`todo: [ <${state.todo.length} items> ],`)
            .error(`done: { <${doneEntries.length} items> },`)
          .groupEnd()
          .error('}')
          .group(`last todo:`)
            .error(state.todo[state.todo.length - 1])
          .groupEnd()
          .group(`last done:`)
            .error(doneEntries[doneEntries.length - 1])
          .groupEnd()
          .debug({ state })
        .groupEnd();
    },
  };
  implementation.evaluate = implementation.evaluate.bind(implementation);
  return implementation;
}

async function rewrite<Scope extends Compute.Spec>(
  this: {
    debug: Debug.Logger,
    computations: Eval.Computations<Scope>,
  },
  roots: readonly RewriteItem<Scope>[],
): Promise<WorkItem<Scope>[]> {
  const D = this.debug.scope('rewrite');
  const work: WorkItem<Scope>[] = []; // resulting work queue
  const pend: WorkItem<Scope>[] = []; // pending computes to append at end
  const rewrites: RewriteItem<Scope>[] = [ ...roots ];
  D.debug({ roots });
  let item; while(item = rewrites.pop(), !!item) {
    D.log(`item: ${item[0]}`).debug(item);
    const [ key, indexed, { body: [ dependencies, receiver ] } ] = item;
    const rewritten = await Promise.all(dependencies.map(async (dependency, dependencyIndex) => {
      // redex<scope>: materialize a result key; queue recursive rewrite
      if (Redex.cast(dependency)) {
        const dependencyKey = `dependencies[${dependencyIndex}].${key}`;
        // NOTE(jordan): don't index intermediary dependencies
        rewrites.push([ dependencyKey, false, dependency ]);
        D.debug('dependency:redex:', rewrites[rewrites.length - 1]);
        return dependencyKey;
      }
      // lookup<scope>: rewrite each lookup to map to a result key
      const [ name, context ] = (dependency as Redex.Lookup<Scope>);
      pend.push([ 'computation', name, context ]);
      D.debug('new pend:', pend[pend.length - 1]);
      const computation = this.computations[name];
      const versionedName = Compute.versionedName(name, computation.version);
      const dependencyKey = await computation.key(versionedName, context);
      const rewrittenLookup: WorkItem.Redex.RewrittenLookup = (
        [ name, dependencyKey ]
      );
      D.debug('dependency:lookup:', { rewrittenLookup });
      return rewrittenLookup;
    }));
    work.push([ 'redex', key, indexed, [ rewritten, receiver ] ]);
    D.debug('work.push(...)', work[work.length - 1]);
  }
  // add pending computes for lookups after parent redexes are rewritten
  work.push(...pend);
  if (D.enabled()) {
    let returnLine = `<${work.length} items>`;
    if (work.length <= 3) {
      returnLine = work.map(([ t, n ]) => `${t}(${n})`).join(', ');
    }
    D.group(`◀ return: [ ${returnLine} ]`)
      .debug(work)
      .groupEnd();
  }
  return work;
}

interface StepState<
    Scope extends Compute.Spec,
    Return = unknown
  >
  extends Eval.EventualResult<Return>
{
  todo:  WorkItem<Scope>[],
  pend:  WorkItem.Batch<Extract<Scope, Compute.Batch.Spec>>[],
  stuck: boolean,
  done:  { ROOT?: Return } & { [key: string]: unknown },
};

namespace StepState {
  export interface Done<
      Scope extends Compute.Spec,
      Return = unknown
    >
    extends StepState<Scope, Return>
  {
    // NOTE(jordan): no longer optional
    done: { ROOT: Return } & { [key: string]: unknown };
  }
  export type ForTest<Scope extends Compute.Spec, Return = unknown> = {
    done:  StepState<Scope, Return>['done'],
    stuck: StepState<Scope, Return>['stuck'],
    //
    todo:  WorkItem.ForTest<Scope>[],
    pend:  WorkItem.ForTest.Batch<Extract<Scope, Compute.Batch.Spec>>[],
  };
}

async function step<
  Scope extends Compute.Spec,
  Return,
>(
  this: {
    flags:        Flags.FullFlags,
    debug:        Debug.Logger,
    cache:        Cache.Cache,
    rewrite:      Implementation<Scope>['rewrite'],
    computations: Eval.Computations<Scope>,
  },
  { todo, done, pend }: StepState<Scope, Return>,
): Promise<StepState<Scope, Return>> {
  const D = this.debug.scope('step');
  if (todo.length === 0 && pend.length === 0) {
    return { stuck: false, todo, done, pend };
  }
  let stuck = true;
  let work: WorkItem<Scope>[] = todo.slice();
  let next: WorkItem<Scope>[] = [];
  let rewrites: RewriteItem<Scope>[] = [];
  // process every work item and try to step-evaluate it
  /* NOTE(jordan): by iterating backwards we are more likely to make
   * progress, because the last items on the work queue are the leaves
   * of the dependency trees of the first items on the work queue.
   */
  let item; while(item = work.pop(), !!item) {
    D.debug(`next work item:`, item);
    switch (item[0]) {
      // a. pending batch
      case 'batch': {
        const [ _, name, batch, hash ] = item;
        const computation = this.computations[name];
        const versionedName = Compute.versionedName(name, computation.version);
        const key = await computation.key(versionedName, batch);
        // FIXME?: manually padded to match the length of 'computation'
        D.group(`batch       { key: ${key} }`); // manually aligned
        D.log(  `batch     { hash: ${hash} }`); // manually aligned
        // 0.1. assert invariants
        if (!Compute.Batch.is(computation)) {
          D.error(
            `✗  invariant violated:`
            + ` expected batch work item computation to be`
            + ` a Batch computation`
          );
          D.groupEnd(); // batch
          throw new Error(
            `Evaluator#step(state): invariant violated:`
            + ` batch work item computation MUST be a Batch computation`
          );
        }
        // 0.2. check if this batch was completed at some point before
        if (key in done) {
          stuck = false;
          D.groupEnd(); // batch
          continue;
        }
        // 1.a. if indexed, try to read a result from cache
        const indexed = computation.index.includes(batch);
        if (indexed) {
          const cacheResult = await this.cache.get<{/*unknown*/}>(key);
          if (Fallible.isFailure(cacheResult)) {
            const payload = Fallible.unwrap(cacheResult);
            this.debug.error(`Failure: ${payload.type}`, { failure: payload });
            throw new Error(`Failure: ${payload.type}`, { cause: payload });
          }
          // 1.a.1. if cache returns result...
          if (cacheResult !== null) {
            // 1.a.1.1.a. ensure that the result is valid
            if (!(cacheResult instanceof Array)) {
              D.error(
                `✗ invariant violated: expected cacheResult to be an Array`,
                cacheResult
              );
              D.groupEnd(); // batch
              throw new Error(
                `Evaluator#step(state): invariant violated:`
                + ` batch result MUST be an Array`
              );
            }
            // 1.a.1.1.b if valid, save the result and skip computation
            stuck = false;
            done[key] = cacheResult;
            // 1.a.1.2. and save results for each individual batched item
            for (let index = 0; index < batch.items.length; index++) {
              const batchItem = batch.items[index];
              const itemKey = await computation.key(versionedName, {
                frame: batch.frame,
                items: [ batchItem ],
              });
              done[itemKey] = [ cacheResult[index] ];
            }
            D.groupEnd(); // batch
            continue;
          }
        }
        // 1.b. if not indexed and not cached, compute the batch
        stuck = false;
        if (D.enabled()) {
          const n = batch.items.length.toString().padStart(3, '0');
          D.log(`! batching ${n} computations of ${name} into one call`);
        }
        const outcome = await computation.compute(batch, D, name);
        if (Fallible.isFailure(outcome)) {
          /* do something dude
           */
          throw new Error(`bad vibes`);
        }
        const result = Fallible.must(outcome);
        // 2.a. if it's a redex, queue for rewrite into a new work item
        if (Redex.cast<Scope>(result)) {
          rewrites.push([ key, indexed, result ]);
          D.groupEnd(); // batch
          continue;
        }
        // 2.b. if it's a result, save it
        // 2.b.1. into the working result set
        // 2.b.1.1. save the batch as a whole...
        done[key] = result;
        // 2.b.1.2. ...and save every individual batch item result
        for (let index = 0; index < batch.items.length; index++) {
          const batchItem = batch.items[index];
          const itemKey = await computation.key(versionedName, {
            frame: batch.frame,
            items: [ batchItem ],
          });
          done[itemKey] = [ result[index] ];
        }
        // 2.b.2. and to the cache, if this batch is indexed
        if (indexed) {
          this.cache.put(key, result);
        }
        D.groupEnd(); // batch
        break;
      }
      // b. current 'computation'
      // may push it onto pend if it can be batched
      case 'computation': {
        const [ _, name, context ] = item;
        const computation = this.computations[name];
        const versionedName = Compute.versionedName(name, computation.version);
        const key = await computation.key(versionedName, context);
        D.group(`computation { key: ${key} }`);
        // 0. check if this work was already done by a later item
        if (key in done) {
          D.log('! already done. skipping.');
          stuck = false;
          D.groupEnd(); // computation
          continue;
        }
        // 1.a. if indexed, try to read a result from cache
        const indexed = computation.index.includes(context);
        if (indexed) {
          const cacheResult = await this.cache.get<{/*unknown*/}>(key);
          if (Fallible.isFailure(cacheResult)) {
            const payload = Fallible.unwrap(cacheResult);
            this.debug.error(`Failure: ${payload.type}`, { failure: payload });
            throw new Error(`Failure: ${payload.type}`, { cause: payload });
          }
          // 1.a.1. if cache returns result, save it and skip computation
          if (cacheResult !== null) {
            D.log(`✓ found result in cache, moving to done`);
            stuck = false;
            done[key] = cacheResult;
            D.groupEnd(); // computation
            continue;
          }
        }
        // 1.b. if not indexed and cached, see if can be batched
        if (true
          && this.flags.batchingEnabled
          && Compute.Batch.is(computation)
          && Compute.Batch.isPayload(context)
        ) {
          // 1.b.1. pend computation to try to build up a larger batch
          /* NOTE(jordan): pending a computation does not mean the
           * evaluator is not stuck. If all we do is pend work, that's the
           * very definition of stuck: there is no way to continue
           * evaluation except by evaluating the pending work (if any). So
           * we do not set `stuck = false` when we pend a computation.
           */
          const { frame } = context;
          // 1.b.1.1. construct a hash representing similar batches
          const batchHash = await sha256(Key.toKey('', { name, frame }));
          // 1.b.1.2. try to find an existing batch with the same hash
          let existing = pend.find(([ _type, _name, _batch, hash ]) => {
            return batchHash === hash;
          });
          if (!existing) {
            // 1.b.1.2.a. if none is found, create one
            D.log(`! new batch { hash: ${batchHash} }`); // manually aligned
            const emptyBatch = { frame, items: [] };
            existing = [ 'batch', name, emptyBatch, batchHash, ];
            pend.push(existing);
          } else {
            D.log(`→ in batch  { hash: ${batchHash} }`); // manually aligned
          }
          // 1.b.1.3. push all the items in this batch onto pend
          existing[2].items.push(...context.items);
          D.groupEnd(); // computation
          continue;
        }
        // 1.c. if not indexed and cached, compute
        stuck = false;
        const outcome = await computation.compute(context, D, name);
        if (Fallible.isFailure(outcome)) {
          /* do something dude
           */
          throw new Error(`bad vibes`);
        }
        const result = Fallible.must(outcome);
        // 2.a. if it's a redex, queue for rewrite into a new work item
        if (Redex.cast<Scope>(result)) {
          rewrites.push([ key, indexed, result ]);
          D.groupEnd(); // computation
          continue;
        }
        // 2.b. if it's a result, save it
        // 2.b.1. into the working result set
        done[key] = result;
        // 2.b.2.a. and if it's a batch...
        if (true
          && Compute.Batch.is(computation)
          && Compute.Batch.isPayload(context)
        ) {
          // 2.b.2.a.1. ensure the result is valid
          if (!(result instanceof Array)) {
            D.error(`✗ invariant violated: batch result is not an array`)
              .error({ result });
            D.groupEnd(); // computation
            throw new Error(
              `✗ invariant violated: batch result is not an array`
            );
          }
          // 2.b.2.a.2. and save each batch item as well
          for (let index = 0; index < context.items.length; index++) {
            const batchItem = context.items[index];
            const itemKey = await computation.key(versionedName, {
              frame: context.frame,
              items: [ batchItem ],
            });
            done[itemKey] = [ result[index] ];
          }
        }
        // 2.b.2. and to the cache, if this context is indexed
        if (indexed) {
          this.cache.put(key, result);
        }
        D.groupEnd(); // computation
        break;
      }
      // c. pending 'redex'
      // may not be able to progress if dependencies are not yet computed
      case 'redex': {
        const [ _, key, indexed, [ requirements, receiver ] ] = item;
        // FIXME?: manually padded to match the length of 'computation'
        D.group(`redex       { key: ${key} }`);
        // 0. check if this work was already done by a later item
        if (key in done) {
          D.log('! already done. skipping.');
          stuck = false;
          D.groupEnd(); // redex
          continue;
        }
        // 1. check if this 'redex' work item is ready to progress
        const ready = requirements.every(req => {
          if (typeof(req) === 'string') {
            return req in done;
          } else { // [ name: string, key: string ]
            return req[1] in done;
          }
        });
        // 2.a. if not ready, unshift this item onto next and skip it
        if (!ready) {
          /* NOTE(jordan): we use unshift here because we are iterating
           * through the work queue backwards; therefore, in order to keep
           * the next work queue ordered, we need to push onto the front,
           * not the back.
           */
          next.unshift(item);
          D.groupEnd(); // redex
          continue;
        }
        // 2.b. if ready, step-evaluate this work item
        // 2.b.1. resolve inputs
        const inputs = requirements.map(req => {
          if (typeof(req) === 'string') {
            if (!(req in done)) {
              throw new Error(
                `step: missing result despite marked 'ready': ${req}`
              );
            }
            return done[req];
          } else {
            const [ name, key ] = req;
            if (!(key in done)) {
              throw new Error(
                `step: missing result despite marked 'ready': ${key}`
              );
            }
            return [ name, done[key] ];
          }
        });
        // 2.b.2. invoke the receiver and handle the result
        stuck = false;
        const result = await receiver(inputs);
        // 3.a. if it's a redex, queue for rewrite into a new work item
        if (Redex.cast<Scope>(result)) {
          rewrites.push([ key, indexed, result ]);
          D.groupEnd(); // redex
          continue;
        }
        // 3.b. it it's a result, save it...
        // 3.b.1. into the working result set
        done[key] = result;
        // 3.b.2.a. and if it's indexed...
        if (indexed) {
          // 3.b.2.a.1. save it to the cache as well
          this.cache.put(key, result);
        }
        D.groupEnd(); // redex
        break;
      }
    }
  }
  //
  if (this.debug.enabled({ scope: 'rewrite' })) {
    this.debug.group(`▶ step: rewrite`);
  }
  // process pending rewrites and post-append them to the next work queue
  const rewritten = await this.rewrite(rewrites);
  next.push(...rewritten);
  //
  if (this.debug.enabled({ scope: 'rewrite' })) {
    this.debug.groupEnd(); // ▶ step: rewrite
  }
  // NOTE(jordan): large block of debug logs {{{
  if (rewrites.length > 0) {
    let aside: string = '';
    if (!this.debug.enabled({ scope: 'rewrite' })) {
      aside = ` (add 'rewrite' to DEBUG to see more)`;
    }
    D.log(
      `! rewrote and flattened ${rewrites.length} redex results into`
      + ` ${rewritten.length} additional new work items`
      + aside
    );
  }
  if (D.enabled()) {
    let returnLine = `<${next.length} items>`;
    if (!D.enabled({ level: 'debug' })) {
      returnLine += ` (set DEBUG_LEVEL to 'debug' to see more)`
    }
    if (next.length <= 3) {
      returnLine = next.map(([ t, n ]) => `${t}(${n})`).join(', ');
    }
    D.group(`◀ return: [ ${returnLine} ]`)
      .debug(work)
      .groupEnd();
  }
  // NOTE(jordan): end large block of debug logs }}}
  // if we failed to make progress but there is pending work to do...
  if (stuck && pend.length > 0) {
    this.debug.log(`! flushing pend to get unstuck`);
    next.push(...pend);
    stuck = false;
    pend = [];
  }
  return { todo: next, stuck, done, pend };
}

// [ <result key>, <redex that will reduce to the result> ]
type RewriteItem<Scope extends Compute.Spec> = (
  readonly [ key: string, indexed: boolean, redex: Redex.Redex<Scope> ]
);

/*
 *
 */
type WorkItem<Scope extends Compute.Spec> = (
  | WorkItem.Redex<Scope>
  | WorkItem.Computation<Scope>
  | WorkItem.Batch<Extract<Scope, Compute.Batch.Spec>>
);
namespace WorkItem {
  /*
   *
   */
  export type Computation<Scope extends Compute.Spec> = (readonly [
    type:    'computation',
    name:    Scope['name'],
    context: Scope['expects'],
  ]);
  /*
   *
   */
  export type Batch<Scope extends Compute.Batch.Spec> = (readonly [
    type: 'batch',
    name: Scope['name'],
    batch: {
      frame: Scope['frame'],
      items: Scope['item'][],
    },
    hash: string,
  ]);
  /*
   *
   */
  export type Redex<Scope extends Compute.Spec> = (readonly [
    type:    'redex',
    key:     string,
    indexed: boolean,
    body:    WorkItem.Redex.RewrittenBody<Scope>
  ]);
  export namespace Redex {
    // Redex.Lookup<Scope> except it points to result keys, not contexts
    export type RewrittenLookup = [ name: string, key: string ];
    // Redex.Redex<Scope>['body'] except requirements points to result keys
    export type RewrittenBody<Scope extends Compute.Spec> = (
      readonly [
        readonly (string | RewrittenLookup)[],
        (results: any) => (
          | Scope['returns']
          | import('../redex.js').Redex<Scope, Scope['returns']>
          // NOTE(jordan): ^ namespace conflict, hence import() type
        )
      ]
    );
  }
  /*
   *
   */
  export type ForTest<Scope extends Compute.Spec> = (
    | ForTest.Redex<Scope>
    | ForTest.Computation<Scope>
    | ForTest.Batch<Extract<Scope, Compute.Batch.Spec>>
  );
  export namespace ForTest {
    export type Computation<Scope extends Compute.Spec> = (
      WorkItem.Computation<Scope>
    );
    export type Batch<Scope extends Compute.Batch.Spec> = (
      WorkItem.Batch<Scope>
    );
    export type Redex<_ extends Compute.Spec> = (readonly [
      type:    'redex',
      key:     string,
      indexed: boolean,
      body:    WorkItem.ForTest.Redex.RewrittenBody,
    ]);
    export namespace Redex {
      // When writing test expectations, omit receiver (since it's a function)
      export type RewrittenBody = (
        readonly [
          readonly (string | WorkItem.Redex.RewrittenLookup)[],
        ]
      );
    }
  }
  /*
   *
   */
  export function fieldNames<Scope extends Compute.Spec>
    (item: WorkItem<Scope> | WorkItem.ForTest<Scope>)
    : string[]
  {
    switch (item[0]) {
      case 'computation': return [ 'type', 'name', 'context'          ];
      case 'batch':       return [ 'type', 'name', 'hash',    'batch' ];
      case 'redex':       return [ 'type', 'key',  'indexed', 'body'  ];
    }
  }
}

export type {
  StepState,
  RewriteItem,
  Implementation,
};

export {
  step,
  rewrite,
  WorkItem,
  WorkingsetEvaluator,
  WorkingsetEvaluator as Evaluator,
};
