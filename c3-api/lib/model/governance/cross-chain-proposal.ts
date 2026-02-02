import * as Eth      from '../../eth-constants.js';
import { BigNumber } from '../../bignumber.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

type CrossChainProposal = {
  id:         BigNumber,
  states:     ProposalState[],
  network:    KnownNetwork.Name,
  targets:    Eth.Address[],
  values_:    BigNumber[],
  calldatas:  string[],
  signatures: string[],
};

const ProposalStates = <const>([
  'queued',   // block <  proposal.startBlock. eta <- 0
  'executed', // block >= proposal.startBlock && <= endBlock
  'expired',  // forVotes >= quorum && > againstVotes
  'queued',   // succeeded -> queued. eta <- timestamp
]);
type ProposalStateType = (typeof ProposalStates)[number];

type ProposalState = {
  state:           ProposalStateType,
  startBlock:      Eth.BlockNumber,
  startTime?:      number,
  transactionHash: string,
};

const ProposalCreated = (
  `event ProposalCreated(
    address indexed messageSender,
    uint      id,
    address[] targets,
    uint[]    values_,
    string[]  signatures,
    bytes[]   calldatas,
    uint      eta
  )`
) as const;

const ProposalExecuted = (
  `event ProposalExecuted(
    uint indexed id
  )`
) as const;

const events = {
  ProposalCreated,
  ProposalExecuted,
};

export type {
  CrossChainProposal,
};

export {
  events,
  ProposalCreated,
  ProposalExecuted,
};
