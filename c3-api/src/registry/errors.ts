/*
 * Registry ingestion errors. A code classifies the failure for validation
 * results and sync diagnostics; the message is safe to persist and to return
 * to an authenticated admin, so it never carries a token, a raw upstream
 * body, or a full response.
 */
type RegistryErrorCode = (
  // configuration or requested source is unusable
  | 'SOURCE_CONFIGURATION_INVALID'
  | 'SOURCE_REF_UNRESOLVED'
  | 'SOURCE_COMMIT_UNREACHABLE'
  // the source did not answer, or refused the request with an error status
  | 'SOURCE_REQUEST_FAILED'
  // the source answered, but the answer cannot be trusted
  | 'SOURCE_RESPONSE_INVALID'
  | 'SOURCE_TREE_TRUNCATED'
  | 'SOURCE_CONTENT_TOO_LARGE'
  | 'SOURCE_BLOB_MISMATCH'
  // the pinned content does not describe a registry we can import
  | 'ROOT_PATH_INVALID'
  | 'ROOT_NETWORK_UNSUPPORTED'
  | 'ROOT_DOCUMENT_INVALID'
  | 'ROOT_DUPLICATE'
  // on-chain enrichment could not read what the source declares
  | 'CHAIN_REQUEST_FAILED'
  | 'CHAIN_RESPONSE_INVALID'
  | 'CHAIN_CALL_REVERTED'
  | 'CHAIN_CONTRACT_MISSING'
  // the reviewed overlay is unusable
  | 'OVERLAY_INVALID'
  | 'OVERLAY_FEED_UNREADABLE'
  | 'OVERLAY_CREATION_BLOCK_WRONG'
  // the stored candidate is not in the state the caller expected
  | 'CANDIDATE_STATE_CONFLICT'
  // the sync fence refused the work
  | 'SYNC_ALREADY_RUNNING'
);

class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly scope: string;

  /*
   * `scope` names what the failure is about, such as a root path or a
   * network key, and matches the scope recorded in validation_results.
   *
   * `cause` is the failure underneath, such as the HTTP status a node
   * provider answered. Only the logs show it: D1 and the API keep the code
   * and the message.
   */
  constructor(code: RegistryErrorCode, message: string, scope: string = 'global', options: { cause?: unknown } = {}) {
    super(message, options);
    this.name  = 'RegistryError';
    this.code  = code;
    this.scope = scope;
  }
}

function isRegistryError(error: unknown): error is RegistryError {
  return error instanceof RegistryError;
}

/*
 * Whether a failure is about the way the work was carried out rather than
 * about the thing being worked on.
 *
 * The distinction decides whether a root spends one of its five attempts. A
 * root the source or the chain describes wrongly will describe itself the
 * same way next time, so every attempt at it is worth spending. A node
 * provider that did not answer, or an invocation that ran out of the
 * subrequests or the time a Worker is given, says nothing about the root: it
 * is the same work, interrupted. Spending attempts on those is how an import
 * of a large source exhausts every root's budget without ever reading it, and
 * ends with a candidate that can never be completed.
 *
 * The set is deliberately narrow. A revert or an unreadable answer stays a
 * spent attempt, because it usually is the contract, and a run that never
 * spends an attempt would retry forever — which is what the `sync-stalled`
 * alert watches for. D1 restarted or overloaded under a root, which says so
 * in words of its own rather than a network's, is a spent attempt too.
 */
const TRANSPORT_CODES: ReadonlySet<RegistryErrorCode> = new Set([
  // the node provider did not answer
  'CHAIN_REQUEST_FAILED',
  /*
   * The source did not answer either — the request threw, or GitHub refused
   * it with a status. A root is read from GitHub before it is read from the
   * chain, so this is the first thing that fails when an invocation runs out
   * of the subrequests it is given, and it says as little about the root as a
   * provider timing out does.
   */
  'SOURCE_REQUEST_FAILED',
]);

// what a Worker or a network says when it is the carrier that failed, not the payload
const INFRASTRUCTURE = /too many subrequests|exceeded .*cpu|network connection lost|fetch failed|connection (reset|refused|closed)|\btimed? ?out\b/i;

function isTransportFailure(error: unknown): boolean {
  if (isRegistryError(error)) {
    return TRANSPORT_CODES.has(error.code);
  }
  return error instanceof Error && INFRASTRUCTURE.test(error.message);
}

export type { RegistryErrorCode };
export { RegistryError, isRegistryError, isTransportFailure };
