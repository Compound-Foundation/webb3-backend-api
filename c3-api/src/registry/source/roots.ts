import * as Fallible     from '../../../lib/fallible/fallible.js';
import * as KnownNetwork from '../../../lib/well-known/networks/network.js';

import {
  Address,
  CONTRACT_ROLES,
  CONTRACT_ROLE_KEYS,
  ContractRole,
  DeploymentPath,
  ParsedRoot,
  isAddress,
  normalizeAddress,
} from '../../../lib/model/comet-registry.js';

import { sha256 } from '../../../lib/hash.js';

import { RegistryError } from '../errors.js';

/*
 * Strict parser for the pinned Comet source: deployment paths, roots.json
 * documents, and the canonical checksums computed from them.
 *
 * Deployment keys are discovered data, but the network directory is not: a
 * root under an unknown network cannot be mapped onto a network this API
 * serves, so it is rejected instead of silently imported. Testnets are out of
 * scope and are therefore absent from the allowlist.
 */
const SUPPORTED_NETWORKS: Record<string, string> = {
  mainnet:  'ethereum-mainnet',
  polygon:  'polygon-mainnet',
  arbitrum: 'arbitrum-mainnet',
  optimism: 'optimism-mainnet',
  base:     'base-mainnet',
  scroll:   'scroll-mainnet',
  mantle:   'mantle-mainnet',
  linea:    'linea-mainnet',
  unichain: 'unichain-mainnet',
  ronin:    'ronin-mainnet',
};

/*
 * roots.json keys the registry stores as market contracts, keyed by the
 * upstream camelCase spelling. Every other key is bridge or deployment
 * tooling: it is validated as an address and included in the checksum, but it
 * is not a registry contract role.
 */
const ROOT_CONTRACT_ROLES: Record<string, ContractRole> = Object.fromEntries(
  CONTRACT_ROLES.map(role => [ CONTRACT_ROLE_KEYS[role], role ])
);

const ENCODER = new TextEncoder();

const DEPLOYMENT_PATH  = /^deployments\/([a-z0-9][a-z0-9-]{0,31})\/([a-z0-9][a-z0-9._-]{0,63})\/roots\.json$/;
const ROOT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// one roots.json is a small flat map; these bounds reject anything unexpected
const MAX_ROOT_BYTES = 64 * 1024;
const MAX_ROOT_KEYS  = 200;

function isSupportedNetworkKey(key: string): boolean {
  return Object.hasOwn(SUPPORTED_NETWORKS, key);
}

/*
 * Maps `deployments/{network}/{deployment}/roots.json` onto the network this
 * API serves. The path shape is validated before the network allowlist, so a
 * malformed path never reports itself as an unsupported network.
 */
function parseDeploymentPath(rootPath: string): DeploymentPath {
  const match = DEPLOYMENT_PATH.exec(rootPath);
  if (match === null) {
    throw new RegistryError('ROOT_PATH_INVALID', `not a deployment roots path: ${rootPath}`, rootPath);
  }
  const [ , upstreamNetworkKey, deploymentKey ] = match as unknown as [ string, string, string ];
  if (!isSupportedNetworkKey(upstreamNetworkKey)) {
    throw new RegistryError(
      'ROOT_NETWORK_UNSUPPORTED',
      `network ${upstreamNetworkKey} is not a supported registry network`,
      rootPath,
    );
  }
  return { rootPath, upstreamNetworkKey, deploymentKey };
}

/*
 * The canonical network name and chain id behind an upstream directory. The
 * allowlist above maps the directory onto a name, and the well-known networks
 * module is the single source of chain ids.
 */
function networkOf(upstreamNetworkKey: string): { name: string, chainId: number } {
  const name = SUPPORTED_NETWORKS[upstreamNetworkKey];
  if (name === undefined) {
    throw new RegistryError(
      'ROOT_NETWORK_UNSUPPORTED',
      `network ${upstreamNetworkKey} is not a supported registry network`,
      upstreamNetworkKey,
    );
  }
  const known = KnownNetwork.lookup({ name });
  if (Fallible.isFailure(known)) {
    throw new RegistryError(
      'ROOT_NETWORK_UNSUPPORTED',
      `network ${name} is not a well-known network of this API`,
      upstreamNetworkKey,
    );
  }
  return { name, chainId: known.chainId };
}

