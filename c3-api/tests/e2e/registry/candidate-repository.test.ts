import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import { applyMigrations, foreignKeyViolations } from '../../util/d1.js';
import {
  clearCandidateSnapshot,
  loadRegistrySnapshotFixture,
  seedCandidate,
  writeCandidateSnapshot,
} from '../../util/registry-fixture.js';
import { isRegistryError } from '../../../src/registry/errors.js';
import {
  createCandidate,
  findAttemptsByCommit,
  latestValidationAttempt,
  marketWrites,
  markInvalid,
  readSnapshot,
  markValidated,
  recordValidationResults,
  snapshotChecksum,
} from '../../../src/registry/repository.js';

/*
 * The candidate write repository against real local D1: the RegistrySnapshotV1
 * fixture is written as an importing candidate, taken through its lifecycle,
 * and rejected once terminal. The database enforces the invariants, so these
 * tests assert that the repository writes rows the triggers accept and that
 * its checksum matches the frozen contract.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

const snapshot = loadRegistrySnapshotFixture();
const networks = snapshot.networks;

const SOURCE = {
  repository:     'Compound-Foundation/comet',
  commitSha:      snapshot.registryVersion.sourceCommitSha,
  sourceChecksum: 'a'.repeat(64),
};

async function candidate(db: D1Database, attempt: number = 1) {
  return createCandidate(db, { ...SOURCE, attempt, createdBy: 'test' });
}

async function count(db: D1Database, table: string, where: string = '1 = 1', ...bindings: unknown[]): Promise<number> {
  const value = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...bindings).first<number>('n');
  return value ?? 0;
}

async function rejects(operation: () => Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const text = isRegistryError(error) ? error.message : String(error);
    t.match(text, message, `rejected: ${message}`);
    return;
  }
  throw new Error(`expected a rejection matching ${message}`);
}

t.test('a candidate records its source identity once per attempt', async t => {
  const db = await freshDatabase();

  const first = await candidate(db);
  t.equal(first.status, 'importing', 'a candidate starts importing');
  t.equal(first.source_repository, 'compound-foundation/comet', 'the repository is stored lowercase');
  t.equal(first.snapshot_checksum, null, 'it has no snapshot checksum yet');

  // the same source in different casing is the same source, not a second one
  const attempts = await findAttemptsByCommit(db, 'COMPOUND-FOUNDATION/comet', SOURCE.commitSha);
  t.same(attempts.map(version => version.id), [ first.id ], 'the attempt is found case-insensitively');

  await rejects(() => candidate(db), /UNIQUE constraint failed/);

  const second = await candidate(db, 2);
  t.same(
    (await findAttemptsByCommit(db, SOURCE.repository, SOURCE.commitSha)).map(version => version.attempt),
    [ 2, 1 ],
    'attempts for one source are listed newest first',
  );
  t.not(second.id, first.id);
});

t.test('the fixture snapshot is written as rows the schema accepts', async t => {
  const db      = await freshDatabase();
  const version = await candidate(db);

  const counts = await writeCandidateSnapshot(db, version.id, networks);
  const markets = networks.flatMap(network => network.markets);
  t.same(counts, {
    networks:        networks.length,
    markets:         markets.length,
    tokens:          counts.tokens,
    contracts:       counts.contracts,
    assets:          markets.reduce((total, market) => total + 1 + (market.rewardAsset ? 1 : 0) + market.collateralAssets.length, 0),
    priceExceptions: networks.reduce((total, network) => total + network.priceExceptions.length, 0),
  }, 'the reported counts match the fixture');

  for (const [ table, expected ] of [
    [ 'registry_networks',         counts.networks ],
    [ 'markets',                   counts.markets ],
    [ 'tokens',                    counts.tokens ],
    [ 'market_contracts',          counts.contracts ],
    [ 'market_assets',             counts.assets ],
    [ 'network_price_exceptions',  counts.priceExceptions ],
  ] as const) {
    t.equal(await count(db, table), expected, `${table} holds every written row`);
  }
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');

  // COMP is the reward token of several markets, and WETH is a base asset of
  // one market and collateral in others: identity is shared within a network
  const mainnet = networks.find(network => network.chainId === 1)!;
  const distinctAddresses = new Set(mainnet.markets.flatMap(market => [
    market.baseAsset.token.address,
    ...(market.rewardAsset ? [ market.rewardAsset.token.address ] : []),
    ...market.collateralAssets.map(collateral => collateral.token.address),
  ]));
  t.equal(
    await count(
      db,
      'tokens',
      `registry_version_id = ?1
       AND network_id = (SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1)`,
      version.id,
    ),
    distinctAddresses.size,
    'each token of a network is written once',
  );

  const base = await db.prepare(
    `SELECT asset.display_name, asset.is_wrapped_native, asset.usd_price_feed_address
     FROM market_assets AS asset
     JOIN markets AS market ON market.id = asset.market_id
     WHERE asset.role = 'base' AND market.deployment_key = 'weth' AND market.registry_version_id = ?1`
  ).bind(version.id).first();
  const weth = mainnet.markets.find(market => market.deploymentKey === 'weth')!;
  t.same(base, {
    display_name:           weth.baseAsset.displayName,
    is_wrapped_native:      1,
    usd_price_feed_address: weth.baseAsset.usdPriceFeed!.address,
  }, 'the base row carries the reviewed base asset fields');
});

/*
 * An import writes a network only with its first market, so a snapshot that
 * names a network without markets cannot be written the way an import writes
 * it. The writer refuses it before writing any of it, rather than report rows
 * the database does not hold.
 */
