import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import { registryConfig } from '../../../src/registry/config.js';
import { activationStatements } from '../../../src/registry/repository.js';
import type { Env } from '../../../entrypoint.js';
import {
  Row,
  applyMigration,
  applyMigrations,
  changedRows,
  foreignKeyViolations,
  insertRow,
  insertStatement,
} from '../../util/d1.js';
import {
  loadRegistrySnapshotFixture,
  seedCandidate,
  sha256Hex,
} from '../../util/registry-fixture.js';

/*
 * Runs the worker from wrangler.toml in real workerd with local D1, KV, and
 * rate-limit bindings. Every subtest recreates storage and applies the
 * migrations, then checks that migration 0001 enforces the registry
 * invariants in the database itself rather than in application code.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

async function freshEnv(): Promise<Env> {
  await server.reset();
  const env = await server.getWorker<Env>().getEnv();
  await applyMigrations(env.APP_DB);
  return env;
}

const NOW = '2026-09-17T00:00:00.000Z';

const APPLICATION_TABLES = [
  'registry_versions',
  'registry_state',
  'registry_networks',
  'network_price_exceptions',
  'markets',
  'tokens',
  'market_contracts',
  'market_assets',
  'validation_results',
  'registry_overlay_events',
  'registry_activations',
  'sync_runs',
  'sync_run_items',
];

const NOT_IMPORTING = { message: /registry version is not importing/ };
const CHECK_FAILED = { message: /CHECK constraint failed/ };
const UNIQUE_FAILED = { message: /UNIQUE constraint failed/ };
const FOREIGN_KEY_FAILED = { message: /FOREIGN KEY constraint failed/ };

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

async function insertCandidate(db: D1Database, versionId: string = randomUUID(), chainId: number = 1): Promise<Candidate> {
  const scope = { registry_version_id: versionId, network_id: randomUUID() };
  const marketId = randomUUID();
  const baseTokenId = randomUUID();
  const collateralTokenId = randomUUID();
  await db.batch([
    insertStatement(db, 'registry_versions', versionRow(versionId)),
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
 * what refuses a version that is not validated has to be the schema.
 */
function activationBatch(db: D1Database, versionId: string, action: 'activate' | 'rollback' = 'activate'): D1PreparedStatement[] {
  return activationStatements(db, { activationId: randomUUID(), versionId, action, actor: 'test-admin', reason: 'test', at: NOW });
}

async function activate(db: D1Database, versionId: string, action: 'activate' | 'rollback' = 'activate'): Promise<number[]> {
  const results = await db.batch(activationBatch(db, versionId, action));
  return results.map(changedRows);
}

async function activeVersionId(db: D1Database): Promise<string | null> {
  return db.prepare('SELECT active_version_id FROM registry_state').first<string | null>('active_version_id');
}

async function count(db: D1Database, table: string, where: string = '1 = 1', ...bindings: unknown[]): Promise<number> {
  const value = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...bindings).first<number>('n');
  return value ?? 0;
}

async function run(db: D1Database, sql: string, ...bindings: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...bindings).run();
}

// the settings the registry reads from the environment, by the names wrangler.toml sets them under
const REGISTRY_SETTINGS = [
  'COMET_SOURCE_REPOSITORY',
  'COMET_SOURCE_REF',
  'COMET_UPSTREAM_CHECK_INTERVAL_S',
  'COMET_SYNC_MARKETS_PER_INVOCATION',
  'COMET_SYNC_LEASE_SECONDS',
  'REGISTRY_SNAPSHOT_CACHE_TTL_S',
  'REGISTRY_STALE_FALLBACK_MAX_S',
] as const;

t.test('the worker boots in workerd with the registry bindings', async t => {
  const env = await freshEnv();

  const preflight = await server.fetch('/', { method: 'OPTIONS' });
  t.equal(preflight.status, 204, 'legacy preflight still answers');
  t.equal(preflight.headers.get('x-content-type-options'), 'nosniff', 'security headers still apply');

  /*
   * Discovery only asks upstream once per interval, so recording a check
   * first keeps this test off the network while still running the real cron
   * handler.
   */
  await env.APP_DB.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();

  const scheduled = await server.getWorker<Env>().scheduled({ cron: '0 * * * *', scheduledTime: new Date() });
  t.equal(scheduled.outcome, 'ok', 'the cron handler runs');
  t.equal(
    await env.APP_DB.prepare(`SELECT COUNT(*) AS n FROM sync_runs`).first<number>('n'),
    0,
    'and starts no import while upstream was checked recently',
  );

  /*
   * wrangler.toml sets every registry setting, and sets it to something the
   * registry takes. What each value is stays wrangler.toml's to decide.
   */
  for (const name of REGISTRY_SETTINGS) {
    t.notSame(String(env[name] ?? '').trim(), '', `${name} comes from wrangler.toml`);
  }
  t.same(registryConfig(env).invalid, [], 'and the registry takes every one of them');

  const limited = await env.REGISTRY_ADMIN_RATE_LIMITER.limit({ key: 'registry-admin:test:sync' });
  t.equal(limited.success, true, 'the admin rate limiter is bound');
  const addressed = await env.REGISTRY_ADMIN_AUTH_RATE_LIMITER.limit({ key: 'registry-admin-auth:test' });
  t.equal(addressed.success, true, 'and so is the one every admin request spends from before its token is checked');

  await env.kv_registry.put('probe', 'registry');
  t.equal(await env.kv_registry.get('probe'), 'registry', 'the registry KV is bound');
  t.equal(await env.kv_mainnet.get('probe'), null, 'the registry KV is separate from the computation cache');
});

