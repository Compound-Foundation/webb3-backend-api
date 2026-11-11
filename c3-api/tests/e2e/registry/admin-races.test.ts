import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type { Address, PriceFeedV1 } from '../../../lib/model/comet-registry.js';
import { replaceMarketOverlay, validateStoredVersion } from '../../../src/registry/admin.js';
import { overlayOfMarket } from '../../../src/registry/overlay.js';
import { activateVersion, activationStatements, readSnapshot, snapshotChecksum } from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { interleaved } from '../../util/interleave.js';
import { approveSeeded, loadRegistrySnapshotFixture, seedCandidate, validateSeeded } from '../../util/registry-fixture.js';
import { registryWorker } from '../../util/registry-worker.js';

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
const server = createTestHarness({ workers: [ registryWorker() ] });

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

/*
 * A move is decided against the version that is on: whether it needs an
 * approval, which one, and which version a rollback restores. Another move
 * landing between that reading and the write would leave a decision about
 * one change written as another, so the write is made only while the version
 * read is still on, and the move is otherwise refused, recording nothing.
 *
 * Until an environment has an approval, only the code holds the rule, so the
 * race is run on a database without one as well: its moves are made as the
 * release before approvals made them.
 */
async function freshVersions(): Promise<{ db: D1Database, versions: string[] }> {
  await server.reset();
  const { APP_DB: db } = await server.getWorker<Env>().getEnv();
  await applyMigrations(db);
  const versions: string[] = [];
  // each a later attempt than the one before, which is the order a rollback goes back in
  for (const attempt of [ 1, 2, 3 ]) {
    const { versionId } = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt });
    await validateSeeded(db, versionId);
    versions.push(versionId);
  }
  return { db, versions };
}

// a move written as it is, by the release before approvals when `approved` is false, and as an activation does otherwise
async function switchTo(db: D1Database, versionId: string, approved: boolean): Promise<void> {
  if (approved) {
    await approveSeeded(db, versionId, 'bob');
    await activateVersion(db, { versionId, action: 'activate', actor: 'carol', reason: 'meanwhile' });
    return;
  }
  await db.batch(activationStatements(db, {
    activationId: randomUUID(), versionId, action: 'activate', actor: 'carol', reason: 'meanwhile',
    at: new Date().toISOString(), approvalId: null,
  }));
}

const activeOf = (db: D1Database) => db.prepare(`SELECT active_version_id FROM registry_state`).first<string | null>('active_version_id');
const movesOf  = async (db: D1Database, action: string) => (await db.prepare(
  `SELECT COUNT(*) AS n FROM registry_activations WHERE action = ?1`
).bind(action).first<number>('n')) ?? 0;

for (const approved of [ false, true ]) {
  const where = approved ? 'once the environment has an approval' : 'before the environment has an approval';

  t.test(`a version switched on between a rollback's check and its write refuses the rollback, ${where}`, async t => {
    const { db, versions: [ first, second, third ] } = await freshVersions();
    await switchTo(db, first!, approved);
    await switchTo(db, second!, approved);

    const racing = interleaved(db, /INSERT INTO registry_activations/, async () => {
      await switchTo(db, third!, approved);
    });
    await t.rejects(
      activateVersion(racing, { versionId: first!, action: 'rollback', actor: 'alice', reason: 'go back' }),
      { code: 'CANDIDATE_STATE_CONFLICT', message: `the active version changed to ${third} while this rollback was decided; read the status and ask again` },
      'the rollback decided against the second version is refused',
    );
    t.equal(await activeOf(db), third, 'the version switched on meanwhile stays on');
    t.equal(await movesOf(db, 'rollback'), 0, 'and no rollback is recorded');
  });

  /*
   * Nothing is decided for a move to the version that is on, and nothing is
   * written for it: a move landing meanwhile has nothing to land between.
   */
  t.test(`a move to the version on writes nothing, whatever lands meanwhile, ${where}`, async t => {
    const { db, versions: [ first, second ] } = await freshVersions();
    await switchTo(db, first!, approved);

    let landed = false;
    const racing = interleaved(db, /./, async () => {
      landed = true;
      await switchTo(db, second!, approved);
    });
    const answer = await activateVersion(racing, { versionId: first!, action: 'activate', actor: 'alice', reason: 'again' });
    t.same([ answer.changed, answer.activationId, answer.approvalId ], [ false, null, null ], 'it is the idempotent no-op');
    t.notOk(landed, 'which sends no write for anything to land before');
    t.equal(await movesOf(db, 'activate'), 1, 'and records nothing');
  });
}