t.test('a snapshot with a network that has no markets is refused, and none of it is written', async t => {
  const db      = await freshDatabase();
  const version = await candidate(db);

  // a network with markets comes first, so a writer that refused only on reaching the other would have written it
  const mainnet = networks.find(network => network.chainId === 1)!;
  const base    = networks.find(network => network.chainId === 8453)!;
  await rejects(
    () => writeCandidateSnapshot(db, version.id, [ mainnet, { ...base, markets: [] } ]),
    /base-mainnet has no markets/,
  );
  for (const table of [ 'registry_networks', 'network_price_exceptions', 'markets', 'tokens' ]) {
    t.equal(await count(db, table), 0, `${table} holds nothing`);
  }
});

t.test('a market is written idempotently, with its network the first time', async t => {
  const db      = await freshDatabase();
  const version = await candidate(db);
  const network = networks.find(entry => entry.chainId === 1)!;
  const market  = network.markets.find(entry => entry.deploymentKey === 'usdc')!;
  const write   = async (written: typeof market) => db.batch((await marketWrites(db, version.id, {
    network:         { ...network, markets: [] },
    market:          written,
    networkReviewed: true,
    marketReviewed:  true,
  }))());

  await write(market);
  t.equal(await count(db, 'registry_networks'), 1, 'the first market of a network writes the network');
  t.equal(
    await count(db, 'network_price_exceptions'),
    network.priceExceptions.length,
    'with its price exceptions',
  );

  /*
   * A market replaces any row of its deployment, so writing it again leaves
   * one market rather than colliding with the deployment key it already wrote.
   */
  await t.resolves(() => write({ ...market, id: randomUUID() }), 'the same market can be written twice');
  t.equal(await count(db, 'registry_networks'), 1, 'and the network it already has is not written again');
  t.equal(await count(db, 'markets'), 1, 'and leaves one row');
  t.equal(
    await count(db, 'market_assets'),
    1 + (market.rewardAsset ? 1 : 0) + market.collateralAssets.length,
    'with one set of assets, the replaced ones having gone with it',
  );
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

/*
 * A version has one default market, which the schema keeps with a unique
 * index. A market imported as the default beside another one is refused
 * before anything is written, naming both, rather than by that index in the
 * middle of the write, whose message names neither.
 */
t.test('a second default market is refused before it is written, naming both', async t => {
  const db      = await freshDatabase();
  const version = await candidate(db);
  const network = networks.find(entry => entry.chainId === 1)!;
  const usdc    = network.markets.find(entry => entry.deploymentKey === 'usdc')!;
  const weth    = network.markets.find(entry => entry.deploymentKey === 'weth')!;
  const writes  = async (market: typeof usdc) => marketWrites(db, version.id, {
    network:         { ...network, markets: [] },
    market,
    networkReviewed: true,
    marketReviewed:  true,
  });

  t.ok(usdc.isDefault, 'the fixture opens mainnet usdc by default');
  await db.batch((await writes(usdc))());

  const refused = await writes({ ...weth, isDefault: true }).then(() => null, (error: unknown) => error);
  t.ok(isRegistryError(refused) && refused.code === 'OVERLAY_INVALID', 'a second default is the overlay\'s mistake');
  t.match((refused as Error).message, /1\/weth.*1\/usdc/, 'and names both markets');
  t.equal(await count(db, 'markets'), 1, 'nothing of it is written');

  await t.resolves(async () => db.batch((await writes({ ...usdc, id: randomUUID() }))()),
    'while the default written again is still the one default');
});

t.test('the snapshot checksum reproduces the frozen contract value', async t => {
  t.equal(
    await snapshotChecksum(networks),
    snapshot.registryVersion.checksum,
    'the repository computes the checksum the fixture was frozen with',
  );
  t.equal(await snapshotChecksum(networks), await snapshotChecksum(networks), 'it is stable');

  const changed = structuredClone(networks);
  changed[0]!.markets[0]!.displayName = 'Renamed';
  t.not(await snapshotChecksum(changed), snapshot.registryVersion.checksum, 'a semantic change changes it');

  const reissued = structuredClone(networks);
  reissued[0]!.markets[0]!.id = randomUUID();
  t.equal(
    await snapshotChecksum(reissued),
    snapshot.registryVersion.checksum,
    'a new row id does not, so re-importing unchanged source is not reported as a change',
  );
});

t.test('two imports of the same source agree on the checksum', async t => {
  const db = await freshDatabase();

  const first  = await seedCandidate(db, snapshot);
  const second = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });

  const [ firstSnapshot, secondSnapshot ] = await Promise.all([
    readSnapshot(db, first.versionId),
    readSnapshot(db, second.versionId),
  ]);
  t.not(
    firstSnapshot[0]!.markets[0]!.id,
    secondSnapshot[0]!.markets[0]!.id,
    'the two versions hold different market rows',
  );
  t.equal(
    await snapshotChecksum(firstSnapshot),
    await snapshotChecksum(secondSnapshot),
    'yet describe the same registry, so their checksums match',
  );
});

