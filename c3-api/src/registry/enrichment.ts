import { Interface, Result } from '@ethersproject/abi';

import * as Eth      from '../../lib/eth-constants.js';
import * as Fallible from '../../lib/fallible/fallible.js';
import * as jsonRpc  from '../../lib/json-rpc.js';

import type * as KnownNetwork from '../../lib/well-known/networks/network.js';

import {
  Address,
  CONTRACT_ROLES,
  ContractRole,
  ParsedRoot,
  PriceFeedV1,
  TokenV1,
  isAddress,
  normalizeAddress,
} from '../../lib/model/comet-registry.js';

import { RegistryError } from './errors.js';

/*
 * Reads the on-chain facts a registry candidate cannot take from the pinned
 * source: what a Comet says its base asset, price feeds, collateral assets,
 * and reward token are, and the ERC-20 and feed metadata behind them.
 *
 * Reads go through the same node provider proxy as route traffic, batched and
 * bounded. Nothing here decides policy: display names, capabilities, quotes,
 * and reviewed feeds come from the overlay. What the chain cannot confirm
 * fails the market's import here, before anything about it is written.
 */
type ChainEndpoint = {
  apiHost:  string,
  nodeHost: string,
  nodeKey:  string,
  network:  KnownNetwork.Name,
  /*
   * The fetch to reach the node provider with. It is passed in rather than
   * taken from the module-global counting fetch, whose configuration is
   * shared with the request handler and would be reset underneath a
   * long-running import.
   */
  fetch:    (input: Request) => Promise<Response>,
  // how long one batch may take, its answer included; REQUEST_TIMEOUT_MS unless a test needs less
  timeoutMs?: number,
};

/*
 * One batch of JSON-RPC calls, answered in request order. The sync service
 * passes the proxy transport; tests pass their own.
 */
type RpcTransport = (calls: jsonRpc.Call[]) => Promise<Array<{ result?: unknown, error?: unknown }>>;

type MarketEnrichment = {
  baseToken:        TokenV1,
  basePriceFeed:    PriceFeedV1,
  rewardToken:      TokenV1 | null,
  collateralAssets: Array<{ assetIndex: number, token: TokenV1, priceFeed: PriceFeedV1 }>,
};

// a market as enrichMarket read it, with the decimals of every feed it read on the way
type EnrichedMarket = MarketEnrichment & {
  feeds: Map<Address, PriceFeedV1>,
};

// one collateral asset as getAssetInfo answers for it
type CollateralInfo = {
  assetIndex: number,
  token:      Address,
  priceFeed:  Address,
};

// what a Comet answers now about the facts an import keeps from it
type CometFacts = {
  basePriceFeed:    Address,
  collateralAssets: CollateralInfo[],
};

// a Comet holds at most 15 collateral assets today; the bound rejects a
// nonsensical numAssets rather than issuing thousands of calls
const MAX_COLLATERAL_ASSETS = 32;
const MAX_CALLS_PER_BATCH   = 100;

/*
 * How long one batch may take through the node provider proxy, from asking
 * to the last byte of the answer. A provider answers a batch in a second or
 * two, and the proxy may try a second one after the first fails; a batch
 * still open after this long is not going to be answered, and without a
 * deadline it would hold the import's run, and every sync that wants it, for
 * as long as the connection stayed open.
 */
const REQUEST_TIMEOUT_MS = 30_000;

const COMET = new Interface([
  'function baseToken() view returns (address)',
  'function baseTokenPriceFeed() view returns (address)',
  'function numAssets() view returns (uint8)',
  `function getAssetInfo(uint8) view returns (tuple(
    uint8 offset,
    address asset,
    address priceFeed,
    uint64 scale,
    uint64 borrowCollateralFactor,
    uint64 liquidateCollateralFactor,
    uint64 liquidationFactor,
    uint128 supplyCap
  ))`,
]);

const REWARDS = new Interface([
  'function rewardConfig(address) view returns (address token, uint64 rescaleFactor, bool shouldUpscale)',
]);

