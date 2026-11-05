import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type { ActivationResultV1, ApprovalV1 } from '../../../lib/model/comet-registry.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import { registryConfig } from '../../../src/registry/config.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate, validateSeeded } from '../../util/registry-fixture.js';
import { registryWorker } from '../../util/registry-worker.js';

/*
 * Two people switch a version on: an admin approves it, and an admin of
 * another name activates it. A rollback is one person's, as break-glass, but
 * goes back one step only: to the version the one on replaced when it was
 * last activated, if that is older. These tests hold the rules through the
 * worker, as a client meets them.
 */
const ALICE = 'registry-alice-token-for-tests';
const BOB   = 'registry-bob-token-for-tests';
// carol rotating her token: two tokens of one name, which are one person
const CAROL_OLD = 'registry-carol-old-token-for-tests';
const CAROL_NEW = 'registry-carol-new-token-for-tests';

const admin = async (name: string, token: string) => ({ name, sha256: await sha256Hex(token), role: 'admin', notAfter: null });

const server = createTestHarness({
  workers: [ registryWorker({
    COMET_REGISTRY_ADMIN_TOKENS: JSON.stringify([
      await admin('alice', ALICE),
      await admin('bob', BOB),
      await admin('carol', CAROL_OLD),
      await admin('carol', CAROL_NEW),
    ]),
  }) ],
});

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

/*
 * Validated versions, each a later attempt than the one before: the order a
 * rollback goes back in is the order they were made in, and two made within
 * one millisecond are still told apart by their attempts.
 */
function versionsOf(db: D1Database): () => Promise<string> {
  let attempt = 0;
  return async () => {
    const { versionId } = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: ++attempt });
    await validateSeeded(db, versionId);
    return versionId;
  };
}

type Answer = { status: number, body: Record<string, unknown> & { error?: { code: string, message: string, details?: { code?: string } } } };

async function post(path: string, body: unknown, token: string): Promise<Answer> {
  const response = await server.fetch(path, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Answer['body'] };
}

// an approval names the version its giver read the changes against, `against`: null for nothing on
const approve  = (versionId: string, token: string, against: string | null, body: Record<string, unknown> = {}) =>
  post(`/registry/v1/admin/versions/${versionId}/approve`, { reason: 'read its changes', expectedActiveVersionId: against, ...body }, token);
const activate = (versionId: string, token: string, body: Record<string, unknown> = {}) =>
  post(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'switch it on', ...body }, token);
const rollback = (versionId: string, token: string, body: Record<string, unknown> = {}) =>
  post(`/registry/v1/admin/versions/${versionId}/rollback`, { reason: 'go back', ...body }, token);

const resultOf = (answer: Answer) => answer.body as unknown as ActivationResultV1;

// approved by bob against the version it replaces, `replacing`, and activated by alice
async function switchOn(versionId: string, replacing: string | null): Promise<ActivationResultV1> {
  const approved  = await approve(versionId, BOB, replacing);
  const activated = await activate(versionId, ALICE);
  if (approved.status !== 200 || activated.status !== 200) {
    throw new Error(`${versionId} was not switched on: approve ${approved.status}, activate ${activated.status}`);
  }
  return resultOf(activated);
}

async function detailOf(versionId: string): Promise<{ approvals: ApprovalV1[], activations: Array<{ id: string, approvalId: string | null }> }> {
  const response = await server.fetch(`/registry/v1/admin/versions/${versionId}`, { headers: { 'Authorization': `Bearer ${ALICE}` } });
  return await response.json() as { approvals: ApprovalV1[], activations: Array<{ id: string, approvalId: string | null }> };
}

const activeOf = (db: D1Database) => db.prepare(`SELECT active_version_id FROM registry_state`).first<string | null>('active_version_id');
const moves    = async (db: D1Database) => (await db.prepare(`SELECT COUNT(*) AS n FROM registry_activations`).first<number>('n')) ?? 0;

const refusedFor = (answer: Answer, code: string) => [ answer.status, answer.body.error?.details?.code ].join(' ') === `409 ${code}`;

