/*
 * Conditional requests: whether a client already holds what a response would
 * send (RFC 9110, section 13).
 *
 * An `If-None-Match` is `*`, which names any representation the resource
 * has, or a list of entity tags, any one of which may name it. The
 * comparison is weak (section 13.1.2): `W/"x"` and `"x"` are the same tag to
 * this header. That is not a nicety. Cloudflare marks the ETag of a response
 * weak when it compresses it, which it does for every browser, so the tag a
 * browser sends back is the weak form of the one the worker sent.
 */

/*
 * The opaque tags a list of entity tags names, in order, or null when the
 * text is not such a list. Elements are separated by commas and may be empty,
 * which a list allows (section 5.6.1); a comma inside the quotes is part of
 * the tag. An element that is not a tag — unquoted, or marked `w/` rather
 * than `W/` — makes the whole of it something else.
 */
function entityTagsOf(text: string): string[] | null {
  /*
   * One element and the comma after it: an entity tag, weak or not, or
   * nothing, between optional whitespace. The whitespace after a tag is
   * matched with the tag: two runs of it side by side, around a tag that may
   * be absent, would be tried at every split of a long run that ends in
   * anything but a comma, which any client could send to spend seconds of a
   * request's time.
   */
  const element = /[ \t]*(?:(?:W\/)?"([^"]*)"[ \t]*)?(,|$)/y;
  const tags: string[] = [];
  for (;;) {
    const match = element.exec(text);
    if (match === null) {
      return null;
    }
    if (match[1] !== undefined) {
      tags.push(match[1]);
    }
    if (match[2] === '') {
      return tags;
    }
  }
}

/*
 * Whether the request's `If-None-Match` names the representation a response
 * would send under `etag`, so that a 304 answers it in place of the body. A
 * header that is neither form names nothing: it is answered with the body,
 * as if it were absent, and never with a 304 it did not ask for.
 */
function matchesIfNoneMatch(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match');
  if (header === null) {
    return false;
  }
  if (header === '*') {
    return true;
  }
  const [ current ] = entityTagsOf(etag) ?? [];
  const named = entityTagsOf(header);
  return current !== undefined && named !== null && named.includes(current);
}

export { entityTagsOf, matchesIfNoneMatch };
