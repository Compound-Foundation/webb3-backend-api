import type * as jsonRpc from 'json-rpc';
import type * as fetch   from './fetch.js';

/*
 * Register a mocked RPC expectation on a fetch mock for a URL.
 */
function expectPost(
  fetch: fetch.MockFetch,
  url:   string,
  [ request, response ]: [ jsonRpc.Request, jsonRpc.Response ],
) {
  fetch.expect(url, {
      method: 'POST',
      body: {
        type: 'json',
        value: [ request ], // rpc will be unit-batched
      },
    })
    .returns(JSON.stringify([ response ]));
}

/*
 * Construct mock RPC request and response for eth_getBlockByNumber.
 */
function ethGetBlock(
  mockBlock: { number: number, timestamp: number },
  options:   Partial<ethGetBlock.Options> = {},
)
  : [ request: jsonRpc.Request, response: jsonRpc.Response ]
{
  const { error, result, reference, showTransactionDetails } = {
    ...ethGetBlock.defaults(mockBlock),
    ...options,
  };
  const call: jsonRpc.Call = {
    method: 'eth_getBlockByNumber',
    params: [
      reference === 'latest' ? reference : `0x${reference.toString(16)}`,
      showTransactionDetails,
    ],
  };
  const request: jsonRpc.Request = { jsonrpc: '2.0', id: 0, ...call };
  // if we're mocking an RPC error, then return an error response
  if (!!error) {
    const response: jsonRpc.Response = { jsonrpc: '2.0', id: 0, error };
    return [ request, response ];
  }
  // otherwise, return a result response
  const response: jsonRpc.Response = { jsonrpc: '2.0', id: 0, result };
  return [ request, response ];
}

namespace ethGetBlock {
  export type Options = {
    error?:                 jsonRpc.Error,
    result:                 any,
    reference:              number | 'latest',
    showTransactionDetails: boolean,
  };
  export function defaults(block: { number: number, timestamp: number }): ethGetBlock.Options {
    return {
      reference:              block.number,
      showTransactionDetails: false,
      result: {
        number:    `0x${block.number.toString(16)}`,
        timestamp: `0x${block.timestamp.toString(16)}`,
        transactions: [],
      },
    };
  }
}

export {
  expectPost,
  ethGetBlock,
};
