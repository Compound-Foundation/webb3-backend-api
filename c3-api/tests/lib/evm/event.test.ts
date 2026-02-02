import t from 'tap';

import * as Event from '../../../lib/evm/event.js';
import * as comet from '../../../lib/model/comet.js';
import * as governance from '../../../lib/model/governance.js';

t.test(`parseSignature`, async t => {
  type Case = [ Event.Signature, Event.Descriptor ];
  const cases: Case[] = [
    [ `event NoArgs()`, {
      name: 'NoArgs',
      parameters: [],
    }],
    [ `event JustType(uint)`, {
      name: 'JustType',
      parameters: [
        {
          name: 0,
          type: 'uint',
          indexed: false,
        },
      ]
    }],
    [ `event Supply(address indexed from, string)`, {
      name: 'Supply',
      parameters: [
        {
          name: 'from',
          type: 'address',
          indexed: true,
        },
        {
          name: 1,
          type: 'string',
          indexed: false,
        },
      ]
    }],
    [ comet.events.WithdrawCollateral, {
      name: 'WithdrawCollateral',
      parameters: [
        {
          name: 'src',
          type: 'address',
          indexed: true,
        },
        {
          name: 'to',
          type: 'address',
          indexed: true,
        },
        {
          name: 'asset',
          type: 'address',
          indexed: true,
        },
        {
          name: 'amount',
          type: 'uint',
          indexed: false,
        },
      ]
    }],
    [ comet.events.PauseAction, {
      name: 'PauseAction',
      parameters: [
        {
          name: 'supplyPaused',
          type: 'bool',
          indexed: false,
        },
        {
          name: 'transferPaused',
          type: 'bool',
          indexed: false,
        },
        {
          name: 'withdrawPaused',
          type: 'bool',
          indexed: false,
        },
        {
          name: 'absorbPaused',
          type: 'bool',
          indexed: false,
        },
        {
          name: 'buyPaused',
          type: 'bool',
          indexed: false,
        },
      ]
    }],
    [ `event wonky(int indexed)`, {
      name: 'wonky',
      parameters: [
        {
          name: 'indexed',
          type: 'int',
          indexed: false,
        },
      ],
    }],
    [
      `event ProposalCreated(
        uint      id,
        address   proposer,
        address[] targets,
        uint[]    values_,
        string[]  signatures,
        bytes[]   calldatas,
        uint      startBlock,
        uint      endBlock,
        string    description
      )`,
      {
        name: 'ProposalCreated',
        parameters: [
          {
            name: 'id',
            type: 'uint',
            indexed: false,
          },
          {
            name: 'proposer',
            type: 'address',
            indexed: false,
          },
          {
            name: 'targets',
            type: 'address[]',
            indexed: false,
          },
          {
            name: 'values_',
            type: 'uint[]',
            indexed: false,
          },
          {
            name: 'signatures',
            type: 'string[]',
            indexed: false,
          },
          {
            name: 'calldatas',
            type: 'bytes[]',
            indexed: false,
          },
          {
            name: 'startBlock',
            type: 'uint',
            indexed: false,
          },
          {
            name: 'endBlock',
            type: 'uint',
            indexed: false,
          },
          {
            name: 'description',
            type: 'string',
            indexed: false,
          },
        ],
      }
    ],
  ];

  for (const [ signature, descriptor ] of cases) {
    t.strictSame(
      Event.parseSignature(signature),
      descriptor,
      `parses: ${signature}`
    );
  }

  type Failure = [ string, any ];
  const failures: Failure[] = [
    invalidSignature(``),
    invalidSignature(`event`),
    invalidSignature(`evnet`),
    invalidSignature(`evnet name()`),
    badParameters(`event name(badparam)`, [
      badType({ source: 'badparam', got: 'badparam' }),
    ]),
    badParameters(`event name(badtype goodname)`, [
      badType({ source: 'badtype goodname', got: 'badtype' }),
    ]),
    badParameters(`event name(this is too many tokens)`, [
      malformed({ source: 'this is too many tokens', tokens: 5 }),
    ]),
    badParameters(`event bad(bytes data, address notindexed name)`, [
      expectedIndexed({ source: 'address notindexed name', got: 'notindexed' }),
    ]),
    badParameters(`event multiple(typeless, bytes32 data, address bologna dst,)`, [
      badType({ source: 'typeless', got: 'typeless' }),
      expectedIndexed({ source: 'address bologna dst', got: 'bologna' }),
      malformed({ source: '', tokens: 0 }),
    ]),
  ];

  for (const [ badSignature, failure ] of failures) {
    t.strictSame(
      Event.parseSignature(badSignature as any),
      [ false, failure ],
      `fails: ${badSignature}`,
    );
  }

  function invalidSignature(signature: string): Failure {
    return [ signature, { signature, message: 'invalid signature' } ];
  }

  function badParameters(signature: string, failures: any[]): Failure {
    return [ signature, { message: 'some parameters failed to parse', failures } ];
  }

  function malformed({ source, tokens }: { source: string, tokens: number }) {
    return {
      source,
      message: `parameter string needs 1-3 tokens delimited by spaces, got ${tokens}`,
    };
  }

  function badType({ source, got }: { source: string, got: string }) {
    return {
      source,
      parameterType: got,
      message: 'parameter type (token at index 0) not recognized',
    };
  }

  function expectedIndexed({ source, got }: { source: string, got: string }) {
    return {
      source,
      message: `expected 'indexed', got ${got}`,
    };
  }
});

import { Interface } from '@ethersproject/abi';

t.test(`coders.topics`, async t => {
  await t.test(`comet`, async t => {
    const ethersInterface = new Interface(Object.values(comet.events));
    const coder = Event.Coder.fromSignatures(Object.values(comet.events));
    type CometEventName = keyof (typeof comet.events);
    for (const eventName of Object.keys(comet.events) as CometEventName[]) {
      const ethersTopic = Interface.getEventTopic(ethersInterface.getEvent(eventName));
      const computedTopic = coder.topics[eventName];
      t.equal(computedTopic, ethersTopic, `topic should match what ethers would compute`);
    }
  });
  await t.test(`governor`, async t => {
    const ethersInterface = new Interface([ governance.proposal.events.ProposalCreated ]);
    const coder = Event.Coder.fromSignatures([ governance.proposal.events.ProposalCreated ]);
    const ethersTopic = Interface.getEventTopic(ethersInterface.getEvent('ProposalCreated'));
    const computedTopic = coder.topics.ProposalCreated;
    t.equal(computedTopic, ethersTopic, `topic should match what ethers would compute`);
  });
});
