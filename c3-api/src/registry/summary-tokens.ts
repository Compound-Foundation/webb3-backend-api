import type * as KnownNetwork from '../../lib/well-known/networks/network.js';
import { throttleBy } from '../../lib/throttle.js';

import { ASSET_ROLES, checksumAddress, normalizeAddress } from '../../lib/model/comet-registry.js';
import type {
  Address,
  AssetRole,
  BlockRefV1,
  CollateralValueStatusV1,
  PriceExceptionV1,
  RegistryAnnotation,
  TokenV1,
  VisibilityReasonV1,
} from '../../lib/model/comet-registry.js';
import { exceptionFor } from '../../lib/computations/comet/asset-price.js';
import { valueStatusOf, type CollateralValue, type MarketLatestSummary } from '../../lib/computations/market/market-latest-summary.js';
import type { CollateralStatus, MarketIdentity } from '../../lib/computations/market/market-summary.js';

import type { CacheDeps } from './cache.js';
import type { Catalog, CatalogMarket, RegistryComet } from './catalog.js';
import { nowOf } from './clock.js';
import type { CollateralOfComet } from './collateral-decision-repository.js';
import { DEPRECATED_RECORD, HIDDEN_RECORD } from './collateral-decisions.js';
import { decisionSetOf, markedDecisions } from './decision-records.js';
import type { DecisionRead } from './decision-records.js';
import { readStrategicTokensByChain } from './token-policy-repository.js';
import { visibilityHere } from './token-visibility.js';
import { staleHeaders } from './version-headers.js';

/*
 * What /summary says of each collateral beside what it read of the market,
 * written flat on the collateral: what holds of its token on the chain, the
 * collateral's own value in this market, and whether discovery shows the
 * token here. A field about the token across its chain says `network` in its
 * name, since on a market it would read as the market's own; the value is
 * the collateral's in this market, and says `collateral`. `is_visible` is
 * whether discovery shows the token, not whether this market offers it, and
 * is the market's own: the rule asked with whether this market's Comet hides
 * the token and whether it has it deprecated, the chain's strategic mark, and
 * that value (token-visibility.ts, visibilityHere).
 *
 * The values are what the summary read of the market, at the market's own
 * block, which the market answers once, beside them (withTokenFields): both
 * are read with the market (marketLatestSummary) and cached with its summary
 * of the minute (marketMinutelySummary), a header the node did not give
 * included. The decisions are read with every request, and the fields added
 * once the computations have answered, as the labels of a market are
 * (market.ts, described), so no cache key holds a decision.
 */

// every chain's strategic tokens, by chain id
type StrategicTokens = ReadonlyMap<number, ReadonlySet<Address>>;

// the decisions of administrators, every chain's, or null where they could not be read
type SummaryDecisions = {
  deprecated: DecisionRead<CollateralOfComet> | null,
  hidden:     DecisionRead<CollateralOfComet> | null,
  strategic:  StrategicTokens | null,
};

/*
 * When this isolate says it could not read a kind of decision, per database
 * binding: once a minute, as the cache says it answers from an older version,
 * rather than once a request, since the summary is still answered on every
 * request of an outage.
 */
const unreadDue = throttleBy<D1Database>(60_000);

/*
 * The decisions, every kind read at once. No read fails the summary: on the
 * legacy router a database fault would be a 500 of every market's summary. A
 * read that failed leaves out the fields it decides on every request, and is
 * logged under the id of the request that found it (unreadDue). The
 * deprecated and the hidden decisions are read as /registry/v1/active reads
 * them, and come from the records the worker keeps while D1 cannot be
 * reached; the strategic ones have no such record.
 */
async function summaryDecisions(deps: CacheDeps, requestId: string): Promise<SummaryDecisions> {
  const unread = (decisions: string) => (error: unknown) => {
    if (unreadDue(deps.db, decisions, nowOf(deps.now).getTime())) {
      deps.debug.error(`the summary could not read the ${decisions}`, { requestId, error });
    }
    return null;
  };
  const [ deprecated, hidden, strategic ] = await Promise.all([
    markedDecisions(DEPRECATED_RECORD, deps).catch(unread('deprecated collateral decisions')),
    markedDecisions(HIDDEN_RECORD, deps).catch(unread('hidden collateral decisions')),
    readStrategicTokensByChain(deps.db).catch(unread('token policies')),
  ]);
  return { deprecated, hidden, strategic };
}

