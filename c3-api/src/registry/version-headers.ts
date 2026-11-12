/*
 * How a response names the registry version it was computed from.
 *
 * One builder, because these two headers are the contract a client uses to
 * tell two answers apart, and they are set from three places: the registry's
 * own reads, failed ones included, an activation result, and every legacy
 * route that resolved a market. Renaming or adding to the pair must not mean
 * finding every copy.
 *
 * An answer computed from a version the database could not confirm says how
 * old that version is, and that the answer may not be stored, by a browser, a
 * proxy or anything else. The two travel together, so a caller cannot set one
 * and forget the other.
 */
type VersionRef = {
  id:       string,
  checksum: string,
};

// for an answer whose version the legacy router names itself (summary-tokens.ts)
function staleHeaders(staleFor: number | null): Record<string, string> {
  return staleFor === null ? {} : { 'X-Registry-Stale': String(staleFor), 'Cache-Control': 'no-store' };
}

function registryHeaders({ id, checksum }: VersionRef, staleFor: number | null = null): Record<string, string> {
  return {
    'X-Registry-Version':  id,
    'X-Registry-Checksum': checksum,
    ...staleHeaders(staleFor),
  };
}

export type { VersionRef };
export { registryHeaders, staleHeaders };
