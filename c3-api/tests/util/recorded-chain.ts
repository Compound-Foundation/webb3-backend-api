import { readFileSync } from 'node:fs';

import type * as jsonRpc from '../../lib/json-rpc.js';

/*
 * A chain that answers from a recording of the calls enrichment makes
 * (tests/fixtures/registry/chain/), keyed as the recording says: the method
 * and what it was asked of, `eth_getCode:<address>`, `eth_call:<to>:<data>`,
 * or the method alone.
 *
 * `overrides` replaces the answer for a key, `failures` makes a key revert,
 * and `errors` makes it answer with any other JSON-RPC error, which is how a
 * revert, an unreadable contract or a node that does not serve the call is
 * exercised. A call the recording does not cover throws, as a node that
 * could not be asked does.
 */
type Replay = {
  overrides?: Record<string, string>,
  failures?:  string[],
  errors?:    Record<string, jsonRpc.Error>,
};

function keyOf(call: jsonRpc.Call): string {
  if (call.method === 'eth_getCode') {
    return `eth_getCode:${call.params[0]}`;
  }
  if (call.method === 'eth_call') {
    return `eth_call:${call.params[0].to}:${call.params[0].data}`;
  }
  return call.method;
}

/*
 * The chain's transport, as the importer takes one per network, and the size
 * of each batch it was sent.
 */
function recordedChain(path: string, { overrides = {}, failures = [], errors = {} }: Replay = {}) {
  const { responses }: { responses: Record<string, string> } = JSON.parse(readFileSync(path, 'utf8'));
  const batches: number[] = [];
  const transport = async (calls: jsonRpc.Call[]) => {
    batches.push(calls.length);
    return calls.map(call => {
      const key = keyOf(call);
      if (failures.includes(key)) {
        return { error: { code: 3, message: 'execution reverted' } };
      }
      if (errors[key] !== undefined) {
        return { error: errors[key] };
      }
      const result = overrides[key] ?? responses[key];
      if (result === undefined) {
        throw new Error(`the chain has no recorded answer for ${key}`);
      }
      return { result };
    });
  };
  return { transport, batches };
}

export type { Replay };
export { keyOf, recordedChain };
