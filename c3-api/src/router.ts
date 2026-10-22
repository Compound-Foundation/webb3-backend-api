import * as Eth      from '../lib/eth-constants.js';
import * as Fallible from '../lib/fallible/fallible.js';
import * as jsonRpc  from '../lib/json-rpc.js';
import { ROUTE_EVALUATOR_FLAGS } from '../lib/flags.js';

import * as KnownNetwork  from '../lib/well-known/networks/network.js';
import * as ContractUtils from '../lib/well-known/contracts/utils.js';

import * as v2Handlers                from './v2-handlers/handlers.js';
import * as marketHandlers            from './market.js';
import * as accountHandlers           from './account-handlers/handlers.js';
import * as governanceHandlers        from './governance-handlers/handlers.js';
import * as transactionHistoryHandler from './transaction-history-handler/transaction-history-items-handler.js';

import type { Contract } from '../lib/well-known/contracts/types.js';
import type { RegistryComet } from '../lib/model/comet-registry.js';

import { ApiError, failureResponse, isApiError, nodeUnavailable } from './http/errors.js';
import { refuseTestnet, refuseTestnetsParameter } from './testnets.js';
import type { Catalog } from './registry/catalog.js';
import {
  RequestCatalog,
  catalogHeadersOf,
  isRegistryUnavailable,
  requestCatalog,
  unavailableError,
} from './registry/request-catalog.js';

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
  // the id the entrypoint gave the request, which its error answer and the log line about it carry
  requestId?: string;
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
  // a market the version materialized, or every market it serves
  contract: RegistryComet | typeof AllContracts;
  queryParams: URL['searchParams'];
  // the one registry version that answers this request
  catalog: Catalog;
}

interface GovernanceRouteData {
  apiHost: string;
  nodeHost: string;
  nodeKey: string;
  network: Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>;
  contract: Contract | typeof AllContracts;
  queryParams: URL['searchParams'];
  /*
   * The registry, not loaded. Governance resolves its own contracts
   * statically, and names markets from the registry alone: the proposal
   * list, and the vote receipts with their proposals, describe the actions
   * of the page they answer again with its markets, so only a page with no
   * action never reads D1.
   */
  registry: RequestCatalog;
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
  /*
   * The registry, not loaded: the handler refuses a testnet market before
   * it reads the registry, as the market routes refuse a testnet.
   */
  registry: RequestCatalog;
}

interface AccountRouteData {
  apiHost: string;
  nodeHost: string;
  nodeKey: string;
  account: Eth.Address;
  catalog: Catalog;
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

/*
 * The legacy routes: every path but the registry's, which the entrypoint
 * hands to the registry router instead (src/registry/router.ts).
 */
async function route(
  request: Request,
  context: Omit<Context, 'evaluator'>,
  instantiateEvaluator: Evaluator.InstantiateFn<Scope>,
): Promise<Response> {
  /*
   * The registry version of this request. It is loaded at most once, by the
   * first handler that needs it, and every response whose content depended on
   * it says which version answered.
   */
  const registry  = requestCatalog(context.env, context.debug);
  // a caller that made no id, such as a test calling the router directly, gets one here
  const requestId = context.requestId ?? crypto.randomUUID();
  const answer = async (): Promise<Response> => {
    try {
      return await unsafeRoute(request, { ...context, requestId }, instantiateEvaluator, registry);
    } catch (e: unknown) {
      context.debug.clearDanglingGroups();
      /*
       * A failure is answered in the envelope every route answers with, under
       * this request's id. What a handler raised to say something — a market
       * without rewards, a cursor of another version — says it; a route that
       * needs the registry cannot be answered from anywhere else, since after
       * the cutover there is no static market list to fall back to, so it
       * fails with 503 while the rest of the API keeps working. So does a
       * node provider that did not serve the request, which a client may ask
       * again; a call the contract reverted is its answer, not the node's
       * failure. Anything else is a 500 that tells the client nothing but the
       * id, while the log gets the whole of it.
       */
      const said = isApiError(e) ? e
        : isRegistryUnavailable(e) ? unavailableError(e)
        : jsonRpc.isNotServed(e) ? nodeUnavailable(e)
        : null;
      return failureResponse(said, e, {
        requestId,
        pathname: new URL(request.url).pathname,
        debug:    context.debug,
        label:    'route',
      });
    }
  };

  // whatever the outcome, a response that was computed against a version says which one
  const response = await answer();
  for (const [ name, value ] of Object.entries(catalogHeadersOf(registry))) {
    response.headers.set(name, value);
  }
  return response;
}

async function unsafeRoute(
  request: Request,
  // by now with the request's id: the entrypoint's, or one route() made
  context: Omit<Context, 'evaluator'> & { requestId: string },
  instantiateEvaluator: Evaluator.InstantiateFn<Scope>,
  registry: RequestCatalog,
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
          registry,
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
      // testnets are not served: asking for them is refused, not answered without them
      refuseTestnetsParameter(url.searchParams);
      return accountHandlers.rewardsSummary(
        {
          apiHost: context.env.V3_API_HOST,
          nodeHost: context.env.NODE_PROXY_HOST,
          nodeKey: context.env.NODE_PROXY_KEY,
          account: accountAddress,
          catalog: await registry.load(),
        },
        {
          ...context,
          evaluator: instantiateEvaluator(
            'mainnet',
            {
              flags: {
                ...context.flags,
                ...ROUTE_EVALUATOR_FLAGS,
              },
            }
          ),
        }
      );
    }
    /*
     * No valid path: answered in the envelope, as every other failure is
     */
    throw new ApiError('NOT_FOUND', `no route matches ${url.pathname}`);
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

