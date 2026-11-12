import * as Eth     from '../../eth-constants.js';
import * as jsonRpc from '../../json-rpc.js';

import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { BlockRefV1 } from '../../model/comet-registry.js';

import { throttle } from '../../throttle.js';

import { validateResult } from './eth-get-block.js';
import type { EvmRpc } from './rpc.js';

/*
 * The number and the timestamp of a block of a known number, or null where
 * the node does not give them, which ethGetBlock fails on instead. A provider
 * answers null for a block it does not have yet, which the node provider
 * proxy passes on, where it asks another provider for a call that errs; and
 * a call can still err on every provider. A reader that can do without the
 * time it read at asks this, as the summary does for the time it read each
 * collateral's value at (market-latest-summary.ts).
 *
 * The read itself is never cached, whatever the index bias (evm.ts): a header
 * the node did not give is an answer of the moment, and is asked for again.
 * What a reader makes of the answer, null included, is the reader's to keep:
 * the summary keeps it with the market's summary of the minute, for that
 * minute (market-minutely-summary.ts).
 */
type EthGetBlockHeader = Compute.Spec<{
  name: 'ethGetBlockHeader',
  depends: [ EvmRpc ],
  expects: {
    apiHost:     string,
    nodeHost:    string,
    nodeKey:     string,
    network:     KnownNetwork.Name,
    blockNumber: Eth.BlockNumber,
  },
  returns: BlockRefV1 | null,
}>;

/*
 * When this isolate reports a header it was not given, by network: once a
 * minute, as a feed that reverts is reported (get-price.ts), since every
 * market read at the block asks for it.
 */
const due = throttle(60_000);

function reportMissing(network: KnownNetwork.Name, blockNumber: Eth.BlockNumber, why: string): void {
  if (!due(network)) {
    return;
  }
  console.warn(`block header not read: block ${blockNumber} on ${network}: ${why}`);
}

const { implement, pipe1 } = Compute.Functor<EthGetBlockHeader>({});
const ethGetBlockHeader = implement({
  version: 1,
  compute({ apiHost, nodeHost, nodeKey, network, blockNumber }) {
    const call: jsonRpc.Call = { method: 'eth_getBlockByNumber', params: [ Eth.BlockReference.encode(blockNumber), false ] };
    return pipe1([
      { evmRpc: { frame: { apiHost, nodeHost, nodeKey, network }, items: [ call ] } },
      ([{ result, error }]) => {
        if (error) {
          reportMissing(network, blockNumber, `call error: ${jsonRpc.formatError(error)}`);
          return null;
        }
        // a block other than the one asked for is no answer either
        if (!validateResult(result, { showTransactionDetails: false }) || parseInt(result.number, 16) !== blockNumber) {
          reportMissing(network, blockNumber, result === null ? 'no such block' : 'malformed result');
          return null;
        }
        return { number: blockNumber, timestamp: Eth.Timestamp.decode(result.timestamp) };
      },
    ]);
  },
});

export {
  EthGetBlockHeader,
  ethGetBlockHeader,
};
