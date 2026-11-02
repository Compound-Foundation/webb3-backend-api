import t from 'tap';

import * as Compute   from '../../../lib/symbolic/computation.js';
import * as Cache     from '../../../lib/symbolic/cache.js';

import { marketRewards } from '../../../lib/computations/market/market-rewards.js';

import { MemoryKv } from '../../util/kv.js';

/*
 * KV refuses a key longer than 512 bytes of UTF-8, and some computations are
 * keyed by lists that grow: the markets of a network, the proxies an account
 * has. The cache stores such a key under its computation's name and its
 * digest, and the KV double refuses it as the runtime does. Names are
 * versioned as the evaluator versions them, so a new version of a computation
 * keeps the test about its key.
 */

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

t.test('a key KV takes is stored as it is, and a longer one under its name and digest', async t => {
  const name    = Compute.versionedName('marketRewards', marketRewards.version);
  const longest = `${name}:${'a'.repeat(Cache.KV_MAX_KEY_BYTES - name.length - 1)}`;
  t.equal(bytes(longest), Cache.KV_MAX_KEY_BYTES);
  t.equal(Cache.kvKeyOf(longest), longest, 'a key of 512 bytes is stored as it is');

  // KV counts a key's bytes, not its characters
  const wide = `${name}:(label:${'₮'.repeat(170)})`;
  t.ok(wide.length < Cache.KV_MAX_KEY_BYTES && bytes(wide) > Cache.KV_MAX_KEY_BYTES,
    'a key of fewer characters than the limit can be more bytes than it');

  for (const key of [ `${longest}b`, wide ]) {
    const stored = Cache.kvKeyOf(key);
    t.match(stored, new RegExp(`^${name}#keccak256:[0-9a-f]{64}$`), 'a longer one is stored under its computation and its digest');
    t.ok(bytes(stored) <= Cache.KV_MAX_KEY_BYTES, 'which KV takes');
    t.equal(Cache.kvKeyOf(key), stored, 'the same one every time');
  }
  t.not(Cache.kvKeyOf(`${longest}b`), Cache.kvKeyOf(`${longest}c`), 'two keys that differ past the limit are two entries');
  t.match(Cache.kvKeyOf('x'.repeat(600)), /^key#keccak256:[0-9a-f]{64}$/, 'and a key no computation names goes under a generic name');
});

t.test('the KV double refuses a key the runtime refuses, as the runtime does', async t => {
  const kv      = MemoryKv({});
  const key     = 'a'.repeat(513);
  const refused = (method: string) => ({
    message: `KV ${method} failed: 414 UTF-8 encoded length of 513 exceeds key length limit of 512.`,
  });

  await t.rejects(kv.get(key), refused('GET'));
  await t.rejects(kv.put(key, 'value'), refused('PUT'));
  await t.rejects(kv.delete(key), refused('DELETE'));
  await t.rejects(kv.list({ prefix: key }), refused('GET'), 'a listing is a GET, and its prefix a key');
  await t.rejects(kv.get('₮'.repeat(171)), refused('GET'), 'counting bytes, not characters');

  await kv.put('a'.repeat(512), 'value');
  t.equal(await kv.get('a'.repeat(512)), 'value', 'while a key of 512 bytes is taken');
});