/*
 * Collaterals marked by the deprecated or the hidden decisions the worker
 * last recorded, because D1 could not give them, are not confirmed, and the
 * answer says so as /registry/v1/active does; the legacy router sets the
 * version's own age over it where the version came from the cache too.
 */
function summaryHeaders({ deprecated, hidden }: SummaryDecisions): Record<string, string> {
  return staleHeaders(deprecated?.recorded || hidden?.recorded ? 0 : null);
}

// what /summary says of a token across its chain but its strategic mark, which collateralFields looks up beside what the collateral's own market decides
type ChainFacts = {
  roles:        AssetRole[],
  isDeprecated: boolean,
  deprecatedIn: Address[],
  hiddenIn:     Address[],
};

/*
 * What holds of a token across a chain is found the first time a collateral
 * of a market the summary answers asks, and kept for the rest of the request:
 * a base or a reward token, which no collateral asks about, and a market the
 * chain has not reached, which answers no collateral, cost nothing.
 */
type ChainTokens = {
  chainId:   number,
  decisions: SummaryDecisions,
  factsOf:   (token: Address) => ChainFacts,
};

// a kind of decision as the facts of a chain ask it (decision-records.ts): whether it names a collateral, its addresses lowercase
type Decisions = { has: (collateral: { chainId: number, cometAddress: Address, tokenAddress: Address }) => boolean };

/*
 * The roles a token plays in the markets a chain serves, in the order
 * ASSET_ROLES gives them. A deprecated market is still served, so the token
 * plays its roles there too; a disabled one is never materialized. A reward
 * token is the market's reward asset.
 */
function rolesOf(token: Address, markets: CatalogMarket[]): AssetRole[] {
  const plays = (role: AssetRole) => markets.some(({ market }) => (
      role === 'base'   ? market.baseAsset.token.address === token
    : role === 'reward' ? market.rewardAsset?.token.address === token
    : market.collateralAssets.some(asset => asset.token.address === token)
  ));
  return ASSET_ROLES.filter(plays);
}

/*
 * What the decisions of a chain's served markets say of a token they take as
 * collateral: the Comets that have it deprecated, and those that hide it,
 * sorted; and whether it is deprecated in every enabled market that takes it,
 * of which there is at least one. A market whose status is `deprecated`
 * offers the token no longer: its decisions are named, and take no part in
 * whether the token is deprecated across the chain. None of it decides
 * whether discovery shows the token in a market, which that market's own
 * decisions do (visibilityHere).
 */
function decisionsOnChain(
  chainId: number,
  token: Address,
  markets: CatalogMarket[],
  { deprecated, hidden }: { deprecated: Decisions, hidden: Decisions },
): { isDeprecated: boolean, deprecatedIn: Address[], hiddenIn: Address[] } {
  const taking = markets
    .filter(({ market }) => market.collateralAssets.some(asset => asset.token.address === token))
    .map(({ market }) => {
      const collateral = { chainId, cometAddress: market.contracts.comet, tokenAddress: token };
      return { market, isHidden: hidden.has(collateral), isDeprecated: deprecated.has(collateral) };
    });
  const enabled = taking.filter(({ market }) => market.status === 'enabled');
  return {
    isDeprecated: enabled.length > 0 && enabled.every(entry => entry.isDeprecated),
    deprecatedIn: taking.filter(entry => entry.isDeprecated).map(({ market }) => market.contracts.comet).sort(),
    hiddenIn:     taking.filter(entry => entry.isHidden).map(({ market }) => market.contracts.comet).sort(),
  };
}

/*
 * A kind of decision that could not be read is taken as no decision by the
 * facts of the chain, and what it decides is left out of every collateral
 * (collateralFields).
 */
