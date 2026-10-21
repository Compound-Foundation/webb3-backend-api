import * as Eth      from '../../lib/eth-constants.js';
import * as Constant from '../../lib/constants.js';
import * as Fallible from '../../lib/fallible/fallible.js';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import * as TallyApi        from '../../lib/model/governance/tally.js';
import * as governanceModel from '../../lib/model/governance.js';

import {
  AllContracts,
  GovernanceRouteData,
} from '../router.js';

import { getPageData, PaginationSummary } from '../pagination.js';
import {
  contractForLocation,
  decodeFunctionDataFromSignature,
  describeContractCallForHumans,
  getNetworkIfCrossChain,
  lookupInWellKnown,
  withRegistryContracts,
} from '../../lib/well-known/contracts/utils.js';
import type { Contract, WellKnownContractsByNetworkAddress } from '../../lib/well-known/contracts/utils.js';
import { isAddress } from '../../lib/model/comet-registry.js';
import { defaultAbiCoder } from '@ethersproject/abi';

import type * as Type from '../../lib/type-utilities.js'

import type { Context } from './handlers.js';

const knownGovernanceContracts = (network: Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>) => [
  Eth.wellKnownContractsByNetwork[network]['GovernorAlpha']['default'],
  Eth.wellKnownContractsByNetwork[network]['GovernorBravo']['default'],
  Eth.wellKnownContractsByNetwork[network]['GovernorCharlie']['default'],
];

type Action = governanceModel.proposal.Proposal['actions'][number];

/*
 * The addresses each action names that the constants do not know: its target
 * and its arguments.
 *
 * Governance decodes against the static constants, the protocol this API is
 * built against, which name no market of a mainnet: every market is the
 * registry's to name. A market is as often an argument as the target — a
 * token approved to it, COMP sent to it, an admin handed to it — so an
 * action naming one either way is described again with the markets of the
 * active version merged in.
 */
function unknownAddresses(
  proposals: governanceModel.proposal.Proposal[],
  network: KnownNetwork.Name,
): Map<Action, Eth.Address[]> {
  const unknown = new Map<Action, Eth.Address[]>();
  for (const proposal of proposals) {
    for (const action of proposal.actions) {
      const addresses = [ action.target, ...argumentAddresses(action) ].filter(address => (
        Fallible.isFailure(lookupInWellKnown({ network, address }, Eth.wellKnownContractsByNetwork))
      ));
      if (addresses.length > 0) {
        unknown.set(action, addresses);
      }
    }
  }
  return unknown;
}

/*
 * The addresses among an action's arguments, decoded as its description
 * decodes them. Every action of the page is read here, so one this cannot
 * decode names nothing, rather than failing the page.
 */
function argumentAddresses(action: Action): Eth.Address[] {
  let decoded;
  try {
    decoded = decodeFunctionDataFromSignature(action.signature, action.data);
  } catch {
    return [];
  }
  const found: Eth.Address[] = [];
  const walk = (value: unknown): void => {
    if (isAddress(value)) {
      found.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    }
  };
  walk(decoded === null ? [] : [ ...decoded.functionValues ]);
  return found;
}

/*
 * The contracts governance names, with the markets the version holds but
 * does not serve beside those it serves. An address the constants or a
 * served market already name keeps that name.
 */
function withUnservedMarkets(
  contracts: WellKnownContractsByNetworkAddress,
  unserved: Contract[],
): WellKnownContractsByNetworkAddress {
  if (unserved.length === 0) {
    return contracts;
  }
  const merged = new Map<KnownNetwork.Name, Record<string, Contract>>();
  for (const market of unserved) {
    const named = merged.get(market.network) ?? { ...contracts[market.network] };
    merged.set(market.network, named);
    named[market.address.toLowerCase()] ??= market;
  }
  return { ...contracts, ...Object.fromEntries(merged) };
}

/*
 * An action that carries further actions to another chain. Its target is a
 * bridge the constants know, but what it carries configures contracts on that
 * chain, which may be markets only the registry describes; its description
 * says it bridged, because the constants decoded the bridge.
 */
function isBridged(action: Action): boolean {
  return action.title.startsWith('Bridge wrapped actions');
}