const ERC20 = new Interface([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);

const ERC20_BYTES32 = new Interface([
  'function symbol() view returns (bytes32)',
  'function name() view returns (bytes32)',
]);

const PRICE_FEED = new Interface([
  'function decimals() view returns (uint8)',
]);

function call(to: Address, data: string): jsonRpc.Call {
  return { method: 'eth_call', params: [ { to, data }, 'latest' ] };
}

/*
 * Sends one batch of calls through the node provider proxy, the same path
 * route traffic takes.
 *
 * The deadline rides on the request, so it ends the answer's body as well as
 * the wait for its headers. A batch that outlived it is a node provider that
 * did not answer, like any other, and its message names the deadline; what
 * the deadline cut short is the cause, for the logs.
 */
function proxyTransport(endpoint: ChainEndpoint): RpcTransport {
  return async calls => {
    const timeout   = endpoint.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const deadline  = AbortSignal.timeout(timeout);
    const responses = await jsonRpc.postBatch({
      calls,
      endpoint: Eth.nodeEndpoint(endpoint.nodeHost, endpoint.nodeKey, endpoint.network),
      headers:  { origin: endpoint.apiHost },
      fetch:    (request: Request) => endpoint.fetch(new Request(request, { signal: deadline })),
    }).catch((error: unknown) => {
      if (!deadline.aborted) {
        throw error;
      }
      throw new RegistryError(
        'CHAIN_REQUEST_FAILED',
        `the node provider did not answer within ${timeout / 1000} seconds`,
        endpoint.network,
        { cause: error },
      );
    });
    if (Fallible.isFailure(responses)) {
      throw new RegistryError('CHAIN_REQUEST_FAILED', `the node provider did not answer`, endpoint.network, {
        cause: Fallible.unwrap(responses),
      });
    }
    return responses as Array<{ result?: unknown, error?: unknown }>;
  };
}

// what a call asked of which contract, as a failure names it
function describe(call: jsonRpc.Call): string {
  if (call.method === 'eth_call') {
    return `a read of ${(call.params[0] as { to: string }).to}`;
  }
  if (call.method === 'eth_getCode') {
    return `the code of ${call.params[0] as string}`;
  }
  return call.method;
}

function isRpcError(error: unknown): error is jsonRpc.Error {
  return typeof(error) === 'object' && error !== null
    && typeof((error as jsonRpc.Error).code) === 'number'
    && typeof((error as jsonRpc.Error).message) === 'string';
}

type Answer = { call: jsonRpc.Call, response: { result?: unknown, error?: unknown } };

/*
 * Sends one batch of at most MAX_CALLS_PER_BATCH calls and returns every
 * answer beside the call it answers, in order. Only a batch that was not
 * answered fails here; what each answer says is resultOf's to judge, so a
 * caller can judge some answers before others.
 */
async function answersOf(transport: RpcTransport, calls: jsonRpc.Call[], scope: string): Promise<Answer[]> {
  let responses: Array<{ result?: unknown, error?: unknown }>;
  try {
    responses = await transport(calls);
  } catch (error) {
    if (error instanceof RegistryError) {
      throw error;
    }
    /*
     * What failed underneath is the cause, for the logs: json-rpc names the
     * status the proxy answered and its URL as far as the network.
     */
    throw new RegistryError('CHAIN_REQUEST_FAILED', `a node provider request failed`, scope, { cause: error });
  }
  if (responses.length !== calls.length) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `the node provider answered ${responses.length} of ${calls.length} calls`, scope);
  }
  return responses.map((response, position) => ({ call: calls[position]!, response }));
}

/*
 * The raw result of one answer. A call that reverts or answers with anything
 * but hex data fails the import: a market the registry cannot read is not a
 * market it can serve.
 *
 * A revert is the contract's answer, the same from every provider, and says
 * something about what was read. Any other error a node answers with — a
 * rate limit, a block it does not have, its own failure — is the node not
 * serving the call, which is a provider that did not answer: calling it a
 * revert would turn a provider's bad minute into the reader's mistake.
 */
function resultOf({ call, response }: Answer, scope: string): string {
  const asked = describe(call);
  if (response.error !== undefined && response.error !== null) {
    if (isRpcError(response.error) && jsonRpc.isExecutionReverted(response.error)) {
      throw new RegistryError('CHAIN_CALL_REVERTED', `${asked} reverted`, scope);
    }
    throw new RegistryError('CHAIN_REQUEST_FAILED', `the node provider did not serve ${asked}`, scope, {
      cause: response.error,
    });
  }
  if (typeof(response.result) !== 'string' || !response.result.startsWith('0x')) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `${asked} returned no data`, scope);
  }
  return response.result;
}

async function callAll(transport: RpcTransport, calls: jsonRpc.Call[], scope: string): Promise<string[]> {
  const results: string[] = [];
  for (let index = 0; index < calls.length; index += MAX_CALLS_PER_BATCH) {
    const answers = await answersOf(transport, calls.slice(index, index + MAX_CALLS_PER_BATCH), scope);
    results.push(...answers.map(answer => resultOf(answer, scope)));
  }
  return results;
}