t.test('migration 0001 creates strict tables and an empty active pointer', async t => {
  const { APP_DB: db } = await freshEnv();

  const tables = await db.prepare(`PRAGMA table_list`).all<{ schema: string, name: string, strict: number }>();
  const strictness = Object.fromEntries(
    (tables.results ?? [])
      .filter(table => table.schema === 'main' && APPLICATION_TABLES.includes(table.name))
      .map(table => [ table.name, table.strict ])
  );
  t.same(strictness, Object.fromEntries(APPLICATION_TABLES.map(name => [ name, 1 ])), 'every table exists and is STRICT');

  const partialIndexes = await db.prepare(
    `SELECT name FROM sqlite_schema WHERE type = 'index' AND sql LIKE '%WHERE%' ORDER BY name`
  ).all<{ name: string }>();
  t.same((partialIndexes.results ?? []).map(index => index.name), [
    'market_assets_collateral_index',
    'market_assets_single_base',
    'market_assets_single_reward',
    'markets_one_default_per_version',
    'markets_slug_per_network',
    'sync_runs_only_one_running',
  ], 'partial unique indexes exist');

  const added = await db.prepare(
    `SELECT name FROM pragma_table_info('markets') WHERE name = 'reviewed'
     UNION ALL SELECT name FROM pragma_table_info('registry_networks') WHERE name = 'reviewed'
     UNION ALL SELECT name FROM pragma_table_info('sync_runs') WHERE name = 'hold_for_review'`
  ).all<{ name: string }>();
  t.equal((added.results ?? []).length, 3, 'migration 0002 adds the review flags and the hold');

  const listing = await db.prepare(
    `SELECT name FROM pragma_table_info('markets') WHERE name IN ('slug', 'is_institutional') ORDER BY name`
  ).all<{ name: string }>();
  t.same((listing.results ?? []).map(row => row.name), [ 'is_institutional', 'slug' ],
    'migration 0003 adds how the frontend lists a market');

  const unused = await db.prepare(
    `SELECT name FROM pragma_table_info('sync_runs') WHERE name = 'lease_generation'
     UNION ALL SELECT name FROM pragma_table_info('sync_run_items') WHERE name IN ('claim_generation', 'root_checksum')
     UNION ALL SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN (
       'tokens_network_symbol_lookup', 'market_contracts_role_address_lookup', 'sync_run_items_fence_lookup'
     )`
  ).all<{ name: string }>();
  t.same(unused.results ?? [], [], 'migration 0004 drops the columns and indexes nothing uses');

  const state = await db.prepare('SELECT singleton_id, active_version_id FROM registry_state').all();
  t.same(
    state.results,
    [ { singleton_id: 1, active_version_id: null } ],
    'the singleton pointer is seeded without an active version',
  );
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

t.test('the fixture snapshot seeds, validates, activates, and rolls back', async t => {
  const { APP_DB: db } = await freshEnv();
  const snapshot = loadRegistrySnapshotFixture();

  const first = await seedCandidate(db, snapshot);
  for (const [ table, expected ] of Object.entries(first.counts)) {
    t.equal(await count(db, table), expected, `${table} holds every seeded row`);
  }
  const markets = snapshot.networks.flatMap(network => network.markets);
  t.equal(await count(db, 'markets'), markets.length, 'one row per fixture market');
  t.equal(
    await count(db, 'market_assets'),
    markets.reduce((total, market) => total + 1 + (market.rewardAsset ? 1 : 0) + market.collateralAssets.length, 0),
    'one asset row per base, reward, and collateral asset',
  );

  const order = await db.prepare(
    `SELECT network.chain_id AS chain_id, market.deployment_key AS deployment_key
     FROM markets AS market
     JOIN registry_networks AS network ON network.id = market.network_id
     WHERE market.registry_version_id = ?1
     ORDER BY network.chain_id, market.creation_block, market.deployment_key`
  ).bind(first.versionId).all<{ chain_id: number, deployment_key: string }>();
  t.same(
    (order.results ?? []).map(row => `${row.chain_id}/${row.deployment_key}`),
    snapshot.networks.flatMap(network => network.markets.map(market => `${network.chainId}/${market.deploymentKey}`)),
    'columns reproduce the snapshot order',
  );

  const weth = markets.find(market => market.deploymentKey === 'weth' && market.contractName === 'cWETHv3')!;
  t.same(
    await db.prepare(
      `SELECT asset.display_name, asset.is_wrapped_native, asset.usd_price_feed_address
       FROM market_assets AS asset
       JOIN markets AS market ON market.id = asset.market_id
       WHERE asset.role = 'base' AND market.registry_version_id = ?1 AND market.deployment_key = 'weth'`
    ).bind(first.versionId).first(),
    { display_name: 'Ether', is_wrapped_native: 1, usd_price_feed_address: weth.baseAsset.usdPriceFeed!.address },
    'the base row stores the base display fields and USD conversion',
  );

  await recordChecks(db, first.versionId, 1, [ true, true ]);
  await setStatus(db, first.versionId, 'validated');
  t.same(await activate(db, first.versionId), [ 1, 1 ], 'first activation writes the event and the pointer');
  t.equal(await activeVersionId(db), first.versionId);
  t.same(await activate(db, first.versionId), [ 0, 0 ], 're-activating the active version changes nothing');

  const second = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await validate(db, second.versionId);
  t.same(await activate(db, second.versionId), [ 1, 1 ]);
  t.same(await activate(db, first.versionId, 'rollback'), [ 1, 1 ], 'rollback moves the pointer back');
  t.equal(await activeVersionId(db), first.versionId);

  const history = await db.prepare(
    `SELECT registry_version_id, previous_version_id, action FROM registry_activations ORDER BY rowid`
  ).all();
  t.same(history.results, [
    { registry_version_id: first.versionId,  previous_version_id: null,              action: 'activate' },
    { registry_version_id: second.versionId, previous_version_id: first.versionId,   action: 'activate' },
    { registry_version_id: first.versionId,  previous_version_id: second.versionId,  action: 'rollback' },
  ], 'every pointer change is audited');
  t.equal(await count(db, 'registry_versions', `status = 'validated'`), 2, 'rollback keeps both versions validated');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

t.test('the version lifecycle is closed', async t => {
  const { APP_DB: db } = await freshEnv();

  await t.rejects(
    () => insertRow(db, 'registry_versions', versionRow(randomUUID(), { status: 'validated', snapshot_checksum: hex('x', 64), validated_at: NOW })),
    { message: /must start as importing/ },
    'a version cannot be created validated',
  );

  const { registry_version_id: versionId } = await insertCandidate(db);
  await t.resolves(
    () => run(db, `UPDATE registry_versions SET snapshot_checksum = ?1 WHERE id = ?2`, hex('candidate', 64), versionId),
    'an importing candidate may replace its snapshot checksum',
  );
  for (const [ column, value ] of [
    [ 'source_commit_sha', hex('other', 40) ],
    [ 'source_checksum', hex('other', 64) ],
    [ 'attempt', 2 ],
    [ 'created_by', 'someone-else' ],
  ] as const) {
    await t.rejects(
      () => run(db, `UPDATE registry_versions SET ${column} = ?1 WHERE id = ?2`, value, versionId),
      { message: /identity and provenance are immutable/ },
      `${column} cannot change while importing`,
    );
  }
  await t.rejects(
    () => run(db, `UPDATE registry_versions SET validated_at = ?1 WHERE id = ?2`, NOW, versionId),
    CHECK_FAILED,
    'an importing version has no validation time',
  );
  await t.rejects(() => setStatus(db, versionId, 'validated'), { message: /fully passing latest validation attempt/ }, 'validation requires checks');
  await t.rejects(() => setStatus(db, versionId, 'invalid'), { message: /requires a failed check/ }, 'invalidation requires a failed check');

  await recordChecks(db, versionId, 1, [ false ]);
  await recordChecks(db, versionId, 2, [ true, true ]);
  await t.rejects(
    () => run(db, `UPDATE registry_versions SET status = 'validated', snapshot_checksum = NULL, validated_at = ?1 WHERE id = ?2`, NOW, versionId),
    CHECK_FAILED,
    'a validated version needs a snapshot checksum',
  );
  await t.resolves(() => setStatus(db, versionId, 'validated'), 'a passing latest attempt validates despite an older failure');

  await t.rejects(
    () => run(db, `UPDATE registry_versions SET status = 'importing', validated_at = NULL WHERE id = ?1`, versionId),
    { message: /immutable/ },
    'validated cannot return to importing',
  );
  await t.rejects(
    () => run(db, `UPDATE registry_versions SET snapshot_checksum = ?1 WHERE id = ?2`, hex('changed', 64), versionId),
    { message: /immutable/ },
    'a validated version cannot change',
  );
  await t.rejects(() => run(db, `DELETE FROM registry_versions WHERE id = ?1`, versionId), { message: /cannot be deleted/ });

  const { registry_version_id: failingId } = await insertCandidate(db, randomUUID(), 10);
  await recordChecks(db, failingId, 1, [ true ]);
  await recordChecks(db, failingId, 2, [ true, false ]);
  await t.rejects(() => setStatus(db, failingId, 'validated'), { message: /fully passing latest validation attempt/ }, 'a failing latest attempt blocks validation');
  await t.resolves(() => setStatus(db, failingId, 'invalid'), 'a failing latest attempt invalidates');
  await t.rejects(() => setStatus(db, failingId, 'validated'), { message: /immutable/ }, 'invalid is terminal');
});

t.test('snapshot rows change only while their version imports', async t => {
  const { APP_DB: db } = await freshEnv();
  const candidate = await insertCandidate(db);
  const scope: Scope = { registry_version_id: candidate.registry_version_id, network_id: candidate.network_id };

  await insertRow(db, 'network_price_exceptions', priceExceptionRow(scope));
  await insertRow(db, 'market_contracts', { market_id: candidate.marketId, role: 'comet', address: address('comet') });
  await insertRow(db, 'market_assets', collateralAssetRow(scope, candidate.marketId, candidate.collateralTokenId));
  await t.resolves(() => run(db, `UPDATE markets SET display_name = 'USDC.e' WHERE id = ?1`, candidate.marketId), 'importing rows are writable');
  await t.resolves(() => run(db, `DELETE FROM market_contracts WHERE market_id = ?1`, candidate.marketId), 'importing rows are deletable');
  await insertRow(db, 'market_contracts', { market_id: candidate.marketId, role: 'comet', address: address('comet') });

  const other = await insertCandidate(db, randomUUID(), 10);
  await t.rejects(
    () => run(db, `UPDATE tokens SET registry_version_id = ?1 WHERE id = ?2`, other.registry_version_id, candidate.baseTokenId),
    NOT_IMPORTING,
    'rows cannot move to another version',
  );

  await validate(db, candidate.registry_version_id);

  const newNetwork = { ...scope, network_id: randomUUID() };
  const cases: Array<[ string, () => Promise<unknown> ]> = [
    [ 'insert network', () => insertRow(db, 'registry_networks', networkRow(newNetwork, 10)) ],
    [ 'update network', () => run(db, `UPDATE registry_networks SET display_name = 'Renamed' WHERE id = ?1`, scope.network_id) ],
    [ 'delete network', () => run(db, `DELETE FROM registry_networks WHERE id = ?1`, scope.network_id) ],
    [ 'insert price exception', () => insertRow(db, 'network_price_exceptions', priceExceptionRow(scope, { price_feed_address: address('feed:other') })) ],
    [ 'update price exception', () => run(db, `UPDATE network_price_exceptions SET provenance = 'changed' WHERE network_id = ?1`, scope.network_id) ],
    [ 'delete price exception', () => run(db, `DELETE FROM network_price_exceptions WHERE network_id = ?1`, scope.network_id) ],
    [ 'insert market', () => insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'weth' })) ],
    [ 'update market', () => run(db, `UPDATE markets SET status = 'disabled' WHERE id = ?1`, candidate.marketId) ],
    [ 'delete market', () => run(db, `DELETE FROM markets WHERE id = ?1`, candidate.marketId) ],
    [ 'insert token', () => insertRow(db, 'tokens', tokenRow(randomUUID(), scope)) ],
    [ 'update token', () => run(db, `UPDATE tokens SET symbol = 'X' WHERE id = ?1`, candidate.baseTokenId) ],
    [ 'delete token', () => run(db, `DELETE FROM tokens WHERE id = ?1`, candidate.collateralTokenId) ],
    [ 'insert contract', () => insertRow(db, 'market_contracts', { market_id: candidate.marketId, role: 'bulker', address: address('bulker') }) ],
    [ 'update contract', () => run(db, `UPDATE market_contracts SET address = ?1 WHERE market_id = ?2`, address('moved'), candidate.marketId) ],
    [ 'delete contract', () => run(db, `DELETE FROM market_contracts WHERE market_id = ?1`, candidate.marketId) ],
    [ 'insert asset', () => insertRow(db, 'market_assets', collateralAssetRow(scope, candidate.marketId, candidate.collateralTokenId, { asset_index: 1 })) ],
    [ 'update asset', () => run(db, `UPDATE market_assets SET price_feed_decimals = 18 WHERE market_id = ?1`, candidate.marketId) ],
    [ 'delete asset', () => run(db, `DELETE FROM market_assets WHERE market_id = ?1`, candidate.marketId) ],
  ];
  for (const [ name, operation ] of cases) {
    await t.rejects(operation, NOT_IMPORTING, `${name} is rejected once validated`);
  }
  t.equal(await count(db, 'market_assets', 'registry_version_id = ?1', scope.registry_version_id), 2, 'validated rows are intact');
});

t.test('the active pointer only moves between validated versions', async t => {
  const { APP_DB: db } = await freshEnv();

  await t.rejects(
    () => insertRow(db, 'registry_state', { singleton_id: 2, updated_at: NOW }),
    { message: /seeded singleton/ },
    'no second pointer row',
  );
  await t.rejects(() => run(db, `DELETE FROM registry_state`), { message: /seeded singleton/ }, 'the pointer row cannot be deleted');
  await t.rejects(() => run(db, `UPDATE registry_state SET singleton_id = 2`), { message: /seeded singleton/ }, 'the pointer key cannot change');
  await t.resolves(
    () => run(db, `UPDATE registry_state SET last_upstream_checked_at = ?1, updated_at = ?1`, NOW),
    'the upstream check time is writable without an active version',
  );

  const importing = await insertCandidate(db, randomUUID(), 1);
  const invalid = await insertCandidate(db, randomUUID(), 10);
  await recordChecks(db, invalid.registry_version_id, 1, [ false ]);
  await setStatus(db, invalid.registry_version_id, 'invalid');
  const validA = await insertCandidate(db, randomUUID(), 137);
  await validate(db, validA.registry_version_id);
  const validB = await insertCandidate(db, randomUUID(), 8453);
  await validate(db, validB.registry_version_id);

  for (const [ name, versionId ] of [
    [ 'an importing version', importing.registry_version_id ],
    [ 'an invalid version', invalid.registry_version_id ],
    [ 'an unknown version', randomUUID() ],
  ] as const) {
    await t.rejects(
      () => run(db, `UPDATE registry_state SET active_version_id = ?1`, versionId),
      { message: /active registry version must be validated/ },
      `the pointer cannot select ${name}`,
    );
    await t.rejects(
      () => activate(db, versionId),
      { message: /must reference validated versions/ },
      `activation of ${name} is rejected before the pointer changes`,
    );
  }
  t.equal(await count(db, 'registry_activations'), 0, 'rejected activations leave no audit rows');

  t.same(await activate(db, validA.registry_version_id), [ 1, 1 ]);
  await t.rejects(() => run(db, `UPDATE registry_state SET active_version_id = NULL`), { message: /cannot be cleared/ });

  await t.rejects(
    () => db.batch([
      activationBatch(db, validB.registry_version_id)[0]!,
      db.prepare(`UPDATE registry_state SET active_version_id = ?1`).bind(importing.registry_version_id),
    ]),
    { message: /active registry version must be validated/ },
    'a failing pointer update aborts the batch',
  );
  t.equal(await count(db, 'registry_activations'), 1, 'the audit insert of the failed batch is rolled back');
  t.equal(await activeVersionId(db), validA.registry_version_id, 'the pointer is unchanged');

  await t.rejects(
    () => insertRow(db, 'registry_activations', {
      id:                  randomUUID(),
      registry_version_id: validA.registry_version_id,
      previous_version_id: validA.registry_version_id,
      action:              'activate',
      actor:               'test-admin',
      reason:              'test',
      created_at:          NOW,
    }),
    CHECK_FAILED,
    'an activation cannot name the target as its previous version',
  );
});

t.test('review and audit records are append-only', async t => {
  const { APP_DB: db } = await freshEnv();
  const candidate = await insertCandidate(db);
  const versionId = candidate.registry_version_id;
  const overlayEvent = (overrides: Row = {}): Row => ({
    id:                  randomUUID(),
    registry_version_id: versionId,
    scope_type:          'market',
    scope_key:           '1/usdc',
    previous_digest:     null,
    new_digest:          hex('overlay', 64),
    actor:               'test-admin',
    reason:              'reviewed',
    created_at:          NOW,
    ...overrides,
  });

  await recordChecks(db, versionId, 1, [ true ]);
  await t.rejects(
    () => recordChecks(db, versionId, 1, [ true ]),
    UNIQUE_FAILED,
    'a check is recorded once per attempt and scope',
  );
  await insertRow(db, 'registry_overlay_events', overlayEvent());
  await t.rejects(() => run(db, `UPDATE validation_results SET passed = 0`), { message: /append-only/ });
  await t.rejects(() => run(db, `DELETE FROM validation_results`), { message: /append-only/ });
  await t.rejects(() => run(db, `UPDATE registry_overlay_events SET reason = 'edited'`), { message: /append-only/ });
  await t.rejects(() => run(db, `DELETE FROM registry_overlay_events`), { message: /append-only/ });
  await t.rejects(() => insertRow(db, 'registry_overlay_events', overlayEvent({ reason: ' ' })), CHECK_FAILED, 'an overlay reason is required');

  await setStatus(db, versionId, 'validated');
  await t.rejects(() => recordChecks(db, versionId, 2, [ true ]), NOT_IMPORTING, 'no new checks for a validated version');
  await t.rejects(() => insertRow(db, 'registry_overlay_events', overlayEvent()), NOT_IMPORTING, 'no overlay changes for a validated version');

  await activate(db, versionId);
  await t.rejects(() => run(db, `UPDATE registry_activations SET reason = 'edited'`), { message: /append-only/ });
  await t.rejects(() => run(db, `DELETE FROM registry_activations`), { message: /append-only/ });
});

/*
 * A market the import wrote without anyone reviewing it. Its rows exist so
 * they can be reviewed in place, and the schema is what guarantees that until
 * then the API cannot offer it: an unreviewed market is disabled and never the
 * default, whatever the code that wrote it did.
 */
t.test('a market nobody has reviewed cannot be served', async t => {
  const { APP_DB: db } = await freshEnv();
  const candidate = await insertCandidate(db);
  const scope     = { registry_version_id: candidate.registry_version_id, network_id: candidate.network_id };

  await insertRow(db, 'markets', marketRow(randomUUID(), scope, {
    deployment_key: 'unreviewed',
    status:         'disabled',
    creation_block: 0,
    reviewed:       0,
  }));
  await t.rejects(
    () => insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'served', reviewed: 0 })),
    { message: /nobody has reviewed must be disabled/ },
    'an unreviewed market is not written enabled',
  );
  await t.rejects(
    () => insertRow(db, 'markets', marketRow(randomUUID(), scope, {
      deployment_key: 'default', status: 'disabled', is_default: 1, reviewed: 0,
    })),
    { message: /nobody has reviewed must be disabled/ },
    'nor as the default',
  );
  await t.rejects(
    () => run(db, `UPDATE markets SET status = 'enabled' WHERE deployment_key = 'unreviewed'`),
    { message: /nobody has reviewed must be disabled/ },
    'and cannot be enabled without being reviewed',
  );

  await run(db, `UPDATE markets SET status = 'enabled', creation_block = 7, reviewed = 1 WHERE deployment_key = 'unreviewed'`);
  const reviewed = await db.prepare(`SELECT status, reviewed FROM markets WHERE deployment_key = 'unreviewed'`)
    .first<{ status: string, reviewed: number }>();
  t.same(reviewed, { status: 'enabled', reviewed: 1 }, 'a review is what enables it, in the same statement');

  await t.rejects(
    () => insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'bad-flag', reviewed: 2 })),
    CHECK_FAILED,
  );
  const network = await db.prepare(`SELECT reviewed FROM registry_networks WHERE id = ?1`)
    .bind(candidate.network_id).first<number>('reviewed');
  t.equal(network, 1, 'a row written without the flag is a reviewed one, as every row before it was');
});

