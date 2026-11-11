/*
 * The worker a registry test runs in workerd, with the secrets the test gives
 * it.
 *
 * The harness reads c3-api/.dev.vars beneath what a test passes, and a
 * developer's .dev.vars holds their own local settings: admin tokens under
 * their own names, a malformed list among them, and a webhook of their own,
 * which a test that switches a version on would post to — the harness sends
 * a worker's requests out through the host's own fetch. The token list and
 * the webhook are given here, the test's or none, so no test is answered or
 * recorded by somebody's local configuration, nor announces anything.
 */
function registryWorker(secrets: Record<string, string> = {}): { configPath: string, secrets: Record<string, string> } {
  return {
    configPath: './wrangler.toml',
    secrets:    {
      COMET_REGISTRY_ADMIN_TOKENS: '',
      COMET_REGISTRY_WEBHOOK_URL:  '',
      ...secrets,
    },
  };
}

export { registryWorker };
