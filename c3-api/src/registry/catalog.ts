import * as Fallible     from '../../lib/fallible/fallible.js';
import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import { canonicalJson } from '../../lib/canonical-json.js';
import { keccak256 } from '../../lib/hash.js';


import {
  Comet,
  Contract,
  ERC20,
  PriceFeed,
  StandaloneContract,
  UntypedContract,
} from '../../lib/well-known/contracts/types.js';

import {
  Address,
  AssetDisplayOverrideV1,
  MarketV1,
  NetworkV1,
  PriceExceptionV1,
  PriceFeedV1,
  RegistryAnnotation,
  RegistryComet,
  RegistrySnapshotV1,
  TokenV1,
  checksumAddress,
} from '../../lib/model/comet-registry.js';

/*
 * The request catalog: one activated snapshot, materialized into the contract
 * objects the existing computations already consume.
 *
 * The catalog hands out the same `Comet`, `ERC20`, and `PriceFeed` shapes the
 * well-known constants do, so a computation written against those shapes
 * reads a market of the registry unchanged. What it adds is the registry's
 * description of each Comet, which is what a computation reads for anything
 * the shapes cannot say, and identity: every lookup is answered from one
 * pinned version, and the version id is available for cache keys, because two
 * versions can describe the same address with different metadata.
 */

/*
 * A market the API serves: one that is not disabled, with its Comet, which
 * is what it is addressed and keyed by. Validation refuses a market that does
 * not declare its Comet (comet-contract-declared), so of a validated version
 * only the disabled markets are left out.
 */
type ServedMarket = MarketV1 & { contracts: MarketV1['contracts'] & { comet: Address } };

type CatalogMarket = {
  chainId:       number,
  network:       KnownNetwork.Name,
  deploymentKey: string,
  market:        ServedMarket,
  comet:         RegistryComet,
};

type Catalog = {
  versionId: string,
  checksum:  string,
  /*
   * Until when the catalog describes its version as it applies: the moment
   * the next price exception it applies expires, or null when none will. A
   * catalog kept past it would go on applying an exception that has expired.
   */
  validUntil: number | null,
  /*
   * What this catalog contributes to a computation's cache key. It is the
   * content checksum, not the version id: re-importing the same markets
   * produces a new version that must not invalidate everything computed from
   * the previous one, while any change to what the registry says must.
   */
  key(): string,
  /*
   * The same for transaction history, which reads one network: what its
   * items are made of there. That is the tokens the network's markets name,
   * with the symbol and the scale an amount is read at and the name the
   * network renames one to, and each market's Comet, rewards contract,
   * bulker, base token and creation block. A change on another network, or to
   * anything else about a market — a feed, an exception, a capability, a
   * label — keeps every page computed so far.
   */
  historyKeyFor(network: KnownNetwork.Name): string,
  /*
   * Markets the API may serve. `enabled` and `deprecated` are readable;
   * `disabled` markets are excluded, because a runtime consumer must not
   * resolve one.
   */
  markets(): CatalogMarket[],
  // the networks the API serves: those with a market it may resolve
  networks(): NetworkV1[],
  marketAt(network: KnownNetwork.Name, cometAddress: Address): CatalogMarket | null,
  marketsOn(network: KnownNetwork.Name): CatalogMarket[],
  /*
   * Every token of a version, by network and address: base, collateral, and
   * reward assets alike. A transaction log names a token by address only, so
   * this is what turns one into a symbol and a scale.
   */
  tokenAt(network: KnownNetwork.Name, address: Address): TokenV1 | null,
  baseTokenAt(network: KnownNetwork.Name, cometAddress: Address): TokenV1 | null,
  /*
   * The symbol a network's presentation renames a token to, where it keeps
   * the token's own address; a token presented as the chain's own token is
   * not renamed here.
   */
  renamedSymbolAt(network: KnownNetwork.Name, address: Address): string | null,
  /*
   * The markets of the version that markets() leaves out, disabled ones, as
   * contracts that only name them, by the name a served market has. A
   * proposal names a market whatever the version says of it — it sets one up
   * before it is served, and retires one no longer served — so governance
   * names these too. Nothing else may resolve a market through them.
   */
  unservedMarkets(): Contract[],
};

function networkName(network: NetworkV1): KnownNetwork.Name | null {
  const known = KnownNetwork.lookup({ name: network.key });
  return Fallible.isFailure(known) ? null : (network.key as KnownNetwork.Name);
}