t.test('an activation needs an approval by an admin of another name', async t => {
  const db      = await freshDatabase();
  const version = versionsOf(db);
  const first   = await version();

  const unapproved = await activate(first, ALICE, { expectedActiveVersionId: null });
  t.ok(refusedFor(unapproved, 'APPROVAL_REQUIRED'), 'the first activation of an environment needs one too');
  t.match(unapproved.body.error?.message, `registry version ${first} has no approval alice can activate it with`, 'and says so');
  t.same([ await activeOf(db), await moves(db) ], [ null, 0 ], 'nothing moved, and nothing is audited');

  const own = await approve(first, ALICE, null);
  t.equal(own.status, 200, 'an admin approves a version');
  const approval = own.body.approval as ApprovalV1;
  t.match(approval, { versionId: first, actor: 'alice', reason: 'read its changes', activeVersionId: null, activationId: null, usable: true },
    'by the name of the token, against what is on, here nothing');
  const { approvalTtlSeconds } = registryConfig(await server.getWorker<Env>().getEnv());
  t.equal(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt), approvalTtlSeconds * 1000,
    'for as long as COMET_REGISTRY_APPROVAL_TTL_S says');
  t.ok(refusedFor(await activate(first, ALICE), 'APPROVAL_REQUIRED'), 'and does not switch it on on that approval');

  const approved = await approve(first, BOB, null);
  const activated = await activate(first, ALICE, { expectedActiveVersionId: null });
  t.equal(activated.status, 200, 'another admin\'s approval lets it through');
  const result = resultOf(activated);
  t.equal(result.approvalId, (approved.body.approval as ApprovalV1).id, 'the newest by another name, which the answer names');

  const detail = await detailOf(first);
  t.same(detail.activations.map(({ id, approvalId }) => ({ id, approvalId })), [ { id: result.activationId, approvalId: result.approvalId } ],
    'as the history of the version does');
  t.same(detail.approvals.map(({ actor, activationId, usable }) => ({ actor, activationId, usable })), [
    { actor: 'bob', activationId: result.activationId, usable: false },
    { actor: 'alice', activationId: null, usable: false },
  ], 'which lists every approval, newest first, the one used with its activation, and neither usable once the version is on');
});

/*
 * A name is a person: two tokens of one name — a holder rotating a token —
 * never approve each other's activation.
 */
t.test('two tokens of one name are one person', async t => {
  const db    = await freshDatabase();
  const first = await versionsOf(db)();

  t.equal((await approve(first, CAROL_OLD, null)).status, 200, 'carol approves with her old token');
  t.ok(refusedFor(await activate(first, CAROL_NEW), 'APPROVAL_REQUIRED'), 'and cannot switch the version on with her new one');
  t.equal((await activate(first, ALICE)).status, 200, 'while alice can');
});

t.test('an approval is used once, and a move back makes switching on again a new decision', async t => {
  const db      = await freshDatabase();
  const version = versionsOf(db);
  const first   = await version();
  const second  = await version();
  await switchOn(first, null);

  // bob approves the second twice, as a request sent again does
  t.equal((await approve(second, BOB, first)).status, 200, 'bob approves the second version');
  t.equal((await approve(second, BOB, first)).status, 200, 'every request records an approval');
  t.equal((await activate(second, ALICE)).status, 200, 'one lets the second version through');
  t.equal((await rollback(first, ALICE)).status, 200, 'alice rolls back to the first, alone');

  const again = await activate(second, ALICE);
  t.ok(refusedFor(again, 'APPROVAL_REQUIRED'), 'switching the second on again takes neither approval: one is used, and the other came before the move');
  t.same([ await activeOf(db), await moves(db) ], [ first, 3 ], 'and nothing moves');

  t.equal((await approve(second, BOB, first)).status, 200, 'a new approval');
  t.equal((await activate(second, ALICE)).status, 200, 'lets it through again');
});

