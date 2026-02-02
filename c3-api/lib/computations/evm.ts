import type { EvmRpc      } from './evm/rpc.js';
import type { EthCall     } from './evm/eth-call.js';
import type { EthGetLogs  } from './evm/eth-get-logs.js';
import type { EthGetBlock } from './evm/eth-get-block.js';
import type { EthGetTransactionByHash } from './evm/eth-get-transaction-by-hash.js';

export type Evm = (
  | EvmRpc
  | EthCall
  | EthGetLogs
  | EthGetBlock
  | EthGetTransactionByHash
);

export { EvmRpc,      evmRpc      } from './evm/rpc.js';
export { EthCall,     ethCall     } from './evm/eth-call.js';
export { EthGetLogs,  ethGetLogs  } from './evm/eth-get-logs.js';
export { EthGetBlock, ethGetBlock } from './evm/eth-get-block.js';
export {
  EthGetTransactionByHash,
  ethGetTransactionByHash,
} from './evm/eth-get-transaction-by-hash.js';

/*
 * NOTE(jordan): applyIndexBias allows us to bias the indexing logic for
 * the entire class of evm computations, so that we can build cache seeds
 * and run tests without actually sending requests to node providers. By
 * using a shared type from the Flags library, we can control the bias via
 * an environment flag: FLAGS_ETH_COMPUTATION_INDEX_BIAS=...
 */
import * as Index          from '../symbolic/index.js';
import { composeIndex }    from './evm/eth-get-block.js';
import type * as Flags     from '../flags.js';
import type * as Evaluator from '../symbolic/evaluator.js';

export function applyIndexBias(
  bias:         Flags.EthComputationIndexBias,
  computations: Evaluator.Computations<Evm>,
): Evaluator.Computations<Evm> {
  // if the bias is not 'default', we bias indexing towards the bias index
  const index = bias === 'default' ? {} : { index: Index[bias] };
  return {
    // evmRpc ignores the index bias; it's always uncached
    evmRpc: computations.evmRpc,
    // ethGetBlock adopts the bias, except never caches the 'latest' block
    ethGetBlock: {
      ...computations.ethGetBlock,
      index: composeIndex(index.index ?? computations.ethGetBlock.index),
    },
    // ethCall, ethGetLogs, ethGetTransactionByHash all succumb to bias
    ethCall:     { ...computations.ethCall,     ...index },
    ethGetLogs:  { ...computations.ethGetLogs,  ...index },
    ethGetTransactionByHash: {
      ...computations.ethGetTransactionByHash,
      ...index,
    },
  };
}