/*
 * The result of one call, decoded, or a failure that names the contract.
 *
 * An address without code answers a call with no data rather than an error,
 * and the decoder then throws an exception that says nothing about which
 * address it was. Both are the chain's answer about that address — most
 * often a contract of another chain — and are reported as such.
 */
function decoded(abi: Interface, method: string, data: string, address: string, scope: string): Result {
  if (data === '0x') {
    throw new RegistryError(
      'CHAIN_RESPONSE_INVALID',
      `${address} answered ${method}() with no data: there is no such contract at that address on this chain`,
      scope,
    );
  }
  try {
    return abi.decodeFunctionResult(method, data);
  } catch (error) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `${address} answered ${method}() with data that does not decode`, scope, {
      cause: error,
    });
  }
}

function decodeAddress(method: 'baseToken' | 'baseTokenPriceFeed', data: string, address: Address, scope: string): Address {
  const [ value ] = decoded(COMET, method, data, address, scope);
  if (!isAddress(value)) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `${address} answered ${method}() with no address`, scope);
  }
  return normalizeAddress(value);
}

// a uint8 such as decimals() or numAssets(), which both decode the same way
function decodeUint8(abi: Interface, method: string, data: string, address: Address, scope: string): number {
  const [ value ] = decoded(abi, method, data, address, scope);
  const number    = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 255) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `${address} answered ${method}() outside 0 to 255`, scope);
  }
  return number;
}

function decodeNumAssets(data: string, comet: Address, scope: string): number {
  const numAssets = decodeUint8(COMET, 'numAssets', data, comet, scope);
  if (numAssets > MAX_COLLATERAL_ASSETS) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `${comet} reports ${numAssets} collateral assets`, scope);
  }
  return numAssets;
}

function decodeAssetInfo(data: string, assetIndex: number, comet: Address, scope: string): CollateralInfo {
  const [ info ] = decoded(COMET, 'getAssetInfo', data, comet, scope);
  if (!isAddress(info.asset) || !isAddress(info.priceFeed)) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `asset ${assetIndex} has a malformed address`, scope);
  }
  return {
    assetIndex,
    token:     normalizeAddress(info.asset),
    priceFeed: normalizeAddress(info.priceFeed),
  };
}

function assetInfoCalls(comet: Address, numAssets: number): jsonRpc.Call[] {
  return [ ...Array(numAssets).keys() ].map(index => call(comet, COMET.encodeFunctionData('getAssetInfo', [ index ])));
}

/*
 * ERC-20 metadata predates the string return type, so a token such as MKR
 * answers with a padded bytes32 instead. Both spellings are accepted.
 */
function decodeText(method: 'symbol' | 'name', data: string, address: Address, scope: string): string {
  let text: string;
  try {
    [ text ] = ERC20.decodeFunctionResult(method, data);
  } catch {
    const [ bytes ] = decoded(ERC20_BYTES32, method, data, address, scope);
    text = new TextDecoder().decode(
      Uint8Array.from((bytes as string).slice(2).match(/../g) ?? [], byte => parseInt(byte, 16))
    ).replace(/\0+$/, '');
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `${address} answered an empty ${method}()`, scope);
  }
  return trimmed;
}

async function readTokensAndFeeds(
  transport: RpcTransport,
  tokenAddresses: Address[],
  feedAddresses: Address[],
  scope: string,
): Promise<{ tokens: Map<Address, TokenV1>, feeds: Map<Address, PriceFeedV1> }> {
  const results = await callAll(transport, [
    ...tokenAddresses.flatMap(address => [
      call(address, ERC20.encodeFunctionData('symbol')),
      call(address, ERC20.encodeFunctionData('name')),
      call(address, ERC20.encodeFunctionData('decimals')),
    ]),
    ...feedAddresses.map(address => call(address, PRICE_FEED.encodeFunctionData('decimals'))),
  ], scope);

  const tokens = new Map<Address, TokenV1>();
  tokenAddresses.forEach((address, index) => {
    const [ symbol, name, decimals ] = results.slice(index * 3, index * 3 + 3) as [ string, string, string ];
    tokens.set(address, {
      address,
      symbol:   decodeText('symbol', symbol, address, scope),
      name:     decodeText('name', name, address, scope),
      decimals: decodeUint8(ERC20, 'decimals', decimals, address, scope),
    });
  });
  const feedResults = results.slice(tokenAddresses.length * 3);
  const feeds = new Map<Address, PriceFeedV1>();
  feedAddresses.forEach((address, index) => {
    feeds.set(address, { address, decimals: decodeUint8(PRICE_FEED, 'decimals', feedResults[index]!, address, scope) });
  });
  return { tokens, feeds };
}