/*
 * A slug is what the frontend addresses a market by where its label is shared
 * with another market of the network, so it has to name exactly one of them.
 */
t.test('a slug names one market of a network, in the form the frontend reads', async t => {
  const { APP_DB: db } = await freshEnv();
  const candidate = await insertCandidate(db);
  const scope     = { registry_version_id: candidate.registry_version_id, network_id: candidate.network_id };

  await insertRow(db, 'markets', marketRow(randomUUID(), scope, {
    deployment_key: 'institutional_usdc', slug: 'usdc-institutional', is_institutional: 1,
  }));
  const stored = await db.prepare(`SELECT slug, is_institutional FROM markets WHERE deployment_key = 'institutional_usdc'`)
    .first<{ slug: string, is_institutional: number }>();
  t.same(stored, { slug: 'usdc-institutional', is_institutional: 1 });

  await t.rejects(
    () => insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'second', slug: 'usdc-institutional' })),
    { message: /UNIQUE constraint failed/ },
    'no two markets of one network share a slug',
  );
  await t.rejects(
    () => insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'upper', slug: 'USDC-Institutional' })),
    CHECK_FAILED,
    'a slug is lowercase, as the frontend compares it',
  );
  await t.rejects(
    () => insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'spaced', slug: 'usdc institutional' })),
    CHECK_FAILED,
    'and holds only what a market key can',
  );
  await t.rejects(
    () => insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'flag', is_institutional: 2 })),
    CHECK_FAILED,
  );

  await insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'plain' }));
  const plain = await db.prepare(`SELECT slug, is_institutional FROM markets WHERE deployment_key = 'plain'`)
    .first<{ slug: string | null, is_institutional: number }>();
  t.same(plain, { slug: null, is_institutional: 0 }, 'a market written without them is listed by its label, as a standard one');
});

