import * as KnownNetwork from '../lib/well-known/networks/network.js';

import { ApiError } from './http/errors.js';

/*
 * Testnets are not served. The registry imports mainnets alone
 * (registry/source/roots.ts), and the market, account and history routes
 * resolve every market through it, so a route asked about a testnet could
 * only answer with nothing, or with mainnet data in its place. It refuses the
 * request instead, in the error envelope, naming what in it named a testnet:
 * the network, or `testnets=include`.
 *
 * Which networks are testnets is the network definitions' to say
 * (lib/well-known/networks).
 */
function testnetNotServed(named: string): ApiError {
  return new ApiError('TESTNET_NOT_SERVED', `testnets are not served: ${named}`);
}

function refuseTestnet(network: KnownNetwork.Name): void {
  if (KnownNetwork.isNameOfTestnet(network)) {
    throw testnetNotServed(network);
  }
}

/*
 * Refuses `testnets=include`, which used to add every testnet to a route over
 * every network. Any other value leaves them out, as it always has.
 */
function refuseTestnetsParameter(query: URLSearchParams): void {
  if (query.get('testnets') === 'include') {
    throw testnetNotServed('testnets=include');
  }
}

export { refuseTestnet, refuseTestnetsParameter };
