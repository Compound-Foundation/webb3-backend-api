import * as Eth      from '../../eth-constants.js';
import * as jsonRpc  from '../../json-rpc.js';
import { keccak256 } from '../../hash.js';

import * as Key     from '../../symbolic/key.js';
import * as Debug   from '../../debug-log.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { Redex } from '../../symbolic/redex.js';

import { EvmRpc, notServed } from './rpc.js';

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
const { implement, pipe1, join } = Compute.Functor<EthGetLogs>({});

// the refused calls one range may split before it fails (compute)
const MAX_REFUSALS = 32;

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
    /*
     * A range the node answers with an error is read again in two halves,
     * and so is each half the node refuses in turn, down to a single block;
     * the logs of the halves, in block order, are the range's.
     *
     * Node providers refuse a range whose logs do not fit one answer: they
     * cap eth_getLogs at a number of logs, about 10,000, or at a size. The
     * node provider proxy masks every such refusal as "upstream error"
     * (node-provider-proxy/src/handler.ts), so the refusal cannot be told
     * from another error, and any error splits the range. The ranges of a
     * very active account's history, which span many days of blocks, are
     * refused this way.
     *
     * The splits of one range share MAX_REFUSALS: an error that every half
     * repeats, which is not about size, fails the range after at most
     * 1 + 2 × MAX_REFUSALS calls, rather than reading it block by block. A
     * request the proxy fails as a whole, because no provider answered it,
     * is not split: it fails before an answer reaches this point
     * (json-rpc.ts, postBatch).
     */
    let refusals = 0;
    const read = (from: Eth.BlockNumber, to: Eth.BlockNumber): Redex<EvmRpc, EthGetLogs['returns']> => {
      const call: jsonRpc.Call = {
        method: 'eth_getLogs',
        params: [{
          topics:    Eth.Event.encodeFilter(filter),
          address:   addresses,
          fromBlock: Eth.Hex.fromNumber(from),
          toBlock:   Eth.Hex.fromNumber(to),
        }],
      };
      return pipe1([
        { evmRpc: { frame: { apiHost, nodeHost, nodeKey, network }, items: [ call ] } },
        ([{ result, error }]) => {
          if (!error) {
            return result as EthGetLogs['returns'];
          }
          refusals++;
          const where = `ethGetLogs(${addresses} on ${network} from ${from} to ${to})`;
          if (from >= to || refusals > MAX_REFUSALS) {
            logsDebug.error(`eth_getLogs`, { error, refusals }, { ...debugPayload, blockRange: [ from, to ] });
            throw notServed(where, error);
          }
          const middle = from + Math.floor((to - from) / 2);
          logsDebug.warn(`${where} refused; reading it in two halves`, { error, refusals });
          return join([
            [ read(from, middle), read(middle + 1, to) ],
            ([ older, newer ]) => [ ...older, ...newer ],
          ]);
        },
      ]);
    };
    return read(start, end);
  },
});

export { EthGetLogs, ethGetLogs, MAX_REFUSALS };
