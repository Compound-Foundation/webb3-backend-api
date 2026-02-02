import { Profile }   from './profile';
import * as proposal from './proposal.js';

type ProposalVoteReceipt = {
  voter:       Profile,
  votes:       string,
  support:     boolean | null,
  proposal:    proposal.FormattedProposal | null,
  proposal_id: number,
};

export type {
  ProposalVoteReceipt
};
