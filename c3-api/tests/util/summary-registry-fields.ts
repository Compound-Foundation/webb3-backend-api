import type { MarketV1 } from '../../lib/model/comet-registry.js';
import { checksumAddress } from '../../lib/model/comet-registry.js';

/*
 * A summary entry held against the market /registry/v1/active served: the
 * same contracts and fields, in the order the summary writes them. A contract
 * or a slug the version has none of is not there.
 */
function contractsBesideComet(market: MarketV1): { rewards?: string, bulker?: string } {
  const { rewards, bulker } = market.contracts;
  return {
    ...(rewards === null ? {} : { rewards: checksumAddress(rewards) }),
    ...(bulker  === null ? {} : { bulker:  checksumAddress(bulker) }),
  };
}

function registryFields(market: MarketV1) {
  return {
    deployment_key:    market.deploymentKey,
    display_name:      market.displayName,
    base_asset_name:   market.baseAsset.displayName,
    is_wrapped_native: market.baseAsset.isWrappedNative,
    ...(market.slug === null ? {} : { slug: market.slug }),
    is_default:        market.isDefault,
    is_institutional:  market.isInstitutional,
  };
}

function onSummary<Entry extends { chain_id: number, comet: { address: string } }>({ chain_id, comet, ...rest }: Entry, market: MarketV1) {
  return { chain_id, comet: { ...comet, ...contractsBesideComet(market) }, ...registryFields(market), ...rest };
}

// the keys of a market of the summary that come from the version, and not from what was read
const REGISTRY_KEYS = [ 'deployment_key', 'display_name', 'base_asset_name', 'is_wrapped_native', 'slug', 'is_default', 'is_institutional' ] as const;

export {
  REGISTRY_KEYS,
  onSummary,
};
