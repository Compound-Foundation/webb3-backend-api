import * as Eth      from '../../eth-constants.js';
import * as Index    from '../../symbolic/index.js';
import * as Compute  from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import * as governanceModel from '../../model/governance.js';

import type * as evm from '../evm.js';


type CrossChainProposals = Compute.Recurrence.Spec<{
  name: 'crossChainProposals',
  basis: {
    network: Exclude<KnownNetwork.Name, `ethereum-${'mainnet'|'goerli'}`>,
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
  returns: governanceModel.CrossChainProposal[],
}>;

const {
  implement,
  fromPrevious,
  pipe1,
  join,
  split,
  value,
} = Compute.Recurrence.Functor<CrossChainProposals>({});

const crossChainProposals = implement({
  version: 1,
  index: Index.BlockNumberRange<CrossChainProposals['expects']>({
    start: ({ contract: { creation } }) => creation.block.number,
    stride: ({ network }) => {
      if (network === 'base-mainnet') {
        return 10_000;
      } else {
        return 50_000;
      }
    },
  }),
  origin: ({}) => [],
  compute({ apiHost, nodeHost, nodeKey, blockNumber, network, contract }) {
    return fromPrevious(previous => pipe1([
      {
        ethGetLogs: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          addresses:  [ contract.address ],
          blockRange: [ previous.cursor.blockNumber, blockNumber ],
          filter: [
            [
              coders.topics.ProposalCreated,
              coders.topics.ProposalExecuted,
            ]
          ],
        }
      },
      async rawLogs => {
        // clone proposals to avoid mutating data
        const proposals = previous.value.map(proposal => {
          return { ...proposal, states: proposal.states.slice() };
        });
        for (const log of rawLogs) {
          if (log.removed) continue;
          const decoded = coders.decode(log);
          switch (decoded.name) {
            case 'ProposalCreated': {
              proposals.push({
                id: decoded.body.id,
                targets: decoded.body.targets,
                values_: decoded.body.values_,
                signatures: decoded.body.signatures,
                calldatas: decoded.body.calldatas,
                states: [{
                  state: 'queued',
                  startBlock: parseInt(log.blockNumber, 16),
                  transactionHash: log.transactionHash,
                }],
                network,
              });
              break;
            }
            case 'ProposalExecuted': {
              const targetId = decoded.body.id;
              const proposal = proposals.find(({ id }) => id.eq(targetId));
              if (!proposal) continue;
              proposal.states.push({
                state: 'executed',
                startBlock: parseInt(log.blockNumber, 16),
                transactionHash: log.transactionHash,
              });
              break;
            }
            default: {
              throw new Error(`unrecognized event: ${(decoded as any).name}`);
            }
          }
        }
        return split(
          proposals.map(proposal => join([
            proposal.states.map(state => (
              state.startTime
              ? value(state)
              : pipe1([
                { ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: state.startBlock, network } },
                (block) => ({ startTime: block.timestamp, ...state }),
              ])
            )),
            (states) => ({ ...proposal, states }),
        ])));
      },
    ]));
  },
});

const coders = Eth.Event.Coder.fromSignatures([
  governanceModel.crossChainProposal.events.ProposalCreated,
  governanceModel.crossChainProposal.events.ProposalExecuted,
]);

export {
  CrossChainProposals,
  crossChainProposals,
};
