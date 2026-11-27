import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type { Address, PriceFeedV1 } from '../../../lib/model/comet-registry.js';
import { replaceMarketOverlay, validateStoredVersion } from '../../../src/registry/admin.js';
import { overlayOfMarket } from '../../../src/registry/overlay.js';
import { activateVersion, activationStatements, approveVersion, readSnapshot, readVersionDecisions, snapshotChecksum } from '../../../src/registry/repository.js';

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
 * read is still on and no other move has been written since, and the move is
 * otherwise refused, recording nothing.
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

/*
 * Moves landing between an activation's check and its write refuse it even
 * when they bring the pointer back to the version it read: what it decided,
 * here the approval it picked, may no longer hold.
 */
t.test('moves that bring the pointer back between an activation\'s check and its write refuse the activation', async t => {
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
    {
      code:    'CANDIDATE_STATE_CONFLICT',
      message: `other moves were written while this activate was decided, and ${first} is on again; read the status and ask again`,
    },
    'the activation decided before them is refused',
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
 * is no longer one step back. The rollback is refused, to be decided again.
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
      code:    'CANDIDATE_STATE_CONFLICT',
      message: `other moves were written while this rollback was decided, and ${third} is on again; read the status and ask again`,
    },
    'the rollback decided against the third version\'s activation before is refused',
  );
  t.equal(await activeOf(db), third, 'the third stays on');
  t.equal(await db.prepare(`SELECT COUNT(*) AS n FROM registry_activations WHERE actor = 'alice'`).first<number>('n'), 0,
    'and nothing of the rollback is recorded');
  await t.rejects(
    activateVersion(db, { versionId: second!, action: 'rollback', actor: 'alice', reason: 'go back' }),
    {
      code:    'ROLLBACK_TARGET_INVALID',
      message: `a rollback goes back one step, from ${third} to ${first}, the version it replaced when it was last activated; `
        + `to switch ${second} on, activate it once an admin of another name has approved it`,
    },
    'asked again, it is decided against what is on now, and says what a rollback restores',
  );
});

/*
 * An activation takes its instant before it picks its approval and writes.
 * An approval of the same version given between the two carries a later
 * instant than the activation written after it, and is overtaken by it all
 * the same: "overtaken" is the order the database wrote them in. After a
 * rollback, it does not switch the version on again.
 */
t.test('an approval given while an activation of its version is decided is overtaken by it', async t => {
  const { db, versions: [ first, second ] } = await freshVersions();
  await switchTo(db, first!, true);
  await approveSeeded(db, second!, 'bob');

  let between: string | undefined;
  const racing = interleaved(db, /INSERT INTO registry_activations/, async () => {
    // a moment later than the instant the activation took, so the approval's instant is the later one
    await new Promise(resolve => setTimeout(resolve, 5));
    between = (await approveVersion(db, {
      versionId: second!, actor: 'carol', reason: 'meanwhile', ttlSeconds: 3600, expectedActiveVersionId: first!,
    })).id;
  });
  const switched = await activateVersion(racing, { versionId: second!, action: 'activate', actor: 'alice', reason: 'switch it on' });
  t.ok(switched.changed, 'the activation decided before it is written');
  const [ written ] = (await db.prepare(
    `SELECT activation.created_at < approval.created_at AS earlier
     FROM registry_activations AS activation, registry_approvals AS approval
     WHERE activation.id = ?1 AND approval.id = ?2`
  ).bind(switched.activationId, between).all<{ earlier: number }>()).results ?? [];
  t.equal(written?.earlier, 1, 'with an instant before the approval\'s');

  await activateVersion(db, { versionId: first!, action: 'rollback', actor: 'carol', reason: 'back' });
  await t.rejects(
    activateVersion(db, { versionId: second!, action: 'activate', actor: 'alice', reason: 'again' }),
    { code: 'APPROVAL_REQUIRED' },
    'the approval given meanwhile does not switch the version on again after the rollback',
  );
  const { approvals } = await readVersionDecisions(db, second!);
  t.same(approvals.find(approval => approval.id === between)?.usable, false, 'and the version\'s detail says it is not usable');
});

/*
 * An activation refused for moves in between is decided again when it is
 * asked again, against what is on then. An approval given against the
 * version that is on again, and not overtaken by a move of its own version,
 * holds again: another version going on only suspended it.
 */
