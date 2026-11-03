import {
  Address,
  AssetDisplayOverrideV1,
  CONTRACT_ROLES,
  CONTRACT_ROLE_KEYS,
  ContractRoleKey,
  EXCEPTION_KINDS,
  MARKET_STATUSES,
  MarketStatus,
  MarketV1,
  NetworkV1,
  PRICE_QUOTES,
  ParsedRoot,
  PriceExceptionV1,
  PriceFeedV1,
  PriceQuote,
  UnwrappedCollateralAssetV1,
  isAddress,
  normalizeAddress,
} from '../../lib/model/comet-registry.js';

import type { MarketEnrichment } from './enrichment.js';
import { RegistryError } from './errors.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { sha256Hex } from '../../lib/hash.js';

/*
 * The reviewed overlay: everything about a market that the chain and the
 * pinned source cannot state. Labels, the default market, lifecycle status,
 * capabilities, the quote unit, the USD conversion feed, the reward feed and
 * its unit, network presentation, and price exceptions are all decisions,
 * not observations.
 *
 * Overlay documents are complete replacements with exact key sets: a missing
 * key is a missing decision, never an implicit default. The same shapes are
 * cloned from the active version, so an import inherits reviewed data instead
 * of asking an operator to restate it for every unchanged market.
 */
type MarketOverlay = {
  displayName:          string,
  slug:                 string | null,
  contractName:         string | null,
  isDefault:            boolean,
  isInstitutional:      boolean,
  status:               MarketStatus,
  creationBlock:        number,
  collateralValueQuote: PriceQuote,
  capabilities: {
    rewards:            boolean,
    accountRewards:     boolean,
    transactionHistory: boolean,
  },
  baseAsset: {
    displayName:        string,
    isWrappedNative:    boolean,
    usdPriceFeedAddress: Address | null,
  },
  rewardPriceFeed: { address: Address, quote: PriceQuote } | null,
};

/*
 * A price exception as an overlay states it. A remap names the feed to read
 * instead and never its scale: enrichment reads the decimals from that feed,
 * so a reviewer cannot state a scale the chain disagrees with, and the wire
 * shape, which carries them, is assembled once they are read.
 */
type OverlayPriceException = (
  | Exclude<PriceExceptionV1, { kind: 'deprecated_price_remap' }>
  | {
      kind:                        'deprecated_price_remap',
      priceFeedAddress:            Address,
      replacementPriceFeedAddress: Address,
      provenance:                  string,
      expiresAt:                   string | null,
    }
);

type NetworkOverlay = {
  displayName:               string,
  assetDisplayOverrides:     AssetDisplayOverrideV1[],
  unwrappedCollateralAssets: UnwrappedCollateralAssetV1[],
  priceExceptions:           OverlayPriceException[],
};

/*
 * What a decision is held to. A stored decision is parsed again whenever it
 * is read back: every import parses the ones it inherits, every overlay write
 * to a draft parses every reviewed one the draft holds, whichever scopes it
 * names, and reading a scope's overlay parses that scope's. One the parser
 * refuses stops every import that inherits it and every review of the draft
 * that holds it, so a release that makes a rule here stricter also takes what
 * versions stored under the looser one, normalized as it is read, as
 * storedExpiry does with an expiry.
 */
const MAX_TEXT      = 200;
const MAX_PROVENANCE = 1000;
const MAX_OVERRIDES  = 200;
const MAX_BLOCK      = Number.MAX_SAFE_INTEGER;

function fail(message: string, scope: string): never {
  throw new RegistryError('OVERLAY_INVALID', message, scope);
}

function object(value: unknown, keys: readonly string[], scope: string): Record<string, unknown> {
  if (typeof(value) !== 'object' || value === null || Array.isArray(value)) {
    fail(`${scope} must be an object`, scope);
  }
  const record  = value as Record<string, unknown>;
  const present = Object.keys(record);
  const unknown = present.filter(key => !keys.includes(key));
  if (unknown.length > 0) {
    fail(`${scope} has unexpected keys: ${unknown.sort().join(', ')}`, scope);
  }
  const missing = keys.filter(key => !present.includes(key));
  if (missing.length > 0) {
    fail(`${scope} is missing: ${missing.join(', ')}`, scope);
  }
  return record;
}

function text(value: unknown, scope: string, { max = MAX_TEXT }: { max?: number } = {}): string {
  if (typeof(value) !== 'string' || value.trim().length === 0 || value.length > max) {
    fail(`${scope} must be a non-empty string of at most ${max} characters`, scope);
  }
  return value.trim();
}