/*
 * The protocol's own contracts a proposal configures a market through. Their
 * addresses are static and the constants name them, but the market they act
 * on is an argument of the call — a Comet only the registry names — so an
 * action on one of them is described again as well.
 *
 * They are named as the constants name them: the proxy admin, the Solidity
 * CometProxyAdmin, is `CometAdmin` on every network.
 */
const MARKET_ADMINISTRATION = [ 'Configurator', 'CometAdmin', 'CometRewards', 'CometFactory' ];

function administersMarkets(network: KnownNetwork.Name, address: Eth.Address): boolean {
  const contracts = Eth.wellKnownContractsByNetwork[network] as Record<string, Record<string, unknown>>;
  return MARKET_ADMINISTRATION.some(name => contracts[name]?.[address.toLowerCase()] !== undefined);
}

/*
 * The bridges that carry tokens to an address on another chain, often a
 * market seeded with reserves. The recipient is named on that chain, so a
 * mainnet lookup cannot tell whether the version names it.
 */
const TOKEN_BRIDGES = [ 'PolygonBridge', 'ArbitrumGatewayRouter', 'OptimismL1StandardBridge', 'BaseL1StandardBridge' ];

function bridgesTokens(network: KnownNetwork.Name, address: Eth.Address): boolean {
  const contracts = Eth.wellKnownContractsByNetwork[network] as Record<string, Record<string, unknown>>;
  return TOKEN_BRIDGES.some(name => contracts[name]?.[address.toLowerCase()] !== undefined);
}

/*
 * Describes again, against the constants with the markets of the active
 * version merged in, the actions the registry can say more about: one whose
 * target or argument the constants do not know and the version names, one
 * that bridges actions to another chain, whose inner targets may be markets,
 * one that bridges tokens to an address on another chain, which may be a
 * market, and a call to a contract that administers markets.
 *
 * The version names the markets it serves, with their base and reward
 * tokens, and the markets it holds without serving them
 * (Catalog.unservedMarkets). Any other Comet reads as its address, and so
 * does every market while the registry cannot be read, since the constants
 * name none; only a description the list cached while they still did keeps
 * their name.
 *
 * Loading the registry is deliberately last: a page whose actions name only
 * addresses the constants know, and neither bridge nor call a contract that
 * administers markets, never reads D1 at all, though few pages are like
 * that. An address neither source knows — a grant recipient, another
 * protocol — would read the same described again, so its action is not. If
 * the registry cannot be loaded, the actions keep the description they
 * already have rather than failing the whole proposal list.
 */
async function describeRegistryTargets(
  proposals: governanceModel.proposal.Proposal[],
  network: Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>,
  { registry, debug }: Pick<GovernanceRouteData, 'registry'> & { debug: Context['debug'] },
): Promise<void> {
  const unknown = unknownAddresses(proposals, network);
  const again   = (action: Action) => (
    isBridged(action) || administersMarkets(network, action.target) || bridgesTokens(network, action.target)
  );
  const more = proposals.some(proposal => proposal.actions.some(again));
  if (unknown.size === 0 && !more) {
    return;
  }

  let catalog;
  try {
    catalog = await registry.load();
  } catch (error) {
    debug?.error(`proposal targets not described from the registry`, { error });
    return;
  }

  const contracts = withUnservedMarkets(
    withRegistryContracts(Eth.wellKnownContractsByNetwork, catalog.markets()),
    catalog.unservedMarkets(),
  );
  // an address the constants do not know, which the version names
  const named = (address: Eth.Address) => !Fallible.isFailure(lookupInWellKnown({ network, address }, contracts));

  for (const proposal of proposals) {
    for (const action of proposal.actions) {
      if (!again(action) && !(unknown.get(action) ?? []).some(named)) {
        continue;
      }
      const redescribed = describeContractCallForHumans(
        contractForLocation({ network, address: action.target }, contracts),
        action.signature,
        action.data,
        action.value,
        contracts,
      );
      action.title     = redescribed.title;
      action.subtitles = redescribed.subtitles ?? [];
    }
  }
}

