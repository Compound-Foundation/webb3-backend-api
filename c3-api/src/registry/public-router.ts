import { methodNotAllowed } from '../http/errors.js';

import {
  RegistryContext,
  getActive,
  getMarket,
  getMarkets,
  getNetworks,
  getVersion,
} from './handlers.js';

/*
 * The exact public registry routes. Paths are matched in full rather than by
 * prefix, so an unknown path under /registry/v1 is a 404 and never falls
 * through to a handler that happens to share a prefix.
 */
const ROUTES = [
  { pattern: /^\/registry\/v1\/active$/,                                     handler: 'active' },
  { pattern: /^\/registry\/v1\/networks$/,                                   handler: 'networks' },
  { pattern: /^\/registry\/v1\/networks\/([^/]+)\/markets$/,                 handler: 'markets' },
  { pattern: /^\/registry\/v1\/networks\/([^/]+)\/markets\/([^/]+)$/,        handler: 'market' },
  { pattern: /^\/registry\/v1\/versions\/([^/]+)$/,                          handler: 'version' },
] as const;

async function routePublic(
  request: Request,
  context: RegistryContext,
  pathname: string,
  { maxAge }: { maxAge: number },
): Promise<Response | null> {
  const route = ROUTES.map(({ pattern, handler }) => ({ handler, match: pattern.exec(pathname) }))
    .find(({ match }) => match !== null);
  if (route === undefined) {
    return null;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw methodNotAllowed(request.method, pathname, [ 'GET', 'HEAD', 'OPTIONS' ]);
  }

  const [ , first, second ] = route.match!;
  switch (route.handler) {
    case 'active':   return getActive(request, context, maxAge);
    case 'networks': return getNetworks(request, context, maxAge);
    case 'markets':  return getMarkets(request, context, first!, maxAge);
    case 'market':   return getMarket(request, context, first!, second!, maxAge);
    case 'version':  return getVersion(request, context, first!, maxAge);
  }
}

export { routePublic };