function flag(value: unknown, scope: string): boolean {
  if (typeof(value) !== 'boolean') {
    fail(`${scope} must be a boolean`, scope);
  }
  return value;
}

function address(value: unknown, scope: string): Address {
  if (!isAddress(value)) {
    fail(`${scope} must be an address`, scope);
  }
  return normalizeAddress(value);
}

function member<T extends string>(value: unknown, allowed: readonly T[], scope: string): T {
  if (typeof(value) !== 'string' || !allowed.includes(value as T)) {
    fail(`${scope} must be one of ${allowed.join(', ')}`, scope);
  }
  return value as T;
}

function array(value: unknown, scope: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_OVERRIDES) {
    fail(`${scope} must be an array of at most ${MAX_OVERRIDES} entries`, scope);
  }
  return value;
}

/*
 * An instant as RFC 3339 writes one: a calendar date, a time of day, and the
 * offset that places them. Anything looser names a different moment depending
 * on who reads it — Date.parse takes "1" for the year 2001 and a time without
 * an offset as the reader's local time, which in a Worker is UTC and in Node
 * is the machine's zone — and a date the calendar does not have, such as 30
 * February, is not rolled over into March.
 */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

function instantOf(value: string): number | null {
  const match = RFC3339.exec(value);
  if (match === null) {
    return null;
  }
  const [ year, month, day, hour, minute, second ] = match.slice(1, 7).map(Number) as [ number, number, number, number, number, number ];
  // setUTCFullYear takes the years 0 to 99 as written, where Date.UTC reads them as 1900 to 1999
  const stated = new Date(0);
  stated.setUTCFullYear(year, month - 1, day);
  stated.setUTCHours(hour, minute, second);
  const exists = stated.getUTCFullYear() === year && stated.getUTCMonth() === month - 1 && stated.getUTCDate() === day
    && stated.getUTCHours() === hour && stated.getUTCMinutes() === minute && stated.getUTCSeconds() === second;
  const offset = match[7] === undefined || (Number(match[7]) <= 23 && Number(match[8]) <= 59);
  const instant = Date.parse(value.toUpperCase());
  return exists && offset && Number.isFinite(instant) ? instant : null;
}

// the first and the last instant RFC 3339 writes in UTC, whose years have four digits
const FIRST_INSTANT = Date.parse('0000-01-01T00:00:00.000Z');
const LAST_INSTANT  = Date.parse('9999-12-31T23:59:59.999Z');

/*
 * An expiry is stored as the UTC instant it names, so two spellings of one
 * moment are one decision and one digest. What is stored is read back through
 * this parser, so it has to be an instant RFC 3339 writes in UTC: one past
 * either end of those years — which an offset can name, and a version stored
 * before this rule can hold — is stored as the nearest one it writes, which is
 * just as long past or just as far off.
 */
function storedInstant(instant: number): string {
  return new Date(Math.min(Math.max(instant, FIRST_INSTANT), LAST_INSTANT)).toISOString();
}

function timestamp(value: unknown, scope: string): string | null {
  if (value === null) {
    return null;
  }
  const instant = typeof(value) === 'string' ? instantOf(value) : null;
  if (instant === null) {
    fail(`${scope} must be null or an RFC 3339 timestamp with its offset, such as 2027-01-01T00:00:00Z`, scope);
  }
  return storedInstant(instant);
}

function unique<T>(entries: T[], key: (entry: T) => string, scope: string): T[] {
  const keys = entries.map(key);
  if (new Set(keys).size !== keys.length) {
    fail(`${scope} lists the same address twice`, scope);
  }
  // arrays are stored sorted, so an overlay cannot differ by order alone
  return [ ...entries ].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
}

