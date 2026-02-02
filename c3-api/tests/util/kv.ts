import { KVNamespace   as MiniflareKVNamespace   } from '@miniflare/kv';
import { MemoryStorage as MiniflareMemoryStorage } from '@miniflare/storage-memory';

import type { StoredValueMeta } from '@miniflare/shared';

type CacheSeed = { [_: string]: any };
type StorageMap = Map<string, StoredValueMeta>;

/*
 * Our cache seeds are typically unstringified JSON objects, but the
 * Miniflare MemoryStorage module requires a Uint8Array of utf-8 bytes
 * wrapped in a StoredValueMeta object that looks like { value: bytes }.
 *
 * So we JSON.stringify any non-string seed values and wrap everything in
 * a StoredValueMeta, because otherwise with there being no bulk-put API
 * (even on the Miniflare type...) we would have to wrap the whole thing
 * in a Promise and wait for Miniflare to validate and check every cache
 * entry in the seed one by one -- which is totally unnecessary and slow.
 */
function encodeSeed(seed: CacheSeed | StorageMap): StorageMap {
  if (seed instanceof Map) {
    return seed;
  }
  const encoder = new TextEncoder();
  const encodedEntries: [ string, StoredValueMeta ][] = (
    Object.entries(seed)
      .map(([ k, v ]) => {
        const encoded = encoder.encode(JSON.stringify(v));
        return [ k, { value: encoded } ];
      })
  );
  return new Map(encodedEntries);
}

function MemoryKv({ seed = {} }: { seed?: CacheSeed | StorageMap }): KVNamespace<string> {
  const storage = new MiniflareMemoryStorage(encodeSeed(seed));
  const memoryKv = new MiniflareKVNamespace(storage);
  return memoryKv as KVNamespace<string>;
}

export {
  MemoryKv,
  encodeSeed,
};