// what an overlay write reads of the chain
async function readFeeds(
  transport: RpcTransport,
  addresses: Address[],
  scope: string,
): Promise<Map<Address, PriceFeedV1>> {
  return (await readTokensAndFeeds(transport, [], addresses, scope)).feeds;
}

// a block number as JSON-RPC writes it
function quantity(block: number): string {
  return `0x${block.toString(16)}`;
}

/*
 * Whether the creation block an overlay states for each market of one
 * network is the block its Comet was deployed in: the Comet has code at that
 * block and none at the block before it. A block past the latest one is no
 * block yet, and is not asked about. Every block is above 0: one of 0 is the
 * market not stating any.
 *
 * It answers what is wrong, naming each market by `scope` as the document
 * names it, and nothing when every block is right. It reads the latest
 * block, then the code of every Comet at both blocks, in batches of
 * MAX_CALLS_PER_BATCH calls: two round trips for up to fifty markets. A node
 * provider that does not answer fails the read, as it fails readFeeds: the
 * chain has then said nothing about any block.
 */
async function readCreationBlocks(
  transport: RpcTransport,
  markets: Array<{ scope: string, comet: Address, block: number }>,
  network: string,
): Promise<string[]> {
  if (markets.length === 0) {
    return [];
  }
  const [ answer ] = await answersOf(transport, [ { method: 'eth_blockNumber', params: [] } ], network);
  const result = resultOf(answer!, network);
  const head   = /^0x[0-9a-f]+$/i.test(result) ? Number.parseInt(result, 16) : Number.NaN;
  if (!Number.isSafeInteger(head)) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `eth_blockNumber returned no block number`, network);
  }

  const reached = markets.filter(market => market.block <= head);
  const codes   = await callAll(transport, reached.flatMap(({ comet, block }): jsonRpc.Call[] => [
    { method: 'eth_getCode', params: [ comet, quantity(block) ] },
    { method: 'eth_getCode', params: [ comet, quantity(block - 1) ] },
  ]), network);
  const codeOf  = new Map(reached.map((market, index) => [ market, { at: codes[index * 2]!, before: codes[index * 2 + 1]! } ]));

  return markets.flatMap(market => {
    const { scope, comet, block } = market;
    const code = codeOf.get(market);
    if (code === undefined) {
      return [ `${scope}.creationBlock ${block} is past the latest block, ${head}` ];
    }
    if (code.at === '0x') {
      return [ `${scope}.creationBlock ${block} is before the Comet ${comet} was deployed: it has no code at that block` ];
    }
    if (code.before !== '0x') {
      return [ `${scope}.creationBlock ${block} is after the Comet ${comet} was deployed: it has code at block ${block - 1}` ];
    }
    return [];
  });
}

/*
 * Reads one market. The Comet itself is authoritative for base asset, feeds,
 * and collateral assets; the rewards contract names the reward token.
 *
 * It takes three round trips to the node provider, each one batch, and each
 * waiting only on what the one before answered: the code of every declared
 * contract with the Comet's base fields and the reward token its rewards
 * contract names; the collateral assets, whose count the first answered; and
 * the metadata of every token with the decimals of every feed — those `feeds`
 * adds among them, which the reviewed overlay names.
 *
 * The chain id is not asked. The node provider proxy answers eth_chainId from
 * its own table rather than from the chain, so the answer would say how the
 * proxy maps a network, not what its endpoint serves. An endpoint routed to
 * another chain shows instead as no code at the addresses the source
 * declares, and fails the import as a missing contract.
 */