function parsePriceException(value: unknown, scope: string): OverlayPriceException {
  const kind = member((value as { kind?: unknown })?.kind, EXCEPTION_KINDS, `${scope}.kind`);
  switch (kind) {
    case 'zero_price': {
      const entry = object(value, [ 'kind', 'priceFeedAddress', 'provenance', 'expiresAt' ], scope);
      return {
        kind,
        priceFeedAddress: address(entry.priceFeedAddress, `${scope}.priceFeedAddress`),
        provenance:       text(entry.provenance, `${scope}.provenance`, { max: MAX_PROVENANCE }),
        expiresAt:        timestamp(entry.expiresAt, `${scope}.expiresAt`),
      };
    }
    case 'fixed_price': {
      const entry = object(value, [ 'kind', 'priceFeedAddress', 'price', 'provenance', 'expiresAt' ], scope);
      const price = object(entry.price, [ 'value', 'decimals' ], `${scope}.price`);
      if (typeof(price.value) !== 'string' || !/^[0-9]+$/.test(price.value)) {
        fail(`${scope}.price.value must be a decimal string`, scope);
      }
      if (typeof(price.decimals) !== 'number' || !Number.isInteger(price.decimals) || price.decimals < 0 || price.decimals > 255) {
        fail(`${scope}.price.decimals must be between 0 and 255`, scope);
      }
      return {
        kind,
        priceFeedAddress: address(entry.priceFeedAddress, `${scope}.priceFeedAddress`),
        price:            { value: price.value, decimals: price.decimals },
        provenance:       text(entry.provenance, `${scope}.provenance`, { max: MAX_PROVENANCE }),
        expiresAt:        timestamp(entry.expiresAt, `${scope}.expiresAt`),
      };
    }
    case 'deprecated_price_remap': {
      const entry       = object(value, [ 'kind', 'priceFeedAddress', 'replacementPriceFeedAddress', 'provenance', 'expiresAt' ], scope);
      const replaced    = address(entry.priceFeedAddress, `${scope}.priceFeedAddress`);
      const replacement = address(entry.replacementPriceFeedAddress, `${scope}.replacementPriceFeedAddress`);
      if (replaced === replacement) {
        fail(`${scope} remaps a feed onto itself`, scope);
      }
      return {
        kind,
        priceFeedAddress:            replaced,
        replacementPriceFeedAddress: replacement,
        provenance:                  text(entry.provenance, `${scope}.provenance`, { max: MAX_PROVENANCE }),
        expiresAt:                   timestamp(entry.expiresAt, `${scope}.expiresAt`),
      };
    }
  }
}

function parseNetworkOverlay(value: unknown, scope: string = 'overlay'): NetworkOverlay {
  const entry = object(
    value,
    [ 'displayName', 'assetDisplayOverrides', 'unwrappedCollateralAssets', 'priceExceptions' ],
    scope,
  );

  const overrides = array(entry.assetDisplayOverrides, `${scope}.assetDisplayOverrides`).map((item, index) => {
    const override = object(item, [ 'tokenAddress', 'displayAddress', 'symbol', 'name' ], `${scope}.assetDisplayOverrides[${index}]`);
    return {
      tokenAddress:   address(override.tokenAddress, `${scope}.assetDisplayOverrides[${index}].tokenAddress`),
      // the zero address displays a wrapped native asset as the native one
      displayAddress: address(override.displayAddress, `${scope}.assetDisplayOverrides[${index}].displayAddress`),
      symbol:         text(override.symbol, `${scope}.assetDisplayOverrides[${index}].symbol`),
      name:           text(override.name, `${scope}.assetDisplayOverrides[${index}].name`),
    };
  });

  const unwrapped = array(entry.unwrappedCollateralAssets, `${scope}.unwrappedCollateralAssets`).map((item, index) => {
    const pair = object(item, [ 'wrappedTokenAddress', 'tokenAddress', 'symbol', 'name' ], `${scope}.unwrappedCollateralAssets[${index}]`);
    return {
      wrappedTokenAddress: address(pair.wrappedTokenAddress, `${scope}.unwrappedCollateralAssets[${index}].wrappedTokenAddress`),
      tokenAddress:        address(pair.tokenAddress, `${scope}.unwrappedCollateralAssets[${index}].tokenAddress`),
      symbol:              text(pair.symbol, `${scope}.unwrappedCollateralAssets[${index}].symbol`),
      name:                text(pair.name, `${scope}.unwrappedCollateralAssets[${index}].name`),
    };
  });

  const exceptions = array(entry.priceExceptions, `${scope}.priceExceptions`)
    .map((item, index) => parsePriceException(item, `${scope}.priceExceptions[${index}]`));

  return {
    displayName:               text(entry.displayName, `${scope}.displayName`),
    assetDisplayOverrides:     unique(overrides, override => override.tokenAddress, `${scope}.assetDisplayOverrides`),
    unwrappedCollateralAssets: unique(unwrapped, pair => pair.wrappedTokenAddress, `${scope}.unwrappedCollateralAssets`),
    priceExceptions:           unique(exceptions, exception => exception.priceFeedAddress, `${scope}.priceExceptions`),
  };
}

