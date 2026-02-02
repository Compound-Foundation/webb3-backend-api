import * as Eth      from '../lib/eth-constants.js';
import * as Fallible from '../lib/fallible/fallible.js';

import * as KnownNetwork  from '../lib/well-known/networks/network.js';
import * as ContractUtils from '../lib/well-known/contracts/utils.js';

import * as v2Handlers                from './v2-handlers/handlers.js';
import * as marketHandlers            from './market.js';
import * as accountHandlers           from './account-handlers/handlers.js';
import * as governanceHandlers        from './governance-handlers/handlers.js';
import * as transactionHistoryHandler from './transaction-history-handler/transaction-history-items-handler.js';

import type { Contract } from '../lib/well-known/contracts/types.js';

import type * as Evaluator from './evaluator.js';

/*
 * Handlers must declare the sets of computations upon which they depend.
 * The union of these is the Scope of the evaluator needed by the router.
 */
type Scope = (
  | v2Handlers.Dependencies
  | marketHandlers.Dependencies
  | accountHandlers.Dependencies
  | governanceHandlers.Dependencies
  | transactionHistoryHandler.Dependencies
);

/*
 * Router application context extends the Evaluator application context
 * with an instance of a properly-configured evaluator, with all handler
 * dependencies included in its Scope.
 */
interface Context extends Evaluator.Context {
  evaluator: Evaluator.Implementation<Scope>;
}

/*
 * An UninstantiatedContext lets a handler instantiate its own evaluator.
 */
interface UninstantiatedContext extends Evaluator.Context {
  instantiateEvaluator: Evaluator.InstantiateFn<Scope>;
}

/*
 * Specifier keyword for aggregating across all relevant contracts for a
 * computation. For example, when aggregating proposals over multiple
 * governor contracts (like alpha + bravo). It's not otherwise possible to
 * give both addresses, so this is a feature rather than convenience.
 *
 * e.g.
 *  governance/mainnet/all-contracts/proposals
 *
 */
const AllContracts = 'all-contracts' as const;

const AllNetworks = 'all-networks' as const;

/*
 * Specifier keyword for referring to the default COMP contract for a
 * network where relevant for a computation. For example, when selecting
 * the COMP contract for which to compute vote-holding accounts, in place
 * of the contract address of the default.
 *
 * e.g.
 *  governance/mainnet/comp/accounts
 */
const DefaultCompContract = 'comp' as const;

interface MarketRouteData {
  apiHost: string;
  nodeHost: string;
  nodeKey: string;
  network: KnownNetwork.Name | typeof AllNetworks;
  contract: Contract | typeof AllContracts;
  queryParams: URL['searchParams'];
}

interface GovernanceRouteData {
  apiHost: string;
  nodeHost: string;
  nodeKey: string;
  network: Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>;
  contract: Contract | typeof AllContracts;
  queryParams: URL['searchParams'];
}

interface V2RouteData {
  apiHost: string;
  nodeHost: string;
  nodeKey: string;
  network: Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>;
  queryParams: URL['searchParams'];
}

/*
* TxnHistoryRouteData is currently used by CometTxnHistory and CometRewardsTxnHistory.
*/
interface TransactionHistoryRouteData {
  apiHost: string;
  nodeHost: string;
  nodeKey: string;
  accountAddress: Eth.Address;
  queryParams: URL['searchParams'];
}

interface AccountRouteData {
  apiHost: string;
  nodeHost: string;
  nodeKey: string;
  account: Eth.Address;
  testnets: 'include' | 'exclude';
}

// Example Route: /{resource api}/<network>/<contract-specifier>/{endpoint suffix}

const handlerMappings = {
  'market': {
    'summary': marketHandlers.latestSummary,
    'historical/summary': marketHandlers.historicalSummary,
    'rewards/summary': marketHandlers.latestRewardsSummary,
    'rewards/dapp-data': marketHandlers.rewardsDappData,
  },
  'governance': {
    'proposals': governanceHandlers.getProposals,
    'proposal_vote_receipts': governanceHandlers.getProposalVoteReceipts,
    'accounts': governanceHandlers.getAccounts,
    'history': governanceHandlers.getHistory,
    'distribution': governanceHandlers.getCompDistribution,
  },
} as const;

type ResourceAPI = keyof typeof handlerMappings;
type ResourceEndpoint<API extends ResourceAPI> = keyof typeof handlerMappings[API];

async function route(
  request: Request,
  context: Omit<Context, 'evaluator'>,
  instantiateEvaluator: Evaluator.InstantiateFn<Scope>,
): Promise<Response> {
  try {
    return await unsafeRoute(request, context, instantiateEvaluator);
  } catch (e: unknown) {
    context.debug.clearDanglingGroups();
    context.debug.error(e, (e as any).cause);
    return new Response((e as Error).message, { status: 500 });
  }
}