async function getProposals(
  { apiHost, nodeHost, nodeKey, network, contract, queryParams, registry }: GovernanceRouteData,
  context: Context,
): Promise<Response> {
  const { evaluate, join, pull1 } = context.evaluator;

  // Start fetching the cached profiles above the computation to slightly
  // reduce blocking calls.
  const profilesByAddressPromise = TallyApi.getProfilesByAddress(context.env.TALLY_API_KEY);

  // By default, compute proposals across Governors Alpha and Bravo
  const selectedGovernanceContracts = (
    contract === AllContracts
      ? knownGovernanceContracts(network)
      : [ contract ]
  );

  const latestBlock = await evaluate(pull1({
    ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network }
  }));

  const proposalsComputation = await evaluate(join([
    selectedGovernanceContracts
      .filter(({ creation }) => {
        return creation.block.number <= latestBlock.number;
      })
      .map(contract => pull1({
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

  // For any proposals that affect cross chain, attempt to add those states to the mainnet proposal.
  // await hydrateCrossChainProposalsWithMoreStates(network, context, proposalsComputation);

  // Check if the client is filtering on any specific proposals, and if
  // so, fetch those proposals (otherwise get all).
  const selectedProposalIds = queryParams.get('proposal_ids')?.split(',');
  const selectedProposals = (
    selectedProposalIds != null
      ? proposalsComputation.filter(proposal => selectedProposalIds.includes(proposal.id.toString()))
      : [ ...proposalsComputation ]
  );

  // Check if the client is interested in any specific page numbers/sizes, otherwise use defaults.
  const pageSize   = parseInt(queryParams.get('page_size')   ?? '100');
  const pageNumber = parseInt(queryParams.get('page_number') ??   '1');

  // Paginate from newest -> oldest proposals.
  selectedProposals.sort((a, b) => b.startBlock - a.startBlock);
  const [ page, paginationSummary ] = (
    getPageData(selectedProposals, pageSize, pageNumber)
  );

  /*
   * Markets are named here, from the registry, after the cached decoding,
   * whose constants name none. The proposal computation is a recurrence over
   * years of logs, and keying it by registry version would rebuild the whole
   * chain whenever anything in the registry changed. This describes the page
   * the client asked for, not every proposal ever made, so the registry is
   * read for what is about to be answered.
   */
  await describeRegistryTargets(page, network, { registry, debug: context.debug });

  // Format each proposal computation result to have a backwards compatible schema with V2
  // (Also inserts in timestamps for each proposal state transition, which is currently displayed on the web app)
  let profilesByAddress = {};
  try { profilesByAddress = await profilesByAddressPromise } catch (e) {
    context.debug?.error(`swallowing error:`, { error: e });
  }

  return new Response(JSON.stringify({
    proposals: formatProposals(page, network, latestBlock, profilesByAddress),
    pagination_summary: paginationSummary,
  }));
}

// Format the proposal in human-readable UI-ready style.
function formatProposals(
  proposals: governanceModel.proposal.Proposal[],
  network: KnownNetwork.Name,
  latestBlock: Eth.Block,
  profilesByAddress: { [key: Eth.Address]: governanceModel.Profile }
): governanceModel.proposal.FormattedProposal[] {
  // Attempt to hydrate any pending and active proposals with an estimated end time.
  const proposalsWithMaybeEndTime = hydratePendingAndActiveProposalsWithEndTime(network, latestBlock.number, proposals);
  // Attempt to hydrate the proposer addresses with governance profile information (offchain data).
  const proposalsWithProfiles = hydrateProposers(profilesByAddress, proposalsWithMaybeEndTime);

  return proposalsWithProfiles.map(proposal => ({
    // unchanged
    eta:           proposal.eta,
    title:         proposal.title,
    proposer:      proposal.proposer,
    end_block:     proposal.endBlock,
    start_block:   proposal.startBlock,
    description:   proposal.description,
    // reformatted
    id:            proposal.id.toNumber(),
    for_votes:     governanceModel.proposal.forVotesCount(proposal.voteEntries).toString(),
    against_votes: governanceModel.proposal.againstVotesCount(proposal.voteEntries).toString(),
    actions:       proposal.actions.map(action => ({
      ...action,
      value: action.value.toString(), // format to string from BigFixnum
    })),
    states:        proposal.states.map(
      stateData => ({
        state:      stateData.state,
        ...(stateData.startTime ? {start_time: stateData.startTime} : {}),
        ...(stateData.endTime ? {end_time: stateData.endTime} : {}),
        ...(stateData.crossChainNetwork ? {cross_chain_network: stateData.crossChainNetwork} : {}),
        /*
         * NOTE: v2 shortened this to 'trx_hash' but for consistency since
         * we ordinarily don't abbreviate other terms, we won't abbreviate
         * this, either.
         */
        ...(stateData.transactionHash ? {transaction_hash: stateData.transactionHash} : {}),
      })
    ),
  }));
}

// For pending and active proposals, we want to estimate and show an end
// time of the future, to allow the client to roughly know how much time
// is remaining for proposal voting to finish.
function hydratePendingAndActiveProposalsWithEndTime(
  network:           KnownNetwork.Name,
  latestBlockNumber: Eth.BlockNumber,
  proposals:         governanceModel.Proposal[],
): governanceModel.Proposal[] {
  return proposals.map(proposal => {
    // Check if this proposal is currently pending or active, and skip hydrating if it isn't.
    // This is because the older the proposal, the more inaccurate the estimation will be.
    // Ideally for proposals in terminal states, we should look up the actual end time of the block, if the data is ever needed.
    const [latestProposalState] = [...proposal.states].sort((a, b) => a.startBlock - b.startBlock).slice(-1);
    if (!['pending','active'].includes(latestProposalState.state)) {
      return proposal;
    }

    return {
      ...proposal,
      states: proposal.states.map(state => {
        // Skip if this proposal does not have an pending or active state.
        if (!['pending','active'].includes(state.state) || !state.endBlock) {
          return state;
        }
        // Estimate and hydrate the end time for the state, of this pending/active proposal.
        const now = Date.now() / 1000;
        // If the timestamp is newer than the latest block (in the future), we'll add to the current time.
        const diffToLatestBlock = state.endBlock - latestBlockNumber;
        const blockTime = Eth.estimateSecondsTakenForBlock(network, { number: state.endBlock });
        return {
          ...state,
          endTime: Math.floor(now + (diffToLatestBlock * blockTime)),
        };
      }),
    };
  });
}

type HydratedProposal = Type.Merge<(
  & governanceModel.Proposal
  & { proposer: governanceModel.Profile }
)>;

// Attempt to replace the proposer ETH address with a more human-readable,
// governance profile (if exists).
function hydrateProposers(
  profiles:  { [key: string]: governanceModel.Profile },
  proposals: governanceModel.Proposal[],
): HydratedProposal[] {
  return proposals.map<HydratedProposal>(proposal => {
    const lookupKey = proposal.proposer.address.toLowerCase();
    return {
      ...proposal,
      proposer: profiles[lookupKey] ?? governanceModel.defaultProfile(proposal.proposer.address),
    };
  });
}

export async function hydrateCrossChainProposalsWithMoreStates(
  apiHost: string,
  nodeHost: string,
  nodeKey: string,
  network: Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>,
  context: Context,
  proposals: governanceModel.proposal.Proposal[],
): Promise<void> {
  // Cross chain governance works in that there is one action in the proposal that wraps and sends a bunch of 'sub-actions'
  // over a bridge to the governance bridge receiver on the other network.
  // Look for any actions that target a bridge receiver, and track those proposal & action indices to the relevant cross chain network.
  type NonEthNetworkAlias = Exclude<KnownNetwork.Name, (`ethereum-${string}`)>;
  const crossChainProposalActions: {[key: `${number}:${number}`]: NonEthNetworkAlias } = {};
  for (const [proposalIdx, proposal] of proposals.entries()) {
    // If the proposal hasn't been executed yet, don't bother checking it.
    const [latestProposalState] = [...proposal.states].sort((a, b) => a.startBlock - b.startBlock).slice(-1);
    if (latestProposalState.state !== 'executed') {
      continue;
    }
    for (const [actionIdx, action] of proposal.actions.entries()) {
      const maybeCrossChainNetwork = getNetworkIfCrossChain({...action, network});
      if (!!maybeCrossChainNetwork) {
        crossChainProposalActions[`${proposalIdx}:${actionIdx}`] = maybeCrossChainNetwork;
      }
    }
  }

  // Get the targeted cross chain networks and fetch all of the cross chain proposals sent to each of them.
  const targetedCrossChainNetworks = Object.values(crossChainProposalActions);
  const crossChainProposalComputations = filterNull(await Promise.all(targetedCrossChainNetworks.map(async (crossChainNetworkAlias) => {
    const network = KnownNetwork.lookup({ name: crossChainNetworkAlias });
    if (Fallible.isFailure(network)) {
      return null;
    }
    if (network.chain === 'polygon' || network.chain === 'arbitrum' || network.chain === 'base') {
      if (!('BridgeReceiver' in Eth.wellKnownContractsByNetwork[crossChainNetworkAlias])) {
        return null;
      }
      const { evaluate, pull1 } = context.evaluator;
      // Get the latest block of the target cross chain network.
      const latestBlock = await evaluate(pull1({
        ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network: crossChainNetworkAlias },
      }));
      // Get the proposals on the target cross chain network.
      return await evaluate(pull1({
        crossChainProposals: {
          apiHost,
          nodeHost,
          nodeKey,
          network: crossChainNetworkAlias,
          blockNumber: latestBlock.number,
          contract: (Eth.wellKnownContractsByNetwork[crossChainNetworkAlias] as any)['BridgeReceiver']['default'],
        }
      }));
    }
    return null;
  }))).flat();

  for (const [proposalActionIdx, network] of Object.entries(crossChainProposalActions)) {
    const [proposalIdx, actionIdx] = proposalActionIdx.split(':').map(idx => parseInt(idx));
    const proposal = proposals[proposalIdx];
    const action = proposals[proposalIdx].actions[actionIdx];

    // Unwrap the 'sub-actions' from the bridge actions.
    const maybeFunctionData = decodeFunctionDataFromSignature(action.signature, action.data);
    if (maybeFunctionData === null) {
      continue;
    }

    let crossChainActionData;
    if (network === 'polygon-mainnet' || network === 'polygon-mumbai') {
      crossChainActionData = maybeFunctionData.functionValues[1];
    } else if (network === 'arbitrum-mainnet' || network === 'arbitrum-goerli') {
      crossChainActionData = maybeFunctionData.functionValues[7];
    } else if (network === 'base-mainnet' || network === 'base-goerli') {
      crossChainActionData = maybeFunctionData.functionValues[1];
    }
    const unwrappedAction = defaultAbiCoder.decode(['address[] targets', 'uint256[] values_', 'string[] sigs', 'bytes[] calldatas'], crossChainActionData);

    // Iterate through all the cross chain proposals of the target network, and attempt
    // to match the sub-actions against each cross chain proposal, until we get a match.
    // This approach is a bit brittle, but we have to do it this way since there's
    // not a convenient way to associate a cross chain proposal with its original mainnet proposal action, yet.
    const crossChainNetworkSpecificProposals = crossChainProposalComputations.filter(proposal => proposal.network === network);
    const relevantCrossChainProposal = crossChainNetworkSpecificProposals.find(proposal => (
      proposal.targets.every((e, i) => e === unwrappedAction.targets[i])
      && proposal.values_.every((e, i) => e.toString() === unwrappedAction.values_[i]?.toString())
      && proposal.signatures.every((e, i) => e === unwrappedAction.sigs[i])
      && proposal.calldatas.every((e, i) => e === unwrappedAction.calldatas[i])
    ));

    // If we find a cross chain proposal, add its states to the original mainnet proposals',
    // so that governance participants can know the progress of the cross-chain proposal execution.
    if (relevantCrossChainProposal) {
      for (const crossChainState of relevantCrossChainProposal.states) {
        proposal.states.push({
          ...crossChainState,
          crossChainNetwork: network,
        })
      }
    }
  }
}

function filterNull<T extends (any)[]>(arr: T): Exclude<T[number], null>[] {
  return arr.filter((value): value is Exclude<T[number], null> => value !== null);
}

type ProposalsPage = {
  proposals:          governanceModel.proposal.FormattedProposal[],
  pagination_summary: PaginationSummary,
};

export {
  describeRegistryTargets,
  getProposals,
  formatProposals,
  knownGovernanceContracts,
  hydrateProposers,
};

export type {
  ProposalsPage,
  //
  HydratedProposal,
};
