import * as Eth     from '../../eth-constants.js';
import * as jsonRpc from '../../json-rpc.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { EvmRpc } from './rpc.js';

type EthGetTransactionByHash = Compute.Spec<{
  name: 'ethGetTransactionByHash',
  depends: [ EvmRpc ],
  returns: Eth.Transaction,
  expects: {
    apiHost: string,
    nodeHost: string,
    nodeKey: string,
    network: KnownNetwork.Name,
    transactionHash: Eth.TransactionHash,
  },
}>;

const { implement, pipe1 } = Compute.Functor<EthGetTransactionByHash>({});

const ethGetTransactionByHash = implement({
  version: 1,
  async compute({ apiHost, nodeHost, nodeKey, network, transactionHash }, debug) {
    const call: jsonRpc.Call = {
      method: 'eth_getTransactionByHash',
      params: [ transactionHash ],
    };
    return pipe1([
      { evmRpc: { frame: { apiHost, nodeHost, nodeKey, network }, items: [ call ] } },
      ([{ result, error }]) => {
        if (error) {
          const message = `${call.method}: ${jsonRpc.formatError(error)}`;
          debug.error(message, { error, result });
          throw new Error(message);
        }
        // FIXME(jordan): this parser only checks 'to', 'from', 'hash'
        if (!Eth.parseTransaction(result)) {
          const message = `${call.method}: malformed result`;
          debug.error(message, { result });
          throw new Error(message);
        }
        return result;
      },
    ]);
  },
});

export { EthGetTransactionByHash, ethGetTransactionByHash };
