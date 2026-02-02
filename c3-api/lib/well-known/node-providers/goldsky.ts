import type {
  ProviderSourceWithChainId,
  ProviderSecrets,
} from './endpoint.js';

function transformer(secrets: ProviderSecrets<'Goldsky'>) {
  if('chainId' in secrets) {
    const { key, chainId } = secrets;
    return `https://edge.goldsky.com/standard/evm/${chainId}?secret=${key}`;
  } else {
    throw new Error('Goldsky configuration requires chainId');
  }
}

function provide(chainId: string, source: { env: string }): ProviderSourceWithChainId<'Goldsky'> {
  return {
    provider: 'Goldsky',
    key: { source: 'env', value: source.env },
    chainId: chainId,
  };
}

const KnownRpcErrors = {
  provider: 'GoldskyGoldsky',
  errors: {}
};

export {
  provide,
  transformer,
  KnownRpcErrors,
};
