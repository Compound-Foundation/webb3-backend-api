import { AllProposals         } from './governance/all-proposals.js';
import { VoteTransfers        } from './governance/vote-transfers.js';
import { CrowdProposals       } from './governance/crowd-proposals.js';
import { CrossChainProposals       } from './governance/cross-chain-proposals.js';
import { DelegateTransfers    } from './governance/delegate-transfers.js';
import { CrowdProposalUpdated } from './governance/crowd-proposal-updated.js';
import { CompBorrowSpeeds } from './governance/comp-borrow-speeds.js';
import { CompSupplySpeeds } from './governance/comp-supply-speeds.js';
import { CompRate } from './governance/comp-rate.js';

export type Governance = (
  | AllProposals
  | VoteTransfers
  | CrowdProposals
  | DelegateTransfers
  | CrowdProposalUpdated
  | CrossChainProposals
  | CompBorrowSpeeds
  | CompSupplySpeeds
  | CompRate
);

export {
  AllProposals,
  allProposals,
} from './governance/all-proposals.js';

export {
  VoteTransfers,
  voteTransfers,
} from './governance/vote-transfers.js';

export {
  DelegateTransfers,
  delegateTransfers,
} from './governance/delegate-transfers.js';

export {
  CrowdProposals,
  crowdProposals,
} from './governance/crowd-proposals.js';

export {
  CrowdProposalUpdated,
  crowdProposalUpdated,
} from './governance/crowd-proposal-updated.js';

export {
  CrossChainProposals,
  crossChainProposals,
} from './governance/cross-chain-proposals.js';

export {
  CompBorrowSpeeds,
  compBorrowSpeeds,
} from './governance/comp-borrow-speeds.js';

export {
  CompSupplySpeeds,
  compSupplySpeeds,
} from './governance/comp-supply-speeds.js';

export {
  CompRate,
  compRate,
} from './governance/comp-rate.js';