function parseMarketOverlay(value: unknown, scope: string = 'overlay'): MarketOverlay {
  const entry = object(value, [
    'displayName', 'slug', 'contractName', 'isDefault', 'isInstitutional', 'status', 'creationBlock',
    'collateralValueQuote', 'capabilities', 'baseAsset', 'rewardPriceFeed',
  ], scope);

  // lowercase, as the frontend compares it, and within what its market keys accept
  const slug = entry.slug;
  if (slug !== null && (typeof(slug) !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(slug))) {
    fail(`${scope}.slug must be null or up to 64 lowercase letters, digits, dots and hyphens`, scope);
  }

  const capabilities = object(entry.capabilities, [ 'rewards', 'accountRewards', 'transactionHistory' ], `${scope}.capabilities`);
  const baseAsset    = object(entry.baseAsset, [ 'displayName', 'isWrappedNative', 'usdPriceFeedAddress' ], `${scope}.baseAsset`);

  const creationBlock = entry.creationBlock;
  if (typeof(creationBlock) !== 'number' || !Number.isInteger(creationBlock) || creationBlock < 0 || creationBlock > MAX_BLOCK) {
    fail(`${scope}.creationBlock must be a non-negative block number`, scope);
  }

  let rewardPriceFeed: MarketOverlay['rewardPriceFeed'] = null;
  if (entry.rewardPriceFeed !== null) {
    const feed = object(entry.rewardPriceFeed, [ 'address', 'quote' ], `${scope}.rewardPriceFeed`);
    rewardPriceFeed = {
      address: address(feed.address, `${scope}.rewardPriceFeed.address`),
      quote:   member(feed.quote, PRICE_QUOTES, `${scope}.rewardPriceFeed.quote`),
    };
  }

  return {
    displayName:          text(entry.displayName, `${scope}.displayName`),
    slug:                 slug as string | null,
    contractName:         entry.contractName === null ? null : text(entry.contractName, `${scope}.contractName`),
    isDefault:            flag(entry.isDefault, `${scope}.isDefault`),
    isInstitutional:      flag(entry.isInstitutional, `${scope}.isInstitutional`),
    status:               member(entry.status, MARKET_STATUSES, `${scope}.status`),
    creationBlock,
    collateralValueQuote: member(entry.collateralValueQuote, PRICE_QUOTES, `${scope}.collateralValueQuote`),
    capabilities: {
      rewards:            flag(capabilities.rewards, `${scope}.capabilities.rewards`),
      accountRewards:     flag(capabilities.accountRewards, `${scope}.capabilities.accountRewards`),
      transactionHistory: flag(capabilities.transactionHistory, `${scope}.capabilities.transactionHistory`),
    },
    baseAsset: {
      displayName:         text(baseAsset.displayName, `${scope}.baseAsset.displayName`),
      isWrappedNative:     flag(baseAsset.isWrappedNative, `${scope}.baseAsset.isWrappedNative`),
      usdPriceFeedAddress: baseAsset.usdPriceFeedAddress === null
        ? null
        : address(baseAsset.usdPriceFeedAddress, `${scope}.baseAsset.usdPriceFeedAddress`),
    },
    rewardPriceFeed,
  };
}

/*
 * The overlay a stored market carries: its decisions, without the facts the
 * import read. It is the document the overlay routes accept, so a market that
 * is already described can be read, changed, and written back, and a similar
 * market is where describing a new one starts.
 */
function overlayOfMarket(market: MarketV1): MarketOverlay {
  return {
    displayName:          market.displayName,
    slug:                 market.slug,
    contractName:         market.contractName,
    isDefault:            market.isDefault,
    isInstitutional:      market.isInstitutional,
    status:               market.status,
    creationBlock:        market.creationBlock,
    collateralValueQuote: market.collateralValueQuote,
    capabilities:         { ...market.capabilities },
    baseAsset: {
      displayName:         market.baseAsset.displayName,
      isWrappedNative:     market.baseAsset.isWrappedNative,
      usdPriceFeedAddress: market.baseAsset.usdPriceFeed?.address ?? null,
    },
    /*
     * A feed without the unit it answers in is not a feed anything can use,
     * and validation refuses it; a candidate can still hold one, and this
     * document has to be one the route takes back, so it reads as none.
     */
    rewardPriceFeed: market.rewardAsset?.priceFeed == null || market.rewardAsset.priceFeedQuote === null
      ? null
      : { address: market.rewardAsset.priceFeed.address, quote: market.rewardAsset.priceFeedQuote },
  };
}

