import * as Cache     from '../lib/symbolic/cache.js';
import * as Evaluator from '../lib/symbolic/evaluator.js';

import Quota         from '../lib/quota.js';
import * as Debug    from '../lib/debug-log.js';
import * as Flags    from '../lib/flags.js';
import { BigNumber } from '../lib/bignumber.js';
import { BigFixnum } from '../lib/bigfixnum.js';

import type { Env } from '../entrypoint.js';

import type * as Compute from '../lib/symbolic/computation.js';

/*
 * The application context includes the environmental configuration, a
 * debug logger, any applicable feature flags, and optionally a cache
 * instance for storage.
 */
interface Context {
  env:   Env;
  debug: Debug.Logger;
  flags: Flags.SomeFlags;
  // a custom cache may be passed in, but typically should not be.
  cache?: Cache.Cache;
}

/*
 * For convenience, we say that an implementation must include
 * Scope['depends'], as otherwise the evaluator is not usable.
 */
type Implementation<Scope extends Compute.Spec> = (
  Evaluator.Implementation<(Scope | Scope['depends'])>
);

/*
 * A pre-instantiated evaluator requires a networkEnv, but can also accept
 * overrides for any of its pre-instantiated context values.
 */
type InstantiateFn<Scope extends Compute.Spec> = (
  (networkEnv: 'testnet' | 'mainnet', overrides?: Partial<Context>)
    => Implementation<Scope>
);

/*
 * An evaluator cannot be fully instantiated until we know the network
 * environment, so as to select the right form of storage. (testnet data
 * is kept isolated from production mainnet data.)
 *
 * At the top-level, everything except the network environment can be
 * known, and so the evaluator can be "pre-instantiated."
 *
 */
function preInstantiate<Scope extends Compute.Spec>(
  quota: Quota<{ ops: number, reads: number, writes: number }>,
  context: Context,
  computations: Evaluator.Computations<Scope | Scope['depends']>,
) {
  /*
   * KV storage is split on a boundary between mainnet and testnet. In
   * general, testnet data is considered volatile; whereas mainnet data is
   * considered immutable.
   *
   * In other words: testnet data can be weird, broken, and unpredictable.
   * A developer should feel safe wiping the staging data storage, knowing
   * that no real user's mainnet data will be affected.
   *
   * So for an evaluator to be instantiated we must determine its 'network
   * environment', i.e., whether to use mainnet or testnet storage.
   *
   * Generally speaking, if any testnet is included in a computation's
   * network scope, the network environment is 'testnet', since the
   * inclusion of testnet results renders the data volatile.
   *
   * networkEnv:
   *  for a given network: depends on whether network is a testnet.
   *  for AllNetworks cases:
   *    if testnets=exclude: mainnet (e.g. no testnets parameter is set)
   *    if testnets=include: testnet (mainnet data is included as a copy)
   *    if testnets=only:    testnet (all data is volatile tesnet data)
   */
  return function instantiate(
    networkEnv: 'testnet' | 'mainnet',
    { cache, ...overrides }: Partial<Context> = {},
  ) {
    return Evaluator.instantiate<Scope>(computations, {
      cache: cache ?? Cache.Layers.of([
        // FIXME: this is a gnarly hack for namespace conflicts in test.
        getOrCreateMemoryCache(
          networkEnv,
          context.env.MEMORY_CACHE_SEED,
          context.debug,
        ),
        Cache.Quota.wrap(
          quota,
          new Cache.WorkersKv(
            context.env[`kv_${networkEnv}`],
            [
              BigNumber.JsonReviver,
              BigFixnum.JsonReviver,
            ],
            context.debug,
          ),
          context.debug,
        ),
      ], context.debug),
      ...context,   // spread comes last: may overwrite cache value
      ...overrides, // finally, optional overrides may overwrite anything
    });
  }
}

/* FIXME: this is a gnarly hack for namespace conflicts in test.
 * Mapping of keys (network + seed) to some memory caches.
 */
const MEMORY_CACHES: { [key: string]: Cache.Memory } = {};

function getOrCreateMemoryCache(
  networkEnv: 'testnet' | 'mainnet',
  seed: string,
  debug: Debug.Logger,
): Cache.Memory {
  const key = `kv_${networkEnv}_${seed || ''}`;
  if (!Object.keys(MEMORY_CACHES).includes(key)) {
    MEMORY_CACHES[key] = new Cache.Memory({}, [
      BigNumber.JsonReviver,
      BigFixnum.JsonReviver,
    ], debug);
  }
  return MEMORY_CACHES[key];
}

export {
  preInstantiate,
  type Context,
  type Implementation,
  type InstantiateFn,
};
