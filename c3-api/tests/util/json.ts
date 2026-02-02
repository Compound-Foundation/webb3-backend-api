import * as fs from 'node:fs/promises';

import type * as Json from '../../lib/json-types.js';

async function loadJson<T = unknown>(
  path: string,
  revivers: Json.Reviver<unknown>[] = [],
): Promise<T> {
  const utf8Bytes = await fs.readFile(path, { encoding: 'utf8' });
  return JSON.parse(utf8Bytes, (_key, value) => {
    const reviver = revivers.find(reviver => reviver.accept(value));
    if (!!reviver) return reviver.revive(value);
    return value;
  });
}

export { loadJson as load };