t.test('an activation refused for moves that brought the pointer back goes through when asked again, with its approval', async t => {
  const { db, versions: [ first, second, third ] } = await freshVersions();
  await switchTo(db, first!, true);
  const approval = await approveSeeded(db, second!, 'bob');

  // carol switches the third on and rolls back to the first, before alice's write
  const racing = interleaved(db, /INSERT INTO registry_activations/, async () => {
    await switchTo(db, third!, true);
    await activateVersion(db, { versionId: first!, action: 'rollback', actor: 'carol', reason: 'and back' });
  });
  await t.rejects(
    activateVersion(racing, { versionId: second!, action: 'activate', actor: 'alice', reason: 'switch it on' }),
    {
      code:    'CANDIDATE_STATE_CONFLICT',
      message: `other moves were written while this activate was decided, and ${first} is on again; read the status and ask again`,
    },
    'the activation decided before them is refused',
  );
  t.equal(await db.prepare(`SELECT COUNT(*) AS n FROM registry_activations WHERE actor = 'alice'`).first<number>('n'), 0,
    'and nothing of it is recorded');

  const again = await activateVersion(db, { versionId: second!, action: 'activate', actor: 'alice', reason: 'switch it on' });
  t.same([ again.changed, again.approvalId ], [ true, approval.id ], 'asked again, it is written, with the approval given against the first');
  t.equal(await activeOf(db), second, 'and the second is on');
});

/*
 * An activation picks an approval in force at the instant it took, and
 * writes a moment later. An approval that expires in between is refused at
 * the write, by the database's clock, and nothing of the activation is
 * recorded.
 */
t.test('an approval that expires between an activation\'s check and its write refuses the activation', async t => {
  const { db, versions: [ first, second ] } = await freshVersions();
  await switchTo(db, first!, true);
  await approveVersion(db, { versionId: second!, actor: 'bob', reason: 'read it', ttlSeconds: 2, expectedActiveVersionId: first! });

  // the write waits until the approval has expired
  const racing = interleaved(db, /INSERT INTO registry_activations/, async () => {
    await new Promise(resolve => setTimeout(resolve, 3_000));
  });
  await t.rejects(
    activateVersion(racing, { versionId: second!, action: 'activate', actor: 'alice', reason: 'switch it on' }),
    {
      code:    'APPROVAL_REQUIRED',
      message: `the approval of registry version ${second} this activation was to use was no longer in force when it was written; read the version and ask again`,
    },
    'the activation is refused for the approval it was to use',
  );
  t.equal(await activeOf(db), first, 'nothing moved');
  t.equal(await db.prepare(`SELECT COUNT(*) AS n FROM registry_activations WHERE actor = 'alice'`).first<number>('n'), 0,
    'and nothing of it is recorded');
});

/*
 * Moves are taken in the order the database wrote them, not by the instants
 * Workers gave them, whose clocks need not agree. Here the second version is
 * switched on in place of the third, a newer one, by a move written last but
 * at an earlier instant than the one that first switched it on, in place of
 * the first. That last move is the one a rollback goes back from, and the
 * one the version's history lists first.
 */
t.test('a version\'s last move is the one written last, whatever instants the moves carry', async t => {
  const { db, versions: [ first, second, third ] } = await freshVersions();
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
  const written = async (versionId: string, at: string): Promise<string> => {
    const approval = await approveSeeded(db, versionId, 'bob');
    const activationId = randomUUID();
    await db.batch(activationStatements(db, { activationId, versionId, action: 'activate', actor: 'alice', reason: 'test', at, approvalId: approval.id }));
    return activationId;
  };
  await written(first!, ago(30));
  const toSecond = await written(second!, ago(10));
  const toThird  = await written(third!, ago(5));
  const back     = await written(second!, ago(20));

  await t.rejects(
    activateVersion(db, { versionId: first!, action: 'rollback', actor: 'carol', reason: 'go back' }),
    {
      code:    'ROLLBACK_TARGET_INVALID',
      message: `a rollback goes back one step, and ${second} replaced no older version when it was last activated, so nothing is restored alone; `
        + `to switch ${first} on, activate it once an admin of another name has approved it`,
    },
    'from the second, switched on last in place of the newer third, no rollback goes back to the first',
  );
  t.equal(await activeOf(db), second, 'the second stays on');
  t.same((await readVersionDecisions(db, second!)).activations.map(activation => activation.id), [ back, toThird, toSecond ],
    'and its history lists its moves in the order they were written');
});
