import * as Eth        from '../../eth-constants.js';
import * as governance from '../../model/governance.js';
import * as Index      from '../../symbolic/index.js';
import * as Compute    from '../../symbolic/computation.js';
import * as evm        from '../evm.js';
import * as Key        from '../../symbolic/key.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

// Takes in a created crowd proposal and updates the state of it.
type CrowdProposalUpdated = Compute.Recurrence.Spec<{
  name: 'crowdProposalUpdated',
  basis: {
    crowdProposal: governance.CrowdProposal,
    network: Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>,
    contract: Eth.Contract,
  },
  cursor: {
    blockNumber: Eth.BlockNumber,
  },
  depends: [ evm.EthGetLogs, evm.EthGetBlock ],
  expects: {
    apiHost: string,
    nodeHost: string,
    nodeKey: string
  },
  returns: governance.CrowdProposal,
}>;

const {
  implement,
  fromPrevious,
  join,
  pipe1,
  pull1,
  value,
} = Compute.Recurrence.Functor<CrowdProposalUpdated>({});

const crowdProposalUpdated = implement({
  version: 1,
  index: Index.BlockNumberRange<CrowdProposalUpdated['expects']>({
    start: ({ contract: { creation } }) => creation.block.number,
    stride: 500_000,
  }),
  origin: ({ crowdProposal }) => crowdProposal,
  key(name, { crowdProposal, ...context }) {
    return Key.toKey(name, {
      proposalAddress: crowdProposal.proposalAddress,
      author: crowdProposal.author.address,
      ...context,
    });
  },
  compute({ apiHost, nodeHost, nodeKey, blockNumber, network, crowdProposal }) {
    return fromPrevious(previous => pipe1([
      {
        ethGetLogs: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          addresses:  [ crowdProposal.proposalAddress ],
          blockRange: [ previous.cursor.blockNumber, blockNumber ],
          filter: [
            [
              coders.topics.CrowdProposalProposed,
              coders.topics.CrowdProposalTerminated,
            ]
          ],
        }
      },
      rawLogs => {
        // clone proposals to avoid mutating data
        const updatedProposal = {...previous.value};
        for (const log of rawLogs) {
          if (log.removed) continue;
          const decoded = coders.decode(log);
          switch (decoded.name) {
            case 'CrowdProposalProposed': {
              updatedProposal.state = 'proposed';
              updatedProposal.proposeBlock = parseInt(log.blockNumber, 16);
              break;
            }
            case 'CrowdProposalTerminated': {
              updatedProposal.state = 'terminated';
              updatedProposal.terminateBlock = parseInt(log.blockNumber, 16);
              break;
            }
            default: {
              throw new Error(`unrecognized event: ${(decoded as any).name}`);
            }
          }
        }
        return join([
          [ updatedProposal.proposeBlock, updatedProposal.terminateBlock ].map(block => {
            if (block === undefined) return value(null);
            return pull1({ ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: block, network } });
          }),
          ([proposeBlock, terminateBlock]) => ({
            ...updatedProposal,
            ...(!!proposeBlock ? {proposeTime: proposeBlock.timestamp} : {}),
            ...(!!terminateBlock ? {terminateTime: terminateBlock.timestamp} : {}),
          })
        ])
      },
    ]));
  },
});

const coders = Eth.Event.Coder.fromSignatures([
  governance.crowdProposal.events.CrowdProposalProposed,
  governance.crowdProposal.events.CrowdProposalTerminated,
]);

export {
  CrowdProposalUpdated,
  crowdProposalUpdated,
};
