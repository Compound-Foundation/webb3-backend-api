import * as Eth from '../../eth-constants.js';

import * as proposalModel from '../governance/proposal.js';

import { Profile } from './profile.js';

type CrowdProposal = {
  proposalAddress: Eth.Address,
  title: string,
  description: string,
  author: { address: Eth.Address },
  actions: proposalModel.Action[],
  createBlock: Eth.BlockNumber,
  proposeBlock?: Eth.BlockNumber,
  terminateBlock?: Eth.BlockNumber,
  createTime?: number,
  proposeTime?: number,
  terminateTime?: number,
  state: 'gathering_votes' | 'proposed' | 'terminated',
};

type FormattedCrowdProposal = {
  proposal_address: Eth.Address,
  title: string,
  description: string,
  author: Profile,
  actions: proposalModel.FormattedAction[],
  create_time: null | number,
  propose_time: null | number,
  terminate_time: null | number,
  state: string,
};

function formatCrowdProposal(crowdProposalComputation: CrowdProposal, authorProfile: Profile ): FormattedCrowdProposal {
  return {
    proposal_address: crowdProposalComputation.author.address,
    title: crowdProposalComputation.title,
    description: crowdProposalComputation.description,
    author: authorProfile,
    actions: crowdProposalComputation.actions.map(action => ({
      ...action,
      value: action.value.toString(), // format to string from BigFixnum
    })),
    create_time: crowdProposalComputation.createTime ?? null,
    propose_time: crowdProposalComputation.proposeTime ?? null,
    terminate_time: crowdProposalComputation.terminateTime ?? null,
    state: crowdProposalComputation.state,
  }
}

const CrowdProposalCreated = (
  `event CrowdProposalCreated(
    address indexed proposal,
    address indexed author,
    address[] targets,
    uint[] values_,
    string[] signatures,
    bytes[] calldatas,
    string description
  )`
) as const;

const CrowdProposalProposed = (
  `event CrowdProposalProposed(
    address indexed proposal,
    address indexed author,
    uint proposalId
  )`
) as const;

const CrowdProposalTerminated = (
  `event CrowdProposalTerminated(
    address indexed proposal,
    address indexed author
  )`
) as const;

const events = {
  CrowdProposalCreated,
  CrowdProposalProposed,
  CrowdProposalTerminated,
};

export type {
  CrowdProposal,
  FormattedCrowdProposal,
};

export {
  events,
  CrowdProposalCreated,
  CrowdProposalProposed,
  CrowdProposalTerminated,
  formatCrowdProposal,
};