function chainTokens(catalog: Catalog, network: KnownNetwork.Name, chainId: number, decisions: SummaryDecisions): ChainTokens {
  const markets = catalog.marketsOn(network);
  const decided = {
    deprecated: decisions.deprecated?.decisions ?? decisionSetOf(DEPRECATED_RECORD, []),
    hidden:     decisions.hidden?.decisions ?? decisionSetOf(HIDDEN_RECORD, []),
  };
  const found = new Map<Address, ChainFacts>();
  const factsOf = (token: Address): ChainFacts => {
    let facts = found.get(token);
    if (facts === undefined) {
      facts = { roles: rolesOf(token, markets), ...decisionsOnChain(chainId, token, markets, decided) };
      found.set(token, facts);
    }
    return facts;
  };
  return { chainId, decisions, factsOf };
}

// what every collateral of one market is decided and described by, made once for the market (withTokenFields)
type MarketFacts = {
  chainId:   number,
  comet:     Address,
  decisions: SummaryDecisions,
  registry:  RegistryAnnotation,
};

// a price exception of the registry as /summary describes it on a collateral
type SummaryException = {
  kind:               PriceExceptionV1['kind'],
  price_feed_address: string,
  provenance:         string,
  expires_at:         string | null,
};

/*
 * The fields /summary adds to a collateral, an optional one where
 * collateralFields leaves it out. A key one of its conditional spreads adds
 * compiles all the same: the tests hold every key (COLLATERAL_KEYS).
 */
type CollateralTokenFields = {
  name:                       string,
  decimals:                   number,
  is_deprecated?:             boolean,
  is_network_deprecated?:     boolean,
  deprecated_in?:             string[],
  is_hidden?:                 boolean,
  hidden_in?:                 string[],
  is_strategic?:              boolean,
  network_roles:              AssetRole[],
  collateral_value_usd?:      string,
  collateral_value_status:    CollateralValueStatusV1,
  collateral_value_exception: SummaryException | null,
  is_visible?:                boolean,
  visibility_reason?:         VisibilityReasonV1,
};

/*
 * The price exception that priced a collateral, or the remap whose fallback
 * left its value unknown (marketLatestSummary), as the version that answers
 * describes it, where the summary read names it by what it does and to which
 * feed: the summary may have been read under another version that describes
 * it otherwise. Each version it is answered with holds it, since what keys
 * the summary, the market's digest, takes in every exception of its network
 * but why it was added and until when it applies (catalog.ts, marketDigest),
 * and a network has one exception for a feed. Its expiry is an instant, which
 * a version stored before expiries were normalized may state with an offset;
 * the catalog has already dropped an expiry it cannot parse, so this one
 * parses.
 */
function exceptionOf({ exception }: CollateralValue, annotation: RegistryAnnotation): SummaryException | null {
  if (exception === null) {
    return null;
  }
  const described = exceptionFor(annotation, exception.priceFeedAddress);
  if (described === null || described.kind !== exception.kind) {
    return null;
  }
  return {
    kind:               described.kind,
    price_feed_address: checksumAddress(described.priceFeedAddress),
    provenance:         described.provenance,
    // null where the exception does not expire: that is known, not left out
    expires_at:         described.expiresAt === null ? null : new Date(Date.parse(described.expiresAt)).toISOString(),
  };
}

/*
 * One collateral's token under the summary's names, after what was read of
 * it: its name and decimals; `is_deprecated` and `is_hidden`, the decisions of
 * this market's Comet, as /registry/v1/active marks its collateral; what holds
 * of the token across the chain; the collateral's value in this market; and
 * whether discovery shows it here (visibilityHere). A field whose decision
 * could not be read is left out, and so is a value that is not known: never
 * null, as the summary leaves out whatever it cannot give. A value is written
 * as the market's totals are, so that the values that are known and the total
 * they add up to read alike.
 *
 * Whether discovery shows the token is said wherever the decisions read settle
 * it, whichever way those that could not be read went, and why only where they
 * settle that as well (visibilityHere): one this Comet hides or has
 * deprecated, or one that is not strategic and is worth less than the
 * threshold here, is said not to be shown here even when this Comet's other
 * decisions about it could not be read, since a client that is told nothing
 * shows the token; and one this Comet neither hides nor deprecates, worth the
 * threshold here or of a value that cannot be read, is said to be shown even
 * when the strategic marks could not be.
 */
