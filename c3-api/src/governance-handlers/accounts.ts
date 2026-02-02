import * as Eth         from '../../lib/eth-constants.js';
import * as Fallible    from '../../lib/fallible/fallible.js';
import { BigFixnum    } from '../../lib/bigfixnum.js';
import { BigNumberish } from '../../lib/bignumber.js';

import { ERC20 } from '../../lib/well-known/contracts/utils.js';

import * as TallyApi        from '../../lib/model/governance/tally.js';
import * as governanceModel from '../../lib/model/governance.js';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import { AllContracts, GovernanceRouteData } from '../router.js';

import { Context } from './handlers.js';

function parseBigFixnum(value: BigNumberish) {
  return BigFixnum.from({ value, decimals: 18 });
}

/*
 * TODO still:
 *  - move formatting logic into the model
 *  - ... and TallyApi response parser(s)... no more casting!
 *  - allow multiple governors, ofc, indexed by comp token
 *  - do better parameter parsing of query params... preferably elsewhere
 *  - definitely simplify / streamline the all vs. specified cases...
 *      Accounts.Query vs. Delegates.Query, but same end result
 *      basically needs to route to the appropriate query resolver
 *  - the Accounts.Query case does not respect pagination query parameters
 */
async function getAccounts(
  { network, contract, queryParams }: GovernanceRouteData,
  context: Context,
): Promise<Response> {
  // Parse and use any query selectors for the resulting data.
  const pageSize = parseInt(queryParams.get('page_size') ?? '20');
  const pageNumber = parseInt(queryParams.get('page_number') ?? '1');
  const addressesRaw = (
    queryParams
      .get('addresses')
      ?.split(',')
      .map(address => address.toLowerCase())
  ) ?? [];

  // verify deprecation of pagination parameters
  if (pageSize > 20) {
    return new Response(`Error: page_size ${pageSize} is not valid. Use 20.`);
  }
  if (pageNumber != 1) {
    return new Response(`Error: page_number is not supported. Must use '1' or omit.`);
  }

  // parse addresses from the addresses query parameter
  const addresses: Eth.Address[] = [];
  for (let rawAddress of addressesRaw) {
    if (!Eth.parseAddress(rawAddress)) {
      return new Response(`Error: address ${rawAddress} is not a valid address`);
    }
    addresses.push(rawAddress);
  }

  // Parse/get the various contracts for the computations.
  if (contract === AllContracts) {
    return new Response(`Error: Specifier '${AllContracts}' is invalid for this route`, { status: 400 });
  }
  const selectedGovernanceTokenContract = contract;

  if (!ERC20.is(selectedGovernanceTokenContract)) {
    return new Response(`Governance Token Contract must be an ERC20`, { status: 400 });
  }

  // Get Governor Bravo contract for network
  const { chainId } = Fallible.must(KnownNetwork.lookup({ name: network }));
  const governorBravo = Eth.wellKnownContractsByNetwork[network]['GovernorBravo']['default'];
  const bravoId: TallyApi.CAIP10 = `eip155:${chainId}:${governorBravo.address}`;

  // for a specific set of addresses, use a filtered query instead of
  // enumerating all accounts
  if (addresses.length > 0) {
    const accountIds = addresses.map(address => `eip155:1:${address}` as TallyApi.CAIP10);
    let results: TallyApi.Result<TallyApi.AccountProfiles.Data>; try {
      results = await TallyApi.AccountProfiles.query(
        context.env.TALLY_API_KEY,
        { accountIds, governanceIds: [ bravoId ] }
      );
    } catch (error) {
      console.error(`Tally API Error`, error);
      return new Response(`Tally API Error: ${(error as Error).message}`, { status: 500 });
    }

    if ('errors' in results) {
      throw new Error(results.errors[0]?.message);
    }

    // format response
    const accounts: governanceModel.Account[] = results.data.accounts.map(account => parseDelegate({ account }));
    return new Response(JSON.stringify({ accounts }));
  }

  // if no specific addresses were requested, we enumerate all accounts
  let results: TallyApi.Result<TallyApi.Delegates.Data>; try {
    results = await TallyApi.Delegates.query(
      context.env.TALLY_API_KEY,
      {
        governanceId: bravoId,
        // cursor: ...
      }
    );
  } catch (error) {
    console.error(`Tally API Error`, error);
    return new Response(`Tally API Error: ${(error as Error).message}`, { status: 500 });
  }

  if ('errors' in results) {
    throw new Error(results.errors[0]?.message);
  }

  // format response
  const accounts: governanceModel.Account[] = results.data.delegates.nodes.map((delegate, index) => {
    const parsed = parseDelegate(delegate);
    return { ...parsed, rank: index + 1 };
  });
  return new Response(JSON.stringify({ accounts }));
}

function parseDelegate(delegate: { account: TallyApi.Account }): governanceModel.Account {
  // assume that if an account has no participation, all values are 0
  const stats = delegate.account.participations[0]?.stats ?? {
    voteCount:       0,
    tokenBalance:    '0',
    delegationCount: 0,
    votingPower: { net: '0' },
  };
  return {
    // decimals
    votes:       parseBigFixnum(stats.votingPower.net).toString(),
    balance:     parseBigFixnum(stats.tokenBalance).toString(),
    vote_weight: parseBigFixnum(stats.votingPower.net).toString(),
    // unstructured data
    address:         delegate.account.address,
    image_url:       delegate.account.picture,
    display_name:    delegate.account.name,
    proposals_voted: stats.voteCount,
    total_delegates: stats.delegationCount,
  };
}

export { getAccounts };
