import * as Eth      from '../../eth-constants.js';
import { BigFixnum } from '../../bigfixnum.js';

type VoteTransfersByAddress = {
  [address: Eth.Address]: VoteTransferEvent[],
};

type VoteTransferEvent = {
  newBalance:      BigFixnum,
  blockNumber:     Eth.BlockNumber,
  netVotesChanged: BigFixnum,
  transactionHash: string,
};

const DelegateVotesChanged = (
  `event DelegateVotesChanged(
    address indexed delegate,
    uint previousBalance,
    uint newBalance
  )`
) as const;

const events = {
  DelegateVotesChanged,
};

export type {
  VoteTransfersByAddress,
  VoteTransferEvent,
  DelegateVotesChanged,
};

export {
  events,
};
