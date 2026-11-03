import t from 'tap';

import { MAX_BODY_BYTES, readJsonObject } from '../../../src/http/json.js';

/*
 * The administrative body reader. A body is refused for its size before it is
 * parsed, whether it declares its length or is sent in chunks, and a chunked
 * one is read no further than the first chunk past the limit.
 */
const CHUNK = new TextEncoder().encode(' '.repeat(16 * 1024));

// a body sent in chunks without a declared length, counting how much of it was read
function chunked(chunks: number): { request: Request, pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (pulled === chunks) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(CHUNK);
    },
  });
  const request = new Request('https://api.test.local/registry/v1/admin/sync', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    duplex:  'half',
  } as RequestInit);
  return { request, pulled: () => pulled };
}

t.test('a body past the limit is too large, however it is sent', async t => {
  const declared = new Request('https://api.test.local/registry/v1/admin/sync', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_BODY_BYTES + 1) },
    body:    ' '.repeat(MAX_BODY_BYTES + 1),
  });
  await t.rejects(readJsonObject(declared), { code: 'PAYLOAD_TOO_LARGE', status: 413 },
    'one that declares a length past the limit is refused as too large, not as malformed');

  const { request, pulled } = chunked(64);
  await t.rejects(readJsonObject(request), { code: 'PAYLOAD_TOO_LARGE', status: 413 },
    'and so is one that never said how large it is');
  t.ok(pulled() <= MAX_BODY_BYTES / CHUNK.byteLength + 2, `which was read no further than the limit: ${pulled()} of 64 chunks`);
});

t.test('a body within the limit is read whole, in however many chunks it comes', async t => {
  const { request } = chunked(3);
  t.same(await readJsonObject(request), {}, 'whitespace is an empty command');

  const parts = [ '{"reason":', '"split', ' across chunks"}' ].map(part => new TextEncoder().encode(part));
  const body  = new ReadableStream({
    start(controller) {
      parts.forEach(part => controller.enqueue(part));
      controller.close();
    },
  });
  const split = new Request('https://api.test.local/registry/v1/admin/sync', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    duplex:  'half',
  } as RequestInit);
  t.same(await readJsonObject(split), { reason: 'split across chunks' }, 'and JSON is parsed from all of them');
});

/*
 * A media type is compared in any case (RFC 9110), and JSON is
 * application/json or a +json type: a type that merely ends in "json" is not
 * JSON, and neither is a +json suffix without a type and a name before it.
 */
t.test('a body is JSON when its media type is, in any case', async t => {
  const BODY = '{"reason":"typed"}';
  const sent = (headers: Record<string, string>, body: string | Blob = BODY) =>
    new Request('https://api.test.local/registry/v1/admin/sync', { method: 'POST', headers, body });

  for (const type of [ 'application/json', 'Application/JSON; charset=UTF-8', 'APPLICATION/JSON', 'application/merge-patch+json' ]) {
    t.same(await readJsonObject(sent({ 'Content-Type': type })), { reason: 'typed' }, `${type} is read`);
  }
  // a blob without a type, unlike a string, is sent without a Content-Type
  t.same(await readJsonObject(sent({}, new Blob([ BODY ]))), { reason: 'typed' },
    'and so is a body that names no type');

  for (const type of [ 'application/foojson', 'text/json', 'application/x-json', 'text/plain', 'foo+json', '+json', 'application/+json' ]) {
    await t.rejects(readJsonObject(sent({ 'Content-Type': type })),
      { code: 'BAD_REQUEST', status: 400, message: 'the request body must be JSON' }, `${type} is refused`);
  }
});
