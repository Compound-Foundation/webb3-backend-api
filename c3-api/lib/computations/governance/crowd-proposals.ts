import * as Eth      from '../../eth-constants.js';
import * as Index    from '../../symbolic/index.js';
import * as Compute  from '../../symbolic/computation.js';
import { BigFixnum } from '../../bigfixnum.js';

import * as KnownNetwork  from '../../well-known/networks/network.js';
import * as ContractUtils from '../../well-known/contracts/utils.js';

import * as governanceModel from '../../model/governance.js';

import * as evm from '../evm.js';

import { CrowdProposalUpdated } from './crowd-proposal-updated.js';

type CrowdProposals = Compute.Recurrence.Spec<{
  name: 'crowdProposals',
  basis: {
    network: Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>,
    contract: Eth.Contract,
  },
  cursor: {
    blockNumber: Eth.BlockNumber,
  },
  depends: [ CrowdProposalUpdated, evm.EthGetLogs, evm.EthGetBlock ],
  expects: {
    apiHost: string,
    nodeHost: string,
    nodeKey: string
  },
  returns: governanceModel.CrowdProposal[],
}>;

const {
  implement,
  fromPrevious,
  pipe1,
  pull1,
  split,
} = Compute.Recurrence.Functor<CrowdProposals>({});

const crowdProposals = implement({
  version: 2,
  index: Index.BlockNumberRange<CrowdProposals['expects']>({
    start: ({ contract: { creation } }) => creation.block.number,
    stride: 500_000,
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
          filter:     [ coders.topics.CrowdProposalCreated ],
        }
      },
      async rawLogs => {
        // clone proposals to avoid mutating data
        const proposals = previous.value.map(proposal => ({ ...proposal }));
        for (const log of rawLogs) {
          if (log.removed) continue;
          const decoded = coders.decode(log);
          switch (decoded.name) {
            case 'CrowdProposalCreated': {
              const actions: governanceModel.proposal.Action[] = [];
              // convert our struct-of-arrays into an array-of-structs...
              for (let i = 0; i < decoded.body.targets.length; i++) {
                const { data, signature } = governanceModel.proposal.parseSignatureAndCalldata(
                  decoded.body.signatures[i],
                  decoded.body.calldatas[i],
                );
                const target: Eth.Address = decoded.body.targets[i];
                const value     = (
                  BigFixnum.from({
                    value: decoded.body.values_[i] || 0,
                    decimals: 18, // wei
                  })
                );
                const { title, subtitles } = ContractUtils.describeContractCallForHumans(
                  /* callee */
                  ContractUtils.contractForLocation(
                    { network, address: target },
                    Eth.wellKnownContractsByNetwork,
                  ),
                  signature,
                  data,
                  value,
                  Eth.wellKnownContractsByNetwork,
                );
                actions.push({
                  data,
                  value,
                  target,
                  signature,
                  title,
                  subtitles: subtitles ?? [],
                });
              }
              proposals.push({
                ...governanceModel.proposal.parseTitleDescriptionFromBody(decoded.body.description),
                actions,
                proposalAddress: decoded.body.proposal,
                // proposer can be extended (hydrated) with additional
                // fields separately, to turn it into a governance profile
                author: {
                  address: decoded.body.author,
                },
                // unwrap start and end blocks from BigNumber
                createBlock: parseInt(log.blockNumber, 16),
                state: 'gathering_votes',
              });
              break;
            }
            default: {
              throw new Error(`unrecognized event: ${(decoded as any).name}`);
            }
          }
        }
        return split(
          proposals.map(proposal => pipe1([
            { ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: proposal.createBlock, network } },
            (block) => pull1({
              crowdProposalUpdated: {
                apiHost,
                nodeHost,
                nodeKey, 
                network,
                contract,
                crowdProposal: {...proposal, createTime: block.timestamp},
                blockNumber
              }
            })
          ])));
      },
    ]));
  },
});

const coders = Eth.Event.Coder.fromSignatures([
  governanceModel.crowdProposal.events.CrowdProposalCreated,
  governanceModel.crowdProposal.events.CrowdProposalProposed,
  governanceModel.crowdProposal.events.CrowdProposalTerminated,
]);

export {
  CrowdProposals,
  crowdProposals,
};
