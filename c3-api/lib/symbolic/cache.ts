import * as Debug    from '../debug-log.js';
import * as Json     from '../json-types.js';
import * as Quota    from '../quota.js';
import * as Fallible from '../fallible/fallible.js';
import { keccak256 } from '../hash.js';
import { throttleBy } from '../throttle.js';

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
 * The key an entry is stored under in KV.
 *
 * KV refuses a key longer than 512 bytes of UTF-8 ("KV GET failed: 414 UTF-8
 * encoded length of 513 exceeds key length limit of 512."), and a key grows
 * with what its computation is keyed by: the markets of a history stream and
 * an account's proxies, the markets of a rewards group. Such a key is stored
 * under its computation's name and its digest. Every key KV takes is stored as
 * it is, so nothing already cached is lost; a computation's own key has ':'
 * after its name where a digest has '#', so the two never meet.
 */
const KV_MAX_KEY_BYTES = 512;

const encoder = new TextEncoder();

function kvKeyOf(key: string): string {
  if (encoder.encode(key).byteLength <= KV_MAX_KEY_BYTES) {
    return key;
  }
  const name = /^[\w.-]{1,64}(?=:)/.exec(key)?.[0] ?? 'key';
  return `${name}#keccak256:${keccak256(key)}`;
}

/*
 * When this isolate logs a call KV refused, by namespace and kind.
 *
 * A refusal is a warning: the request is answered without the cache. It is
 * logged once a minute rather than once a call, since a KV that does not
 * answer refuses every read and write of every request, and a line for each
 * would bury everything else in the log.
 */
type Refusal = 'unreadable' | 'unwritable';

const refusalDue = throttleBy<KVNamespace>(60_000);

/*
 * Workers KV Cache
 * Common cache interface wrapper for Workers KV `KVNamespace' instances.
 * Exposes non-standard methods for `list`, `delete` on entries.
 *
 * A call KV refuses, such as a 429 or a 503, costs a computation only its
 * cache: `get` answers a miss, so the value is computed, and `put` leaves the
 * value computed but not kept. Failing the request instead would answer 500
 * for what could only have made it slower. State that nothing computes again,
 * such as a history cursor, is read and written with `read` and `write`,
 * which throw what KV refused.
 */
class WorkersKvCache implements Cache {
  // the logger as given, before it is scoped: a refusal is logged whatever scopes DEBUG names
  private readonly log: Debug.Logger;

  constructor(
    public store: KVNamespace,
    public revivers: Json.Reviver<unknown>[] = [],
    public debug: Debug.Logger = Debug.MakeLogger([]),
  ) {
    this.log   = debug;
    this.debug = debug.scope('cache');
  }

  async get<T>(key: string): Promise<T | null> {
    let cached: string | null;
    try {
      cached = await this.store.get(kvKeyOf(key));
    } catch (error) {
      this.refused('unreadable', key, error);
      return null;
    }
    return this.parsed<T>(key, cached);
  }

  async put(
    key:     string,
    value:   Json.Representable,
    options: KVNamespacePutOptions = {},
  ): Promise<void> {
    try {
      await this.write(key, value, options);
    } catch (error) {
      this.refused('unwritable', key, error);
    }
  }

  async read<T>(key: string): Promise<T | null> {
    return this.parsed<T>(key, await this.store.get(kvKeyOf(key)));
  }

  async write(
    key:     string,
    value:   unknown,
    options: KVNamespacePutOptions = {},
  ): Promise<void> {
    this.debug.log(`WorkersKvCache: put: ${key} with ${JSON.stringify(options)}`);
    await this.store.put(kvKeyOf(key), JSON.stringify(value), options);
  }

  delete(key: string): Promise<void> {
    this.debug.log(`WorkersKvCache: delete: ${key}`);
    return this.store.delete(kvKeyOf(key));
  }

  // a key too long for KV is listed as its computation's name, '#' and its digest
  list<Metadata>(prefix: string): Promise<KVNamespaceListResult<Metadata>> {
    this.debug.log(`WorkersKvCache: list: { prefix: ${prefix} }`);
    return this.store.list({ prefix });
  }

  private parsed<T>(key: string, cached: string | null): T | null {
    if (cached === null || cached === '') {
      this.debug.log(`WorkersKvCache: get: miss: ${key}`);
      return null;
    }
    this.debug.log(`WorkersKvCache: get: hit: ${key}`);
    return Json.parse(cached, this.revivers) as T;
  }

  private refused(kind: Refusal, key: string, error: unknown): void {
    if (!refusalDue(this.store, kind)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.log.warn(`computation cache ${kind}: ${message}: ${key}`);
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
  // the key KV stores an entry under
  kvKeyOf,
  KV_MAX_KEY_BYTES,
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