t.test('a rollback landing between an activation\'s check and its write refuses the activation', async t => {
  const { db, versions: [ first, second, third ] } = await freshVersions();
  await switchTo(db, first!, true);
  await switchTo(db, second!, true);
  await approveSeeded(db, third!, 'bob');

  const racing = interleaved(db, /INSERT INTO registry_activations/, async () => {
    await activateVersion(db, { versionId: first!, action: 'rollback', actor: 'carol', reason: 'meanwhile' });
  });
  await t.rejects(
    activateVersion(racing, { versionId: third!, action: 'activate', actor: 'alice', reason: 'switch it on' }),
    { code: 'CANDIDATE_STATE_CONFLICT', message: `the active version changed to ${first} while this activate was decided; read the status and ask again` },
    'the activation decided against the second version is refused',
  );
  t.equal(await activeOf(db), first, 'the rollback stands');
  t.equal(await db.prepare(`SELECT COUNT(*) AS n FROM registry_activations WHERE registry_version_id = ?1`).bind(third).first<number>('n'), 0,
    'and the activation is not recorded');
});

/*
 * Two admins switching one approved version on at once: the one written
 * first uses the approval. The other finds the version on, which is where a
 * request made a moment later would find it: the idempotent no-op. Had the
 * version gone off again in between, the approval would be used up, and the
 * later activation is refused for it, by the database.
 */
t.test('of two activations of one approved version at once, one uses the approval, and the other changes nothing', async t => {
  const { db, versions: [ first, second ] } = await freshVersions();
  await switchTo(db, first!, true);
  const approval = await approveSeeded(db, second!, 'bob');

  const racing = interleaved(db, /INSERT INTO registry_activations/, async () => {
    await activateVersion(db, { versionId: second!, action: 'activate', actor: 'carol', reason: 'meanwhile' });
  });
  const later = await activateVersion(racing, { versionId: second!, action: 'activate', actor: 'alice', reason: 'switch it on' });
  t.same([ later.changed, later.activationId, later.approvalId ], [ false, null, null ], 'the later one changes nothing, and uses nothing');
  t.same(
    (await db.prepare(`SELECT actor, approval_id FROM registry_activations WHERE registry_version_id = ?1`).bind(second).all()).results,
    [ { actor: 'carol', approval_id: approval.id } ],
    'while the first is recorded with the approval',
  );
});

t.test('an approval used up between an activation\'s check and its write refuses the activation', async t => {
  const { db, versions: [ first, second ] } = await freshVersions();
  await switchTo(db, first!, true);
  await approveSeeded(db, second!, 'bob');

  // carol switches the version on with the approval, and back off, before alice's write
  const racing = interleaved(db, /INSERT INTO registry_activations/, async () => {
    await activateVersion(db, { versionId: second!, action: 'activate', actor: 'carol', reason: 'meanwhile' });
    await activateVersion(db, { versionId: first!, action: 'rollback', actor: 'carol', reason: 'and back' });
  });
  await t.rejects(
    activateVersion(racing, { versionId: second!, action: 'activate', actor: 'alice', reason: 'switch it on' }),
    { code: 'APPROVAL_REQUIRED', message: /was used up while it was decided/ },
    'the activation is refused for the approval it was to use',
  );
  t.equal(await activeOf(db), first, 'nothing moved');
  t.equal(await db.prepare(`SELECT COUNT(*) AS n FROM registry_activations WHERE actor = 'alice'`).first<number>('n'), 0,
    'and nothing of it is recorded');
});

/*
 * A rollback restores the version the one on replaced when it was last
 * activated. Moves landing between its check and its write can switch the
 * version on off and on again, in place of another: the pointer is back
 * where the rollback read it, but the version the rollback was to restore
 * is no longer one step back. The database refuses it then, and the refusal
 * says what a rollback restores now.
 */
t.test('a version switched on again between a rollback\'s check and its write refuses the rollback to what it replaced before', async t => {
  const { db, versions: [ first, second, third ] } = await freshVersions();
  await switchTo(db, first!, true);
  await switchTo(db, second!, true);
  await switchTo(db, third!, true);

  // carol goes back from the third to the second and the first, and the third is switched on again in place of the first
  const racing = interleaved(db, /INSERT INTO registry_activations/, async () => {
    await activateVersion(db, { versionId: second!, action: 'rollback', actor: 'carol', reason: 'meanwhile' });
    await activateVersion(db, { versionId: first!, action: 'rollback', actor: 'carol', reason: 'and again' });
    await switchTo(db, third!, true);
  });
  await t.rejects(
    activateVersion(racing, { versionId: second!, action: 'rollback', actor: 'alice', reason: 'go back' }),
    {
      code:    'ROLLBACK_TARGET_INVALID',
      message: `the version on was switched on again while this rollback was decided, and a rollback goes back one step, from ${third} to ${first}, `
        + `the version it replaced when it was last activated; to switch ${second} on, activate it once an admin of another name has approved it`,
    },
    'the rollback decided against the third version\'s activation before is refused',
  );
  t.equal(await activeOf(db), third, 'the third stays on');
  t.equal(await db.prepare(`SELECT COUNT(*) AS n FROM registry_activations WHERE actor = 'alice'`).first<number>('n'), 0,
    'and nothing of the rollback is recorded');
});
