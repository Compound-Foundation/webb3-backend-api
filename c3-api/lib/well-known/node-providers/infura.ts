import type {
  ProviderSourceWithSubdomain,
  ProviderSecrets,
} from './endpoint.js';

function transformer(secrets: ProviderSecrets<'Infura'>) {
  if('subdomain' in secrets) {
    const { key, subdomain } = secrets;
    return `https://${subdomain}.infura.io/v3/${key}`;
  } else {
    throw new Error('Infura configuration requires subdomain');
  }
}

function provide(name: string, source: { env: string }): ProviderSourceWithSubdomain<'Infura'> {
  return {
    provider: 'Infura',
    key: { source: 'env', value: source.env },
    subdomain: name,
  };
}

const KnownRpcErrors = {
  provider: 'Infura',
  errors: {
    HeaderNotFound: {
      code: -32000,
      message: 'header not found',
    },
  },
};

export {
  provide,
  transformer,
  KnownRpcErrors,
};
