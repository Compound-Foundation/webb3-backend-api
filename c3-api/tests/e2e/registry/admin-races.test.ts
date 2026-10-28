import t from 'tap';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type { Address, PriceFeedV1 } from '../../../lib/model/comet-registry.js';
import { replaceMarketOverlay, validateStoredVersion } from '../../../src/registry/admin.js';
import { overlayOfMarket } from '../../../src/registry/overlay.js';
import { readSnapshot, snapshotChecksum } from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { interleaved } from '../../util/interleave.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * Administrative commands racing each other over one candidate.
 *
 * A candidate is changed by overlay writes and decided by validation, and two
 * operators — or an operator and the scheduled import — can do either at the
 * same moment. Each command reads, decides and writes; these tests put the
 * other command's write between its reading and its writing, which is where a
 * command that does not check that what it read still holds loses an update,
 * or records a decision about rows that are no longer there.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();
const usdc     = snapshot.networks.find(network => network.chainId === 1)!.markets
  .find(market => market.deploymentKey === 'usdc')!;

async function freshCandidate(): Promise<{ db: D1Database, versionId: string }> {
  await server.reset();
  const { APP_DB: db } = await server.getWorker<Env>().getEnv();
  await applyMigrations(db);
  const { versionId } = await seedCandidate(db, snapshot);
  return { db, versionId };
}

// the market's reviewed decisions under another label; its feeds and its creation block are ones the version already knows
function rename(db: D1Database, versionId: string, displayName: string, expectation: { expectedDigest?: string | null } = {}) {
  return replaceMarketOverlay(db, {
    versionId,
    chainId:       1,
    deploymentKey: 'usdc',
    actor:         'test-admin',
    reason:        `call it ${displayName}`,
    overlay:       { ...overlayOfMarket(usdc), displayName },
    ...expectation,
  }, async () => new Map<Address, PriceFeedV1>(), async () => []);
}

const labelOf = (db: D1Database, versionId: string) => db.prepare(
  `SELECT market.display_name FROM markets AS market
   JOIN registry_networks AS network ON network.id = market.network_id
   WHERE market.registry_version_id = ?1 AND network.chain_id = 1 AND market.deployment_key = 'usdc'`
).bind(versionId).first<string>('display_name');

const statusOf = (db: D1Database, versionId: string) => db.prepare(
  `SELECT status FROM registry_versions WHERE id = ?1`
).bind(versionId).first<string>('status');

const resultsOf = (db: D1Database, versionId: string) => db.prepare(
  `SELECT COUNT(*) AS n FROM validation_results WHERE registry_version_id = ?1`
).bind(versionId).first<number>('n');

/*
 * Validation reads the rows, checks them and records what it found. A review
 * written between the reading and the recording would otherwise leave the
 * version validated with a checksum and checks of rows it no longer holds —
 * and that checksum is what every cache key and ETag of the version names.
 */
t.test('a review written while a candidate is validated stops the validation', async t => {
  const { db, versionId } = await freshCandidate();
  const racing = interleaved(db, /INSERT INTO validation_results/, async () => {
    await rename(db, versionId, 'Renamed meanwhile');
  });

  await t.rejects(
    validateStoredVersion(racing, versionId),
    { status: 409, message: /changed while it was being validated/ },
    'the validation is refused',
  );
  t.equal(await statusOf(db, versionId), 'importing', 'the candidate is left as the review left it');
  t.equal(await resultsOf(db, versionId), 0, 'and no checks of the rows that were read are recorded');

  const validated = await validateStoredVersion(db, versionId);
  t.equal(validated.version.status, 'validated', 'validated again, it is decided over the rows it holds');
  t.equal(
    validated.version.checksum,
    await snapshotChecksum(await readSnapshot(db, versionId)),
    'and its checksum is the checksum of those rows',
  );
  t.equal(await labelOf(db, versionId), 'Renamed meanwhile');
});

/*
 * Two validations at once: each read the same rows and checked them. The one
 * written first decides the candidate. The later one finds it decided, which
 * is the answer validating a decided version gives anyway: the same decision,
 * changed by nothing — not a conflict a caller is told to retry.
 */