/*
 * An address as a contract carries it, and so as every response echoes it:
 * checksummed, the form the API answered with before the registry. The
 * registry stores addresses lowercased, and every lookup and cache key keeps
 * comparing that form.
 */
function shown(address: Address): Address {
  return checksumAddress(address) as Address;
}

/*
 * A token as the contract shapes carry it. The registry's `name` goes into
 * `description`, which is where the static constants put the human name of a
 * token ("USD Coin" beside the symbol "USDC") and where the market rewards
 * computation reads it from. `displayName` stays unset, so a token still
 * reads as its symbol wherever a contract is named.
 */
function erc20(
  network: KnownNetwork.Name,
  token: TokenV1,
  creationBlock: number,
): Contract<StandaloneContract<ERC20>> {
  return ERC20(token.symbol, {
    network,
    address:     shown(token.address),
    decimals:    token.decimals,
    description: token.name,
    block:       { number: creationBlock },
  }) as unknown as Contract<StandaloneContract<ERC20>>;
}

function priceFeed(
  network: KnownNetwork.Name,
  feed: PriceFeedV1,
  creationBlock: number,
): Contract<StandaloneContract<PriceFeed>> {
  return PriceFeed({
    network,
    address:  shown(feed.address),
    decimals: feed.decimals,
    block:    { number: creationBlock },
  }) as unknown as Contract<StandaloneContract<PriceFeed>>;
}

/*
 * What identifies a market to a cache: everything the registry says about it
 * that a computation reads, and what the exceptions of its network do to a
 * price, which decides whether a price is read at all.
 *
 * Left out is what no computation reads, so that changing it does not throw
 * away work that did not depend on it — daily summaries reach back years:
 *
 * - the row id, which changes with every import even when the market does not;
 * - how the website lists the market — its label, slug and section, whether
 *   it opens first — and whether it is served, which decides whether a
 *   computation runs, not what it computes;
 * - its capabilities, which decide which routes serve it, not what they read;
 * - the contract name, which only governance titles use, uncached;
 * - the base asset's display name;
 * - why an exception was added, and until when it applies. An exception that
 *   expires stops being one of the network's (applicableExceptions), which
 *   changes the digest when it happens, not when its date is edited.
 *
 * Every exception of the network stays in, not only those on the market's
 * current feeds: a price is read from the feed the Comet names at the block it
 * is read at, which for a historical block may be one the market has since
 * moved off.
 *
 * The rewards summary does report the labels, and so keys itself by them.
 */
function marketDigest(market: MarketV1, priceExceptions: PriceExceptionV1[]): string {
  const {
    id: _id, displayName: _label, slug: _slug, isInstitutional: _section, isDefault: _default,
    status: _status, contractName: _contract, capabilities: _capabilities,
    baseAsset: { displayName: _baseName, ...baseAsset },
    ...identity
  } = market;
  const applied = priceExceptions.map(({ provenance: _provenance, expiresAt: _expiresAt, ...exception }) => exception);
  return keccak256(canonicalJson({ identity: { ...identity, baseAsset }, priceExceptions: applied })).slice(0, 16);
}

/*
 * Whether the API serves a market. A disabled market is not served: the
 * version keeps it for diagnostics, and nothing the API serves may resolve
 * through it, its tokens included. A deprecated one is, because positions
 * and history in it must stay reachable. Every read of a version asks this;
 * validation judges a candidate's markets by their status alone, and
 * /admin/status asks the same in SQL (candidate-drops-markets).
 */
function isServed(market: MarketV1): market is ServedMarket {
  return market.status !== 'disabled' && market.contracts.comet !== null;
}

/*
 * The networks of a version that serve a market, each with the markets it
 * serves. A network whose every market is disabled serves nothing — a chain
 * the source has just added arrives that way, with nothing about it reviewed
 * — and is left out.
 */
function servedNetworks(snapshot: RegistrySnapshotV1): Array<{ network: NetworkV1, markets: ServedMarket[] }> {
  return snapshot.networks
    .map(network => ({ network, markets: network.markets.filter(isServed) }))
    .filter(({ markets }) => markets.length > 0);
}

// what governance calls a market
function contractNameOf(market: MarketV1): string {
  return market.contractName ?? market.displayName;
}

/*
 * One market as the computations see it.
 *
 * Its rewards are what the market has, and nothing it does not: the
 * CometRewards contract where the source declares one, the token it pays
 * where that contract names one, and the feed that prices the token where
 * the version states one. A consumer checks for the part it needs, and the
 * market's capabilities say which of them are usable.
 *
 * The contract keys itself by address and market digest, so two versions that
 * describe the same market share every cached computation of it, and a version
 * that changes a token, a feed, or an exception shares none.
 */
