import { Settings      } from './settings.js';
import { handleRequest } from './handler.js';
import * as providers    from './providers.js'

export interface Env extends providers.Secrets {
  // kv for storing provider and application metadata
  kv: KVNamespace;
  // behavioral settings, such as fallback expiration TTL
  settings: Settings;
  // configurable allow key and allow list
  allowedAppKey: string;
  allowedHosts: string[];
}

const noopContext: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

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
    // Load secrets from environment to instantiate node endpoints.
    const endpoints = providers.instantiate(env);
    // Validate the request, then forward it to the node provider.
    let response; try {
      response = await handleRequest(request, {
        endpoints,
        kv:       env.kv,
        settings: env.settings,
        allowedAppKey: env.allowedAppKey,
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
