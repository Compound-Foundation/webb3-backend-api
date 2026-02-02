import * as Eth      from '../../lib/eth-constants.js';
import * as Constant from '../../lib/constants.js';

import { BigFixnum } from '../../lib/bigfixnum.js';
import { AllContracts, GovernanceRouteData } from '../router.js';
import { Context } from './handlers.js';
import { knownGovernanceContracts } from './proposals.js';
import { ERC20 } from '../../lib/well-known/contracts/types.js';

async function getHistory({ apiHost, nodeHost, nodeKey, network, contract }: GovernanceRouteData, context: Context): Promise<Response> {
  // Parse/get the various contracts for the computations.
  if (contract === AllContracts) {
    return new Response(`Error: Specifier '${AllContracts}' is invalid for this route`, { status: 400 });
  }
  const selectedGovernanceTokenContract = contract;
  if (!ERC20.is(selectedGovernanceTokenContract) || selectedGovernanceTokenContract.address !== Eth.wellKnownContractsByNetwork[network]['COMP']['default'].address) {
    return new Response(`Error: Governance token distribution data is only available for the COMP token`, { status: 400 });
  }

  // COMP that is not distributed yet, are held in the Reservoir, Timelock and Comptroller contracts.
  const contractsWitholdingGovernanceToken = [
    Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Reservoir']['default'],
    Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Timelock']['default'],
    Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Comptroller']['Unitroller'],
  ]

  // Get the governor contract to fetch proposal data, which is used to
  // fetch the total number of proposals created.
  const governorContracts = knownGovernanceContracts(network);

  const { evaluate, join, pull1, split } = context.evaluator;
  const latestBlock = await evaluate(pull1({
    ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network }
  }));

  const [voteTransfersByAddress, governanceProposals, compRemaining] = await evaluate(split(<const>[
    // Get a mapping of which addresses have delegated their votes to another address.
    pull1({
      voteTransfers: {
        apiHost,
        nodeHost,
        nodeKey,
        network: 'ethereum-mainnet',
        contract: selectedGovernanceTokenContract,
        maxTransferHistoryCount: 1,
        blockNumber: latestBlock.number
      }
    }),
    // Get all governance proposals that have been created
    join([
      governorContracts.map(governorContract => pull1({
        allProposals: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          contract: governorContract,
          quorum:      Constant.quorumVotes,
          blockNumber: latestBlock.number,
        },
      })),
      proposalsByContract => proposalsByContract.flat(),
    ]),
    join([
      contractsWitholdingGovernanceToken.map(contract => pull1({
        erc20Balance: {
          apiHost,
          nodeHost,
          nodeKey,
          account: contract.address,
          network: network,
          contract: selectedGovernanceTokenContract,
          blockNumber: latestBlock.number,
        }
      })),
      (compBalances) => compBalances.reduce((a, b) => a.add(b), BigFixnum.from({value: 0})),
    ]),
  ]));

  const nonZeroVoteBalances = Object.values(voteTransfersByAddress).map(recentVoteData => recentVoteData[0].newBalance).filter(voteBalance => voteBalance.gt(BigFixnum.from({value: 0})));
  const totalVotes = nonZeroVoteBalances.reduce((a, b) => a.add(b), BigFixnum.from({value: 0}));

  const responseData: HistoryResponseData = {
    votes_delegated: totalVotes.toString(),
    voting_addresses: nonZeroVoteBalances.length,
    proposals_created: governanceProposals.length,
    comp_remaining: compRemaining.toString(),
  }

  return new Response(JSON.stringify(responseData));
}

type HistoryResponseData = {
  votes_delegated: string,
  voting_addresses: number,
  proposals_created: number,
  comp_remaining: string,
}

export {
  getHistory,
}
