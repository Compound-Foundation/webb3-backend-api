/*
 * these are all local packages, which are not published anywhere.
 */
import * as jsonRpc      from 'json-rpc';
import * as Fallible     from 'fallible';
import * as KnownNetwork from '@compound-finance/well-known-networks';

import type {
  Endpoints,
  ProviderEndpoint,
} from '@compound-finance/well-known-node-providers';

import type { Settings } from './settings.js';

interface HandlerContext {
  kv:        KVNamespace,
  settings:  Settings,
  endpoints: Endpoints,
  allowedAppKey: string,
  allowedHosts: string[],
  // deferred asynchronous activity that we don't want to wait on
  defer: (_: Promise<any>) => void,
}

/*
 * Validate and route EVM-compatible JSON-RPC requests to any supported
 * network to an appropriate node provider.
 */
export async function handleRequest(
  request: Request,
  context: HandlerContext,
): Promise<Response> {
  const { kv, settings, endpoints, allowedAppKey, allowedHosts } = context;

  // requests to EVM-compatible JSON-RPC nodes must be POST requests.
  if (request.method !== 'POST') { // 405: Method Not Allowed
    return new Response(`unexpected request`, { status: 405 });
  }

  /*
   * The node endpoint proxy supports requests like:
   *    {worker_host}/ethereum-mainnet[/{key}]
   *
   * where the path must have exactly 1-2 segments, and the first segment
   * must name a network in @compound-finance/well-known-networks.
   */
  const url = new URL(request.url);
  const pathSegments = url.pathname.split('/').filter(s => s.length > 0);
  if (pathSegments.length > 2) { // 400: Bad Request
    return new Response(`unexpected request`, { status: 400 });
  }

  /*
   * extract the network and validate that it is a well-known network.
   */
  const name    = KnownNetwork.canonicalizeAlias(pathSegments[0]);
  const network = KnownNetwork.lookup({ name });
  if (Fallible.isFailure(network)) { // 404: Not Found
    return new Response(`unrecognized network`, { status: 404 });
  }

  /*
   * extract the application key and validate that it is well-formed.
   *
   * application keys are at least 20 characters long or more and may contain
   * letters, numbers, dashes, and underscores.
   *
   * so as not to leak information about which keys are valid, invalid
   * keys receive a 401: Not Authorized response, the same as if an
   * application key was used without proper authentication credentials.
   */
  let app = pathSegments[1];
  if(allowedAppKey && allowedAppKey.length > 0) {
    if (!app || app.length < 20) {
      return new Response(`key not authorized`, { status: 401 });
    }
    if (app !== allowedAppKey) {
      // 401: unauthorized
      return new Response(`key not authorized`, { status: 401 });
    }
  }

  /*
   * Check if there are only a specific set of allowed hosts
   * that are valid for this proxy and reject all others.
   */
  const requestOrigin = request.headers.get('origin') || '';
  if (allowedHosts.length > 0) {
    if (requestOrigin === '') {
      return new Response(`key not authorized`, { status: 401 });
    }
    const requestOriginUrl = (new URL(requestOrigin));
    const requestDomain = requestOriginUrl.hostname.replace('www.','');
    if (!allowedHosts.includes(requestDomain)) {
      return new Response(`host not authorized`, { status: 401 });
    }
  }

  /*
   * if there was no application key, resort to the 'default' app.
   */
  app ??= 'default';

  /*
   * given a valid network, look up its available endpoints.
   */
  const canonicalName      = KnownNetwork.canonicalNameOf(network);
  const availableEndpoints = endpoints[canonicalName];

  /*
   * Parse, validate, and normalize JSON RPC data from the request body.
   */
  let jsonRpcRequestBody: jsonRpc.Request | jsonRpc.Request[]; try {
    // TODO(jordan): maybe don't swallow the internal error?
    jsonRpcRequestBody = await jsonRpc.expectRequest(request);
  } catch { // 400: Bad Request
    return new Response(`invalid JSON-RPC payload`, { status: 400 });
  }

  // Normalize a single raw RPC into a single-item array of RPCs.
  const rawRpcs = (
    jsonRpcRequestBody instanceof Array
      ?   jsonRpcRequestBody
      : [ jsonRpcRequestBody ]
  );

  // Filter RPCs to reduce the number of requests forwarded.
  const rpcs:      jsonRpc.Request[]  = [];
  const responses: jsonRpc.Response[] = [];
  for (const rpc of rawRpcs) {
    /*
     * detect and intercept eth_chainId requests.
     */
    if (rpc.method === `eth_chainId`) {
      responses.push({
        id: rpc.id,
        jsonrpc: rpc.jsonrpc,
        result: `0x${network.chainId.toString(16)}`,
      });
    } else { // otherwise, forward the RPC call as-is.
      rpcs.push(rpc);
    }
  }

  /*
   * Select a node provider.
   *
   * Provider selection keys are named according to the format:
   *    provider:${application}:${canonicalName}:${selector}
   *
   * This enables developers to list keys by prefix to enumerate active
   * provider selectors for a given application. Applications may extend
   * the hierarchy by using `:`s in their selectors.
   *
   * For the 'default' application, the key hierarchy is simply:
   *  provider:
   *    default:
   *      active-fallback: JSON filter the selected endpoint must match
   */
  const prefix = `provider:${app}:${canonicalName}`;
  const activeFallback = await kv.get(`${prefix}:active-fallback`);
  // default to the top-ranked endpoint for the target chain network.
  let nodeEndpoint = availableEndpoints[0];
  // if there is a valid active-fallback, treat it as a JSON filter.
  if (activeFallback !== null) {
    const filter   = JSON.parse(activeFallback);
    const selected = findMatchingEndpoint(filter, availableEndpoints);
    // if an endpoint matches the active-fallback filter, use it
    if (selected != null) {
      nodeEndpoint = selected;
    } else { // otherwise, deactivate the invalid active-fallback
      context.defer(new Promise(() => {
        console.log(`performing deferred delete: ${prefix}:active-fallback`);
        return kv.delete(`${prefix}:active-fallback`);
      }));
    }
  }

  /*
   * Perform the JSON-RPC call against the selected endpoint.
   *
   * If there is only one call to make, unwrap it. This improves the
   * analytics data and can reduce latency for some node providers.
   *
   * NOTE that this may surprise a user of the node-provider-proxy who
   * expects that if they send a one-item batch, then the node provider
   * will receive a batch request.
   *
   * In this case we willfully disregard the user's (possible) intent to
   * simplify billing and improve the detail of node provider analytics.
   * However, even if internally the batch was unwrapped, we always
   * still return a batch response to a batch request.
   */
  async function performRpcs(
    rpcs: jsonRpc.Request[],
    nodeEndpoint: ProviderEndpoint
  )
    : Promise<jsonRpc.Response[]>
  {
    // fail fast if there are no rpcs
    if (rpcs.length === 0) {
      return [];
    }
    // if there's one rpc, don't batch it
    if (rpcs.length === 1) {
      const response = Fallible.must(await jsonRpc.post({
        endpoint: nodeEndpoint.uri,
        call: rpcs[0],
      }));
      return [ response ];
    }
    // otherwise, post an RPC batch
    return Fallible.must(await jsonRpc.postBatch({
      endpoint: nodeEndpoint.uri,
      calls: rpcs,
    }));
  }
  async function performRpcs_reportLatency(
    rpcs: jsonRpc.Request[],
    nodeEndpoint: ProviderEndpoint,
  ) {
    const timeSince = (start: number) => performance.now() - start;
    const upstream_markStart = performance.now();
    try {
      const responses = await performRpcs(rpcs, nodeEndpoint);
      const latency = timeSince(upstream_markStart);
      console.log(`${nodeEndpoint.provider} responded in ${latency}ms`);
      return responses;
    } catch (error) {
      const latency = timeSince(upstream_markStart);
      console.log(`${nodeEndpoint.provider} failed in ${latency}ms`);
      throw error;
    }
  }

  try {
    responses.push(...await performRpcs_reportLatency(rpcs, nodeEndpoint));
  } catch (error) { // 503: Service Unavailable (please retry)
    console.error(`upstream error: ${(error as Error).message}`);
    /*
     * It's possible a request can fail upstream, even though we validated
     * our JSON-RPC payloads. In that case:
     *
     * 1. set the next-ranked provider endpoint as the active fallback for
     *    the application. If there is no next-ranked provider, no-op. Set
     *    the fallback to expire after a certain time-to-live.
     *
     * 2. obscure the upstream error to prevent clients from depending on
     *    any particular upstream's formatting of errors.
     *
     * When the provider proxy fails to serve a request, clients are
     * expected to retry until it succeeds. By default, failure responses
     * will set a Retry-After header asking the client to wait some time.
     *
     * If a fallback is set, the Retry-After header will be set to 0s.
     *
     */
    // TODO: per-app-key configurable settings.
    const expirationTtl = settings.defaultFallbackExpirationTtlSeconds;
    const fallback = findNewProvider(nodeEndpoint, availableEndpoints);
    if (fallback == null) {
      // respond 503 with Retry-After to encourage clients to retry.
      // TODO: per-app-key configurable settings.
      const retryAfter = settings.defaultRetryAfterUpstreamErrorSeconds;
      return retryResponse({ retryAfter });
    }
    logFallback(nodeEndpoint, fallback, { expirationTtl });
    activateFallback(fallback, { kv, prefix, expirationTtl, defer: context.defer });
    // retry with fallback on behalf of client
    if (settings.retryWithActiveFallback) {
      try {
        responses.push(...await performRpcs_reportLatency(rpcs, fallback));
      } catch (error) {
        console.error(`fallback-retry-all error: ${(error as Error).message}`);
        // respond 503 with Retry-After to encourage clients to retry.
        // TODO: per-app-key configurable settings.
        const retryAfter = settings.defaultRetryAfterUpstreamErrorSeconds;
        return retryResponse({ retryAfter });
      }
    } else {
      // respond 503 with Retry-After to encourage clients to retry.
      // TODO: per-app-key configurable settings.
      const retryAfter = settings.defaultRetryAfterUpstreamErrorSeconds;
      return retryResponse({ retryAfter });
    }
  }

  /*
   * Analyze RPC errors where the upstream responded with an error code
   */
  const erroredRpcs: jsonRpc.Request[]       = [];
  const maskedResponses: jsonRpc.Response[]  = [];
  const erroredResponses: jsonRpc.Response[] = [];
  for (const response of responses) {
    if (!('error' in response)) {
      maskedResponses.push(response);
      continue;
    }
    if (!settings.retryIndividualFailedRpcs) {
      erroredResponses.push(response);
    }
    const rpc = rpcs.find(({ id }) => id === response.id)!;
    erroredRpcs.push(rpc);
    logRpcError({
      app,
      rpc,
      error: response.error,
      network: canonicalName,
      endpoint: nodeEndpoint,
    });
  }

  /*
   * If some RPCs errored, try to fallback and retry the errored RPCs.
   */
  const retried: jsonRpc.Response[] = [];
  if (settings.retryIndividualFailedRpcs && erroredRpcs.length > 0) {
    // TODO: per-app-key configurable settings.
    // const expirationTtl = settings.defaultFallbackExpirationTtlSeconds;
    const fallback = findNewProvider(nodeEndpoint, availableEndpoints);
    if (fallback != null) {
      logFallback(nodeEndpoint, fallback, { expirationTtl: 0 });
      // activateFallback(fallback, { kv, prefix, expirationTtl, defer: context.defer });
      try {
        retried.push(...await performRpcs_reportLatency(erroredRpcs, fallback));
      } catch (error) {
        console.error(`fallback-retry-only-failed error: ${(error as Error).message}`);
      }
      for (const rpc of erroredRpcs) {
        const response = (
             retried.  find(({ id }) => id === rpc.id)
          ?? responses.find(({ id }) => id === rpc.id)
        )!;
        if (!('error' in response)) {
          maskedResponses.push(response);
          continue;
        }
        erroredResponses.push(response);
        logRpcError({
          app,
          rpc,
          error: response.error,
          network: canonicalName,
          endpoint: fallback,
        });
      }
    }
  }

  /*
   * Mask upstream errors so clients are not able to depend on the error
   * formatting of any specific upstream.
   */
  maskedResponses.push(...erroredResponses.map(response => {
    return {
      ...response,
      error: (
        // masking upstream errors can be disabled for debugging
        context.settings.maskUpstreamErrors
          ? { code: -32000, message: 'upstream error' }
          : response.error!
      ),
    };
  }));

  /*
   * Respect the format of the inbound request: return a batch if the
   * inbound request was a batch request.
   */
  return new Response(
    jsonRpcRequestBody instanceof Array
      ? JSON.stringify(maskedResponses)
      : JSON.stringify(maskedResponses[0])
  );
}

