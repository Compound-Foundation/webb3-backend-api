import t from 'tap';

import { makeRedactor, sentryOptions } from '../../lib/sentry.js';

t.test('redacts secret values in nested strings', async t => {
  const redact = makeRedactor(['proxy-key-123456']);
  const span = {
    name: 'POST https://node.example/mainnet/proxy-key-123456',
    attributes: { 'url.full': 'https://node.example/mainnet/proxy-key-123456?x=proxy-key-123456' },
    links: [{ note: 'unrelated' }],
  };
  t.same(redact(span), {
    name: 'POST https://node.example/mainnet/[Filtered]',
    attributes: { 'url.full': 'https://node.example/mainnet/[Filtered]?x=[Filtered]' },
    links: [{ note: 'unrelated' }],
  });
});

t.test('ignores missing and short secret values', async t => {
  const redact = makeRedactor([undefined, '', 'short']);
  t.same(redact({ message: 'a short message' }), { message: 'a short message' });
});

t.test('handles cyclic payloads', async t => {
  const redact = makeRedactor(['proxy-key-123456']);
  const payload: Record<string, unknown> = { url: '/mainnet/proxy-key-123456' };
  payload.self = payload;
  const redacted = redact(payload);
  t.equal(redacted.url, '/mainnet/[Filtered]');
  t.equal(redacted.self, redacted);
});

t.test('options redact the proxy key and sample by environment', async t => {
  const env = {
    SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
    ENVIRONMENT: 'production',
    TALLY_API_KEY: 'tally-key-123456',
    NODE_PROXY_KEY: 'proxy-key-123456',
  };
  const options = sentryOptions(env);
  t.equal(options.environment, 'production');
  t.equal(options.tracesSampleRate, 0.1);
  t.equal(sentryOptions({ ...env, ENVIRONMENT: 'local' }).tracesSampleRate, 1.0);
  const breadcrumb = options.beforeBreadcrumb!({
    category: 'fetch',
    data: { url: 'https://node.example/mainnet/proxy-key-123456' },
  });
  t.same(breadcrumb, {
    category: 'fetch',
    data: { url: 'https://node.example/mainnet/[Filtered]' },
  });
});
