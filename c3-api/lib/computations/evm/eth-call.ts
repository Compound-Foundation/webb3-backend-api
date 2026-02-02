import { BytesLike } from '@ethersproject/bytes';

import * as Eth     from '../../eth-constants.js';
import * as jsonRpc from '../../json-rpc.js';
import * as Compute from '../../symbolic/computation.js';
import { Contract } from '../../well-known/contracts/utils.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import { EvmRpc } from './rpc.js';

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
  returns: BytesLike,
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
        if (error) {
          console.error({ error });
          throw new Error(`ethCall: call error: ${JSON.stringify(error)}`);
        }
        if (!isBytesLike(result) || result === '0x') {
          console.error({ error: { message: 'malformed result' }, result });
          throw new Error(`ethCall: result is not byteslike`);
        }
        return result;
      },
    ]);
  },
});

function isBytesLike(data: any): data is BytesLike {
  return typeof data === 'string' || (data instanceof Array);
}

export { EthCall, ethCall };