async function unsafeRoute(
  request: Request,
  context: Omit<Context, 'evaluator'>,
  instantiateEvaluator: Evaluator.InstantiateFn<Scope>,
): Promise<Response> {
  const url = new URL(request.url);
  let route = url.pathname;

  // A URL path is generally split into 4 major parts:
  // 1. the resource API, e.g. 'market' or 'governance'
  // 2. the network that this request is interested in
  // 3. the contract that this request will fetch data on (or sometimes, 'all' for all relevant contracts)
  // 4. the endpoint suffix that maps to the resource-specific handler, e.g. 'historical/summary/'
  const pathMatch = route.match(new RegExp('^/([^ /]+)/([^ /]+)/([^ /]+)/([^ ]+)'));

  // A account path is different from the above format,
  // Which for transaction history, it is /account/<address>/transaction-history
  const accountPathMatch = route.match(new RegExp('^/account/([^ /]+)/([^ /]+)'));

  /*
   * Non-resource path. Attempt to match against a non-standard endpoint.
   */
  if (pathMatch === null) {
    /*
     * /legacy/ctokens
     */
    if (true
      && route.startsWith('/legacy/mainnet/ctokens')
      && request.method === 'GET'
    ) {
      return v2Handlers.getCTokens(
        {
          apiHost: context.env.V3_API_HOST,
          nodeHost: context.env.NODE_PROXY_HOST,
          nodeKey: context.env.NODE_PROXY_KEY,
          network: 'ethereum-mainnet',
          queryParams: url.searchParams,
        },
        {
          ...context,
          evaluator: instantiateEvaluator('mainnet'),
        }
      );
    }
    /*
     * /legacy/mainnet/gas-price
     * NOTE: does not depend on an evaluator.
     */
    else if (true
      && route.startsWith('/legacy/mainnet/gas-price')
      && request.method === 'GET'
    ) {
      return v2Handlers.getGasPrice(context.env.BLOCK_NATIVE_API_KEY || '');
    }
    /*
     * /account/{wallet-address}/transaction_history
     */
    else if (true
      && route.startsWith('/account')
      && request.method   === 'GET'
      && accountPathMatch !== null
      && accountPathMatch[2] === 'transaction_history'
    ) {
      const accountAddress = accountPathMatch[1];
      if (!Eth.parseAddress(accountAddress)) {
        return new Response(
          `Error: Bad account address: ${accountAddress}`,
          { status: 400 }
        );
      }
      return transactionHistoryHandler.getTransactionHistory(
        {
          apiHost: context.env.V3_API_HOST,
          nodeHost: context.env.NODE_PROXY_HOST,
          nodeKey: context.env.NODE_PROXY_KEY,
          accountAddress,
          queryParams: url.searchParams,
        },
        context
      );
    }
    /*
     * /account/{wallet-address}/rewards
     */
    else if (true
      && route.startsWith('/account')
      && request.method === 'GET'
      && accountPathMatch !== null
      && accountPathMatch[2] === 'rewards'
    ) {
      const accountAddress = accountPathMatch[1];
      if (!Eth.parseAddress(accountAddress)) {
        return new Response(
          `Error: Bad account address: ${accountAddress}`,
          { status: 400 }
        );
      }
      const queryTestnets = url.searchParams.get('testnets');
      const testnets = queryTestnets === 'include' ? 'include' : 'exclude';
      return accountHandlers.rewardsSummary(
        {
          apiHost: context.env.V3_API_HOST,
          nodeHost: context.env.NODE_PROXY_HOST,
          nodeKey: context.env.NODE_PROXY_KEY,
          testnets,
          account: accountAddress,
        },
        {
          ...context,
          evaluator: instantiateEvaluator(
            testnets === 'exclude' ? 'mainnet' : 'testnet',
            {
              flags: {
                ...context.flags,
                batchingEnabled: true,
                evaluatorAlgorithm: 'workingset',
              },
            }
          ),
        }
      );
    }
    /*
     * No valid path
     */
    return fallthrough();
  }

  /*
   * Resource path. Attempt to match against a configured handler.
   */
  const [
    resourceApi,
    rawNetworkAlias,
    rawContractSpecifier,
    endpointSuffix,
  ] = pathMatch.slice(1);

  // Remove the trailing slash from the endpoint suffix, e.g. 'summary/' -> 'summary'
  const strippedEndpointSuffix = endpointSuffix.replace(/\/$/, '');
  // Allow shorthand goerli and mainnet for ethereum-goerli and ethereum-mainnet
  const networkAlias = KnownNetwork.canonicalizeAlias(rawNetworkAlias);

  // Validate the passed-in network.
  if (!KnownNetwork.castName(networkAlias) && networkAlias !== AllNetworks) {
    return new Response(`Error: Bad network ${networkAlias}`, { status: 400 });
  }

  let testnet = url.searchParams.get('testnet') ?? 'exclude';
  const networkEnvironment = (
    networkAlias === AllNetworks
      ? testnet === 'exclude' ? 'mainnet' : 'testnet'
      : KnownNetwork.isNameOfTestnet(networkAlias) ? 'testnet' : 'mainnet'
  );

  const contractSpecifier = rawContractSpecifier === 'all' ? AllContracts : rawContractSpecifier;

  // Validate the contract specifier is a known contract address or special keyword
  if (!(false
    || Eth.parseAddress(contractSpecifier)
    || contractSpecifier === AllContracts
    || contractSpecifier === DefaultCompContract
  )) {
    return new Response(`Error: Bad contract address: ${contractSpecifier}`, { status: 400 });
  }

  if (networkAlias === AllNetworks && contractSpecifier !== AllContracts) {
    return new Response(`Error: Cannot specify a contract when querying all networks`, { status: 400 });
  }

  // Maybe resolve to a well known contract.
  const maybeWellKnownContract = (() => {
    // If we specify all networks, we must also be querying all contracts
    if (contractSpecifier === AllContracts || networkAlias === AllNetworks) {
      return AllContracts;
    }
    if (contractSpecifier === DefaultCompContract) {
      return Eth.wellKnownContractsByNetwork[networkAlias]['COMP']['default'];
    }
    return ContractUtils.lookupInWellKnown(
      { network: networkAlias, address: contractSpecifier },
      Eth.wellKnownContractsByNetwork
    );
  })();

  if (Fallible.isFailure(maybeWellKnownContract)) {
    return new Response(`Error: Contract address not known`, { status: 400 });
  }

  if (!isValidResourceAPI(resourceApi)) {
    return new Response(`Error: Not a valid resource API`, { status: 400 });
  }

  if (resourceApi === 'market') {
    if (true
      && maybeWellKnownContract
      && isValidMarketEndpointSuffix(strippedEndpointSuffix)
    ) {
      if (false
        || strippedEndpointSuffix === 'rewards/dapp-data'
        || strippedEndpointSuffix === 'rewards/summary'
        || strippedEndpointSuffix === 'summary'
      ) {
        const handler = handlerMappings[resourceApi][strippedEndpointSuffix];
        return handler(
          {
            apiHost: context.env.V3_API_HOST,
            nodeHost: context.env.NODE_PROXY_HOST,
            nodeKey: context.env.NODE_PROXY_KEY,
            network: networkAlias,
            contract: maybeWellKnownContract,
            queryParams: url.searchParams,
          },
          {
            ...context,
            instantiateEvaluator,
          },
        );
      }
      const handler = handlerMappings[resourceApi][strippedEndpointSuffix];
      return handler(
        {
          apiHost: context.env.V3_API_HOST,
          nodeHost: context.env.NODE_PROXY_HOST,
          nodeKey: context.env.NODE_PROXY_KEY,
          network: networkAlias,
          contract: maybeWellKnownContract,
          queryParams: url.searchParams,
        },
        {
          ...context,
          evaluator: instantiateEvaluator(networkEnvironment),
        }
      );
    }
    return new Response(`Error: Not a valid market API endpoint`, { status: 400 });
  }
  else {
    if (!(networkAlias.startsWith('ethereum'))) {
      return new Response(`Error: Must choose either Ethereum mainnet for governance`, { status: 400 });
    }
    // Resource API is 'governance' (enforced by typing).
    if (isValidGovernanceEndpointSuffix(strippedEndpointSuffix)) {
      const handler = handlerMappings[resourceApi][strippedEndpointSuffix];
      return handler({
        apiHost: context.env.V3_API_HOST,
        nodeHost: context.env.NODE_PROXY_HOST,
        nodeKey: context.env.NODE_PROXY_KEY,
        network: networkAlias as Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>,
        contract: maybeWellKnownContract,
        queryParams: url.searchParams,
      }, {
        ...context,
        evaluator: instantiateEvaluator(networkEnvironment),
      });
    }
    return new Response(`Error: Not a valid governance API endpoint`, { status: 400 });
  }
}

async function fallthrough() {
  return new Response('hello, what are you looking for?', { status: 404 });
}

function isValidResourceAPI(apiRoute: string): apiRoute is ResourceAPI {
  return Object.keys(handlerMappings).includes(apiRoute);
}

function isValidMarketEndpointSuffix(endpointSuffix: string): endpointSuffix is ResourceEndpoint<'market'> {
  return Object.keys(handlerMappings['market']).includes(endpointSuffix);
}

function isValidGovernanceEndpointSuffix(endpointSuffix: string): endpointSuffix is ResourceEndpoint<'governance'> {
  return Object.keys(handlerMappings['governance']).includes(endpointSuffix);
}

export {
  route,
  AllContracts,
  AllNetworks,
  DefaultCompContract,
};

export type {
  Context,
  UninstantiatedContext,
  // route data types
  V2RouteData,
  MarketRouteData,
  AccountRouteData,
  GovernanceRouteData,
  TransactionHistoryRouteData,
};
