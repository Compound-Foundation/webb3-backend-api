import {
  Infura,
  Alchemy,
  Quicknode,
  Goldsky,
  instantiate as instantiateEndpoints,
} from '@compound-finance/well-known-node-providers';

/*
 * ProviderSecrets is a mapping of environment variable names to secret
 * values (API keys, etc.) used to construct authenticated node-provider
 * endpoints in `providers.instantiate(..)`.
 */
type ProviderSecrets = {
  // node provider secrets -- should be injected from Cloudflare Secrets
  alchemyEthMainnet:     string;
  alchemyArbMainnet:     string;
  alchemyPolygonMainnet: string;
  alchemyBaseMainnet:    string;
  alchemyScrollMainnet:  string;
  alchemyOptMainnet:     string;
  alchemyMantleMainnet:  string;
  alchemyLineaMainnet:   string;
  alchemyUnichainMainnet:string;
  alchemyRoninMainnet:   string;
  quicknodeEthMainnet:   string;
  quicknodeEthMainnetSubdomain: string;
};

/*
 * providers.instantiate({ ... })
 *
 * given a ProviderSecrets mapping of environment variable names to secret
 * values, instantiate at least one endpoint for each well-known network
 * leveraging every provider available.
 */
function instantiate(env: ProviderSecrets) {
  return instantiateEndpoints({
    context: { env },
    providers: { Alchemy, Infura, Quicknode, Goldsky },
    networkSecrets: {
      /*
       * Note that these are ordered choice: the first provider is
       * preferred over the second, second over the third, etc.
       */
      'ethereum-mainnet': [
        Alchemy.provide('eth-mainnet', { env: 'alchemyEthMainnet' }),
        Quicknode.provide(
          { env: 'quicknodeEthMainnetSubdomain' },
          { env: 'quicknodeEthMainnet'          },
        ),
      ],
      'polygon-mainnet':  [
        Alchemy.provide('polygon-mainnet', { env: 'alchemyPolygonMainnet' }),
      ],
      'arbitrum-mainnet': [
        Alchemy.provide('arb-mainnet', { env: 'alchemyArbMainnet' }),
      ],
      'base-mainnet':     [
        Alchemy.provide('base-mainnet', { env: 'alchemyBaseMainnet' }),
      ],
      'scroll-mainnet':   [
        Alchemy.provide('scroll-mainnet', { env: 'alchemyScrollMainnet' }),
      ],
      'optimism-mainnet': [
        Alchemy.provide('opt-mainnet', { env: 'alchemyOptMainnet' }),
      ],
      'mantle-mainnet': [
        Alchemy.provide('mantle-mainnet', { env: 'alchemyMantleMainnet' }),
      ],
      'linea-mainnet': [
        Alchemy.provide('linea-mainnet', { env: 'alchemyLineaMainnet' }),
      ],
      'unichain-mainnet': [
        Alchemy.provide('unichain-mainnet', { env: 'alchemyUnichainMainnet' }),
      ],
      'ronin-mainnet': [
        Alchemy.provide('ronin-mainnet', { env: 'alchemyRoninMainnet' }),
      ],
      // TODO: So far no active testing on any testnets, so using mainnet for now until
      //       we actually decide on explicit testnets to support.
      'ethereum-sepolia': [ Alchemy.provide('eth-mainnet', { env: 'alchemyEthMainnet' }) ],
      'polygon-mumbai':   [ Alchemy.provide('eth-mainnet', { env: 'alchemyEthMainnet' }) ],
      'arbitrum-goerli':  [ Alchemy.provide('eth-mainnet', { env: 'alchemyEthMainnet' }) ],
      'optimism-goerli':  [ Alchemy.provide('eth-mainnet', { env: 'alchemyEthMainnet' }) ],
      'base-goerli':      [ Alchemy.provide('eth-mainnet', { env: 'alchemyEthMainnet' }) ],
      'base-sepolia':     [ Alchemy.provide('eth-mainnet', { env: 'alchemyEthMainnet' }) ],
      'linea-goerli':     [ Alchemy.provide('eth-mainnet', { env: 'alchemyEthMainnet' }) ],
    },
  });
}

export type {
  ProviderSecrets as Secrets,
};

export {
  instantiate,
};
