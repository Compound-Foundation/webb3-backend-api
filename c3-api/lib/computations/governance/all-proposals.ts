import * as Eth      from '../../eth-constants.js';
import * as Debug    from '../../debug-log.js';
import { BigFixnum } from '../../bigfixnum.js';

import * as governance from '../../model/governance.js';

import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as ContractUtils from '../../well-known/contracts/utils.js';
import * as KnownNetwork  from '../../well-known/networks/network.js';


import type * as evm from '../evm.js';

type AllProposals = Compute.Recurrence.Spec<{
  name: 'allProposals',
  basis: {
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
  returns: governance.Proposal[],
}>;

const {
  implement,
  fromPrevious,
  join,
  pipe1,
  split,
  value,
} = Compute.Recurrence.Functor<AllProposals>({});

const allProposals = implement({
  version: 2,
  index: Index.BlockNumberRange<AllProposals['expects']>({
    start: ({ contract: { creation } }) => creation.block.number,
    stride: 50_000, // index every 50,000th block (per ~7 days)
  }),
  origin: ({}) => [],
  async compute({ apiHost, nodeHost, nodeKey, blockNumber, network, contract: { address } }, debug) {
    return fromPrevious(previous => pipe1([
      {
        ethGetLogs: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          addresses:  [ address ],
          blockRange: [ previous.cursor.blockNumber, blockNumber ],
          filter: [
            [
              alphaCoders.topics.VoteCast,
              bravoCoders.topics.VoteCast,
              coders.topics.ProposalCreated,
              coders.topics.ProposalCanceled,
              coders.topics.ProposalQueued,
              coders.topics.ProposalExecuted,
            ]
          ],
        }
      },
      async (rawLogs) => {
        // clone proposals to avoid mutating data
        const proposals = previous.value.map(proposal => {
          return { ...proposal, states: proposal.states.slice() };
        });
        for (const log of rawLogs) {
          if (log.removed) continue;
          const decoded = coders.decode(log);
          switch (decoded.name) {
            case 'ProposalCreated': {
              const actions: governance.proposal.Action[] = [];
              // convert our struct-of-arrays into an array-of-structs...
              for (let i = 0; i < decoded.body.targets.length; i++) {
                const { data, signature } = governance.proposal.parseSignatureAndCalldata(
                  decoded.body.signatures[i],
                  decoded.body.calldatas[i],
                );
                const target: Eth.Address = decoded.body.targets[i];
                const value  = (
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
                ...governance.proposal.parseTitleDescriptionFromBody(decoded.body.description),
                actions,
                id: decoded.body.id,
                // eta gets set if and when the proposal is queued
                eta: 0,
                // proposer can be extended (hydrated) with additional
                // fields separately, to turn it into a governance profile
                proposer: {
                  address: decoded.body.proposer,
                },
                // unwrap start and end blocks from BigNumber
                startBlock: decoded.body.startBlock.toNumber(),
                endBlock:   decoded.body.endBlock.toNumber(),
                // push pending state, all proposals begin as 'pending'
                // for at least 1 block.
                states:  [
                  {
                    state: 'pending',
                    startBlock: parseInt(log.blockNumber, 16),
                    endBlock: decoded.body.startBlock.toNumber(),
                    transactionHash: log.transactionHash,
                  },
                ],
                voteEntries: [],
              });
              // NOTE(jordan): 116 accidentally omitted its title and so
              // we hacked this into the API and conspired with comp.vote
              if (decoded.body.id.eq(116)) {
                proposals[proposals.length - 1].title = (
                  'Initialize Compound III (USDC on Ethereum)'
                );
              }
              break;
            }
            case 'ProposalCanceled': {
              const targetId = decoded.body.id;
              const proposal = proposals.find(({ id }) => id.eq(targetId));
              if (!proposal) continue;
              // may be pending a transition to succeeded, defeated, or
              // even expired
              const blockNumber = parseInt(log.blockNumber, 16);
              fixupPendingTransitions(proposal, blockNumber, decoded.name);
              proposal.states.push({
                state: 'canceled',
                startBlock: blockNumber,
                transactionHash: log.transactionHash,
              });
              break;
            }
            case 'ProposalQueued': {
              const targetId = decoded.body.id;
              const proposal = proposals.find(({ id }) => id.eq(targetId));
              if (!proposal) continue;
              // must have already transitioned to succeeded
              const blockNumber = parseInt(log.blockNumber, 16);
              fixupPendingTransitions(proposal, blockNumber, decoded.name);
              proposal.states.push({
                state: 'queued',
                startBlock: blockNumber,
                transactionHash: log.transactionHash,
              });
              break;
            }
            case 'ProposalExecuted': {
              const targetId = decoded.body.id;
              const proposal = proposals.find(({ id }) => id.eq(targetId));
              if (!proposal) continue;
              const blockNumber = parseInt(log.blockNumber, 16);
              fixupPendingTransitions(proposal, blockNumber, decoded.name);
              proposal.states.push({
                state: 'executed',
                startBlock: blockNumber,
                transactionHash: log.transactionHash,
              });
              break;
            }
            case 'VoteCast': {
              const targetId = decoded.body.proposalId;
              const proposal = proposals.find(({ id }) => id.eq(targetId));
              if (!proposal) continue;
              const blockNumber = parseInt(log.blockNumber, 16);
              fixupPendingTransitions(proposal, blockNumber, decoded.name);

              // A vote's support can come in as a boolean, in which case map it
              // to one of our enum values, true -> for proposal, false -> against proposal.
              const support = typeof decoded.body.support === 'boolean'
                ? governance.proposal.booleanVoteSupportMapping[`${decoded.body.support}`]
                : decoded.body.support;

              proposal.voteEntries = [...proposal.voteEntries, {
                voter: decoded.body.voter,
                support: support,
                votes: BigFixnum.from({
                  value: decoded.body.votes,
                  decimals: 18, // COMP decimals
                }),
              }];
              break;
            }
            default: {
              throw new Error(`unrecognized event: ${(decoded as any).name}`);
            }
          }
        }
        // fix up succeeded/defeated/expired states
        proposals.forEach(p => fixupPendingTransitions(p, blockNumber, 'postprocess'));
        // For each proposal's state, compute its block timestamp and save it in the proposal computation.
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
        //
        function fixupPendingTransitions(
          proposal:     governance.Proposal,
          blockNumber:  Eth.BlockNumber,
          trigger:      string,
        ): void {
          proposal.states.push(...pendingTransitions(proposal, { trigger, blockNumber }, debug));
        }
      },
    ]));
  },
});