  /*
   * Which storage the evaluation reads and writes: testnet data is kept apart
   * from mainnet data. No market route reaches a testnet — one that names a
   * testnet, or asks for every network with them, is refused below — so only
   * a governance route evaluates in the testnet storage, for the testnet it
   * names, and no query string moves a request off the cache every other
   * request fills.
   */
  const networkEnvironment = (
    networkAlias !== AllNetworks && KnownNetwork.isNameOfTestnet(networkAlias) ? 'testnet' : 'mainnet'
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

  if (!isValidResourceAPI(resourceApi)) {
    return new Response(`Error: Not a valid resource API`, { status: 400 });
  }

  /*
   * A market path that names no market endpoint is the client's mistake
   * whatever the registry holds, so it is answered before the registry is
   * read: a mistyped suffix is a 400 even while the registry is unavailable.
   * Testnets are not served (testnets.ts): a market route that names one, or
   * asks for every network with them, is refused before the registry is
   * read, which has none to answer with.
   *
   * A market address is resolved through the registry, and a governance one
   * through the static constants.
   *
   * The two resolve differently because they answer different questions: a
   * market is whatever the activated version says is a market, while the
   * governors, COMP, and the V2 contracts are part of the protocol this API
   * is built against and do not change with an import. So a market route is
   * handed a Comet the version materialized, and never a contract of the
   * constants.
   */
  if (resourceApi === 'market') {
    if (!isValidMarketEndpointSuffix(strippedEndpointSuffix)) {
      return new Response(`Error: Not a valid market API endpoint`, { status: 400 });
    }
    if (networkAlias === AllNetworks) {
      refuseTestnetsParameter(url.searchParams);
    } else {
      refuseTestnet(networkAlias);
    }

    const catalog  = await registry.load();
    // If we specify all networks, we must also be querying all contracts
    const contract = contractSpecifier === AllContracts || networkAlias === AllNetworks
      ? AllContracts
      : catalog.marketAt(networkAlias, contractSpecifier as Eth.Address)?.comet ?? null;
    if (contract === null) {
      return new Response(`Error: Contract address not known`, { status: 400 });
    }
    const data: MarketRouteData = {
      apiHost: context.env.V3_API_HOST,
      nodeHost: context.env.NODE_PROXY_HOST,
      nodeKey: context.env.NODE_PROXY_KEY,
      network: networkAlias,
      contract,
      queryParams: url.searchParams,
      catalog,
    };
    /*
     * One evaluator for whichever market route answers: in the mainnet
     * storage, as no market route reaches a testnet, and with
     * ROUTE_EVALUATOR_FLAGS, whatever the environment sets.
     */
    const evaluator = instantiateEvaluator('mainnet', { flags: { ...context.flags, ...ROUTE_EVALUATOR_FLAGS } });
    const handler   = handlerMappings[resourceApi][strippedEndpointSuffix];
    return handler(data, { ...context, evaluator });
  }

  const maybeWellKnownContract = (() => {
    // If we specify all networks, we must also be querying all contracts
    if (contractSpecifier === AllContracts || networkAlias === AllNetworks) {
      return AllContracts;
    }
    if (contractSpecifier === DefaultCompContract) {
      return (Eth.wellKnownContractsByNetwork[networkAlias] as any)['COMP']['default'];
    }
    return ContractUtils.lookupInWellKnown(
      { network: networkAlias, address: contractSpecifier },
      Eth.wellKnownContractsByNetwork
    );
  })();

  if (Fallible.isFailure(maybeWellKnownContract)) {
    return new Response(`Error: Contract address not known`, { status: 400 });
  }

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
      registry,
    }, {
      ...context,
      evaluator: instantiateEvaluator(networkEnvironment),
    });
  }
  return new Response(`Error: Not a valid governance API endpoint`, { status: 400 });
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
  // route data types
  V2RouteData,
  MarketRouteData,
  AccountRouteData,
  GovernanceRouteData,
  TransactionHistoryRouteData,
};
