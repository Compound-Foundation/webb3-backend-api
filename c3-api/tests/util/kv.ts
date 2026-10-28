/*
 * In-memory KVNamespace test double.
 *
 * Previously backed by @miniflare/kv + @miniflare/storage-memory (Miniflare
 * v2), which are EOL. Miniflare v3+ no longer exposes standalone, synchronous
 * KVNamespace/MemoryStorage classes (KV is only reachable asynchronously via a
 * running Miniflare/workerd instance), so we ship a tiny synchronous shim here
 * instead. This keeps MemoryKv() synchronous and dependency-free while
 * implementing the KVNamespace surface the tests use (get / put / delete /
 * list), and preserves the original StoredValueMeta seed shape so callers that
 * introspect encodeSeed() output (e.g. cache-seed regeneration) are unchanged.
 *
 * It refuses a key the runtime refuses, a key longer than KV takes, with the
 * runtime's error: a cache key grows with what it names, and one that would
 * fail every call in production must not pass here.
 */

import { kvKeyOf } from '../../lib/symbolic/cache.js';

type CacheSeed = { [_: string]: any };
// Mirrors the StoredValueMeta shape the seed format historically used: the
// JSON-stringified value encoded as utf-8 bytes.
type StoredValueMeta = { value: Uint8Array, metadata?: unknown };
type StorageMap = Map<string, StoredValueMeta>;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/*
 * The longest key workerd takes, in bytes of UTF-8 (its kMaxKeyLength): a
 * longer one is refused before anything is sent. It is the runtime's limit,
 * so it is written out here rather than read from the cache that keeps under it.
 */
const MAX_KEY_BYTES = 512;

function refuseLongKey(method: 'GET' | 'PUT' | 'DELETE', key: string): void {
  const length = ENCODER.encode(key).byteLength;
  if (length > MAX_KEY_BYTES) {
    throw new Error(`KV ${method} failed: 414 UTF-8 encoded length of ${length} exceeds key length limit of ${MAX_KEY_BYTES}.`);
  }
}

/*
 * Our cache seeds are typically unstringified JSON objects. We JSON.stringify
 * each value and store the utf-8 bytes wrapped in a StoredValueMeta. A seed
 * that is already a StorageMap (e.g. produced by a previous encodeSeed call) is
 * passed through untouched so callers can encode once and reuse it across KVs.
 * A seed's key is the cache's key, so each is stored where the cache reads it.
 */
function encodeSeed(seed: CacheSeed | StorageMap): StorageMap {
  if (seed instanceof Map) {
    return seed;
  }
  const encodedEntries: [ string, StoredValueMeta ][] = (
    Object.entries(seed).map(([ k, v ]) => [ kvKeyOf(k), { value: ENCODER.encode(JSON.stringify(v)) } ])
  );
  return new Map(encodedEntries);
}

function MemoryKv({ seed = {} }: { seed?: CacheSeed | StorageMap }): KVNamespace<string> {
  // Copy the seed so each KV instance owns an independent store (the same
  // encoded seed is reused across multiple bindings in some tests).
  const store: StorageMap = new Map(encodeSeed(seed));

  /*
   * `get` honours the type argument, as the real binding does. A double that
   * always answered with a string would make every `get(key, 'json')` read
   * like a corrupt entry: the caller would discard it, refill it, and never
   * exercise the cache it is testing.
   */
  const memoryKv = {
    async get(key: string, type?: string | { type?: string }): Promise<unknown> {
      refuseLongKey('GET', key);
      const entry = store.get(key);
      if (entry === undefined) {
        return null;
      }
      const text = DECODER.decode(entry.value);
      const kind = typeof(type) === 'string' ? type : type?.type;
      return kind === 'json' ? JSON.parse(text) : text;
    },
    async getWithMetadata(key: string, type?: string | { type?: string }): Promise<{ value: unknown, metadata: unknown }> {
      const entry = store.get(key);
      return {
        value:    await memoryKv.get(key, type),
        metadata: entry?.metadata ?? null,
      };
    },
    async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
      refuseLongKey('PUT', key);
      const str = typeof value === 'string' ? value : String(value);
      store.set(key, { value: ENCODER.encode(str), ...(options?.metadata === undefined ? {} : { metadata: options.metadata }) });
    },
    async delete(key: string): Promise<void> {
      refuseLongKey('DELETE', key);
      store.delete(key);
    },
    async list({ prefix = '' }: { prefix?: string } = {}): Promise<{
      keys: { name: string }[];
      list_complete: true;
      cacheStatus: null;
    }> {
      // a listing is a GET, and its prefix a key
      refuseLongKey('GET', prefix);
      const keys = (
        [ ...store.keys() ]
          .filter(name => name.startsWith(prefix))
          .map(name => ({ name }))
      );
      return { keys, list_complete: true, cacheStatus: null };
    },
  };

  return memoryKv as unknown as KVNamespace<string>;
}

type KvMethod = 'get' | 'getWithMetadata' | 'list' | 'put' | 'delete';

/*
 * What the binding throws when KV does not take a call: `KV <method> failed:`
 * and the status KV answered. A listing is a GET to it, and a write past one a
 * second to a key is answered 429.
 */
const REFUSALS: Record<KvMethod, string> = {
  get:             'KV GET failed: 503 Service Unavailable',
  getWithMetadata: 'KV GET failed: 503 Service Unavailable',
  list:            'KV GET failed: 503 Service Unavailable',
  put:             'KV PUT failed: 429 Too Many Requests',
  delete:          'KV DELETE failed: 503 Service Unavailable',
};

/*
 * A namespace that fails the calls `refuses` names, as the binding fails
 * them, and hands every other call to `kv`. It asks on each call, with what
 * the call was given, so a test can refuse one key or have KV come back. A
 * call is refused as REFUSALS says, or with the message `refuses` answers
 * instead: KV that does not answer refuses a write with 503, not 429.
 */
function refusingKv(
  kv: KVNamespace = MemoryKv({}),
  refuses: (method: KvMethod, parameters: unknown[]) => boolean | string = () => true,
): KVNamespace {
  return new Proxy(kv, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof(property) === 'string' && Object.hasOwn(REFUSALS, property) && typeof(value) === 'function') {
        const method = property as KvMethod;
        return async (...parameters: unknown[]) => {
          const refusal = refuses(method, parameters);
          if (refusal !== false) {
            throw new Error(refusal === true ? REFUSALS[method] : refusal);
          }
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
}

export {
  MemoryKv,
  encodeSeed,
  refusingKv,
};