async function enrichMarket(transport: RpcTransport, root: ParsedRoot, feeds: Address[] = []): Promise<EnrichedMarket> {
  const scope = root.rootPath;
  const comet = root.contracts.comet!;

  const declared = CONTRACT_ROLES
    .map(role => ({ role, address: root.contracts[role] }))
    .filter((entry): entry is { role: ContractRole, address: Address } => entry.address !== undefined);
  const rewardsContract = root.contracts.rewards;
  const first = await answersOf(transport, [
    ...declared.map(({ address }): jsonRpc.Call => ({ method: 'eth_getCode', params: [ address, 'latest' ] })),
    call(comet, COMET.encodeFunctionData('baseToken')),
    call(comet, COMET.encodeFunctionData('baseTokenPriceFeed')),
    call(comet, COMET.encodeFunctionData('numAssets')),
    ...(rewardsContract === undefined ? [] : [ call(rewardsContract, REWARDS.encodeFunctionData('rewardConfig', [ comet ])) ]),
  ], scope);

  /*
   * A market the registry cannot fully read is not a market it can serve, so
   * a declared contract without bytecode — any role, not only the Comet —
   * fails the import rather than silently dropping the role. The code is
   * judged before the reads beside it, which an address without code answers
   * with nothing at all.
   */
  const codes   = first.slice(0, declared.length).map(answer => resultOf(answer, scope));
  const missing = declared.filter((_, index) => codes[index] === '0x');
  if (missing.length > 0) {
    throw new RegistryError(
      'CHAIN_CONTRACT_MISSING',
      `no bytecode on chain ${root.chainId} at ${missing.map(({ role, address }) => `${role} ${address}`).join(', ')}`,
      scope,
    );
  }

  const [ baseTokenData, basePriceFeedData, numAssetsData, configData ] = first
    .slice(declared.length)
    .map(answer => resultOf(answer, scope)) as [ string, string, string, string | undefined ];

  const baseTokenAddress = decodeAddress('baseToken', baseTokenData, comet, scope);
  const basePriceFeed    = decodeAddress('baseTokenPriceFeed', basePriceFeedData, comet, scope);
  const numAssets        = decodeNumAssets(numAssetsData, comet, scope);

  let rewardTokenAddress: Address | null = null;
  if (rewardsContract !== undefined && configData !== undefined) {
    const config = decoded(REWARDS, 'rewardConfig', configData, rewardsContract, scope);
    const token  = config.token;
    // a market with no configured reward token answers with the zero address
    if (isAddress(token) && normalizeAddress(token) !== Eth.NullAddress.toLowerCase()) {
      rewardTokenAddress = normalizeAddress(token);
    }
  }

  const assetData  = await callAll(transport, assetInfoCalls(comet, numAssets), scope);
  const collateral = assetData.map((data, assetIndex) => decodeAssetInfo(data, assetIndex, comet, scope));

  const tokenAddresses = [ ...new Set<Address>([
    baseTokenAddress,
    ...collateral.map(asset => asset.token),
    ...(rewardTokenAddress === null ? [] : [ rewardTokenAddress ]),
  ]) ];
  const feedAddresses = [ ...new Set<Address>([
    basePriceFeed,
    ...collateral.map(asset => asset.priceFeed),
    ...feeds,
  ]) ];
  const read = await readTokensAndFeeds(transport, tokenAddresses, feedAddresses, scope);

  return {
    baseToken:     read.tokens.get(baseTokenAddress)!,
    basePriceFeed: read.feeds.get(basePriceFeed)!,
    rewardToken:   rewardTokenAddress === null ? null : read.tokens.get(rewardTokenAddress)!,
    collateralAssets: collateral.map(asset => ({
      assetIndex: asset.assetIndex,
      token:      read.tokens.get(asset.token)!,
      priceFeed:  read.feeds.get(asset.priceFeed)!,
    })),
    feeds: read.feeds,
  };
}

/*
 * What the Comets of one network answer now about the facts an import keeps
 * from them: the feed of each one's base asset, and each collateral asset
 * with the feed that prices it, in the order getAssetInfo reports them. The
 * drift check reads them to hold a version against the chain (drift.ts).
 *
 * The Comets are read together, in two round trips however many there are:
 * the base feed and the collateral count of every one, then every collateral
 * asset of every one. Anything that does not answer, or answers with what
 * does not decode, fails the whole read: the chain has then said nothing
 * about any of them.
 */
async function readCometFacts(transport: RpcTransport, comets: Address[], scope: string): Promise<Map<Address, CometFacts>> {
  const first = await callAll(transport, comets.flatMap(comet => [
    call(comet, COMET.encodeFunctionData('baseTokenPriceFeed')),
    call(comet, COMET.encodeFunctionData('numAssets')),
  ]), scope);
  const counts = comets.map((comet, index) => decodeNumAssets(first[index * 2 + 1]!, comet, scope));
  const assets = await callAll(transport, comets.flatMap((comet, index) => assetInfoCalls(comet, counts[index]!)), scope);

  const facts = new Map<Address, CometFacts>();
  let read = 0;
  comets.forEach((comet, index) => {
    const own = assets.slice(read, read + counts[index]!);
    read += own.length;
    facts.set(comet, {
      basePriceFeed:    decodeAddress('baseTokenPriceFeed', first[index * 2]!, comet, scope),
      collateralAssets: own.map((data, assetIndex) => decodeAssetInfo(data, assetIndex, comet, scope)),
    });
  });
  return facts;
}

export type { ChainEndpoint, CollateralInfo, CometFacts, EnrichedMarket, MarketEnrichment, RpcTransport };

export {
  MAX_CALLS_PER_BATCH,
  enrichMarket,
  proxyTransport,
  readCometFacts,
  readCreationBlocks,
  readFeeds,
};