t.test('the version on is not approved, and an approval holds only while the version it was given against is on', async t => {
  const db      = await freshDatabase();
  const version = versionsOf(db);
  const first   = await version();
  const second  = await version();
  const third   = await version();
  await switchOn(first, null);

  const on = await approve(first, BOB, first);
  t.ok(refusedFor(on, 'CANDIDATE_STATE_CONFLICT'), 'approving the version that is on is refused');
  t.match(on.body.error?.message, `registry version ${first} is on already`, 'as no change to approve');

  t.equal((await approve(second, BOB, first)).status, 200, 'the second is approved against the first');
  await switchOn(third, first);
  const stale = await activate(second, ALICE);
  t.ok(refusedFor(stale, 'APPROVAL_REQUIRED'), 'and once the third is on, that approval switches nothing on: it was given for another change');
  t.match(stale.body.error?.message, `given while ${third} was on`, 'the refusal saying against which version one is needed');
  t.same((await detailOf(second)).approvals.map(approval => approval.usable), [ false ], 'and the history says it can no longer be used');

  const late = await approve(second, BOB, first);
  t.ok(refusedFor(late, 'CANDIDATE_STATE_CONFLICT'), 'an approval decided against a version no longer on is refused');
  t.match(late.body.error?.message, `the active version is ${third}, not ${first} as this approval expected`, 'naming what is on');
  t.equal((await approve(second, BOB, third)).status, 200, 'one decided against what is on is given');
});

t.test('an approval past its expiry lets nothing through', async t => {
  const db      = await freshDatabase();
  const version = versionsOf(db);
  const first   = await version();
  const checksum = await db.prepare(`SELECT snapshot_checksum FROM registry_versions WHERE id = ?1`).bind(first).first<string>('snapshot_checksum');

  // given yesterday for an hour, as an approval nobody used would be
  const given = Date.now() - 86_400_000;
  await db.prepare(
    `INSERT INTO registry_approvals (id, registry_version_id, snapshot_checksum, active_version_id, actor, reason, created_at, expires_at)
     VALUES (?1, ?2, ?3, NULL, 'bob', 'read its changes', ?4, ?5)`
  ).bind(randomUUID(), first, checksum, new Date(given).toISOString(), new Date(given + 3_600_000).toISOString()).run();

  t.ok(refusedFor(await activate(first, ALICE), 'APPROVAL_REQUIRED'), 'an expired approval is no approval');
  t.same((await detailOf(first)).approvals.map(approval => approval.usable), [ false ], 'and the history says it can no longer be used');
});

/*
 * A rollback needs nobody's approval, so that undoing a bad version takes one
 * person. It goes back one step: to the version the one on replaced when an
 * activation last switched it on. Going back further is another rollback,
 * from there; going anywhere else is an activation, which needs two.
 */
t.test('a rollback goes back one step alone, and each step back is a rollback of its own', async t => {
  const db      = await freshDatabase();
  const version = versionsOf(db);
  const first   = await version();
  const second  = await version();
  const third   = await version();
  const fourth  = await version();
  const fifth   = await version();

  const nothing = await rollback(first, ALICE);
  t.ok(refusedFor(nothing, 'ROLLBACK_TARGET_INVALID'), 'with nothing on, there is nothing to roll back');
  t.match(nothing.body.error?.message, 'nothing is on', 'and says so');

  await switchOn(first, null);
  await switchOn(second, first);
  await switchOn(third, second);
  await switchOn(fourth, third);

  const never = await rollback(fifth, ALICE);
  t.ok(refusedFor(never, 'ROLLBACK_TARGET_INVALID'), 'a version never on is not rolled back to');
  t.match(never.body.error?.message, `a rollback goes back one step, from ${fourth} to ${third}`, 'the refusal naming what a rollback restores now');
  t.match(never.body.error?.message, `to switch ${fifth} on, activate it once an admin of another name has approved it`,
    'and how the version asked for is switched on');

  const twoSteps = await rollback(second, ALICE);
  t.ok(refusedFor(twoSteps, 'ROLLBACK_TARGET_INVALID'), 'two steps back at once are refused, though that version was on');
  t.match(twoSteps.body.error?.message, `from ${fourth} to ${third}`, 'naming the one step there is');
  t.same([ await activeOf(db), await moves(db) ], [ fourth, 4 ], 'and nothing moves');

  const same = await rollback(fourth, ALICE);
  t.same([ same.status, resultOf(same).changed ], [ 200, false ], 'a rollback to the version on changes nothing');

  const back = await rollback(third, ALICE, { expectedActiveVersionId: fourth });
  t.equal(back.status, 200, 'one step back, alone');
  t.same([ resultOf(back).approvalId, resultOf(back).previousVersionId ], [ null, fourth ], 'with no approval, naming what it replaced');
  const further = await rollback(second, ALICE, { expectedActiveVersionId: third });
  t.equal(further.status, 200, 'and the step before it is another rollback, to what the third replaced when it was switched on');

  const forward = await rollback(third, ALICE);
  t.ok(refusedFor(forward, 'ROLLBACK_TARGET_INVALID'), 'a newer version is not rolled back to, though it was on');
  t.match(forward.body.error?.message, `from ${second} to ${first}`, 'naming the step back from the version on');
  t.equal(await activeOf(db), second, 'and the second version is on');
  t.same(((await db.prepare(`SELECT action FROM registry_activations ORDER BY rowid`).all<{ action: string }>()).results ?? []).map(row => row.action),
    [ 'activate', 'activate', 'activate', 'activate', 'rollback', 'rollback' ], 'each step back recorded as a move of its own');
});

