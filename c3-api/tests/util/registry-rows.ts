import { randomUUID } from 'node:crypto';

import { activationStatements } from '../../src/registry/repository.js';

import { Row, changedRows, insertStatement } from './d1.js';
import { sha256Hex } from './registry-fixture.js';

/*
 * What the tests of the APP_DB schema, d1-schema.test.ts and
 * decision-schema.test.ts, build a registry from: rows of its tables, a
 * candidate version made of them, and the statements that validate and
 * activate one.
 */

// the time the rows and the steps below are stamped with
const NOW = '2026-09-17T00:00:00.000Z';

const hex = (seed: string, length: number) => sha256Hex(seed).slice(0, length);
const address = (seed: string) => `0x${hex(seed, 40)}`;

/*
 * Minimal valid rows; tests override single columns to probe one constraint.
 */
type Scope = { registry_version_id: string, network_id: string };

function versionRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    source_repository: 'compound-foundation/comet',
    source_commit_sha: hex(`commit:${id}`, 40),
    source_checksum:   sha256Hex(`source:${id}`),
    attempt:           1,
    status:            'importing',
    created_at:        NOW,
    created_by:        'test',
    ...overrides,
  };
}

function networkRow(scope: Scope, chainId: number, overrides: Row = {}): Row {
  return {
    id:                   scope.network_id,
    registry_version_id:  scope.registry_version_id,
    chain_id:             chainId,
    upstream_network_key: `chain${chainId}`,
    canonical_name:       `chain-${chainId}`,
    display_name:         `Chain ${chainId}`,
    metadata:             '{}',
    ...overrides,
  };
}

function marketRow(id: string, scope: Scope, overrides: Row = {}): Row {
  return {
    id,
    ...scope,
    deployment_key:         'usdc',
    display_name:           'USDC',
    contract_name:          'cUSDCv3',
    creation_block:         1,
    status:                 'enabled',
    collateral_value_quote: 'usd',
    ...overrides,
  };
}

function tokenRow(id: string, scope: Scope, overrides: Row = {}): Row {
  return {
    id,
    ...scope,
    address:  address(`token:${id}`),
    symbol:   'TKN',
    name:     'Token',
    decimals: 18,
    ...overrides,
  };
}

function baseAssetRow(scope: Scope, marketId: string, tokenId: string, overrides: Row = {}): Row {
  return {
    ...scope,
    market_id:           marketId,
    token_id:            tokenId,
    role:                'base',
    price_feed_address:  address('feed:base'),
    price_feed_decimals: 8,
    display_name:        'USD Coin',
    is_wrapped_native:   0,
    ...overrides,
  };
}

function collateralAssetRow(scope: Scope, marketId: string, tokenId: string, overrides: Row = {}): Row {
  return {
    ...scope,
    market_id:           marketId,
    token_id:            tokenId,
    role:                'collateral',
    asset_index:         0,
    price_feed_address:  address('feed:collateral'),
    price_feed_decimals: 8,
    ...overrides,
  };
}

function rewardAssetRow(scope: Scope, marketId: string, tokenId: string, overrides: Row = {}): Row {
  return {
    ...scope,
    market_id:           marketId,
    token_id:            tokenId,
    role:                'reward',
    price_feed_address:  address('feed:reward'),
    price_feed_decimals: 8,
    price_feed_quote:    'usd',
    ...overrides,
  };
}

function priceExceptionRow(scope: Scope, overrides: Row = {}): Row {
  return {
    ...scope,
    price_feed_address: address('feed:broken'),
    kind:               'zero_price',
    provenance:         'reviewed in test',
    ...overrides,
  };
}

type Candidate = Scope & { marketId: string, baseTokenId: string, collateralTokenId: string };

async function insertCandidate(db: D1Database, versionId: string = randomUUID(), chainId: number = 1, version: Row = {}): Promise<Candidate> {
  const scope = { registry_version_id: versionId, network_id: randomUUID() };
  const marketId = randomUUID();
  const baseTokenId = randomUUID();
  const collateralTokenId = randomUUID();
  await db.batch([
    insertStatement(db, 'registry_versions', versionRow(versionId, version)),
    insertStatement(db, 'registry_networks', networkRow(scope, chainId)),
    insertStatement(db, 'markets', marketRow(marketId, scope)),
    insertStatement(db, 'tokens', tokenRow(baseTokenId, scope)),
    insertStatement(db, 'tokens', tokenRow(collateralTokenId, scope)),
    insertStatement(db, 'market_assets', baseAssetRow(scope, marketId, baseTokenId)),
  ]);
  return { ...scope, marketId, baseTokenId, collateralTokenId };
}

async function recordChecks(db: D1Database, versionId: string, attempt: number, outcomes: boolean[]): Promise<void> {
  await db.batch(outcomes.map((passed, index) => insertStatement(db, 'validation_results', {
    registry_version_id: versionId,
    validation_attempt:  attempt,
    check_name:          `check-${index}`,
    scope:               'global',
    passed:              passed ? 1 : 0,
    details:             '{}',
    created_at:          NOW,
  })));
}

async function setStatus(db: D1Database, versionId: string, status: 'validated' | 'invalid'): Promise<D1Result> {
  if (status === 'validated') {
    return db
      .prepare(`UPDATE registry_versions SET status = 'validated', snapshot_checksum = ?1, validated_at = ?2 WHERE id = ?3`)
      .bind(sha256Hex(`snapshot:${versionId}`), NOW, versionId)
      .run();
  }
  return db.prepare(`UPDATE registry_versions SET status = 'invalid' WHERE id = ?1`).bind(versionId).run();
}

async function validate(db: D1Database, versionId: string): Promise<void> {
  await recordChecks(db, versionId, 1, [ true ]);
  await setStatus(db, versionId, 'validated');
}

/*
 * The registry's own activation batch: an audit event and the pointer
 * change, each written only when the pointer differs from the target. It is
 * sent as it is, without the checks activateVersion makes before it, because
 * what refuses a version that is not validated, or a move nobody approved,
 * has to be the schema. A move is made by test-admin at NOW, with no
 * approval, unless it says otherwise.
 */
type Move = { actor?: string, at?: string, approvalId?: string | null };

function activationBatch(
  db: D1Database,
  versionId: string,
  action: 'activate' | 'rollback' = 'activate',
  { actor = 'test-admin', at = NOW, approvalId = null }: Move = {},
): D1PreparedStatement[] {
  return activationStatements(db, { activationId: randomUUID(), versionId, action, actor, reason: 'test', at, approvalId });
}

async function activate(db: D1Database, versionId: string, action: 'activate' | 'rollback' = 'activate', move: Move = {}): Promise<number[]> {
  const results = await db.batch(activationBatch(db, versionId, action, move));
  return results.map(changedRows);
}

async function activeVersionId(db: D1Database): Promise<string | null> {
  return db.prepare('SELECT active_version_id FROM registry_state').first<string | null>('active_version_id');
}

async function run(db: D1Database, sql: string, ...bindings: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...bindings).run();
}

export type { Candidate, Move, Scope };
export {
  NOW,
  activate,
  activationBatch,
  activeVersionId,
  address,
  baseAssetRow,
  collateralAssetRow,
  hex,
  insertCandidate,
  marketRow,
  networkRow,
  priceExceptionRow,
  recordChecks,
  rewardAssetRow,
  run,
  setStatus,
  tokenRow,
  validate,
  versionRow,
};