t.test('composite keys keep rows inside one version and network', async t => {
  const { APP_DB: db } = await freshEnv();
  const first = await insertCandidate(db, randomUUID(), 1);
  const second = await insertCandidate(db, randomUUID(), 1);
  const firstScope: Scope = { registry_version_id: first.registry_version_id, network_id: first.network_id };
  const mixedVersion: Scope = { registry_version_id: first.registry_version_id, network_id: second.network_id };

  await t.rejects(() => insertRow(db, 'markets', marketRow(randomUUID(), mixedVersion, { deployment_key: 'weth' })), FOREIGN_KEY_FAILED, 'market under another version\'s network');
  await t.rejects(() => insertRow(db, 'tokens', tokenRow(randomUUID(), mixedVersion)), FOREIGN_KEY_FAILED, 'token under another version\'s network');
  await t.rejects(() => insertRow(db, 'network_price_exceptions', priceExceptionRow(mixedVersion)), FOREIGN_KEY_FAILED, 'price exception under another version\'s network');
  await t.rejects(
    () => insertRow(db, 'market_assets', collateralAssetRow(firstScope, first.marketId, second.collateralTokenId)),
    FOREIGN_KEY_FAILED,
    'asset linking a market to a token of another version',
  );

  const otherNetwork: Scope = { registry_version_id: first.registry_version_id, network_id: randomUUID() };
  const otherNetworkToken = randomUUID();
  await insertRow(db, 'registry_networks', networkRow(otherNetwork, 10));
  await insertRow(db, 'tokens', tokenRow(otherNetworkToken, otherNetwork));
  await t.rejects(
    () => insertRow(db, 'market_assets', collateralAssetRow(firstScope, first.marketId, otherNetworkToken)),
    FOREIGN_KEY_FAILED,
    'asset linking a market to a token of another network',
  );
  await t.rejects(
    () => insertRow(db, 'market_contracts', { market_id: randomUUID(), role: 'comet', address: address('comet') }),
    FOREIGN_KEY_FAILED,
    'contract of an unknown market',
  );
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

t.test('column checks reject malformed rows', async t => {
  const { APP_DB: db } = await freshEnv();
  const candidate = await insertCandidate(db);
  const scope: Scope = { registry_version_id: candidate.registry_version_id, network_id: candidate.network_id };
  const { marketId, baseTokenId, collateralTokenId } = candidate;
  const rewardTokenId = randomUUID();

  await insertRow(db, 'tokens', tokenRow(rewardTokenId, scope));
  await t.resolves(() => insertRow(db, 'market_assets', collateralAssetRow(scope, marketId, collateralTokenId)), 'valid collateral');
  await t.resolves(
    () => insertRow(db, 'market_assets', rewardAssetRow(scope, marketId, rewardTokenId, { price_feed_address: null, price_feed_decimals: null, price_feed_quote: null })),
    'a reward without a price feed',
  );
  await t.resolves(() => insertRow(db, 'network_price_exceptions', priceExceptionRow(scope)), 'valid zero_price');
  await t.resolves(
    () => insertRow(db, 'network_price_exceptions', priceExceptionRow(scope, {
      price_feed_address: address('feed:fixed'), kind: 'fixed_price', fixed_price_value: '102447384', fixed_price_decimals: 8,
    })),
    'valid fixed_price',
  );
  await t.resolves(
    () => insertRow(db, 'network_price_exceptions', priceExceptionRow(scope, {
      price_feed_address: address('feed:remapped'), kind: 'deprecated_price_remap',
      replacement_price_feed_address: address('feed:replacement'), replacement_price_feed_decimals: 8,
    })),
    'valid deprecated_price_remap',
  );
  await insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'usdt', is_default: 1 }));

  const secondMarket = randomUUID();
  await insertRow(db, 'markets', marketRow(secondMarket, scope, { deployment_key: 'weth' }));

  const cases: Array<[ string, () => Promise<unknown>, { message: RegExp } ]> = [
    [ 'uppercase source repository', () => insertRow(db, 'registry_versions', versionRow(randomUUID(), { source_repository: 'Compound-Foundation/comet' })), CHECK_FAILED ],
    [ 'short commit SHA', () => insertRow(db, 'registry_versions', versionRow(randomUUID(), { source_commit_sha: 'cbe77c1' })), CHECK_FAILED ],
    [ 'network metadata that is not an object', () => insertRow(db, 'registry_networks', networkRow({ ...scope, network_id: randomUUID() }, 10, { metadata: '[]' })), CHECK_FAILED ],
    [ 'duplicate chain in a version', () => insertRow(db, 'registry_networks', networkRow({ ...scope, network_id: randomUUID() }, 1, { canonical_name: 'other' })), UNIQUE_FAILED ],
    [ 'mixed-case token address', () => insertRow(db, 'tokens', tokenRow(randomUUID(), scope, { address: address('mixed').toUpperCase().replace('0X', '0x') })), CHECK_FAILED ],
    [ 'token decimals out of range', () => insertRow(db, 'tokens', tokenRow(randomUUID(), scope, { decimals: 256 })), CHECK_FAILED ],
    [ 'text in a STRICT integer column', () => insertRow(db, 'tokens', tokenRow(randomUUID(), scope, { decimals: 'six' })), { message: /cannot store TEXT value in INTEGER column/ } ],
    [ 'unknown market status', () => insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'wbtc', status: 'paused' })), CHECK_FAILED ],
    [ 'malformed deployment key', () => insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'USDC/v3' })), CHECK_FAILED ],
    [ 'second default market in a version', () => insertRow(db, 'markets', marketRow(randomUUID(), scope, { deployment_key: 'wbtc', is_default: 1 })), UNIQUE_FAILED ],
    [ 'second base asset', () => insertRow(db, 'market_assets', baseAssetRow(scope, marketId, collateralTokenId)), UNIQUE_FAILED ],
    [ 'second reward asset', () => insertRow(db, 'market_assets', rewardAssetRow(scope, marketId, baseTokenId)), UNIQUE_FAILED ],
    [ 'duplicate collateral index', () => insertRow(db, 'market_assets', collateralAssetRow(scope, marketId, baseTokenId)), UNIQUE_FAILED ],
    [ 'collateral without an index', () => insertRow(db, 'market_assets', collateralAssetRow(scope, secondMarket, collateralTokenId, { asset_index: null })), CHECK_FAILED ],
    [ 'base asset with an index', () => insertRow(db, 'market_assets', baseAssetRow(scope, secondMarket, baseTokenId, { asset_index: 0 })), CHECK_FAILED ],
    [ 'base asset without a price feed', () => insertRow(db, 'market_assets', baseAssetRow(scope, secondMarket, baseTokenId, { price_feed_address: null, price_feed_decimals: null })), CHECK_FAILED ],
    [ 'price feed without decimals', () => insertRow(db, 'market_assets', baseAssetRow(scope, secondMarket, baseTokenId, { price_feed_decimals: null })), CHECK_FAILED ],
    [ 'base asset without a display name', () => insertRow(db, 'market_assets', baseAssetRow(scope, secondMarket, baseTokenId, { display_name: null })), CHECK_FAILED ],
    [ 'base asset without a wrapped-native flag', () => insertRow(db, 'market_assets', baseAssetRow(scope, secondMarket, baseTokenId, { is_wrapped_native: null })), CHECK_FAILED ],
    [ 'collateral with a display name', () => insertRow(db, 'market_assets', collateralAssetRow(scope, secondMarket, collateralTokenId, { display_name: 'Token' })), CHECK_FAILED ],
    [ 'collateral with a USD conversion feed', () => insertRow(db, 'market_assets', collateralAssetRow(scope, secondMarket, collateralTokenId, { usd_price_feed_address: address('usd'), usd_price_feed_decimals: 8 })), CHECK_FAILED ],
    [ 'collateral with a feed unit', () => insertRow(db, 'market_assets', collateralAssetRow(scope, secondMarket, collateralTokenId, { price_feed_quote: 'usd' })), CHECK_FAILED ],
    [ 'reward feed without a unit', () => insertRow(db, 'market_assets', rewardAssetRow(scope, secondMarket, rewardTokenId, { price_feed_quote: null })), CHECK_FAILED ],
    [ 'reward unit without a feed', () => insertRow(db, 'market_assets', rewardAssetRow(scope, secondMarket, rewardTokenId, { price_feed_address: null, price_feed_decimals: null })), CHECK_FAILED ],
    [ 'fixed_price without a price', () => insertRow(db, 'network_price_exceptions', priceExceptionRow(scope, { price_feed_address: address('a'), kind: 'fixed_price' })), CHECK_FAILED ],
    [ 'fixed_price with a fractional value', () => insertRow(db, 'network_price_exceptions', priceExceptionRow(scope, { price_feed_address: address('b'), kind: 'fixed_price', fixed_price_value: '1.5', fixed_price_decimals: 8 })), CHECK_FAILED ],
    [ 'zero_price with a price', () => insertRow(db, 'network_price_exceptions', priceExceptionRow(scope, { price_feed_address: address('c'), fixed_price_value: '1', fixed_price_decimals: 8 })), CHECK_FAILED ],
    [ 'remap without a replacement', () => insertRow(db, 'network_price_exceptions', priceExceptionRow(scope, { price_feed_address: address('d'), kind: 'deprecated_price_remap' })), CHECK_FAILED ],
    [ 'remap onto the same feed', () => insertRow(db, 'network_price_exceptions', priceExceptionRow(scope, { price_feed_address: address('e'), kind: 'deprecated_price_remap', replacement_price_feed_address: address('e'), replacement_price_feed_decimals: 8 })), CHECK_FAILED ],
    [ 'second exception for one feed', () => insertRow(db, 'network_price_exceptions', priceExceptionRow(scope)), UNIQUE_FAILED ],
    [ 'unknown contract role', () => insertRow(db, 'market_contracts', { market_id: marketId, role: 'governor', address: address('governor') }), CHECK_FAILED ],
    [ 'validation details that are not JSON', () => insertRow(db, 'validation_results', { registry_version_id: scope.registry_version_id, validation_attempt: 1, check_name: 'x', scope: 'global', passed: 1, details: '{', created_at: NOW }), CHECK_FAILED ],
  ];
  for (const [ name, operation, expected ] of cases) {
    await t.rejects(operation, expected, name);
  }
  await insertRow(db, 'market_contracts', { market_id: marketId, role: 'comet', address: address('comet') });
  await t.rejects(
    () => insertRow(db, 'market_contracts', { market_id: marketId, role: 'comet', address: address('comet:other') }),
    UNIQUE_FAILED,
    'one contract per role',
  );
});

