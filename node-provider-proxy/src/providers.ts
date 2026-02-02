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
  infuraKey:             string;
  alchemyEthMainnet:     string;
  alchemyArbMainnet:     string;
  alchemyPolygonMainnet: string;
  alchemyRoninMainnet:   string;
  quicknodeBaseMainnet:  string;
  quicknodeBaseMainnetSubdomain: string;
  quicknodeScrollMainnet:  string;
  quicknodeScrollMainnetSubdomain: string;
  quicknodeMantleMainnet:  string;
  quicknodeMantleMainnetSubdomain: string;
  goldskyKey: string;
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
        Goldsky.provide('1', { env: 'goldskyKey' }),
      ],
      'polygon-mainnet':  [
        Infura. provide('polygon-mainnet', { env: 'infuraKey'             }),
        Alchemy.provide('polygon-mainnet', { env: 'alchemyPolygonMainnet' }),
      ],
      'arbitrum-mainnet': [
        Infura. provide('arbitrum-mainnet', { env: 'infuraKey'         }),
        Alchemy.provide('arb-mainnet',      { env: 'alchemyArbMainnet' }),
      ],
      'base-mainnet':     [
        Infura.provide('base-mainnet', { env: 'infuraKey' }),
        Quicknode.provide(
          { env: 'quicknodeBaseMainnetSubdomain' },
          { env: 'quicknodeBaseMainnet'          },
        ),
      ],
      'scroll-mainnet':   [
        Quicknode.provide(
          { env: 'quicknodeScrollMainnetSubdomain' },
          { env: 'quicknodeScrollMainnet'          },
        ),
      ],
      'optimism-mainnet': [
        Infura. provide('optimism-mainnet', { env: 'infuraKey' }),
      ],
      'mantle-mainnet': [
        Quicknode.provide(
          { env: 'quicknodeMantleMainnetSubdomain' },
          { env: 'quicknodeMantleMainnet'          },
        ),
      ],
      'linea-mainnet': [
        Infura. provide('linea-mainnet', { env: 'infuraKey' }),
      ],
      'unichain-mainnet': [
        Infura. provide('unichain-mainnet', { env: 'infuraKey' }),
      ],
      'ronin-mainnet': [
        Alchemy.provide('ronin-mainnet', { env: 'alchemyRoninMainnet' }),
      ],
      // TODO?: configure fallback node providers for testnets?
      'ethereum-sepolia': [ Infura.provide('sepolia',         { env: 'infuraKey' }) ],
      'polygon-mumbai':   [ Infura.provide('polygon-mumbai',  { env: 'infuraKey' }) ],
      'arbitrum-goerli':  [ Infura.provide('arbitrum-goerli', { env: 'infuraKey' }) ],
      'optimism-goerli':  [ Infura.provide('optimism-goerli', { env: 'infuraKey' }) ],
      'base-goerli':      [ Infura.provide('base-goerli',     { env: 'infuraKey' }) ],
      'base-sepolia':     [ Infura.provide('base-sepolia',    { env: 'infuraKey' }) ],
      'linea-goerli':     [ Infura.provide('linea-goerli',    { env: 'infuraKey' }) ],
    },
  });
}

export type {
  ProviderSecrets as Secrets,
};

export {
  instantiate,
};