t.test('of two validations at once, the later one answers with what the first decided', async t => {
  const { db, versionId } = await freshCandidate();
  const racing = interleaved(db, /INSERT INTO validation_results/, async () => {
    await validateStoredVersion(db, versionId);
  });

  const later = await validateStoredVersion(racing, versionId);
  t.same([ later.version.status, later.changed ], [ 'validated', false ],
    'the later one answers that the candidate is validated, and that it changed nothing');
  t.equal(
    later.version.checksum,
    await snapshotChecksum(await readSnapshot(db, versionId)),
    'with the checksum the first one recorded',
  );
  t.equal(await statusOf(db, versionId), 'validated');
  const attempts = await db.prepare(
    `SELECT COUNT(DISTINCT validation_attempt) AS n FROM validation_results WHERE registry_version_id = ?1`
  ).bind(versionId).first<number>('n');
  t.equal(attempts, 1, 'and only the checks of the first one are recorded');
});

/*
 * The other order: the validation lands between the review's reading and its
 * writing. The version is terminal by then, and the review is a conflict to
 * report, not a fault to answer with a 500.
 */
t.test('a review that loses to a validation is refused as a conflict', async t => {
  const { db, versionId } = await freshCandidate();
  const racing = interleaved(db, /INSERT INTO registry_overlay_events/, async () => {
    await validateStoredVersion(db, versionId);
  });

  await t.rejects(
    rename(racing, versionId, 'Too late'),
    { status: 409, message: /validated registry version cannot be changed/ },
    'the review is refused',
  );
  t.equal(await statusOf(db, versionId), 'validated');
  t.equal(await labelOf(db, versionId), usdc.displayName, 'and the validated version is as it was validated');
});

/*
 * Two reviews of one market at once: each read the same overlay and decided
 * against it. The one written first stands; the later one is refused rather
 * than silently replacing it, and the audit records only what happened.
 */
t.test('of two reviews written at once, the later one is refused, not lost', async t => {
  const { db, versionId } = await freshCandidate();
  const racing = interleaved(db, /INSERT INTO registry_overlay_events/, async () => {
    await rename(db, versionId, 'Second');
  });

  await t.rejects(
    rename(racing, versionId, 'First'),
    { status: 409, message: /changed while this overlay was being written/ },
    'the review decided against what the other one replaced is refused',
  );
  t.equal(await labelOf(db, versionId), 'Second', 'the review that was written stands');

  const events = await db.prepare(
    `SELECT reason FROM registry_overlay_events WHERE registry_version_id = ?1`
  ).bind(versionId).all<{ reason: string }>();
  t.same((events.results ?? []).map(event => event.reason), [ 'call it Second' ], 'and only it is recorded');
});

/*
 * A change read, edited and sent back can say which overlay it was decided
 * against. If the market has changed since, sending it back would undo that
 * change without anybody having seen it, so it is refused.
 */
t.test('a change decided against an overlay that has since changed is refused', async t => {
  const { db, versionId } = await freshCandidate();

  const first  = await rename(db, versionId, 'First');
  const second = await rename(db, versionId, 'Second', { expectedDigest: first.digest });
  t.equal(second.changed, true, 'a change decided against the overlay that is stored is written');
  t.not(second.digest, first.digest, 'and answers the digest the next change is decided against');

  await t.rejects(
    rename(db, versionId, 'Third', { expectedDigest: first.digest }),
    { status: 409, message: /no longer the one this was decided against/ },
    'one decided against an overlay replaced since is refused',
  );
  await t.rejects(
    rename(db, versionId, 'Fourth', { expectedDigest: null }),
    { status: 409, message: /no longer the one this was decided against/ },
    'and so is one that expects a market nobody has reviewed',
  );
  t.equal(await labelOf(db, versionId), 'Second');
  t.same(
    await rename(db, versionId, 'Second', { expectedDigest: second.digest }),
    { versionId, changed: false, overlayEventId: null, digest: second.digest, snapshotChecksum: null },
    'sending back exactly what is stored changes nothing',
  );
});
