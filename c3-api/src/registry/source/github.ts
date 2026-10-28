import {
  DeploymentPath,
  ParsedRoot,
  isCommitSha,
} from '../../../lib/model/comet-registry.js';

import { RegistryError, RegistryErrorCode } from '../errors.js';
import {
  MAX_ROOT_BYTES,
  isSupportedNetworkKey,
  parseDeploymentPath,
  parseRoot,
} from './roots.js';

/*
 * Reads one pinned commit of the Comet repository over the GitHub HTTPS APIs.
 * A Worker cannot clone a repository, so the registry resolves a ref to an
 * immutable commit, lists the deployment tree at that commit, and reads each
 * roots.json from raw content.
 *
 * Every response is bounded and verified: a truncated tree is refused rather
 * than imported as a complete registry, and each file is checked against the
 * git object id the tree reported for it.
 */
type RegistryFetch = (url: string, init?: RequestInit) => Promise<Response>;

type SourceConfig = {
  repository: string,
  ref:        string,
  token?:     string,
  fetch:      RegistryFetch,
  // how long one request may take, its body included; REQUEST_TIMEOUT_MS unless a test needs less
  timeoutMs?: number,
};

type TreeEntry = {
  path: string,
  type: string,
  sha:  string,
  size?: number,
};

const API_ORIGIN = 'https://api.github.com';
const RAW_ORIGIN = 'https://raw.githubusercontent.com';

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REF_PATTERN        = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;

// the deployment tree is a few hundred entries; these bounds refuse anything
// that no longer looks like the Comet repository
const MAX_TREE_BYTES  = 8 * 1024 * 1024;
const MAX_TREE_ENTRIES = 50_000;
const MAX_ROOT_FILES   = 500;

/*
 * How long one request may take, from asking to the last byte of the answer.
 * GitHub ends an API request it takes more than ten seconds to process, and
 * the largest answer, the tree, is a few hundred kilobytes; a request still
 * open after twice that is not going to be answered. Without a deadline it
 * would hold the import's run, and every sync that wants it, for as long as
 * the connection stayed open.
 */
const REQUEST_TIMEOUT_MS = 20_000;

const ENCODER = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [ ...new Uint8Array(buffer) ]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

/*
 * The git object id of a blob: sha1 over `blob {byte length}\0{content}`.
 * Recomputing it locally proves the content belongs to the tree entry the
 * pinned commit lists, without trusting the raw content host separately.
 */