t.test('sync runs keep one running job and consistent checkpoints', async t => {
  const { APP_DB: db } = await freshEnv();
  const syncRun = (overrides: Row = {}): Row => ({
    id:                randomUUID(),
    source_commit_sha: hex('sync', 40),
    tracked_ref:       'main',
    trigger_kind:      'scheduled',
    requested_by:      'registry-cron',
    status:            'running',
    lease_owner:       randomUUID(),
    lease_expires_at:  NOW,
    expected_count:    2,
    started_at:        NOW,
    ...overrides,
  });

  const runId = randomUUID();
  await insertRow(db, 'sync_runs', syncRun({ id: runId }));
  await t.rejects(() => insertRow(db, 'sync_runs', syncRun()), UNIQUE_FAILED, 'only one running sync');

  const terminal = { status: 'completed', outcome: 'imported', completed_at: NOW, lease_owner: null };
  const cases: Array<[ string, Row ]> = [
    [ 'completed without an outcome', { ...terminal, outcome: null } ],
    [ 'failed with an outcome', { ...terminal, status: 'failed' } ],
    [ 'terminal without a completion time', { ...terminal, completed_at: null } ],
    [ 'counts above the expected count', { ...terminal, completed_count: 2, failed_count: 1 } ],
    [ 'explicit SHA without a reason', { ...terminal, tracked_ref: null } ],
    [ 'manual run without an actor', { ...terminal, trigger_kind: 'manual', requested_by: null } ],
  ];
  for (const [ name, overrides ] of cases) {
    await t.rejects(() => insertRow(db, 'sync_runs', syncRun(overrides)), CHECK_FAILED, name);
  }
  await t.resolves(
    () => insertRow(db, 'sync_runs', syncRun({ ...terminal, tracked_ref: null, trigger_kind: 'manual', requested_by: 'admin', reason: 'pinned import' })),
    'a completed manual run of an explicit SHA',
  );
  await t.rejects(
    () => insertRow(db, 'sync_runs', syncRun({ ...terminal, registry_version_id: randomUUID() })),
    FOREIGN_KEY_FAILED,
    'a run cannot reference an unknown version',
  );

  const item = (overrides: Row = {}): Row => ({
    id:                   randomUUID(),
    sync_run_id:          runId,
    root_path:            'deployments/mainnet/usdc/roots.json',
    source_blob_sha:      hex('blob', 40),
    upstream_network_key: 'mainnet',
    deployment_key:       'usdc',
    created_at:           NOW,
    updated_at:           NOW,
    ...overrides,
  });
  await insertRow(db, 'sync_run_items', item());
  const itemCases: Array<[ string, Row, { message: RegExp } ]> = [
    [ 'duplicate root in a run', {}, UNIQUE_FAILED ],
    [ 'root path that does not match its keys', { root_path: 'deployments/base/usdc/roots.json', deployment_key: 'weth' }, CHECK_FAILED ],
    [ 'processing without a claim owner', { root_path: 'deployments/mainnet/weth/roots.json', deployment_key: 'weth', status: 'processing' }, CHECK_FAILED ],
    [ 'completed without a completion time', { root_path: 'deployments/mainnet/weth/roots.json', deployment_key: 'weth', status: 'completed', claim_owner: 'owner' }, CHECK_FAILED ],
    [ 'unbounded attempts', { root_path: 'deployments/mainnet/weth/roots.json', deployment_key: 'weth', attempts: 101 }, CHECK_FAILED ],
    [ 'item of an unknown run', { sync_run_id: randomUUID(), root_path: 'deployments/mainnet/weth/roots.json', deployment_key: 'weth' }, FOREIGN_KEY_FAILED ],
  ];
  for (const [ name, overrides, expected ] of itemCases) {
    await t.rejects(() => insertRow(db, 'sync_run_items', item(overrides)), expected, name);
  }

  await run(db, `UPDATE sync_runs SET status = 'completed', outcome = 'no_change', completed_at = ?1, lease_owner = NULL WHERE id = ?2`, NOW, runId);
  await t.resolves(() => insertRow(db, 'sync_runs', syncRun()), 'a new run may start after the previous one completes');
});