function findMatchingEndpoint(
  filter:       object,
  endpointList: ProviderEndpoint[],
) {
  return endpointList.find(endpoint => {
    return Object.entries(filter)
      .every(([ key, value ]) => (true
        && key in endpoint
        && (endpoint[key as (keyof typeof endpoint)] === value)
      ));
  });
}

function findNewProvider(
  failedEndpoint:     ProviderEndpoint,
  available: ProviderEndpoint[],
) {
  const failedRank = available.indexOf(failedEndpoint);
  for (let rank = failedRank + 1; rank < available.length; rank++) {
    const nextEndpoint = available[rank];
    if (nextEndpoint.provider !== failedEndpoint.provider) {
      return nextEndpoint;
    }
  }
}

function logFallback(
  failedEndpoint: ProviderEndpoint,
  fallback: ProviderEndpoint,
  { expirationTtl }: { expirationTtl: number }
) {
  console.log(
    `!! ${failedEndpoint.provider} failed,`
    + ` falling back on ${fallback.provider}`
    + ` for ${expirationTtl}s start [${(new Date()).toISOString()}]`
  );
}

function activateFallback(
  fallback: ProviderEndpoint,
  { kv, prefix, expirationTtl, ...context }: {
    prefix:        string,
    expirationTtl: number,
    // runtime bindings
    kv:    HandlerContext['kv'],
    defer: HandlerContext['defer'],
  }
) {
  // do a deferred write to the active-fallback key
  context.defer(new Promise(() => {
    console.log(`performing deferred write: ${prefix}:active-fallback`);
    return kv.put(
      `${prefix}:active-fallback`,
      JSON.stringify(fallback),
      { expirationTtl },
    );
  }));
}

function retryResponse({
  retryAfter,
  message: bodyText = 'upstream error',
}: {
  message?: string,
  retryAfter: number,
}) {
  return new Response(bodyText, {
    status: 503,
    headers: { 'Retry-After': retryAfter.toString() },
  });
}

function logRpcError({ app, rpc, error, network, endpoint }: {
  app:      string,
  rpc:      jsonRpc.Request,
  error:    jsonRpc.Error,
  network:  string,
  endpoint: ProviderEndpoint,
}) {
    // FIXME(jordan): use a debug logger that can toggle on/off
    console.warn(`json-rpc error:`, {
      app,
      network,
      provider: endpoint.provider,
      rpc:      JSON.stringify(rpc),
      error:    JSON.stringify(error),
    });
}