/*
 * The decision a served price exception states. A remap names the feed it
 * reads instead; the decimals beside it were read from that feed, not decided.
 */
function overlayOfException(exception: PriceExceptionV1): OverlayPriceException {
  return exception.kind === 'deprecated_price_remap'
    ? {
        kind:                        exception.kind,
        priceFeedAddress:            exception.priceFeedAddress,
        replacementPriceFeedAddress: exception.replacementPriceFeed.address,
        provenance:                  exception.provenance,
        expiresAt:                   exception.expiresAt,
      }
    : exception;
}

/*
 * The digest an overlay audit event records, over the normalized overlay. It
 * identifies what was applied without storing the request body. Written as
 * canonical JSON, it names what the overlay says rather than the order its
 * keys were assigned in; the parser is what makes two spellings of one
 * address, expiry or list one overlay, so what is digested is its output.
 */
async function overlayDigest(overlay: MarketOverlay | NetworkOverlay): Promise<string> {
  return sha256Hex(canonicalJson(overlay));
}

/*
 * The feed addresses an overlay introduces. Their decimals are read on chain,
 * because the overlay states which feed to use, never how to scale it.
 */
function overlayFeedAddresses(overlay: MarketOverlay): Address[] {
  return [
    ...(overlay.baseAsset.usdPriceFeedAddress === null ? [] : [ overlay.baseAsset.usdPriceFeedAddress ]),
    ...(overlay.rewardPriceFeed === null ? [] : [ overlay.rewardPriceFeed.address ]),
  ];
}

function networkOverlayFeedAddresses(overlay: NetworkOverlay): Address[] {
  return overlay.priceExceptions.flatMap(exception => (
    exception.kind === 'deprecated_price_remap' ? [ exception.replacementPriceFeedAddress ] : []
  ));
}

function feedOf(feeds: Map<Address, PriceFeedV1>, address: Address, scope: string): PriceFeedV1 {
  const feed = feeds.get(address);
  if (feed === undefined) {
    throw new RegistryError('OVERLAY_FEED_UNREADABLE', `the decimals of ${address} were not read`, scope);
  }
  return feed;
}

/*
 * Combines one market's three sources into the wire shape: the pinned roots
 * for contract addresses, enrichment for on-chain identity, and the overlay
 * for reviewed decisions.
 */
function applyMarketOverlay(
  root: ParsedRoot,
  enrichment: MarketEnrichment,
  overlay: MarketOverlay,
  feeds: Map<Address, PriceFeedV1>,
  id: string,
): MarketV1 {
  const scope     = root.rootPath;
  const contracts = Object.fromEntries(
    CONTRACT_ROLES.map(role => [ CONTRACT_ROLE_KEYS[role], root.contracts[role] ?? null ])
  ) as Record<ContractRoleKey, Address | null>;

  const rewardAsset = enrichment.rewardToken === null ? null : {
    token:          enrichment.rewardToken,
    priceFeed:      overlay.rewardPriceFeed === null ? null : feedOf(feeds, overlay.rewardPriceFeed.address, scope),
    priceFeedQuote: overlay.rewardPriceFeed === null ? null : overlay.rewardPriceFeed.quote,
  };

  return {
    id,
    deploymentKey:        root.deploymentKey,
    displayName:          overlay.displayName,
    slug:                 overlay.slug,
    contractName:         overlay.contractName,
    isDefault:            overlay.isDefault,
    isInstitutional:      overlay.isInstitutional,
    status:               overlay.status,
    creationBlock:        overlay.creationBlock,
    collateralValueQuote: overlay.collateralValueQuote,
    capabilities:         overlay.capabilities,
    contracts,
    baseAsset: {
      token:           enrichment.baseToken,
      displayName:     overlay.baseAsset.displayName,
      isWrappedNative: overlay.baseAsset.isWrappedNative,
      priceFeed:       enrichment.basePriceFeed,
      usdPriceFeed:    overlay.baseAsset.usdPriceFeedAddress === null
        ? null
        : feedOf(feeds, overlay.baseAsset.usdPriceFeedAddress, scope),
    },
    rewardAsset,
    // getAssetInfo order is the on-chain asset index order
    collateralAssets: enrichment.collateralAssets,
  };
}

