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
 */

type CacheSeed = { [_: string]: any };
// Mirrors the StoredValueMeta shape the seed format historically used: the
// JSON-stringified value encoded as utf-8 bytes.
type StoredValueMeta = { value: Uint8Array };
type StorageMap = Map<string, StoredValueMeta>;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/*
 * Our cache seeds are typically unstringified JSON objects. We JSON.stringify
 * each value and store the utf-8 bytes wrapped in a StoredValueMeta. A seed
 * that is already a StorageMap (e.g. produced by a previous encodeSeed call) is
 * passed through untouched so callers can encode once and reuse it across KVs.
 */
function encodeSeed(seed: CacheSeed | StorageMap): StorageMap {
  if (seed instanceof Map) {
    return seed;
  }
  const encodedEntries: [ string, StoredValueMeta ][] = (
    Object.entries(seed).map(([ k, v ]) => [ k, { value: ENCODER.encode(JSON.stringify(v)) } ])
  );
  return new Map(encodedEntries);
}

function MemoryKv({ seed = {} }: { seed?: CacheSeed | StorageMap }): KVNamespace<string> {
  // Copy the seed so each KV instance owns an independent store (the same
  // encoded seed is reused across multiple bindings in some tests).
  const store: StorageMap = new Map(encodeSeed(seed));

  const memoryKv = {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      return entry ? DECODER.decode(entry.value) : null;
    },
    async put(key: string, value: string): Promise<void> {
      const str = typeof value === 'string' ? value : String(value);
      store.set(key, { value: ENCODER.encode(str) });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list({ prefix = '' }: { prefix?: string } = {}): Promise<{
      keys: { name: string }[];
      list_complete: true;
      cacheStatus: null;
    }> {
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

export {
  MemoryKv,
  encodeSeed,
};
