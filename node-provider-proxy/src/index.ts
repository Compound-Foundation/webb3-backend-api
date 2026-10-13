import { Settings      } from './settings.js';
import { handleRequest } from './handler.js';
import * as providers    from './providers.js'

export interface Env extends providers.Secrets {
  // kv for storing provider and application metadata
  kv: KVNamespace;
  // behavioral settings, such as fallback expiration TTL
  settings: Settings;
  // configurable allow key and allow list. allowedAppKey is a Worker secret;
  // when it is not set, the proxy does not check application keys.
  allowedAppKey?: string;
  allowedHosts: string[];
  // per-client-IP rate limiter, bound only on browser-facing environments
  rateLimiter?: RateLimit;
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
    // Throttle each client IP on environments that bind a rate limiter.
    if (await isRateLimited(request, env.rateLimiter)) { // 429: Too Many Requests
      return cors(origin, new Response(`rate limited`, {
        status: 429,
        // the period of every rateLimiter binding in wrangler.toml
        headers: { 'Retry-After': '60' },
      }));
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
 * Count the request against the client IP's rate limit. Cloudflare sets
 * cf-connecting-ip on every request from the internet, and clients cannot
 * override it. If the limiter is unbound or fails, let the request through:
 * an error in the limiter must not take the proxy down.
 */
async function isRateLimited(request: Request, rateLimiter?: RateLimit) {
  const clientIp = request.headers.get('cf-connecting-ip');
  if (!rateLimiter || !clientIp) {
    return false;
  }
  try {
    const { success } = await rateLimiter.limit({ key: clientIp });
    return !success;
  } catch (error) {
    console.error(`rate limiter error: ${(error as Error).message}`);
    return false;
  }
}

function cors(origin: string, response: Response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Headers', 'Content-Type, User-Agent, Accept');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  for (const [ name, value ] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  const status = response.status;
  return new Response(response.body, { ...response, headers, status });
}