/*
 * Normalized form a checksum is taken over: the path plus every root key with
 * its lowercased address, ordered by key. Keys the registry does not store
 * are included, so renaming or dropping one changes the checksum instead of
 * passing unnoticed.
 */
function canonicalRootDocument(rootPath: string, roots: Record<string, Address>): string {
  const ordered = Object.keys(roots).sort().map(key => [ key, roots[key] ]);
  return JSON.stringify({ rootPath, roots: Object.fromEntries(ordered) });
}

/*
 * Parses one roots.json. `content` is the exact bytes read from the pinned
 * commit, and `sourceBlobSha` is the git object id the tree reported for it.
 */
async function parseRoot(
  path: DeploymentPath,
  content: string,
  sourceBlobSha: string,
): Promise<ParsedRoot> {
  const { rootPath } = path;
  if (ENCODER.encode(content).byteLength > MAX_ROOT_BYTES) {
    throw new RegistryError('SOURCE_CONTENT_TOO_LARGE', `${rootPath} exceeds ${MAX_ROOT_BYTES} bytes`, rootPath);
  }

  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    throw new RegistryError('ROOT_DOCUMENT_INVALID', `${rootPath} is not valid JSON`, rootPath);
  }
  if (typeof(document) !== 'object' || document === null || Array.isArray(document)) {
    throw new RegistryError('ROOT_DOCUMENT_INVALID', `${rootPath} is not a JSON object`, rootPath);
  }

  const entries = Object.entries(document as Record<string, unknown>);
  if (entries.length === 0) {
    throw new RegistryError('ROOT_DOCUMENT_INVALID', `${rootPath} declares no contracts`, rootPath);
  }
  if (entries.length > MAX_ROOT_KEYS) {
    throw new RegistryError('ROOT_DOCUMENT_INVALID', `${rootPath} declares more than ${MAX_ROOT_KEYS} keys`, rootPath);
  }

  const roots:      Record<string, Address>            = {};
  const contracts:  Partial<Record<ContractRole, Address>> = {};
  const otherRoots: Record<string, Address>            = {};
  for (const [ key, value ] of entries) {
    if (!ROOT_KEY_PATTERN.test(key)) {
      throw new RegistryError('ROOT_DOCUMENT_INVALID', `${rootPath} has a malformed key`, rootPath);
    }
    if (!isAddress(value)) {
      throw new RegistryError('ROOT_DOCUMENT_INVALID', `${rootPath} key ${key} is not an address`, rootPath);
    }
    const address = normalizeAddress(value);
    roots[key] = address;
    const role = ROOT_CONTRACT_ROLES[key];
    if (role === undefined) {
      otherRoots[key] = address;
    } else {
      contracts[role] = address;
    }
  }

  if (contracts.comet === undefined) {
    throw new RegistryError('ROOT_DOCUMENT_INVALID', `${rootPath} declares no comet contract`, rootPath);
  }

  const { name, chainId } = networkOf(path.upstreamNetworkKey);
  return {
    ...path,
    network:  name,
    chainId,
    sourceBlobSha,
    contracts,
    otherRoots,
    checksum: await sha256(canonicalRootDocument(rootPath, roots)),
  };
}

/*
 * The checksum of the complete pinned roots input: every deployment path with
 * the git object id of its roots.json, ordered by path. Object ids are
 * content hashes, so this identifies exactly what the commit declares, and it
 * is known from the tree alone, before any root has been read. That is what
 * lets a resumable import name its source before it has finished reading it.
 */
async function sourceChecksum(roots: Array<{ rootPath: string, sourceBlobSha: string }>): Promise<string> {
  const ordered = [ ...roots ]
    .sort((left, right) => left.rootPath < right.rootPath ? -1 : left.rootPath > right.rootPath ? 1 : 0)
    .map(({ rootPath, sourceBlobSha }) => ({ rootPath, sourceBlobSha }));
  const paths = new Set(ordered.map(({ rootPath }) => rootPath));
  if (paths.size !== ordered.length) {
    throw new RegistryError('ROOT_DUPLICATE', `the pinned source lists a deployment path twice`);
  }
  return sha256(JSON.stringify({ schema: 'comet-registry-source-v1', roots: ordered }));
}

export {
  MAX_ROOT_BYTES,
  isSupportedNetworkKey,
  parseDeploymentPath,
  parseRoot,
  sourceChecksum,
};
