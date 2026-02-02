import * as Eth      from '../../lib/eth-constants.js';
import * as Constant from '../../lib/constants.js';

import { GovernanceRouteData } from '../router.js';

import * as TallyApi        from '../../lib/model/governance/tally.js';
import * as governanceModel from '../../lib/model/governance.js';

import { Context } from './handlers.js';
import {
  formatProposals,
  knownGovernanceContracts,
} from './proposals.js';
import { getPageData, PaginationSummary } from '../pagination.js';

async function getProposalVoteReceipts(
  { apiHost, nodeHost, nodeKey, network, queryParams }: GovernanceRouteData,
  context: Context
): Promise<Response> {
  const { evaluate, join, pull1 } = context.evaluator;
  const accountToFilter = queryParams.get('account');
  const proposalIdToFilter = queryParams.get('proposal_id');
  const rawVoteSideToFilter = queryParams.get('support');
  // Check if there's a query param to filter on support,
  const voteSideToFilter = rawVoteSideToFilter === null
    // don't filter on support if there isn't.
    ? null
    // filter on that support side if there is.
    : (rawVoteSideToFilter === 'true' || rawVoteSideToFilter === 'false')
      ? governanceModel.proposal.booleanVoteSupportMapping[rawVoteSideToFilter]
      // otherwise return nothing if the support side is unexpected.
      : undefined;

  const shouldIncludeProposalData = queryParams.get('with_proposal_data');
  // Check if the client is interested in any specific page numbers/sizes, otherwise use defaults.
  const pageSize = parseInt(queryParams.get('page_size') ?? '100');
  const pageNumber = parseInt(queryParams.get('page_number') ?? '1');

  if (!accountToFilter && !proposalIdToFilter) {
    return new Response(`Must either filter on an account or proposal`, {
      status: 400,
    });
  }

  // Start fetching the cached profiles above the computation to slightly
  // reduce blocking calls.
  const profilesByAddressPromise = TallyApi.getProfilesByAddress(context.env.TALLY_API_KEY);

  const latestBlock = await evaluate(pull1({
    ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network }
  }));

  const proposalsComputation = await evaluate(join([
    knownGovernanceContracts(network).map(contract => pull1({
      allProposals: {
        apiHost,
        nodeHost,
        nodeKey,
        network,
        contract,
        quorum:      Constant.quorumVotes,
        blockNumber: latestBlock.number,
      },
    })),
    proposalsByContract => proposalsByContract.flat(),
  ]));

  // Sort the proposals so that paginated results are returned with newest proposal first.
  const sortedProposalsComputation = proposalsComputation.sort((a, b) => b.startBlock - a.startBlock);
  const filteredProposals = sortedProposalsComputation.filter(proposal => {
    // Filter the proposals by proposal id, if specified.
    if (proposalIdToFilter !== null && proposal.id.toString() !== proposalIdToFilter) {
      return false;
    }
    // Filter the proposals by whether a particular account voted on it, if account is specified.
    if (
      accountToFilter !== null
      && !proposal.voteEntries.some((voteEntry) => voteEntry.voter.toLowerCase() === accountToFilter.toLowerCase())
    ) {
      return false;
    }
    return true;
  })

  let profilesByAddress: { [_ in Eth.Address]: governanceModel.Profile } = {};
  try { profilesByAddress = await profilesByAddressPromise } catch (e) {
    context.debug?.error(`swallowing error:`, { error: e });
  }
  // Maybe map the proposal id to its formatted proposal, if proposal data should be returned.
  const maybeFormattedProposalsById: { [key: string]: governanceModel.proposal.FormattedProposal } = {};
  if (shouldIncludeProposalData) {
    const formattedProposals = formatProposals(
      filteredProposals,
      network,
      latestBlock,
      profilesByAddress,
    );
    for (const proposal of formattedProposals) {
      maybeFormattedProposalsById[proposal.id.toString()] = proposal;
    }
  }

  // From each (filtered) proposal, filter the vote entries and transform them into vote receipts.
  const voteReceiptsNoProposalData = filteredProposals.map((proposal) =>
    proposal.voteEntries.filter((voteEntry) => true
      && (voteSideToFilter === null || voteEntry.support === voteSideToFilter)
      && (accountToFilter === null  || voteEntry.voter.toLowerCase() === accountToFilter.toLowerCase())
    ).map((voteEntry) => ({
        proposal_id: proposal.id.toNumber(),
        proposal: maybeFormattedProposalsById[proposal.id.toString()] ?? null,
        voter: profilesByAddress[voteEntry.voter.toLowerCase() as `0x${string}`] ?? {
          image_url: null,
          account_url: null,
          display_name: null,
          address: voteEntry.voter,
        },
        // Map for/against votes to true/false respectively, and abstain to null.
        support: (
            voteEntry.support === governanceModel.proposal.VoteSupport.For     ? true
          : voteEntry.support === governanceModel.proposal.VoteSupport.Against ? false
          : null
        ),
        votes: voteEntry.votes.toString(),
      })
      // Sort the vote receipts so that paginated results are returned with most votes first.
    ).sort((a, b) => parseFloat(b.votes) - parseFloat(a.votes))
  )
  .flat();

  const [voteReceiptsPage, paginationSummary] = getPageData(voteReceiptsNoProposalData, pageSize, pageNumber);
  const responseData: VoteReceiptsResponseData = {
    proposal_vote_receipts: voteReceiptsPage,
    pagination_summary: paginationSummary,
  };
  return new Response(JSON.stringify(responseData));
}

type VoteReceiptsResponseData = {
  proposal_vote_receipts: governanceModel.ProposalVoteReceipt[],
  pagination_summary: PaginationSummary,
};

export {
  getProposalVoteReceipts,
  VoteReceiptsResponseData,
}