t.test('an importing candidate can be rewritten, a terminal one cannot', async t => {
  const db      = await freshDatabase();
  const version = await candidate(db);
  await writeCandidateSnapshot(db, version.id, networks);

  await clearCandidateSnapshot(db, version.id);
  t.equal(await count(db, 'markets'), 0, 'clearing removes the candidate snapshot');
  t.equal(await count(db, 'market_assets'), 0, 'its assets go with it');
  t.equal(await count(db, 'tokens'), 0, 'and its tokens');

  const rewritten = await writeCandidateSnapshot(db, version.id, networks);
  t.equal(await count(db, 'markets'), rewritten.markets, 'the candidate can be written again');

  await recordValidationResults(db, version.id, 1, [
    { check_name: 'source-reproducible', scope: 'global', passed: 1 },
    { check_name: 'markets-enriched',    scope: 'global', passed: 1 },
  ]);
  t.equal(await latestValidationAttempt(db, version.id), 1, 'the latest attempt is reported');

  await markValidated(db, version.id, await snapshotChecksum(networks));
  const [ validated ] = await findAttemptsByCommit(db, SOURCE.repository, SOURCE.commitSha);
  t.equal(validated!.status, 'validated');
  t.equal(validated!.snapshot_checksum, snapshot.registryVersion.checksum);
  t.ok(validated!.validated_at, 'validation is timestamped');

  await rejects(() => writeCandidateSnapshot(db, version.id, networks), /registry version is not importing/);
  await rejects(() => clearCandidateSnapshot(db, version.id), /registry version is not importing/);
  await rejects(
    () => recordValidationResults(db, version.id, 2, [ { check_name: 'late', scope: 'global', passed: 1 } ]),
    /registry version is not importing/,
  );
  await rejects(() => markValidated(db, version.id, 'b'.repeat(64)), /no longer importing/);
  await rejects(() => markInvalid(db, version.id), /no longer importing/);
  t.equal(await count(db, 'markets'), rewritten.markets, 'the validated snapshot is untouched');
});

t.test('validation results decide which terminal status is reachable', async t => {
  const db      = await freshDatabase();
  const version = await candidate(db);
  await writeCandidateSnapshot(db, version.id, networks);
  const checksum = await snapshotChecksum(networks);

  await rejects(() => markValidated(db, version.id, checksum), /fully passing latest validation attempt/);
  await rejects(() => markInvalid(db, version.id), /requires a failed check/);

  await recordValidationResults(db, version.id, 1, [
    { check_name: 'source-reproducible', scope: 'global',                passed: 1 },
    { check_name: 'feed-readable',       scope: 'market:1/usdc',         passed: 0, details: { reason: 'price feed reverted' } },
  ]);
  await rejects(() => markValidated(db, version.id, checksum), /fully passing latest validation attempt/);
  await t.resolves(() => markInvalid(db, version.id), 'a failed check invalidates the candidate');

  const failure = await db.prepare(
    `SELECT details FROM validation_results WHERE registry_version_id = ?1 AND passed = 0`
  ).bind(version.id).first<string>('details');
  t.same(JSON.parse(failure ?? '{}'), { reason: 'price feed reverted' }, 'diagnostics are kept for review');
});
