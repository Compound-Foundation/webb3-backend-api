import { Settings      } from './settings.js';
import { handleRequest } from './handler.js';
import * as providers    from './providers.js'

export interface Env extends providers.Secrets {
  // kv for storing provider and application metadata
  kv: KVNamespace;
  // behavioral settings, such as fallback expiration TTL
  settings: Settings;
  // configurable allow key and allow list. allowedAppKey is a Worker secret.
  // When it is not set, the proxy does not check application keys.
  allowedAppKey?: string;
  allowedHosts: string[];
  // per-client rate limiter, and whether to only log requests over the limit
  rateLimiter?: RateLimit;
  rateLimitLogOnly?: boolean;
}

// Stub execution context for the default fetch() arg (and tests). Only
// waitUntil/passThroughOnException are used; cast past the other
// ExecutionContext members (props/tracing) added in newer workers-types.
const noopContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

/*
 * security headers applied to every response, per security team recommendation
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security':    'max-age=63072000; includeSubDomains; preload',
  'Content-Security-Policy':      "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options':       'nosniff',
  'X-Frame-Options':              'DENY',
  'Referrer-Policy':              'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext = noopContext,
  ): Promise<Response> {
    // Answer OPTIONS requests with CORS headers.
    const origin = request.headers.get('origin') ?? '<unknown>';
    if (request.method === 'OPTIONS') { // 200: OK
      return cors(origin, new Response());
    }
    // Throttle each client on environments that bind a rate limiter.
    if (await isRateLimited(request, env.rateLimiter)) {
      if (env.rateLimitLogOnly) {
        console.warn(`rate limit exceeded (log only)`);
      } else { // 429: Too Many Requests
        return cors(origin, new Response(`rate limited`, {
          status: 429,
          // the period of every rateLimiter binding in wrangler.toml
          headers: { 'Retry-After': '60' },
        }));
      }
    }
    // Load secrets from environment to instantiate node endpoints.
    const endpoints = providers.instantiate(env);
    // Validate the request, then forward it to the node provider.
    let response; try {
      response = await handleRequest(request, {
        endpoints,
        kv:       env.kv,
        settings: env.settings,
        allowedAppKey: env.allowedAppKey ?? '',
        allowedHosts: env.allowedHosts,
        defer:    context.waitUntil,
      });
    } catch {
      return cors(origin, new Response(`unexpected error`, { status: 500 }));
    }
    // Always respond with proper CORS headers.
    response.headers.set('Content-Type', 'application/json');
    return cors(origin, response);
  },
};

/*
 * The most calls one request is charged for. It must be above the limit of
 * every rateLimiter binding in wrangler.toml, so that a large batch is still
 * refused, while bounding the limit() calls made for one request.
 */
const MAX_CHARGED_CALLS = 100;

/*
 * Count each JSON-RPC call in the request against the client's rate limit,
 * so that batching calls into one request does not raise the limit.
 *
 * Cloudflare sets cf-connecting-ip on every request from the internet, and
 * clients cannot override it. With the zone's Pseudo IPv4 setting on, it
 * holds a made-up IPv4 address and the real one is in cf-connecting-ipv6.
 * Requests from other Workers over a service binding have neither header,
 * and are not limited. If the limiter fails, let the request through: an
 * error in the limiter must not take the proxy down.
 */
async function isRateLimited(request: Request, rateLimiter?: RateLimit) {
  const clientIp = (
       request.headers.get('cf-connecting-ipv6')
    ?? request.headers.get('cf-connecting-ip')
  );
  if (!rateLimiter || !clientIp) {
    return false;
  }
  try {
    const key = rateLimitKey(clientIp);
    // charge the first call before reading the body, so that a client over
    // the limit cannot make the proxy parse large bodies
    if (!(await rateLimiter.limit({ key })).success) {
      return true;
    }
    const calls = Math.min(await countRpcs(request), MAX_CHARGED_CALLS);
    for (let call = 1; call < calls; call++) {
      if (!(await rateLimiter.limit({ key })).success) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error(`rate limiter error: ${(error as Error).message}`);
    return false;
  }
}

/*
 * An IPv6 client usually holds a whole /64 and can send each request from a
 * different address in it, so IPv6 clients are limited by their /64 prefix.
 */
function rateLimitKey(clientIp: string) {
  // IPv4, or IPv4-mapped IPv6 such as ::ffff:192.0.2.1
  if (!clientIp.includes(':') || clientIp.includes('.')) {
    return clientIp;
  }
  const [ head = '', tail = '' ] = clientIp.split('::');
  const headGroups = head.split(':').filter(group => group.length > 0);
  const tailGroups = tail.split(':').filter(group => group.length > 0);
  const zeroGroups = Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0');
  const prefix = [ ...headGroups, ...zeroGroups, ...tailGroups ]
    .slice(0, 4)
    .map(group => parseInt(group, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

/*
 * The number of JSON-RPC calls in the request body: the length of a batch,
 * and 1 for a single call or a body that is not a JSON array.
 */
async function countRpcs(request: Request) {
  try {
    const body = await request.clone().json();
    return Array.isArray(body) ? body.length : 1;
  } catch {
    return 1;
  }
}

function cors(origin: string, response: Response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Headers', 'Content-Type, User-Agent, Accept');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  // let browsers read the backoff on 429 and 503 responses
  headers.set('Access-Control-Expose-Headers', 'Retry-After');
  for (const [ name, value ] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  const status = response.status;
  return new Response(response.body, { ...response, headers, status });
}
