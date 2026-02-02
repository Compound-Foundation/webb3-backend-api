import * as Debug    from '../debug-log.js';
import * as Json     from '../json-types.js';
import * as Quota    from '../quota.js';
import * as Fallible from '../fallible/fallible.js';

interface Cache {
  debug: Debug.Logger;
  get<T>(key: string)
    : Promise<Fallible.Outcome.OrJust<
      T | null,
      InsufficientQuota
    >>;
  put(key: string, value: any, options?: any)
    : Promise<Fallible.Outcome.OrJust<
      void,
      InsufficientQuota
    >>;
}

/*
 * No-op Cache
 * Default cache implementation that effects no cache.
 */
const NoopCache: Cache = {
  debug: Debug.MakeLogger([]),
  async get(..._: any[]) { return null },
  async put(..._: any[]) { return },
};

/*
 * Memory Cache
 * Simple cache backed by in-memory storage.
 */
class MemoryCache implements Cache {
  constructor(
    public store: Record<string, Json.Value>,
    public revivers: Json.Reviver<unknown>[] = [],
    public debug: Debug.Logger = Debug.MakeLogger([]),
  ) {
    this.debug = debug.scope('cache').scope('memorycache');
  }

  async get<T>(key: string): Promise<T | null> {
    if (!(key in this.store)) {
      this.debug.log(`MemoryCache: get: miss: ${key}`);
      return null;
    }
    this.debug.log(`MemoryCache: get: hit: ${key}`);
    return Json.revive(this.store[key], this.revivers) as T;
  }

  async put(key: string, value: Json.Representable): Promise<void> {
    this.debug.log(`MemoryCache: put: ${key}`);
    this.store[key] = Json.from(value);
  }
}

/*
 * Workers KV Cache
 * Common cache interface wrapper for Workers KV `KVNamespace' instances.
 * Exposes non-standard methods for `list`, `delete` on entries.
 */
class WorkersKvCache implements Cache {
  constructor(
    public store: KVNamespace,
    public revivers: Json.Reviver<unknown>[] = [],
    public debug: Debug.Logger = Debug.MakeLogger([]),
  ) {
    this.debug = debug.scope('cache');
  }

  async get<T>(key: string): Promise<T | null> {
    const cached = await this.store.get(key);
    if (cached === null || cached === '') {
      this.debug.log(`WorkersKvCache: get: miss: ${key}`);
      return null;
    }
    this.debug.log(`WorkersKvCache: get: hit: ${key}`);
    return Json.parse(cached, this.revivers) as T;
  }

  put(
    key:     string,
    value:   Json.Representable,
    options: KVNamespacePutOptions = {},
  ): Promise<void> {
    this.debug.log(`WorkersKvCache: put: ${key} with ${JSON.stringify(options)}`);
    return this.store.put(key, JSON.stringify(value), options);
  }

  delete(key: string): Promise<void> {
    this.debug.log(`WorkersKvCache: delete: ${key}`);
    return this.store.delete(key);
  }

  list<Metadata>(prefix: string): Promise<KVNamespaceListResult<Metadata>> {
    this.debug.log(`WorkersKvCache: list: { prefix: ${prefix} }`);
    return this.store.list({ prefix });
  }
}

/*
 * Layers Cache Wrapper
 * Cache wrapper over an ordered preference of underlying caches.
 * Back-propagates values retrieved from lower-ranked to preferred caches.
 */
class LayersCache implements Cache {
  private constructor(
    public layers: Cache[],
    public debug: Debug.Logger = Debug.MakeLogger([]),
  ) {
    this.debug = this.debug.scope('cache');
  }
  // Cache.Layers.of([ memorycache, kvcache ])
  static of(orderedLayers: Cache[], debug?: Debug.Logger) {
    return new LayersCache(orderedLayers, debug);
  }

  async get<T>(key: string)
    : Promise<Fallible.Outcome.OrJust<T | null>>
  {
    let [ index, result ] = [ -1, null as Fallible.Outcome.OrJust<(T | null)> ];
    /*
     * query layers sequentially to respect order of preference
     */
    for (const [ layerIndex, cache ] of this.layers.entries()) {
      this.debug.group(`LayersCache: get: try layer ${layerIndex}`);
      [ index, result ] = [ layerIndex, await cache.get<T>(key) ];
      this.debug.groupEnd();
      if (result !== null) break;
    }
    /*
     * back-propagate the result to earlier (more preferred) caches.
     */
    if (result !== null) {
      for (let lowerIndex = 0; lowerIndex < index; lowerIndex++) {
        // NOTE(jordan): do not await, do not wait for it to persist.
        this.debug.debug(`LayersCache: get: back-propagate to layer ${lowerIndex}`);
        this.layers[lowerIndex].put(key, result, {/* TODO? */});
      }
    }
    return result;
  }