function pendingTransitions(
  proposal: governance.Proposal,
  { blockNumber }: {
    trigger:     string,
    blockNumber: Eth.BlockNumber,
  },
  debug: Debug.Logger,
): governance.proposal.State[] {
  const pending: governance.proposal.State[] = [];
  let lastState = proposal.states[proposal.states.length - 1].state;
  // const prefix = `fixup(${trigger.padEnd(16, ` `)} ${proposal.id.toString().padStart(3, ' ')})`;
  if (lastState === 'pending') {
    if (blockNumber > proposal.startBlock) {
      // console.log(`${prefix}: transitioning 'pending'   → 'active'    because ${block.number} > startBlock ${proposal.startBlock}`);
      pending.push({
        state: 'active',
        startBlock: proposal.startBlock,
        endBlock: proposal.endBlock,
      });
      lastState = 'active';
    }
  }
  if (lastState === 'active') {
    if (blockNumber > proposal.endBlock) {
      const state = governance.proposal.succeeded(proposal) ? 'succeeded' : 'defeated';
      // console.log(`${prefix}: transitioning 'active'    → '${state}' because ${block.number} > endBlock ${proposal.endBlock}`);
      pending.push({ state, startBlock: proposal.endBlock });
      lastState = state;
    }
  }
  // FIXME(jordan): handle transition to `expired` despite the fact no
  // proposal has ever expired before. Needs thoughtful testing.
  if (lastState === 'queued') {
    debug.log(`UNHANDLED: proposal[${proposal.id}] COULD be expired (but probably is not).`);
  }
  return pending;
}

const alphaCoders = Eth.Event.Coder.fromSignatures([
  governance.proposal.events.VoteCastAlpha,
]);

const bravoCoders = Eth.Event.Coder.fromSignatures([
  governance.proposal.events.VoteCastBravo,
]);

// FIXME(jordan): VoteCastAlpha and VoteCastBravo overlap by name...
const coders = Eth.Event.Coder.fromSignatures([
  governance.proposal.events.VoteCastAlpha,
  governance.proposal.events.VoteCastBravo,
  governance.proposal.events.ProposalCreated,
  governance.proposal.events.ProposalCanceled,
  governance.proposal.events.ProposalQueued,
  governance.proposal.events.ProposalExecuted,
]);

export {
  AllProposals,
  allProposals,
};
