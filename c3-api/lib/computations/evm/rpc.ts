import * as Eth      from '../../eth-constants.js';
import * as jsonRpc  from '../../json-rpc.js';
import { keccak256 } from '../../hash.js';

import * as Key     from '../../symbolic/key.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type * as Json from '../../json-types.js';

type EvmRpc = Compute.Batch.Spec<{
  name: 'evmRpc',
  frame: { apiHost:string , nodeHost:string, nodeKey:string, network: KnownNetwork.Name },
  item:  jsonRpc.Call,
  returns: jsonRpc.Response<Json.Value>[],
}>;

const evmRpc = Compute.Batch.Functor<EvmRpc>({}).implement({
  version: 1,
  async key(name, { items, ...context }) {
    return Key.toKey(name, {
      itemHash: keccak256(JSON.stringify(items)),
      ...context,
    });
  },
  async compute({ frame, items }) {
    return jsonRpc.postBatch({
      calls:    items,
      endpoint: Eth.nodeEndpoint(frame.nodeHost, frame.nodeKey, frame.network),
      headers: { origin: frame.apiHost },
    });
  },
});

/*
 * A call the node answered with an error that is not a revert: a rate limit,
 * a block it does not have, its own failure, or the proxy's mask over any of
 * them. The contract said nothing, so the node did not serve the call, as when
 * it fails the whole request.
 */
function notServed(method: string, error: jsonRpc.Error): jsonRpc.NotServed {
  return new jsonRpc.NotServed(`${method}: call error: ${jsonRpc.formatError(error)}`, { cause: error });
}

export { EvmRpc, evmRpc, notServed };