/*
 * Migration 0004 drops columns from tables a deployed release has already
 * written to, so it has to apply over their rows and keep the rest of them.
 */
t.test('migration 0004 keeps the sync history it drops columns from', async t => {
  await server.reset();
  const { APP_DB: db } = await server.getWorker<Env>().getEnv();
  await applyMigrations(db, undefined, { through: '0003' });

  const { registry_version_id: versionId } = await insertCandidate(db);
  const runId = randomUUID();
  await insertRow(db, 'sync_runs', {
    id:                  runId,
    source_commit_sha:   hex('sync', 40),
    tracked_ref:         'main',
    registry_version_id: versionId,
    trigger_kind:        'scheduled',
    requested_by:        'registry-cron',
    status:              'running',
    lease_owner:         'owner',
    lease_generation:    3,
    lease_expires_at:    NOW,
    expected_count:      1,
    started_at:          NOW,
  });
  await insertRow(db, 'sync_run_items', {
    id:                   randomUUID(),
    sync_run_id:          runId,
    root_path:            'deployments/mainnet/usdc/roots.json',
    source_blob_sha:      hex('blob', 40),
    root_checksum:        hex('root', 64),
    upstream_network_key: 'mainnet',
    deployment_key:       'usdc',
    status:               'processing',
    claim_owner:          'owner',
    claim_generation:     3,
    created_at:           NOW,
    updated_at:           NOW,
  });

  await applyMigration(db, '0004_registry_unused_schema.sql');

  const runs = await db.prepare(`SELECT * FROM sync_runs`).all();
  t.same(runs.results, [ {
    id:                  runId,
    source_commit_sha:   hex('sync', 40),
    tracked_ref:         'main',
    registry_version_id: versionId,
    trigger_kind:        'scheduled',
    requested_by:        'registry-cron',
    reason:              null,
    status:              'running',
    outcome:             null,
    lease_owner:         'owner',
    lease_expires_at:    NOW,
    expected_count:      1,
    completed_count:     0,
    failed_count:        0,
    last_error:          null,
    started_at:          NOW,
    completed_at:        null,
    hold_for_review:     0,
  } ], 'a run keeps everything but its lease generation');

  const items = await db.prepare(`SELECT root_path, status, claim_owner FROM sync_run_items WHERE sync_run_id = ?1`)
    .bind(runId).all();
  t.same(items.results, [ { root_path: 'deployments/mainnet/usdc/roots.json', status: 'processing', claim_owner: 'owner' } ],
    'a checkpoint keeps its claim');
  t.equal(await count(db, 'tokens'), 2, 'tokens outlive the index nobody read');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});
