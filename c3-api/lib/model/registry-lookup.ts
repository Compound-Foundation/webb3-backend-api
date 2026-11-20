import type * as KnownNetwork from '../well-known/networks/network.js';

import type { Address, MarketV1, RegistryComet, TokenV1 } from './comet-registry.js';

/*
 * What a computation needs from the registry: resolve an address, and say
 * which version it is answering from.
 *
 * The request catalog implements this. It is not the only way computations
 * read the registry: a market computation reads the version's description of
 * its market from the Comet it is handed (`contract.registry` of a
 * RegistryComet), which the same catalog materialized. There is one catalog
 * for the whole request, so every address in one response is resolved
 * against one version. `key()` is what puts that version into the cache keys
 * of a computation given this lookup, and a RegistryComet keys itself by its
 * market's digest: the same addresses described differently are different
 * results.
 */
type ResolvedMarket = {
  market: MarketV1,
  comet:  RegistryComet,
};

type RegistryLookup = {
  key(): string,
  /*
   * The key of what transaction history reads of one network: its markets'
   * contracts, base tokens and creation blocks, and its tokens with their
   * symbols, scales and the names the network renames them to — and nothing
   * else a version says about them, so a change to a feed, an exception or a
   * capability keeps every page of history computed so far.
   */
  historyKeyFor(network: KnownNetwork.Name): string,
  marketAt(network: KnownNetwork.Name, cometAddress: Address): ResolvedMarket | null,
  marketsOn(network: KnownNetwork.Name): ResolvedMarket[],
  tokenAt(network: KnownNetwork.Name, address: Address): TokenV1 | null,
  baseTokenAt(network: KnownNetwork.Name, cometAddress: Address): TokenV1 | null,
  /*
   * The symbol a token is shown by where the network renames it — bridged
   * USDC as USDC.e — and null where it keeps its own. A token shown as the
   * chain's own token instead, WETH as ETH, keeps its own symbol here: that
   * is how the website offers it, not what a transaction moved.
   */
  renamedSymbolAt(network: KnownNetwork.Name, address: Address): string | null,
};

export type { RegistryLookup, ResolvedMarket };
