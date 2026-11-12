import type * as KnownNetwork from '../well-known/networks/network.js';

import {
  Contract,
  ERC20,
  PriceFeed,
  StandaloneContract,
} from '../well-known/contracts/types.js';

import type { PriceFeedV1, TokenV1 } from './comet-registry.js';
import { checksumAddress } from './comet-registry.js';

/*
 * A token and a price feed of a registry version, in the contract shapes the
 * static constants use: what the request catalog builds its Comets of, and
 * what governance names a proposal's tokens and feeds by.
 *
 * Addresses are checksummed, the form the API answered with before the
 * registry; the registry stores them lowercased, and every lookup and cache
 * key keeps comparing that form.
 */

/*
 * The registry's `name` goes into `description`, which is where the static
 * constants put the human name of a token ("USD Coin" beside the symbol
 * "USDC") and where the market rewards computation reads it from.
 * `displayName` stays unset, so a token still reads as its symbol wherever a
 * contract is named.
 */
function tokenContract(
  network: KnownNetwork.Name,
  token: TokenV1,
  creationBlock: number,
): Contract<StandaloneContract<ERC20>> {
  return ERC20(token.symbol, {
    network,
    address:     checksumAddress(token.address),
    decimals:    token.decimals,
    description: token.name,
    block:       { number: creationBlock },
  }) as unknown as Contract<StandaloneContract<ERC20>>;
}

function feedContract(
  network: KnownNetwork.Name,
  feed: PriceFeedV1,
  creationBlock: number,
): Contract<StandaloneContract<PriceFeed>> {
  return PriceFeed({
    network,
    address:  checksumAddress(feed.address),
    decimals: feed.decimals,
    block:    { number: creationBlock },
  }) as unknown as Contract<StandaloneContract<PriceFeed>>;
}

export { feedContract, tokenContract };
