import t from 'tap';

import { entityTagsOf, matchesIfNoneMatch } from '../../../src/http/conditional.js';

/*
 * If-None-Match as RFC 9110 reads it: `*`, or a list of entity tags compared
 * weakly, so that the tag a browser sends back for a response Cloudflare
 * compressed — the same tag, marked weak — still names it. A header that is
 * neither form names nothing.
 */
const ETAG = '"v1-r2-snapshot-8f1e0f3c-1bd74ebe"';

function asked(header: string | null): boolean {
  const headers = header === null ? {} : { 'If-None-Match': header };
  return matchesIfNoneMatch(new Request('https://api.test.local/registry/v1/active', { headers }), ETAG);
}

t.test('a header names the representation by its tag, weak or not, alone or in a list', async t => {
  t.equal(asked(ETAG), true, 'the tag itself');
  t.equal(asked(`W/${ETAG}`), true, 'the tag marked weak, as a browser sends back what Cloudflare compressed');
  t.equal(asked('*'), true, 'any representation');
  t.equal(asked(`"v1-r2-snapshot-another", ${ETAG}`), true, 'a list with the tag in it');
  t.equal(asked(`W/"v1-r2-snapshot-another",W/${ETAG}`), true, 'and one of weak tags, without spaces');
  t.equal(asked(`, ${ETAG} ,`), true, 'empty elements of a list are skipped');
});

t.test('a header that names another representation, or nothing it can be read as, does not', async t => {
  t.equal(asked(null), false, 'no header');
  t.equal(asked('"v1-r2-snapshot-another", W/"v1-r2-snapshot-yet-another"'), false, 'a list without the tag');
  t.equal(asked(ETAG.slice(1, -1)), false, 'the tag without its quotes');
  t.equal(asked(`w/${ETAG}`), false, 'a weak mark in the wrong case');
  t.equal(asked(`${ETAG} "v1-r2-snapshot-another"`), false, 'two tags without a comma between them');
  t.equal(asked(`*, ${ETAG}`), false, 'a star in a list');
  t.equal(asked(''), false, 'an empty header');
});

t.test('a list is read tag by tag, commas inside the quotes included', async t => {
  t.same(entityTagsOf('"a", W/"b,c" ,,"d"'), [ 'a', 'b,c', 'd' ]);
  t.same(entityTagsOf(''), [], 'an empty list names no tag');
  t.equal(entityTagsOf('"a" b'), null, 'and text that is no list is none');
});

/*
 * The header is the client's, as long as it cares to make it, and every read
 * of the registry reads it before anything is authenticated. A run of
 * whitespace is read once, whatever ends it, rather than split every way it
 * can be before the element is refused.
 */
t.test('a long run of whitespace is read in one pass', async t => {
  const spaces  = ' '.repeat(64 * 1024);
  const started = Date.now();
  t.equal(asked(`"v1-r2-snapshot-another",${spaces}x`), false, 'whitespace that ends in no tag and no comma names nothing');
  t.equal(entityTagsOf(`"a"${spaces}x`), null, 'nor does it after a tag');
  t.equal(asked(`"v1-r2-snapshot-another",${spaces}${ETAG}${spaces}`), true, 'and whitespace around a tag is skipped');
  t.ok(Date.now() - started < 500, 'well within a second, where trying every split of it took seconds');
});