/*
 * What a network overlay decides, as the wire shape carries it: a remap with
 * the decimals read for the feed it reads instead. An import builds its
 * network from these, and an overlay write writes them onto the network's
 * rows, so a decision is stored the same way whichever wrote it.
 */
function networkDecisions(
  overlay: NetworkOverlay,
  feeds: Map<Address, PriceFeedV1>,
  scope: string,
): Pick<NetworkV1, 'displayName' | 'presentation' | 'priceExceptions'> {
  return {
    displayName:  overlay.displayName,
    presentation: {
      assetDisplayOverrides:     overlay.assetDisplayOverrides,
      unwrappedCollateralAssets: overlay.unwrappedCollateralAssets,
    },
    priceExceptions: overlay.priceExceptions.map((exception): PriceExceptionV1 => exception.kind === 'deprecated_price_remap'
      ? {
          kind:                 exception.kind,
          priceFeedAddress:     exception.priceFeedAddress,
          replacementPriceFeed: feedOf(feeds, exception.replacementPriceFeedAddress, scope),
          provenance:           exception.provenance,
          expiresAt:            exception.expiresAt,
        }
      : exception),
  };
}

/*
 * Builds one network of the snapshot. Markets are ordered by creation block
 * and then deployment key, as the wire contract fixes.
 */
function applyNetworkOverlay(
  identity: { chainId: number, key: string, upstreamKey: string, testnet: boolean },
  overlay: NetworkOverlay,
  markets: MarketV1[],
  feeds: Map<Address, PriceFeedV1>,
): NetworkV1 {
  const { displayName, presentation, priceExceptions } = networkDecisions(overlay, feeds, identity.key);
  return {
    chainId:     identity.chainId,
    key:         identity.key,
    upstreamKey: identity.upstreamKey,
    displayName,
    testnet:     identity.testnet,
    presentation,
    priceExceptions,
    markets: [ ...markets ].sort((left, right) => (
      left.creationBlock - right.creationBlock
        || (left.deploymentKey < right.deploymentKey ? -1 : left.deploymentKey > right.deploymentKey ? 1 : 0)
    )),
  };
}

/*
 * Networks are ordered by chain id, which completes the snapshot ordering the
 * wire contract fixes.
 */
function orderNetworks(networks: NetworkV1[]): NetworkV1[] {
  return [ ...networks ].sort((left, right) => left.chainId - right.chainId);
}

/*
 * The overlay of a market nobody has reviewed.
 *
 * It decides nothing: the market is disabled, so nothing serves it, has
 * every capability off, is not the default, and carries no USD or reward
 * feed. Its names are identifiers the source and the chain already state —
 * the upstream deployment key and the base token's own name — rather than
 * labels someone would have chosen. The creation block is left at zero,
 * which validation accepts only for a market that is not served.
 *
 * The rows written from it are marked unreviewed, so nothing clones them
 * into the next version as if they had been decided.
 */
function provisionalMarketOverlay(deploymentKey: string, baseTokenName: string): MarketOverlay {
  return {
    displayName:          deploymentKey,
    slug:                 null,
    contractName:         null,
    isDefault:            false,
    isInstitutional:      false,
    status:               'disabled',
    creationBlock:        0,
    collateralValueQuote: 'usd',
    capabilities: {
      rewards:            false,
      accountRewards:     false,
      transactionHistory: false,
    },
    baseAsset: {
      displayName:         baseTokenName,
      isWrappedNative:     false,
      usdPriceFeedAddress: null,
    },
    rewardPriceFeed: null,
  };
}

// the overlay of a network nobody has reviewed
function provisionalNetworkOverlay(canonicalName: string): NetworkOverlay {
  return {
    displayName:               canonicalName,
    assetDisplayOverrides:     [],
    unwrappedCollateralAssets: [],
    priceExceptions:           [],
  };
}

export type { MarketOverlay, NetworkOverlay };

export {
  applyMarketOverlay,
  applyNetworkOverlay,
  feedOf,
  networkDecisions,
  networkOverlayFeedAddresses,
  orderNetworks,
  overlayDigest,
  overlayFeedAddresses,
  overlayOfException,
  overlayOfMarket,
  parseMarketOverlay,
  parseNetworkOverlay,
  provisionalMarketOverlay,
  provisionalNetworkOverlay,
  storedInstant,
};
