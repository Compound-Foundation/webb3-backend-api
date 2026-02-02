import { keccak256 } from '../../hash.js';
import * as Eth      from '../../eth-constants.js';
import * as Constant from '../../constants.js'
import { BigFixnum } from '../../bigfixnum.js';
import { BigNumber } from '../../bignumber.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import {
  commonGovernanceActionSignatures,
} from '../../well-known/signatures.js';

import { Profile } from './profile';

type Proposal = {
  id:          BigNumber,
  eta:         number,
  title:       string,
  description: string,
  //
  endBlock:   Eth.BlockNumber,
  startBlock: Eth.BlockNumber,
  //
  voteEntries: VoteEntry[],
  //
  states:   ProposalState[],
  actions:  ProposalAction[],
  proposer: { address: Eth.Address },
};

const ProposalStates = <const>([
  // pending -> active -> succeeded -> queued
  'pending',   // block <  proposal.startBlock. eta <- 0
  'active',    // block >= proposal.startBlock && <= endBlock
  'succeeded', // forVotes >= quorum && > againstVotes
  'queued',    // succeeded -> queued. eta <- timestamp
  // terminal cases
  'canceled', // any    -> canceled where ProposalCanceled (any time)
  'defeated', // active -> defeated where block > endBlock && !succeeded
  'executed', // queued -> executed where ProposalExecuted
  'expired',  // queued -> expired  where block.time > eta + GRACE_PERIOD
]);
type ProposalStateType = (typeof ProposalStates)[number];

type ProposalState = {
  state:            ProposalStateType,
  endBlock?:        Eth.BlockNumber,
  startBlock:       Eth.BlockNumber,
  endTime?:         number,
  startTime?:       number,
  transactionHash?: string,
  crossChainNetwork?: KnownNetwork.Name,
};

type ProposalAction = {
  title: string,
  subtitles: string[],
  // full contract call payload for the action
  data:      string,      // calldata for the call
  value:     BigFixnum,   // value for the call (e.g. 1eth), for payable?
  target:    Eth.Address, // contract adddress to call
  signature: string,      // function signature to call on target
};

// NOTE that the event argument is actually named `values`, but it's
// overriden as a special Array keyword, so substituting it as `values_` instead.
const ProposalCreated = (
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
  )`
) as const;

const VoteCastBravo = (
  `event VoteCast(
    address indexed voter,
    uint    proposalId,
    uint8   support,
    uint    votes,
    string  reason
  )`
) as const;

const VoteCastAlpha = (
  `event VoteCast(
    address voter,
    uint proposalId,
    bool support,
    uint votes
  )`
) as const;

const ProposalCanceled = `event ProposalCanceled(uint id)`                   as const;
const ProposalExecuted = `event ProposalExecuted(uint id)`                   as const;
const ProposalQueued   = `event ProposalQueued(uint id, uint eta)`           as const;

const events = {
  ProposalCreated,
  VoteCastAlpha,
  VoteCastBravo,
  ProposalQueued,
  ProposalExecuted,
  ProposalCanceled,
};

type FormattedAction = {
  data:      string,
  signature: string,
  target:    string,
  title:     string,
  value:     string,
};

type FormattedProposal = {
  // unchanged
  eta:           number,
  title:         string,
  proposer:      Profile,
  end_block:     number,
  start_block:   number,
  description:   string,
  // reformatted
  id:            number,
  actions:       FormattedAction[],
  for_votes:     string,
  against_votes: string,
  states: {
    start_time?: number,
    end_time?: number,
    state: ProposalStateType,
    transaction_hash?: string,
    cross_chain_network?: KnownNetwork.Name,
  }[],
};

type VoteEntry = {
  voter: Eth.Address,
  support: VoteSupport,
  votes: BigFixnum,
}

// TBD: reorganize
enum VoteSupport {
  Against = 0,
  For     = 1,
  Abstain = 2,
}

const booleanVoteSupportMapping = {
  true: VoteSupport.For,
  false: VoteSupport.Against,
} as const;

function succeeded(proposal: Proposal) {
  const forVotes = forVotesCount(proposal.voteEntries);
  const againstVotes = againstVotesCount(proposal.voteEntries);
  return true
      && forVotes.gt(Constant.quorumVotes)
      && forVotes.gt(againstVotes)
    ;
}

function forVotesCount(voteEntries: VoteEntry[]): BigFixnum {
  return voteEntries.filter(voteEntry =>
    voteEntry.support === VoteSupport.For
  ).reduce((supportingVotes, supportingVoteEntry) =>
    supportingVotes.add(supportingVoteEntry.votes),
    BigFixnum.from({ value: 0, decimals: 18 })
  );
}

function againstVotesCount(voteEntries: VoteEntry[]): BigFixnum {
  return voteEntries.filter(voteEntry =>
    voteEntry.support === VoteSupport.Against
  ).reduce((againstVotes, againstVoteEntry) =>
    againstVotes.add(againstVoteEntry.votes),
    BigFixnum.from({ value: 0, decimals: 18 })
  );
}

function parseTitleDescriptionFromBody(description: string): {
  title:       string,
  description: string,
} {
  const match = description.match(/\s*#\s+([^\r\n]+)/);
  if (match === null) {
    return { title: 'Untitled', description };
  }
  description = description.slice(match.index! + match[0].length);
  return {
    title: match[1],
    description: description.trim(),
  };
}

function parseSignatureAndCalldata(
  rawSignature: string,
  rawCalldata: `0x${string}`,
): {
  signature: string,
  data: `0x${string}`,
} {
  /*
   * Check for an explicit signature if there is one, otherwise assume
   * that the signature is encoded in the calldata (which is supported by
   * the governance contracts) and attempt to decode it.
   */
  if (rawSignature === '') {
    /*
     * Get the function selector from the first 4 bytes of the calldata
     * (and prepending `0x`).
     */
    const functionSelector = rawCalldata.slice(0, 10);
    // The rest of the calldata is for the function argument values.
    const functionArgData = rawCalldata.slice(10);
    /*
     * Match this function selector against a list of known signatures to
     * try to look up which signature it belongs to.
     */
    let maybeSignature = undefined;
    for (const knownSignature of commonGovernanceActionSignatures) {
      const knownSignatureAddress = `0x${keccak256(knownSignature)}`;
      const knownFunctionSelector = knownSignatureAddress.slice(0, 10);
      if (functionSelector.toLowerCase() === knownFunctionSelector.toLowerCase()) {
        maybeSignature = knownSignature;
        break;
      }
    }
    if (maybeSignature) {
      /*
       * Update the signature and calldata, so that the signature is
       * explicit and the calldata is only the function argument values.
       */
      return {
        signature: maybeSignature,
        data: `0x${functionArgData}`,
      };
    }
  }
  return {
    data:      rawCalldata,
    signature: rawSignature,
  };
}

export type {
  Proposal,
  VoteEntry,
  FormattedAction,
  FormattedProposal,
  ProposalState     as State,
  ProposalAction    as Action,
  ProposalStateType as StateType,
};

export {
  events,
  succeeded,
  VoteSupport,
  forVotesCount,
  againstVotesCount,
  booleanVoteSupportMapping,
  parseSignatureAndCalldata,
  parseTitleDescriptionFromBody,
  ProposalStates as StateTypes,
};
