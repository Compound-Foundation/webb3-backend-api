import t from 'tap';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../shim/node-self.js';

import * as hash from '../../lib/hash.js';

import type * as Eth     from '../../lib/eth-constants.js';
import type * as jsonRpc from '../../lib/json-rpc.js';

import { Interface, EventFragment } from '@ethersproject/abi';
import { id as ethersKeccak256    } from '@ethersproject/hash';

t.test(`hash.keccak256 is equivalent to ethersproject's for strings`, async t => {
  // we often hash batches of JSON-RPC calls for batch computations
  const callBatches: jsonRpc.Call[][] = [
    // fake simple RPC, used in other tests as well
    [{ method: 'mock_checkHealth', params: [] }],
    // real eth_getBlockByNumber
    [{ method: 'eth_getBlockByNumber', params: [ 'latest', false ] }],
    // real batch of eth_call 1
    [
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0x9ea99a5a' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0xaba7f15e' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0x189bb2f1' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0xaba7f15e' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0x9364e18a' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0xb9f0baf7' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0x9364e18a' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0xb9f0baf7' },
        '0xf6cbad'
      ]}
    ],
    // real batch of eth_call 2
    [
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0x8285ef40' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0xe7dad6bd' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0x41976e09000000000000000000000000dbd020caef83efd542f4de03e3cf0c28a4428bd5' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0x18160ddd' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0xe7dad6bd' },
        '0xf6cbad'
      ]},
      { method: 'eth_call', params: [
        { to: '0xc3d688b66703497daa19211eedff47f25384cdc3', data: '0x41976e09000000000000000000000000dbd020caef83efd542f4de03e3cf0c28a4428bd5' },
        '0xf6cbad'
      ]}
    ],
  ];
  // ... and we need hashes of event signatures to be equivalent in coders
  const eventSignatures: Eth.Event.Signature[] = [
    // fake but simple signature
    `event Example(uint, address, string)`,
    // real event signatures from GovernorBravo (readably formatted)
    `event ProposalCanceled(uint id)`,
    `event VoteCast(
      address indexed voter,
      uint    proposalId,
      uint8   support,
      uint    votes,
      string  reason
    )`,
    `event ProposalCreated(
      uint      id,
      address   proposer,
      address[] targets,
      uint[]    values,
      string[]  signatures,
      bytes[]   calldatas,
      uint      startBlock,
      uint      endBlock,
      string    description
    )`,
  ];
  const eventSignaturesInterface = new Interface(eventSignatures);
  const formattedEventSignatures: string[] = (
    Object.values(eventSignaturesInterface.events)
      .map((e: EventFragment) => e.format())
  );
  // which gives us a few realistic test cases.
  const cases: string[] = [
    // parsed + sort-formatted event signatures
    ...formattedEventSignatures,
    // JSON stringified json-rpc call batches
    ...callBatches.map(callBatch => JSON.stringify(callBatch)),
  ];
  for (const testCase of cases) {
    t.strictSame(
      // the symbolic/hash version does not prefix with '0x' by default...
      `0x${await hash.keccak256(testCase)}`,
      // ... but the ethersproject keccak256 wrapper does
      ethersKeccak256(testCase),
      `('0x' + hash.keccak256(...)) === ethers.id(...) for ${testCase}`
    );
  }
});
