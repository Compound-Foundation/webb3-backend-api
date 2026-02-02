import * as Eth from '../../../lib/eth-constants.js';
import { Profile } from './profile.js';

/*
 * Partial Tally Account model
 */
type Account = {
  id:      string;
  name:    string;
  picture: string;
  address: Eth.Address;
  participations: Participation[];
};

/*
 * Partial Tally Account governance participation model
 */
type Participation = {
  stats: {
    voteCount:       number, // number of votes cast all time
    tokenBalance:    string, // balance of governance tokens
    delegationCount: number, // number of delegates to this acct
    votingPower: {
      net: string, // net voting power: delegated_{in - out}
    },
  },
};

/*
 * A CAIP-10 compliant account id, which is heavily namespaced for
 * cross-chain compatibility even outside of the EVM universe.
 *
 * This type only supports EVM universe CAIP-10 IDs.
 */
type CAIP10 = `eip155:${string}:${string}`;


/*
 * GraphQL queries can result in data or errors.
 */
type Result<ExpectedData> = (
  | Result.Data<ExpectedData>
  | Result.Errors
);
namespace Result {
  /*
   * GraphQL query responses are wrapped in { data: T }
   */
  export type Data<T> = { data: T };
  /*
   * Failed GraphQL queries return an array of errors as { errors: E[] }
   */
  export type Errors = { errors: Array<{ message: string }> };
}

/*
 * Profile metadata and participation statistics for all accounts for a
 * governor specified by its CAIP-10 compliant account id.
 *
 * Results will be sorted by the net voting power of each governance
 * participant; greatest voting power first.
 */
namespace Delegates {
  export type Variables = {
    governanceId: CAIP10, // CAIP-10 account id
    cursor?:      string, // opaque string, defaults to beginning
    limit?:       number, // max: 20; we default to the maximum 20
  };
  export const Query = (
    `query Delegates($governanceId: AccountID!, $cursor: String, $limit: Int = 20) {
      delegates(input: {
        filters: { governanceId: $governanceId }
        sort: {
          sortBy: VOTES
          isDescending: true
        }
        page: {
          afterCursor: $cursor
          limit: $limit
        }
      }) {
        nodes {
          ... on Delegate {
            account {
              id
              name
              address
              picture
              participations(governanceIds: [ $governanceId ]) {
                stats {
                  voteCount
                  tokenBalance
                  delegationCount
                  votingPower { net }
                }
              }
            }
          }
        }
        pageInfo {
          firstCursor
          lastCursor
          # NOTE: count is not implemented as of 2023-12-03, always 0
          count
        }
      }
    }`
  );
  export type Data = {
    delegates: {
      nodes: { account: Account }[],
      pageInfo: {
        firstCursor: string, // beginning cursor (for beforeCursor queries)
        lastCursor:  string, // ending cursor    (for afterCursor queries)
        count:       0, // NOTE: count is not implemented as of 2023-12-03
      },
    },
  };
  export const query = _query<typeof Query, Variables, Data>(Query);
}

/*
 * Profile metadata and participation statistics for the specified CAIP-10
 * participant ids, for governors specified by CAIP-10 account ids.
 */
namespace AccountProfiles {
  export type Variables = {
    accountIds:    CAIP10[], // participant CAIP-10 account ids
    governanceIds: CAIP10[], // governor CAIP-10 account ids
  };
  export const Query = (
    `query Accounts($governanceIds: [AccountID!], $accountIds: [AccountID!]) {
      accounts(ids: $accountIds) {
        id
        name
        address
        picture
        participations(governanceIds: $governanceIds) {
          stats {
            voteCount
            tokenBalance
            delegationCount
            votingPower { net }
          }
        }
      }
    }`
  );
  export type Data = { accounts: Account[] };
  export const query = _query<typeof Query, Variables, Data>(Query);
}

/*
 * Profile metadata for all accounts for given address
 *
 * TODO?: include url, whether that's twitter etc.
 */
namespace Profiles {
  export type Variables = {};
  export const Query = (
    `query Profiles() {
      governors(addresses: [
        "${Eth.wellKnownContractsByNetwork['ethereum-mainnet']['GovernorAlpha']['default'].address}",
        "${Eth.wellKnownContractsByNetwork['ethereum-mainnet']['GovernorBravo']['default'].address}"
      ]) {
        delegates {
          account {
            id
            name
            address
            picture
          }
        }
      }
    }`
  );
  export type Data = {
    governors: Array<{
      delegates: Array<{
        account: Account;
      }>
    }>
  };
  export const query = _query<typeof Query, Variables, Data>(Query);
}

function _query<
  Query     extends string,
  Variables extends { [key: string]: any },
  Data      extends { [key: string]: any },
>(query: Query) {
  return async (apiKey: string, variables: Variables): Promise<Result<Data>> => {
    const response = await fetch(Eth.governanceTallyQueryEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-key': apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      let errorJson = {} as any; try { errorJson = await response.json() } catch {};
      throw new Error(
        `TallyApi.query(..) failed:`
        + ` [${response.status}] ${response.statusText}`
        + ` -- ${JSON.stringify(errorJson)}`
      );
    }
    return response.json() as any;
  }
}

async function getProfilesByAddress(apiKey: string) {
  const profilesResult = await Profiles.query(apiKey, {});
  if ('errors' in profilesResult) {
    const errors = profilesResult.errors.map(e => '"' + e.message + '"');
    throw new Error(`TallyApi.Profiles.query(..): ERRORS: [${errors}]`);
  }
  return formatProfilesByAddress(profilesResult);
}

function formatProfilesByAddress(profiles: Result.Data<Profiles.Data>) {
  const accounts = profiles.data.governors.map(({ delegates }) => (
    delegates.map(({ account }) => account).flat()
  )).flat();
  const result: { [address: Eth.Address]: Profile } = {};
  for (const { name, address, picture } of accounts) {
    result[address] = result[(address.toLowerCase() as Eth.Address)] = {
      address,
      image_url: picture,
      display_name: name,
    };
  }
  return result;
}

export {
  // profiles helpers
  getProfilesByAddress,
  formatProfilesByAddress,
  // helper types
  CAIP10,
  Account,
  // high-level query result types
  Result,
  // domain query/response namespaces
  Delegates,
  AccountProfiles,
  // DEPRECATED: domain query/response namespaces
  Profiles,
};