  async put(
    key:     string,
    value:   Json.Representable,
    options: KVNamespacePutOptions = {}
  )
    : Promise<Fallible.Outcome.OrJust<void>>
  {
    /* NOTE(jordan): only wait for the fastest layer to persist. The
     * others can finish (or fail to persist) on their own time.
     */
    this.debug.debug(`LayersCache: put: initiate race`);
    return Promise.race(this.layers.map(l => l.put(key, value, options)));
  }
}

/*
 * Quota Cache Wrapper
 */
interface CacheOps extends Quota.ResourceAmounts {
  ops:    number;
  reads:  number;
  writes: number;
}

class QuotaCache implements Cache {
  private constructor(
    public quota:      Quota.default<CacheOps>,
    public underlying: Cache,
    public debug: Debug.Logger = Debug.MakeLogger([]),
  ) {
    this.debug = debug.scope('cache');
  }
  // Cache.Quota.wrap(cache)
  static wrap(
    quota: Quota.default<CacheOps>,
    target: Cache,
    debug?: Debug.Logger,
  ) {
    return new QuotaCache(quota, target, debug);
  }

  async get<T>(key: string)
    : Promise<Fallible.Outcome.OrJust<T | null, InsufficientQuota>>
  {
    this.debug.debug(`QuotaCache: get: check quota`);
    if (!this.quota.has({ ops: 1, reads: 1 })) {
      return Fallible.Outcome.Of.Failure({
        type: Failures.InsufficientQuota,
        error: new Error(`QuotaCache::get(..): insufficient resources`),
        details: {
          quota: {
            requested: { ops: 1, reads: 1 },
            resources: this.quota.resources,
            allocated: this.quota.allocated,
          },
        },
      });
    }
    // conservatively consume resources even if get() fails
    this.debug.debug(`QuotaCache: get: use quota`);
    this.quota.consume({ ops: 1, reads: 1 });
    return this.underlying.get<T>(key);
  }

  async put(
    key:     string,
    value:   Json.Representable,
    options: KVNamespacePutOptions = {},
  )
    : Promise<Fallible.Outcome.OrJust<void, InsufficientQuota>>
  {
    this.debug.debug(`QuotaCache: put: check quota`);
    if (!this.quota.has({ ops: 1, writes: 1 })) {
      return Fallible.Outcome.Of.Failure({
        type: Failures.InsufficientQuota,
        error: new Error(`QuotaCache::put(..): insufficient resources`),
        details: {
          quota: {
            requested: { ops: 1, reads: 1 },
            resources: this.quota.resources,
            allocated: this.quota.allocated,
          },
        },
      });
    }
    // conservatively consume resources even if put() fails
    this.debug.debug(`QuotaCache: put: use quota`);
    this.quota.consume({ ops: 1, writes: 1 });
    await this.underlying.put(key, value, options);
  }
}

// Failure type tags for checking the results of fallibles
const Failures = {
  InsufficientQuota: `Cache.InsufficientQuota` as const,
};

interface InsufficientQuota
  extends Quota.InsufficientQuota<CacheOps>
{
  type: typeof Failures.InsufficientQuota;
}

export type {
  InsufficientQuota,
};

export {
  Cache,
  NoopCache,
  QuotaCache,
  LayersCache,
  MemoryCache,
  WorkersKvCache,
  // Failure type tags
  Failures,
};

/*
 * import * as Cache from 'lib/symbolic/cache';
 *
 * // shorthand for glob imports where -Cache suffices are redundant
 * Cache.Layers.of([
 *    new Cache.Memory({}),
 *    Cache.Quota.wrap(quota, new Cache.WorkersKv(env.kv)),
 * ]);
 */
export {
  QuotaCache     as Quota,
  LayersCache    as Layers,
  MemoryCache    as Memory,
  WorkersKvCache as WorkersKv,
};
