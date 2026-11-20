import { BytesLike } from '@ethersproject/bytes';

import * as Eth     from '../../eth-constants.js';
import * as jsonRpc from '../../json-rpc.js';
import * as Compute from '../../symbolic/computation.js';
import { Contract } from '../../well-known/contracts/utils.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import { EvmRpc, notServed } from './rpc.js';

/*
 * A call the EVM reverted: the contract's answer at that block, which every
 * provider gives alike, as opposed to a node that could not serve the call.
 * ethCall answers it rather than failing, and the function that made the
 * call decides what it means (abi-function.ts): most fail on it, and a price
 * read reports it.
 */
type Reverted = { reverted: { code: number, message: string } };

type EthCall = Compute.Spec<{
  name: 'ethCall',
  depends: [ EvmRpc ],
  expects: {
    data: string,
    apiHost: string,
    nodeHost: string,
    nodeKey: string,
    network: KnownNetwork.Name,
    contract: Contract,
    blockNumber: Eth.BlockNumber,
  },
  returns: BytesLike | Reverted,
}>;

const { implement, pipe1 } = Compute.Functor<EthCall>({});

const ethCall = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  async compute({ blockNumber: block, apiHost, nodeHost, nodeKey, network, contract, data }) {
    const call: jsonRpc.Call = {
      method: 'eth_call',
      params: [
        { to: contract.address, data },
        `0x${block.toString(16)}`,
      ],
    };
    return pipe1([
      { evmRpc: { frame: { apiHost, nodeHost, nodeKey, network }, items: [ call ] } },
      ([{ result, error }]) => {
        if (error && jsonRpc.isExecutionReverted(error)) {
          return { reverted: { code: error.code, message: error.message } };
        }
        if (error) {
          throw notServed('ethCall', error);
        }
        if (!isBytesLike(result) || result === '0x') {
          throw new Error(`ethCall: result is not byteslike`, { cause: { result } });
        }
        return result;
      },
    ]);
  },
});

function isBytesLike(data: any): data is BytesLike {
  return typeof data === 'string' || (data instanceof Array);
}

function isReverted(result: BytesLike | Reverted): result is Reverted {
  return typeof(result) === 'object' && result !== null && 'reverted' in result;
}

export { EthCall, ethCall, Reverted, isReverted };