function cometOf(
  network: KnownNetwork.Name,
  market: ServedMarket,
  annotation: Omit<RegistryAnnotation, 'digest' | 'market'>,
): RegistryComet {
  const block = market.creationBlock;
  const base  = {
    asset:     erc20(network, market.baseAsset.token, block),
    priceFeed: priceFeed(network, market.baseAsset.priceFeed, block),
    ...(market.baseAsset.usdPriceFeed === null
      ? {}
      : { usdPriceFeed: priceFeed(network, market.baseAsset.usdPriceFeed, block) }),
  };

  const rewardsContract = market.contracts.rewards;
  const rewardFeed      = market.rewardAsset?.priceFeed ?? null;
  const rewards = rewardsContract === null ? undefined : {
    contract: UntypedContract('CometRewards', {
      network,
      address: shown(rewardsContract),
      block:   { number: block },
    }),
    ...(market.rewardAsset === null ? {} : { asset: erc20(network, market.rewardAsset.token, block) }),
    ...(rewardFeed === null ? {} : { priceFeed: priceFeed(network, rewardFeed, block) }),
  };

  const address = market.contracts.comet;
  const digest  = marketDigest(market, annotation.priceExceptions);
  const comet   = Comet({
    network,
    address:     shown(address),
    displayName: contractNameOf(market),
    // the registry stores no alias keys; a market is addressed by its Comet
    aliases:     [] as const,
    block:       { number: block },
    base,
    ...(rewards === undefined ? {} : { rewards }),
  });

  return Object.assign(comet as unknown as Contract<StandaloneContract<Comet>>, {
    registry: { ...annotation, digest, market },
    key:      () => `${address}@${digest}`,
  });
}

/*
 * The exceptions of a network that still apply.
 *
 * An exception may carry an expiry, and an expired one must stop applying
 * without waiting for a new import. Expiry is resolved here, once per
 * request, rather than inside a computation: a cached result must not change
 * meaning because time passed while it sat in the cache, and dropping an
 * exception here changes the market digest, which retires exactly the cached
 * results that depended on it.
 */
function applicableExceptions(exceptions: PriceExceptionV1[], now: number): PriceExceptionV1[] {
  return exceptions.filter(exception => {
    const expiresAt = expiryOf(exception);
    return expiresAt === null || expiresAt > now;
  });
}

/*
 * When an exception stops applying, as an instant, or null when it does not
 * expire. Compared as instants, never as strings: a version stored before
 * expiries were normalized may state one with an offset, and
 * "2026-09-21T13:00:00+02:00" sorts after the same moment written in Z. An
 * expiry that cannot be parsed at all is treated as long past, because an
 * exception nobody can date is not one to keep suppressing a live feed with.
 */
