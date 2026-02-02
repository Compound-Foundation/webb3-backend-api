import * as Eth      from '../../eth-constants.js';
import * as jsonRpc  from '../../json-rpc.js';
import { keccak256 } from '../../hash.js';

import * as Key     from '../../symbolic/key.js';
import * as Debug   from '../../debug-log.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import { EvmRpc } from './rpc.js';

type EthGetLogs = Compute.Spec<{
  name: 'ethGetLogs',
  depends: [ EvmRpc ],
  expects: {
    filter: Eth.Event.Filter,
    apiHost: string,
    nodeHost: string,
    nodeKey: string,
    network: KnownNetwork.Name,
    addresses: Eth.Address[],
    blockRange: [ Eth.BlockNumber, Eth.BlockNumber ],
  },
  returns: Eth.Event.Log[],
}>;

/*
 * implementations -- cached and uncached
 */
const { implement, pipe1 } = Compute.Functor<EthGetLogs>({});

/*
 * NOTE(jordan): caching of ethGetLogs RPCs is not recommended in
 * production as we currently don't have a way to index ethGetLogs
 * effectively [1]. It produces huge numbers of cold cache entries, which
 * wastes storage and creates latency due to the cache writes.
 *
 * To index ethGetLogs effectively we probably need discretization [2].
 *
 * Overall, since log streams are not reused across most computations, at
 * least today, the benefit of not spamming the cache outweighs the cost
 * of retrieving the logs from a node endpoint as-needed.
 *
 */
const ethGetLogs = implement({
  version: 3,
  /*
   * eth_getLogs is keyed by hashing a formatted string of the filter
   * object, in order to keep keys within size limits while maintaining a
   * relatively-readable uniqueness.
   */
  async key(name: string, { filter, ...context }) {
    return Key.toKey(name, {
      /*
       * NOTE(jordan): Key.toKey(..) will sort and format the topics in
       * our filter for us, so that the hash is deterministic regardless
       * of the insertion order of the filter fields.
       */
      topics: `0x${keccak256(Key.toKey('', filter))}`,
      ...context,
    });
  },
  compute(
    {
      filter,
      addresses,
      apiHost,
      nodeHost,
      nodeKey,
      network,
      blockRange: [ start, end ],
    }: EthGetLogs['expects'],
    debug: Debug.Logger
  ): Compute.Returns<EthGetLogs> {
    const logsDebug = debug.scope(`eth_getLogs`);
    const debugPayload = {
      filter,
      network,
      addresses,
      blockRange: [ start, end ],
      blockDistance: end - start,
    };
    logsDebug.log(`eth_getLogs`, debugPayload);
    const call: jsonRpc.Call = {
      method: 'eth_getLogs',
      params: [{
        topics:    Eth.Event.encodeFilter(filter),
        address:   addresses,
        fromBlock: Eth.Hex.fromNumber(start),
        toBlock:   Eth.Hex.fromNumber(end),
      }],
    };
    return pipe1([
      { evmRpc: { frame: { apiHost, nodeHost, nodeKey,network }, items: [ call ] } },
      ([{ result, error }]) => {
        if (error) {
          const formatted = jsonRpc.formatError(error);
          logsDebug.error(`eth_getLogs`, { error }, debugPayload);
          throw new Error(
            `ethGetLogs(${debugPayload.addresses}`
            + ` on ${debugPayload.network}`
            + ` from ${debugPayload.blockRange.join(' to ')})`
            + `: call error: ${formatted}`
          );
        }
        return result as EthGetLogs['returns'];
      }
    ]);
  },
});

export { EthGetLogs, ethGetLogs };
