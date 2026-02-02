import type {
  ProviderSourceWithSubdomain,
  ProviderSecrets,
} from './endpoint.js';

function transformer(secrets: ProviderSecrets<'Quicknode'>) {
  if('subdomain' in secrets) {
    const { key, subdomain } = secrets;
    return `https://${subdomain}.quiknode.pro/${key}/`;
  } else {
    throw new Error('Quicknode configuration requires subdomain');
  }
}

function provide(subdomain: { env: string }, source: { env: string }): ProviderSourceWithSubdomain<'Quicknode'> {
  return {
    provider: 'Quicknode',
    key:       { source: 'env', value: source.env    },
    subdomain: { source: 'env', value: subdomain.env },
  };
}

const KnownRpcErrors = {
  provider: 'Quicknode',
  errors: {
    PerSecondRateLimitExceeded: {
      code: -32007,
      message: (
        `/second request limit reached - reduce calls per second`
        + ` or upgrade your account at quicknode.com`
      )
    },
  },
};

export {
  provide,
  transformer,
  KnownRpcErrors,
};