function expiryOf(exception: PriceExceptionV1): number | null {
  if (exception.expiresAt === null) {
    return null;
  }
  const expiresAt = Date.parse(exception.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt : Number.NEGATIVE_INFINITY;
}

function tokensOf(market: MarketV1): TokenV1[] {
  return [
    market.baseAsset.token,
    ...(market.rewardAsset === null ? [] : [ market.rewardAsset.token ]),
    ...market.collateralAssets.map(asset => asset.token),
  ];
}

/*
 * The tokens a network's presentation renames where they keep their own
 * address; a token presented as the chain's own token is shown, not renamed.
 */
function renamesOf(network: NetworkV1): AssetDisplayOverrideV1[] {
  return network.presentation.assetDisplayOverrides.filter(override => override.displayAddress === override.tokenAddress);
}

/*
 * What transaction history reads of one network, as a digest. An item names
 * a token by address and an amount in its scale, so a token counts by its
 * address, symbol and decimals, and by the name the network renames it to;
 * a market counts by the contracts its events and claims come from, the
 * bulker that makes a transaction a bulk one, its base token, and the block
 * its history starts at. Nothing else a version says about a market reaches a
 * history item.
 */
function historyKeyOf(network: NetworkV1, served: ServedMarket[]): string {
  const markets = served
    .map(market => [
      market.contracts.comet, market.contracts.rewards, market.contracts.bulker,
      market.baseAsset.token.address, market.creationBlock,
    ].join(':'))
    .sort();
  const tokens = [ ...new Set(served.flatMap(tokensOf).map(token => `${token.address}:${token.symbol}:${token.decimals}`)) ].sort();
  const renames = renamesOf(network).map(override => `${override.tokenAddress}=${override.symbol}`).sort();
  return keccak256(canonicalJson({ markets, tokens, renames })).slice(0, 16);
}

/*
 * Materializes a snapshot once per request. Building the contract objects is
 * cheap, and holding one catalog for the whole request is what keeps every
 * computation of that request on the same version.
 */
function catalogOf(snapshot: RegistrySnapshotV1, now: Date = new Date()): Catalog {
  const asOf = now.getTime();
  const markets: CatalogMarket[] = [];
  const networks: NetworkV1[]    = [];
  // every token of the version, by network and lowercased address
  const tokens = new Map<string, TokenV1>();
  const bases  = new Map<string, TokenV1>();
  /*
   * Markets by network and Comet address. Transaction history resolves a
   * stream's contracts for every stream on every merge step, so this lookup
   * is on a hot path and must not be a scan of the whole version.
   */
  const byComet = new Map<string, CatalogMarket>();
  const byNetworkMarkets = new Map<string, CatalogMarket[]>();
  // the expiries still to come, each of which changes what the catalog applies
  const expiries: number[] = [];
  // what transaction history reads of each network, which its cache key is made of
  const historyKeys = new Map<string, string>();

  for (const { network, markets: served } of servedNetworks(snapshot)) {
    const name = networkName(network);
    if (name === null) {
      // a network this API cannot name is not one it can serve
      continue;
    }
    networks.push(network);
    historyKeys.set(name, historyKeyOf(network, served));
    const exceptions = applicableExceptions(network.priceExceptions, asOf);
    expiries.push(...exceptions.map(expiryOf).filter((expiry): expiry is number => expiry !== null));

    for (const market of served) {
      const comet = cometOf(name, market, {
        versionId:       snapshot.registryVersion.id,
        chainId:         network.chainId,
        deploymentKey:   market.deploymentKey,
        priceExceptions: exceptions,
      });
      const entry: CatalogMarket = {
        chainId:       network.chainId,
        network:       name,
        deploymentKey: market.deploymentKey,
        market,
        comet,
      };
      markets.push(entry);
      byNetworkMarkets.set(name, [ ...(byNetworkMarkets.get(name) ?? []), entry ]);
      byComet.set(`${name}:${market.contracts.comet}`, entry);
      for (const token of tokensOf(market)) {
        tokens.set(`${name}:${token.address}`, token);
      }
      bases.set(`${name}:${market.contracts.comet}`, market.baseAsset.token);
    }
  }

  const renamed = new Map<string, string>(networks.flatMap(network => renamesOf(network)
    .map(override => [ `${network.key}:${override.tokenAddress}`, override.symbol ] as const)));

  /*
   * A network this API cannot name has no contracts to name a market among,
   * and a market without a Comet has no address to name, so neither is here.
   */
  const unserved: Contract[] = snapshot.networks.flatMap(network => {
    const name = networkName(network);
    return name === null ? [] : network.markets.flatMap(market => (
      isServed(market) || market.contracts.comet === null ? [] : [ UntypedContract('Comet', {
        network:     name,
        address:     shown(market.contracts.comet),
        displayName: contractNameOf(market),
        block:       { number: market.creationBlock },
      }) ]
    ));
  });

  return {
    versionId:     snapshot.registryVersion.id,
    checksum:      snapshot.registryVersion.checksum,
    validUntil:    expiries.length === 0 ? null : Math.min(...expiries),
    key:           () => `registry:${snapshot.registryVersion.checksum.slice(0, 16)}`,
    historyKeyFor: network => `registry:${network}:${historyKeys.get(network) ?? 'none'}`,
    markets:       () => markets,
    networks:      () => networks,
    tokenAt:     (network, address) => tokens.get(`${network}:${address.toLowerCase()}`) ?? null,
    baseTokenAt: (network, address) => bases.get(`${network}:${address.toLowerCase()}`) ?? null,
    renamedSymbolAt: (network, address) => renamed.get(`${network}:${address.toLowerCase()}`) ?? null,
    marketsOn: network => byNetworkMarkets.get(network) ?? [],
    marketAt:  (network, cometAddress) => byComet.get(`${network}:${cometAddress.toLowerCase()}`) ?? null,
    unservedMarkets: () => unserved,
  };
}

export type { Catalog, CatalogMarket, RegistryComet, ServedMarket };
export { catalogOf, isServed, servedNetworks };
