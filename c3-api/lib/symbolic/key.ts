type ProducesKey = (
  | string
  | number
  | boolean
  | ProducesKey[]
  | readonly ProducesKey[]
  | { [_: string]: ProducesKey }
  | { key: (...args: any[]) => string }
);

type Struct = { [_: string]: ProducesKey };

/*
 * A key is a simple, readable unique identifier for a value. Given any
 * value for which a key can be produced, `toKey` produces the key from
 * the value. Similar to `JSON.stringify`, except with key strings:
 *   1. A source object cannot be recovered from its key string
 *   2. Key source objects cannot contain null properties
 *   3. Keys do not wrap field names in quotes, top-level objects in (),
 *      or top-level arrays in [], to minimize character count
 *   4. `toKey` maintains insertion-order independence for objects by
 *      lexicographically sorting object properties by key
 *
 * e.g. toKey('', { x: { y: [ { z: 3 } ], k: 0 } })   ->  x:(k:0;y:[z:3])
 *      toKey('k', [{ c: 'z' }, { a: [ 'b', 'a' ] }]) ->  k:[a:[a,b],c:z]
 */
function toKey(parentKey: string, source: ProducesKey): string {
  if (source instanceof Array) {
    const arrayKey = `${source.map(item => toKey('', item)).join(',')}`;
    if (parentKey.length > 0) {
      return `${parentKey}:[${arrayKey}]`;
    } else {
      return arrayKey;
    }
  } else if (typeof source === 'object') {
    if ('key' in source && (typeof source.key === 'function')) {
      if (parentKey.length > 0) {
        return `${parentKey}:${source.key()}`;
      } else {
        return source.key();
      }
    } else {
      const allEntries = Object.entries(source);
      const entries = allEntries.filter(([key]) => {
        return !['apiHost', 'nodeHost', 'nodeKey'].includes(key);
      });

      // sort keys lexicographically before serializing
      entries.sort(([ k_a ], [ k_b ]) => {
        if (k_a === k_b) return 0;
        return k_a < k_b ? -1 : 1;
      });
      const objectKey = entries
        .map(([ k, v ]) => toKey(k, v))
        .join(`;`);
      if (parentKey.length > 0) {
        return `${parentKey}:(${objectKey})`;
      } else {
        return objectKey;
      }
    }
  } else {
    if (['apiHost', 'nodeHost', 'nodeKey'].includes(parentKey)) {
      return '';
    } else {
      const prefix = parentKey && `${parentKey}:`;
      return `${prefix}${source.toString()}`;
    }
  }
}

export type {
  Struct,
  ProducesKey,
};

export {
  toKey,
};
