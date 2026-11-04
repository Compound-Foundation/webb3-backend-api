/*
 * CORS, decided here for every route of the worker, by the kind of route.
 *
 * The legacy routes answer every origin, and the public registry reads are
 * the same kind of public data, so they keep that. The administrative routes
 * do not: they are authenticated writes, and a browser on any origin must not
 * be able to make them on an operator's behalf. They answer no CORS headers
 * at all, which is what keeps a cross-origin script from reading a response
 * even if it manages to send the request.
 *
 * Which kind a path is, the router that owns it says: the entrypoint hands a
 * path to the registry router or to the legacy one, and the registry router
 * tells its administrative routes from its public ones. Each response takes
 * its headers from the router that answered it, and neither sets the other's,
 * so what this module says for a kind of route is what the route answers with.
 */
/*
 * The version headers are the contract a browser client reads: which version
 * answered, and whether the answer came from the cache because the database
 * could not be reached. A response that does not expose them leaves a
 * cross-origin client unable to see either, and it would take a stale answer
 * for a current one.
 *
 * The ETag too: the preflight allows If-None-Match, and a script that keeps
 * its own copy of a snapshot can only send the tag back if it can read it.
 * And Retry-After, which says when a 503 is worth asking again.
 */
const EXPOSED_HEADERS = 'ETag, X-Registry-Version, X-Registry-Checksum, X-Registry-Stale, Retry-After';


const PUBLIC_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':   '*',
  'Access-Control-Expose-Headers': EXPOSED_HEADERS,
};

const PUBLIC_PREFLIGHT: Record<string, string> = {
  ...PUBLIC_CORS,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Max-Age':       '86400',
};

// the legacy routes take GET alone, and their preflight says no more
const LEGACY_PREFLIGHT: Record<string, string> = {
  ...PUBLIC_CORS,
  'Access-Control-Allow-Methods': 'GET',
};

// the kinds of route that answer a browser differently
type CorsRoute = 'legacy' | 'public' | 'admin';

/*
 * What each kind answers with. A legacy route's are the public registry
 * reads' own: a legacy route that resolves a market names the version it was
 * computed from in the same headers, and a browser has to be able to read
 * them there too. An administrative route answers none, to a preflight as to
 * anything else, and the caller must not add any.
 */
const CORS: Record<CorsRoute, { response: Record<string, string>, preflight: Record<string, string> }> = {
  legacy: { response: PUBLIC_CORS, preflight: LEGACY_PREFLIGHT },
  public: { response: PUBLIC_CORS, preflight: PUBLIC_PREFLIGHT },
  admin:  { response: {},          preflight: {} },
};

function corsHeaders(route: CorsRoute, { preflight = false }: { preflight?: boolean } = {}): Record<string, string> {
  return { ...CORS[route][preflight ? 'preflight' : 'response'] };
}

export type { CorsRoute };
export { corsHeaders };