async function gitBlobSha(content: string): Promise<string> {
  const body   = ENCODER.encode(content);
  const header = ENCODER.encode(`blob ${body.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + body.byteLength);
  object.set(header, 0);
  object.set(body, header.byteLength);
  return hex(await crypto.subtle.digest('SHA-1', object));
}

// whether a configured repository names one, as owner/repository
function isRepository(repository: string): boolean {
  return REPOSITORY_PATTERN.test(repository);
}

// whether a configured ref can name a branch, a tag or a commit of it
function isRef(ref: string): boolean {
  return REF_PATTERN.test(ref) && !ref.includes('..');
}

/*
 * GitHub owner and repository names are case-insensitive, so the identifier
 * is stored lowercase: a casing difference must never create a second source.
 */
function normalizeRepository(repository: string): string {
  if (!isRepository(repository)) {
    throw new RegistryError(
      'SOURCE_CONFIGURATION_INVALID',
      `COMET_SOURCE_REPOSITORY must be owner/repository`,
    );
  }
  return repository.toLowerCase();
}

function assertRef(ref: string): string {
  if (!isRef(ref)) {
    throw new RegistryError('SOURCE_CONFIGURATION_INVALID', `COMET_SOURCE_REF is not a valid git ref`);
  }
  return ref;
}

function requestHeaders(config: SourceConfig, accept: string): HeadersInit {
  const headers: Record<string, string> = {
    'Accept':     accept,
    // GitHub rejects API requests without a user agent
    'User-Agent': 'compound-v3-api-registry',
  };
  if (config.token !== undefined && config.token.length > 0) {
    headers['Authorization'] = `Bearer ${config.token}`;
  }
  return headers;
}

/*
 * Performs one bounded GitHub request. The error never carries the body
 * GitHub answered: a refusal names its status, and the rate limit when that
 * is why (refusalOf).
 */
type ReadOptions = {
  accept:   string,
  maxBytes: number,
  scope:    string,
  /*
   * How to classify a missing ref or commit. GitHub answers 422 for a ref or
   * tree it cannot resolve and 404 for a comparison against a commit outside
   * this repository's fork network. Both are permanent; every other error
   * status may be transient and keeps the generic request failure.
   */
  missing?: { code: RegistryErrorCode, message: string },
};

/*
 * A request the source did not answer: it threw, or its deadline passed
 * before the answer was whole. What failed underneath — a refused
 * connection, the deadline, a Worker out of subrequests — is the cause, for
 * the logs, where it is the only way to tell those apart; D1 and the answer
 * keep the message, which says when it was the deadline.
 */
function unanswered(error: unknown, deadline: AbortSignal, timeout: number, scope: string): RegistryError {
  const message = deadline.aborted
    ? `the comet source did not answer within ${timeout / 1000} seconds`
    : `request to the comet source failed`;
  return new RegistryError('SOURCE_REQUEST_FAILED', message, scope, { cause: error });
}

/*
 * Why the source refused a request, as an operator needs to read it.
 *
 * GitHub refuses a request over its rate limit with 403 or 429, which would
 * otherwise read like any other refusal. The hourly allowance is used up when
 * `x-ratelimit-remaining` is 0, until the moment `x-ratelimit-reset` names; a
 * burst over its secondary limit says in `retry-after` how many seconds to
 * wait. Without a token the allowance is 60 requests an hour per address,
 * which a Worker shares with others, so the message says when the token is
 * what is missing.
 */
function refusalOf(response: Response, config: SourceConfig): string {
  const answered = `the comet source answered ${response.status}`;
  if (response.status !== 403 && response.status !== 429) {
    return answered;
  }
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    return [
      `${answered}: its rate limit is used up`,
      Number.isInteger(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : '',
      config.token === undefined || config.token.length === 0 ? `; without COMET_GITHUB_TOKEN it allows 60 requests an hour` : '',
    ].join('');
  }
  const wait = Number(response.headers.get('retry-after') ?? '');
  if (response.headers.has('retry-after') && Number.isInteger(wait) && wait >= 0) {
    return `${answered}: too many requests at once; it asks to wait ${wait} seconds`;
  }
  return answered;
}

async function read(
  config: SourceConfig,
  url: string,
  { accept, maxBytes, scope, missing }: ReadOptions,
): Promise<string> {
  /*
   * One deadline for the whole request. The signal ends the answer's body as
   * well, so an answer whose headers arrive and whose body then stalls is cut
   * when one that never starts would be.
   */
  const timeout  = config.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeout);
  let response: Response;
  try {
    response = await config.fetch(url, { headers: requestHeaders(config, accept), signal: deadline });
  } catch (error) {
    throw unanswered(error, deadline, timeout, scope);
  }
  if ((response.status === 404 || response.status === 422) && missing !== undefined) {
    throw new RegistryError(missing.code, missing.message, scope);
  }
  if (!response.ok) {
    throw new RegistryError('SOURCE_REQUEST_FAILED', refusalOf(response, config), scope);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new RegistryError('SOURCE_CONTENT_TOO_LARGE', `response exceeds ${maxBytes} bytes`, scope);
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw unanswered(error, deadline, timeout, scope);
  }
  if (ENCODER.encode(body).byteLength > maxBytes) {
    throw new RegistryError('SOURCE_CONTENT_TOO_LARGE', `response exceeds ${maxBytes} bytes`, scope);
  }
  return body;
}

async function readJson<T>(
  config: SourceConfig,
  url: string,
  options: Omit<ReadOptions, 'accept'>,
): Promise<T> {
  const body = await read(config, url, { accept: 'application/vnd.github+json', ...options });
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new RegistryError('SOURCE_RESPONSE_INVALID', `the comet source returned invalid JSON`, options.scope);
  }
}

/*
 * Resolves the configured ref to the commit it points at. A branch name is
 * discovery input only: the resolved SHA is what the candidate records.
 */
async function resolveRef(config: SourceConfig): Promise<string> {
  const repository = normalizeRepository(config.repository);
  const ref        = assertRef(config.ref);
  const url        = `${API_ORIGIN}/repos/${repository}/commits/${encodeURIComponent(ref)}`;
  const body = await read(config, url, {
    // the sha media type answers with the commit id alone
    accept:   'application/vnd.github.sha',
    maxBytes: 1024,
    scope:    ref,
    missing:  { code: 'SOURCE_REF_UNRESOLVED', message: `ref ${ref} does not exist in the comet source` },
  });
  const sha = body.trim();
  if (!isCommitSha(sha)) {
    throw new RegistryError('SOURCE_REF_UNRESOLVED', `ref ${ref} did not resolve to a commit`, ref);
  }
  return sha;
}

/*
 * Confirms an explicitly requested commit is reachable from the configured
 * ref. GitHub serves any commit of a fork network through every repository in
 * it, so a SHA readable here may live only in an unrelated fork. Compare
 * reports how the ref relates to the commit: `identical` is the same commit,
 * `ahead` means the ref descends from it.
 */
async function assertReachableFromRef(config: SourceConfig, sha: string): Promise<void> {
  if (!isCommitSha(sha)) {
    throw new RegistryError('SOURCE_CONFIGURATION_INVALID', `a source commit must be a 40 character sha`, sha);
  }
  const repository = normalizeRepository(config.repository);
  const ref        = assertRef(config.ref);
  const url        = `${API_ORIGIN}/repos/${repository}/compare/${sha}...${encodeURIComponent(ref)}`;
  const comparison = await readJson<{ status?: string }>(config, url, {
    maxBytes: MAX_TREE_BYTES,
    scope:    sha,
    missing:  { code: 'SOURCE_COMMIT_UNREACHABLE', message: `commit ${sha} is not reachable from ${ref}` },
  });
  if (comparison.status !== 'identical' && comparison.status !== 'ahead') {
    throw new RegistryError(
      'SOURCE_COMMIT_UNREACHABLE',
      `commit ${sha} is not reachable from ${ref}`,
      sha,
    );
  }
}

/*
 * Lists the deployment roots of one commit. Paths outside the supported
 * networks are skipped, because deployment directories of unsupported or test
 * networks are not an import failure; a malformed path inside a supported
 * network is.
 */
async function listRootPaths(
  config: SourceConfig,
  commitSha: string,
): Promise<Array<DeploymentPath & { sourceBlobSha: string }>> {
  if (!isCommitSha(commitSha)) {
    throw new RegistryError('SOURCE_CONFIGURATION_INVALID', `a source commit must be a 40 character sha`, commitSha);
  }
  const repository = normalizeRepository(config.repository);
  const url        = `${API_ORIGIN}/repos/${repository}/git/trees/${commitSha}?recursive=1`;
  const tree = await readJson<{ tree?: TreeEntry[], truncated?: boolean }>(config, url, {
    maxBytes: MAX_TREE_BYTES,
    scope:    commitSha,
    missing:  { code: 'SOURCE_COMMIT_UNREACHABLE', message: `commit ${commitSha} has no tree in the comet source` },
  });

  if (tree.truncated === true) {
    throw new RegistryError(
      'SOURCE_TREE_TRUNCATED',
      `the tree of ${commitSha} is truncated and cannot describe a complete registry`,
      commitSha,
    );
  }
  const entries = tree.tree;
  if (!Array.isArray(entries)) {
    throw new RegistryError('SOURCE_RESPONSE_INVALID', `the tree of ${commitSha} has no entries`, commitSha);
  }
  if (entries.length > MAX_TREE_ENTRIES) {
    throw new RegistryError('SOURCE_CONTENT_TOO_LARGE', `the tree of ${commitSha} is too large`, commitSha);
  }

  const roots: Array<DeploymentPath & { sourceBlobSha: string }> = [];
  for (const entry of entries) {
    if (entry.type !== 'blob' || !entry.path?.endsWith('/roots.json')) {
      continue;
    }
    // only the network directory is an allowlist; deployment keys are discovered
    const networkKey = entry.path.split('/')[1];
    if (!entry.path.startsWith('deployments/') || networkKey === undefined || !isSupportedNetworkKey(networkKey)) {
      continue;
    }
    if (!isCommitSha(entry.sha)) {
      throw new RegistryError('SOURCE_RESPONSE_INVALID', `${entry.path} has no git object id`, entry.path);
    }
    if (entry.size !== undefined && entry.size > MAX_ROOT_BYTES) {
      throw new RegistryError('SOURCE_CONTENT_TOO_LARGE', `${entry.path} exceeds ${MAX_ROOT_BYTES} bytes`, entry.path);
    }
    roots.push({ ...parseDeploymentPath(entry.path), sourceBlobSha: entry.sha });
  }

  if (roots.length === 0) {
    throw new RegistryError('SOURCE_RESPONSE_INVALID', `${commitSha} contains no supported deployments`, commitSha);
  }
  if (roots.length > MAX_ROOT_FILES) {
    throw new RegistryError('SOURCE_CONTENT_TOO_LARGE', `${commitSha} contains more than ${MAX_ROOT_FILES} deployments`, commitSha);
  }
  return roots.sort((left, right) => left.rootPath < right.rootPath ? -1 : left.rootPath > right.rootPath ? 1 : 0);
}

/*
 * Reads and parses one roots.json at the pinned commit. The content is
 * rejected unless it hashes to the git object id listed in the tree.
 */
async function readRoot(
  config: SourceConfig,
  commitSha: string,
  path: DeploymentPath & { sourceBlobSha: string },
): Promise<ParsedRoot> {
  const repository = normalizeRepository(config.repository);
  const url        = `${RAW_ORIGIN}/${repository}/${commitSha}/${path.rootPath}`;
  const content = await read(config, url, {
    accept:   'application/vnd.github.raw',
    maxBytes: MAX_ROOT_BYTES,
    scope:    path.rootPath,
  });

  const blobSha = await gitBlobSha(content);
  if (blobSha !== path.sourceBlobSha) {
    throw new RegistryError(
      'SOURCE_BLOB_MISMATCH',
      `${path.rootPath} does not match the object id of the pinned tree`,
      path.rootPath,
    );
  }
  return parseRoot(path, content, path.sourceBlobSha);
}

export type { RegistryFetch, SourceConfig };

export {
  assertReachableFromRef,
  gitBlobSha,
  isRef,
  isRepository,
  listRootPaths,
  normalizeRepository,
  readRoot,
  resolveRef,
};
