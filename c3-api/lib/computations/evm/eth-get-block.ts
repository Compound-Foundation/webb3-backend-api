import * as Eth     from '../../eth-constants.js';
import * as jsonRpc from '../../json-rpc.js';

import * as Key     from '../../symbolic/key.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import { EvmRpc } from './rpc.js';

type EthGetBlock = Compute.Spec<{
  name: 'ethGetBlock',
  depends: [ EvmRpc ],
  expects: {
    apiHost: string,
    nodeHost: string,
    nodeKey: string,
    network: KnownNetwork.Name,
    blockReference: Eth.BlockReference,
    showTransactionDetails?: boolean,
  },
  returns: {
    number: number,
    timestamp: number,
    date: string,
    transactions: (
      | Eth.Transaction[]
      | Eth.TransactionHash[]
    ),
  },
}>;

const { implement, pipe1 } = Compute.Functor<EthGetBlock>({});

// HACK(jordan): see also ../evm.ts and applyIndexBias(..)
const composeIndex = (index: Index.On<EthGetBlock['expects']>) => (
  Index.Make<EthGetBlock['expects']>({
    ...index,
    includes({
      blockReference,
      showTransactionDetails = false, // UGLY
      ...context
    }) {
      const ctx = { blockReference, showTransactionDetails, ...context };
      return index.includes(ctx)
          && blockReference !== 'latest';
    },
  })
);

const ethGetBlock = implement({
  version: 1,
  index: composeIndex(Index.Nothing),
  // TODO(jordan): better support for optional fields...?
  key(name, { showTransactionDetails = false, ...context }) {
    return Key.toKey(name, { showTransactionDetails, ...context });
  },
  async compute({ apiHost, nodeHost, nodeKey, blockReference, network, showTransactionDetails = false }, debug) {
    const method  = 'eth_getBlockByNumber';
    const encoded = Eth.BlockReference.encode(blockReference);
    const call: jsonRpc.Call = { method, params: [ encoded, showTransactionDetails ] };
    //
    return pipe1([
      { evmRpc: { frame: { apiHost, nodeHost, nodeKey, network }, items: [ call ] } },
      ([{ result, error }]) => {
        if (error) {
          const message = `${method}: ${jsonRpc.formatError(error)}`;
          debug.error(message, { error, result });
          throw new Error(message);
        }
        if (!validateResult(result, { showTransactionDetails })) {
          const message = `${method}: malformed result`;
          debug.error(message, { showTransactionDetails, result });
          throw new Error(message);
        }
        const timestamp = Eth.Timestamp.decode(result.timestamp);
        return {
          timestamp,
          date: Eth.Timestamp.toDateString(timestamp),
          number: parseInt(result.number, 16),
          transactions: result.transactions,
        };
      },
    ]);
  },
});

interface eth_getBlockResponse {
  number:       Eth.Hex.String;
  timestamp:    Eth.Hex.String;
  transactions: (
    | Eth.Transaction[]
    | Eth.TransactionHash[]
  );
}
function validateResult(
  result: unknown,
  { showTransactionDetails }: { showTransactionDetails: boolean },
): result is eth_getBlockResponse {
  return true
    && typeof result === 'object'
    && result !== null
    && [ 'number', 'timestamp' ].every(field => (true
      && (field in result)
      && (typeof((result as any)[field]) === 'string')
      && (Eth.Hex.is((result as any)[field]))
    ))
    && 'transactions' in result
    && (result as any).transactions.every(
      showTransactionDetails
        ? Eth.parseTransaction  // if details, full objects
        : Eth.isTransactionHash // otherwise, just hashes
    )
  ;
}

export {
  EthGetBlock,
  ethGetBlock,
  composeIndex,
};
