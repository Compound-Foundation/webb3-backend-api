import type {
  ProviderSourceWithSubdomain,
  ProviderSecrets,
} from './endpoint.js';

function transformer(secrets: ProviderSecrets<'Alchemy'>) {
  if('subdomain' in secrets) {
    const { key, subdomain } = secrets;
    return `https://${subdomain}.g.alchemy.com/v2/${key}`;
  } else {
    throw new Error('Alchemy configuration requires subdomain');
  }
}

function provide(name: string, source: { env: string }): ProviderSourceWithSubdomain<'Alchemy'> {
  return {
    provider: 'Alchemy',
    key: { source: 'env', value: source.env },
    subdomain: name,
  };
}

const KnownRpcErrors = {
  provider: 'Alchemy',
  errors: {
    PerSecondRateLimitExceeded: {
      code: 429,
      message: (
        `Your app has exceeded its compute units per second capacity.`
        + ` If you have retries enabled, you can safely ignore this message.`
        + ` If not, check out https://docs.alchemy.com/reference/throughput`
      ),
    },
  },
};

export {
  provide,
  transformer,
  KnownRpcErrors,
};