function collateralFields(
  token: TokenV1,
  chain: ChainFacts,
  { chainId, comet, decisions, registry }: MarketFacts,
  value: CollateralValue,
): CollateralTokenFields {
  const { deprecated, hidden, strategic } = decisions;
  const { valueUsd } = value;
  const collateral   = { chainId, cometAddress: comet, tokenAddress: token.address };
  const isHidden     = hidden === null ? null : hidden.decisions.has(collateral);
  const isDeprecated = deprecated === null ? null : deprecated.decisions.has(collateral);
  const isStrategic  = strategic === null ? null : strategic.get(chainId)?.has(token.address) ?? false;
  const visibility   = visibilityHere({ isHidden, isDeprecated, isStrategic }, valueUsd);
  return {
    name:     token.name,
    decimals: token.decimals,
    ...(isDeprecated === null ? {} : {
      is_deprecated:         isDeprecated,
      is_network_deprecated: chain.isDeprecated,
      deprecated_in:         chain.deprecatedIn.map(address => checksumAddress(address)),
    }),
    ...(isHidden === null ? {} : {
      is_hidden: isHidden,
      hidden_in: chain.hiddenIn.map(address => checksumAddress(address)),
    }),
    ...(isStrategic === null ? {} : { is_strategic: isStrategic }),
    network_roles: chain.roles,
    ...(valueUsd === null ? {} : { collateral_value_usd: valueUsd.toString() }),
    collateral_value_status:    valueStatusOf(value),
    collateral_value_exception: exceptionOf(value, registry),
    ...(visibility.isVisible        === undefined ? {} : { is_visible: visibility.isVisible }),
    ...(visibility.visibilityReason === undefined ? {} : { visibility_reason: visibility.visibilityReason }),
  };
}

// a collateral whose token the version does not describe is answered as it was read
type SummaryCollateral = CollateralStatus | CollateralStatus & CollateralTokenFields;

// a market of the summary as it was read and described, in the computation's names: its keys are written in snake case after this
type ReadMarket = MarketIdentity & Partial<Pick<MarketLatestSummary['returns'], 'collaterals' | 'marketBlock'>>;

type SummaryMarket<Entry> = Omit<Entry, 'marketBlock' | 'collaterals'> & { collateralValueBlock?: BlockRefV1, collaterals?: SummaryCollateral[] };

/*
 * A market of the summary with each collateral's token fields, and without
 * what they were made of: each collateral's value as it was read, and the
 * block the market was read at, which the market answers once, as the block
 * of every value of its collaterals (collateral_value_block). A value is read
 * with the market and never carried over from an earlier minute, so it is
 * never stale; where the node did not give the header of the market's block,
 * the block is left out, and the values and their statuses stay. A market the
 * chain has not reached has no collaterals, nor a block (market.ts,
 * unreachedMarket), and is answered as it was. The block and `collaterals`
 * are written last, the block right before the values it dates, and
 * `collaterals` where the market had it: the block was the one key after it
 * (marketLatestSummary), and the summary is spread last into the market
 * (market.ts, described).
 */
function withTokenFields<Entry extends ReadMarket>(
  { marketBlock: block = null, collaterals, ...entry }: Entry,
  contract: RegistryComet,
  chain: ChainTokens,
): SummaryMarket<Entry> {
  if (collaterals === undefined) {
    return entry;
  }
  const market: MarketFacts = {
    chainId:   chain.chainId,
    comet:     normalizeAddress(contract.address),
    decisions: chain.decisions,
    registry:  contract.registry,
  };
  return {
    ...entry,
    ...(block === null ? {} : { collateralValueBlock: { number: block.number, timestamp: block.timestamp } }),
    collaterals: collaterals.map((read): SummaryCollateral => {
      const { valueUsd: _value, exception: _exception, ...collateral } = read;
      const address = normalizeAddress(collateral.address);
      const token   = contract.registry.market.collateralAssets.find(asset => asset.token.address === address)?.token;
      return token === undefined ? collateral : { ...collateral, ...collateralFields(token, chain.factsOf(token.address), market, read) };
    }),
  };
}

export type { SummaryDecisions };
export { chainTokens, summaryDecisions, summaryHeaders, withTokenFields };
