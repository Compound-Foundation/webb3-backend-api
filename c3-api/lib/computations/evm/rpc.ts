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

export { EvmRpc, evmRpc };
