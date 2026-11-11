/*
 * The worker a registry test runs in workerd, with the secrets the test gives
 * it.
 *
 * The harness reads c3-api/.dev.vars beneath what a test passes, and a
 * developer's .dev.vars holds their own local settings: admin tokens under
 * their own names, a malformed list among them. The list the administrative
 * API reads is given here, the test's or none, so no test is answered or
 * recorded by somebody's local configuration.
 */
function registryWorker(secrets: Record<string, string> = {}): { configPath: string, secrets: Record<string, string> } {
  return {
    configPath: './wrangler.toml',
    secrets:    {
      COMET_REGISTRY_ADMIN_TOKENS: '',
      ...secrets,
    },
  };
}

export { registryWorker };