/*
 * An activation may switch on a version older than the one on, approved like
 * any other. What it replaced is newer, so nothing is rolled back to from it
 * alone: bringing the newer one back takes an approval too.
 */
t.test('a version switched on in place of a newer one is not rolled back from alone', async t => {
  const db      = await freshDatabase();
  const version = versionsOf(db);
  const first   = await version();
  const second  = await version();
  await switchOn(first, null);
  await switchOn(second, first);
  await switchOn(first, second);

  const back = await rollback(second, ALICE);
  t.ok(refusedFor(back, 'ROLLBACK_TARGET_INVALID'), 'the newer version the downgrade replaced is not restored alone');
  t.match(back.body.error?.message, `${first} replaced no older version when it was last activated, so nothing is restored alone`,
    'nor anything else');
  const same = await rollback(first, ALICE);
  t.same([ same.status, resultOf(same).changed ], [ 200, false ], 'while a rollback to the version on is the no-op it always is');

  await switchOn(second, first);
  t.equal((await rollback(first, ALICE)).status, 200, 'once an approved activation brings the newer one back, a rollback goes back from it');
});

/*
 * An approval is of one change, from the version on to the one approved, so
 * it names the version its giver read the changes against, null when nothing
 * is on: one without it could be recorded against a version nobody read the
 * changes against.
 */
t.test('an approval takes a reason and the version it was decided against, and nothing else', async t => {
  const db        = await freshDatabase();
  const validated = await versionsOf(db)();
  const { versionId: draft } = await seedCandidate(db, snapshot, { versionId: randomUUID() });

  t.ok(refusedFor(await approve(draft, BOB, null), 'CANDIDATE_STATE_CONFLICT'), 'a draft is not approved');
  t.equal((await approve(randomUUID(), BOB, null)).status, 404, 'a version that does not exist is not found');
  t.equal((await post(`/registry/v1/admin/versions/${validated}/approve`, { expectedActiveVersionId: null }, BOB)).status, 400,
    'an approval without a reason is refused');
  const unread = await post(`/registry/v1/admin/versions/${validated}/approve`, { reason: 'read its changes' }, BOB);
  t.same([ unread.status, unread.body.error?.code ], [ 400, 'BAD_REQUEST' ], 'and so is one that does not say what it was decided against');
  t.equal(unread.body.error?.message,
    'expectedActiveVersionId is required: the id of the version on that the changes were read against, or null when nothing is on',
    'saying what to send');
  t.equal((await approve(validated, BOB, null, { actor: 'somebody' })).status, 400, 'and one that names its approver');
  t.equal((await approve(validated, BOB, null, { expectedActiveVersionId: 42 })).status, 400, 'or expects something that is no version');
  t.equal(await db.prepare(`SELECT COUNT(*) AS n FROM registry_approvals`).first<number>('n'), 0, 'none of them is recorded');
});
