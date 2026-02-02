interface Settings {
  /* whether to mask upstream errors from clients. when true, making
   * errors obscures which upstream providers the proxy is using and
   * prevents clients from depending on upstream-specific error types.
   */
  maskUpstreamErrors: boolean;
  // whether to retry on behalf of the client when activating a fallback
  retryWithActiveFallback: boolean;
  // whether to retry individual failed RPCs on behalf of a client
  retryIndividualFailedRpcs: boolean;
  // default application active fallback expiration time-to-live
  defaultFallbackExpirationTtlSeconds: number;
  // upstream error retry-after delay when no fallback available
  defaultRetryAfterUpstreamErrorSeconds: number;
}

export type { Settings };
