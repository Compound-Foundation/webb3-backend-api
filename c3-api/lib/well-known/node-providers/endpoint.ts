import * as KnownNetwork from '@compound-finance/well-known-networks';

/*
 * Configuration is processed into a map of network -> ordered-choice
 * array of URL endpoints. Applications may consume the endpoints map to
 * select URLs to which to route JSON-RPCs.
 */
type Endpoints<Provider extends string = string> = {
  [Name in KnownNetwork.Name]: ProviderEndpoint<Provider>[];
};

interface ProviderEndpoint<Provider extends string = string> {
  uri:      string,
  provider: Provider,
}

/*
 * A well-known node-endpoint configuration provides transformers for
 * every provider (e.g. infura, alchemy, ...) and at least one set of
 * provider secrets for every well-known network.
 */
interface Configuration<Providers extends string> {
  context: SecretsContext;
  providers: { [Provider in Providers]: ProviderConfiguration };
  networkSecrets: {
    /*
     * Require at least one source of provider secrets, guaranteeing that
     * every network has at least one configured node endpoint.
     */
    [_ in KnownNetwork.Name]: [
      ProviderSource,
      ...ProviderSource[]
    ];
  };
}

/*
 * Transformers for each provider convert ProviderSecrets into a
 * well-formed endpoint URL following the schema for that provider.
 *
 * e.g. ({ subdomain, key }) => `https://${subdomain}.infura.io/v3/${key}`
 */
interface ProviderConfiguration {
  transformer: (secrets: ProviderSecrets) => string;
}

/*
 * Node providers provision access using a subdomain to select a network
 * (e.g. arbitrum-mainnet) and a key to authenticate requests, with
 * the key typically encoded in path of the resulting endpoint URL.
 *
 */
interface ProviderSecretsWithSubdomain<Provider extends string = string> {
  key:       string;
  provider:  Provider;
  subdomain: string;
}

/*
 * SomenNode providers provision access using a chainId to select a 
 * network and a key to authenticate requests, with the key typically
 * encoded in path of the resulting endpoint URL.
 *
 */
interface ProviderSecretsWithChainId<Provider extends string = string> {
  key:       string;
  provider:  Provider;
  chainId:   string;
}

type ProviderSecrets<_Provider extends string = string> = ProviderSecretsWithSubdomain | ProviderSecretsWithChainId;

/*
 * Rather than write provider secrets directly in configuration, typically
 * they should be loaded from encrypted storage or injected into the
 * runtime environment by a secrets management process.
 *
 * A secrets source declaratively points the application to the secrets
 * needed to authenticate against providers.
 *
 */
interface ProviderSourceWithSubdomain<Provider extends string = string> {
  provider: Provider;
  // secret keys cannot be strings, to prevent leaks in code.
  key: SourcePath;
  subdomain: (
    | string     // the provider subdomain may be a constant string...
    | SourcePath // ... or it may be loaded from a source path
  );
}

interface ProviderSourceWithChainId<Provider extends string = string> {
  provider: Provider;
  // secret keys cannot be strings, to prevent leaks in code.
  key: SourcePath;
  chainId: string;
}

type ProviderSource = ProviderSourceWithSubdomain | ProviderSourceWithChainId;

/*
 * A secret can be loaded from a source path, such as the name of a
 * variable in the process environment.
 */
interface SourcePath {
  source: 'env';
  value:  string;
}

/*
 * Secrets are loaded from a secrets context. For now, this is just the
 * environment variable mapping.
 */
interface SecretsContext {
  env: { [key: string]: string };
}

/*
 * An Endpoints map can be instantiated given a provider configuration map
 * containing the required secrets to authenticate against at least one
 * provider for every well-known network.
 */
const networkNames = KnownNetwork.networks.map(KnownNetwork.canonicalNameOf);
function instantiate<Providers extends string>
  (configuration: Configuration<Providers>)
  : Endpoints<Providers>
{
  /*
   * Node endpoints are ordered choice. If you want to change the preferred
   * endpoint for a network, change its order in the list to rank it higher.
   */
  const resolveEndpoints = resolverFactory(configuration);
  return networkNames.reduce(
    (endpoints, network) => {
      endpoints[network] = resolveEndpoints(network);
      return endpoints;
    },
    {} as Endpoints<Providers>
  );
}

/*
 * resolverFactory produces an endpoint resolver for a configuration.
 *
 * Given a well-known node endpoint configuration, a generic resolver
 * function is generated that loads secrets to produce endpoint URLs.
 */
function resolverFactory<Providers extends string>
  ({ networkSecrets, providers, context }: Configuration<Providers>)
{
  return function resolve<Name extends KnownNetwork.Name>(name: Name) {
    return networkSecrets[name].map(source => {
      const secrets = loadSource({ source, context });
      return {
        uri: providers[secrets.provider as Providers].transformer(secrets),
        provider: secrets.provider as Providers,
      };
    });
  }
}

/*
 * Paths in a secrets source must be loaded from the secrets context
 * before provider endpoints can be constructed. Context must include the
 * process environment, but could be extended to support filesystem paths
 * or external secrets managers like AWS Secrets Manager.
 */
function loadSource({ source, context }: {
  source:  ProviderSource,
  context: SecretsContext,
})
  : ProviderSecrets
{
  if ('subdomain' in source) {
    return {
      provider: source.provider,
      key: loadSecretFromContext({ path: source.key, context }),
      subdomain: ( // if subdomain is just a string, no need to load
        typeof(source.subdomain) === 'string'
          ? source.subdomain
          : loadSecretFromContext({ path: source.subdomain, context })
      ),
    };
  } else {
    return {
      provider: source.provider,
      key: loadSecretFromContext({ path: source.key, context }),
      chainId: ( // if chainId is just a string, no need to load
        typeof(source.chainId) === 'string'
          ? source.chainId
          : loadSecretFromContext({ path: source.chainId, context })
      ),
    };
  }
}

function loadSecretFromContext({ path, context }: {
  path:    SourcePath,
  context: SecretsContext,
}): string {
  switch (path.source) {
    case 'env':
      if (!(path.value in context.env)) {
        throw new Error(`${path.value} not found in environment`);
      }
      return context.env[path.value];
  }
}

export {
  loadSource,
  instantiate,
};

export type {
  Endpoints,
  Configuration,
  SecretsContext,
  ProviderSource,
  ProviderSourceWithSubdomain,
  ProviderSourceWithChainId,
  ProviderSecrets,
  ProviderSecretsWithSubdomain,
  ProviderSecretsWithChainId,
  ProviderEndpoint,
};
