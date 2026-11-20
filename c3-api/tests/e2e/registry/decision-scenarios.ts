import t from 'tap';

import { randomUUID } from 'node:crypto';

import type {
  ActiveMarketV1,
  Address,
  CollateralDecisionListV1,
  NetworkV1,
  TokenPoliciesV1,
} from '../../../lib/model/comet-registry.js';
import { checksumAddress } from '../../../lib/model/comet-registry.js';
import type { CollateralDecisionKind } from '../../../src/registry/collateral-decision-repository.js';
import {
  DEPRECATED_COLLATERAL_KIND,
  HIDDEN_COLLATERAL_KIND,
  applyCollaterals,
  setCollateral,
} from '../../../src/registry/collateral-decision-repository.js';
import { member } from '../../../src/registry/decision-store.js';
import { applyTokenPolicies, setTokenPolicy } from '../../../src/registry/token-policy-repository.js';

import { foreignKeyViolations } from '../../util/d1.js';
import { interleaved } from '../../util/interleave.js';
import type { AdminClient, Answer } from '../../util/registry-admin.js';
import { ADMIN_ACTOR, adminClient, count, freshActive, seedValidated } from '../../util/registry-admin.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import type { RegistryHarness } from '../../util/registry-harness.js';

/*
 * What token policies, deprecated collaterals and hidden collaterals do
 * alike. All are kinds of one store of decisions
 * (src/registry/decision-store.ts) behind routes of one shape, so a decision,
 * a list of them, the races around their writes and the refusals of their
 * routes are tested here once, over a description of each kind
 * (DecisionKindUnderTest): a change to what the kinds share is made, and
 * checked, for every one. So is what a decision changes in the market reads,
 * for each kind they flag a collateral by; what the active reads answer with
 * those decisions, and the record an outage answers with, are
 * collateral-read-scenarios.ts's.
 *
 * Each kind runs them from its own files, beside the tests only it has:
 * decisionScenarios from token-policies.test.ts,
 * deprecated-collaterals.test.ts and hidden-collaterals.test.ts,
 * decisionRouteScenarios from token-policy-routes.test.ts,
 * deprecated-collateral-routes.test.ts and hidden-collateral-routes.test.ts.
 * The descriptions also drive the tests in Node that need a kind's tables or
 * routes: decision-read.test.ts and
 * collateral-read-scenarios.ts, which deprecated-collateral-reads.test.ts and
 * hidden-collateral-reads.test.ts run. This module is not a test file, and
 * tap does not run it on its own.
 */

// what a decision is about, by the names its answers and its list rows give its addresses: a token, or a collateral of a Comet
type Subject = Record<string, Address>;

/*
 * What a kind lists of the active version's mainnet: the decision in force
 * for a subject the list names (undefined for one it does not), and the
 * decisions it keeps for subjects the version does not hold.
 */
type Listing = {
  versionId:  string | undefined,
  decisionOf: (subject: Subject) => boolean | undefined,
  retained:   unknown,
};

/*
 * A kind of decision, as the scenarios drive it: what its tests call it, its
 * routes, tables and commands, and the subjects of the fixture they decide
 * about. Every subject is on mainnet.
 */
type DecisionKindUnderTest = {
  // what a decision is about, the kind itself, and what a decision makes a subject, in the names of the tests
  noun:       string,
  label:      string,
  adjective:  string,
  // whether the market reads flag a collateral by the kind's decisions, under the kind's flag
  flagged:    boolean,
  // the flag a decision sets, as the answers name it, and an event's flag before the change
  flag:       string,
  previous:   string,
  // the decisions in force, and their audit
  tables:     { rows: string, events: string },
  // the refusal of a write whose subject a version activated meanwhile does not hold
  left:       { code: string, message: RegExp },
  // the route of one subject's decision, which a test also gives a malformed chain id or address
  path:       (chainId: number | string, subject: Record<string, string>) => string,
  // the routes of a list, the member of its body that holds the rows, what a refusal calls the list, and the other kind's member
  list:       { export: string, review: string, apply: string, key: string, what: string, other: string },
  // the kind's own reads of a chain, beside one subject's decision and the export, each with a name for the tests
  reads:      (chainId: number) => Array<[ string, string ]>,
  // a subject that `without` drops, one that every version of the scenarios holds, and the fixture without the first
  subject:    Subject,
  other:      Subject,
  without:    NetworkV1[],
  // the kind's commands, called as a request calls them, so that a test can let a race in between their read and their write
  set:        (db: D1Database, change: { subject: Subject, flag: boolean, actor: string, reason: string }) => Promise<unknown>,
  apply:      (db: D1Database, list: { reason: string | null, rows: Array<[ Subject, boolean, string | null ]> }, actor: string) => Promise<unknown>,
  listing:    (admin: AdminClient) => Promise<Listing>,
  // what `listing` keeps for a subject the version does not hold, decided with the flag set at `updatedAt`
  retained:   (subject: Subject, updatedAt: string | null) => unknown,
  // a list whose first row is fine and whose every other row has a problem, and what review names for each row
  problems:   { list: Record<string, unknown>, named: Array<[ number, string | null ]> },
  // subjects the active version does not hold, each with a name for the tests and what its refusal says
  unheld:     Array<[ string, Subject, RegExp ]>,
  // a list with rows malformed every way the kind's rows can be, and every problem its refusal names
  malformed:  { list: Record<string, unknown>, problems: string[] },
  // the last migration of each database without the kind's tables, and the public reads that need them
  migrations: { through: string[], reads: Array<[ string, string ]> },
};

// what every kind answers, by the members they share; a member named after the kind is read through it
type Decided  = Record<string, unknown> & { changed: boolean, updatedAt: string | null };
type Detail   = Record<string, unknown> & {
  inActiveVersion: boolean,
  updatedAt:       string | null,
  updatedBy:       string | null,
  events:          Array<Record<string, unknown>>,
};
type Reviewed = Record<string, unknown> & { summary: { problems: number } };
type Refused  = { error: { code: string, message: string, details?: { registryVersion?: { id: string }, problems?: unknown[] } } };

const snapshot = loadRegistrySnapshotFixture();

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// a subject by its checksummed addresses, which name the same subject
function checksummed(subject: Subject): Record<string, string> {
  return Object.fromEntries(Object.entries(subject).map(([ name, address ]) => [ name, checksumAddress(address) ]));
}

// values by the columns of every kind's tables, which name in snake case what their answers name in camel case
function columnsOf(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([ name, value ]) => [ name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value ]));
}

// the rows that hold these values, as count() selects them
function rowOf(values: Record<string, unknown>): [ string, ...unknown[] ] {
  const columns = columnsOf(values);
  return [ Object.keys(columns).map((column, index) => `${column} = ?${index + 1}`).join(' AND '), ...Object.values(columns) ];
}

/*
 * Every statement that names a kind's table of decisions, as a test picks
 * out the kind's reads to fail them (failingStatements) or to count them: by
 * the table each kind reads apart from every other, rather than by how the
 * statement around it is written.
 */
function statementsOf(kind: Pick<DecisionKindUnderTest, 'tables'>): RegExp {
  return new RegExp(`\\b${kind.tables.rows}\\b`);
}

/*
 * The decisions of one kind through the real worker in workerd over local
 * D1: a decision and its audit, idempotency under a race, survival across
 * activations, the database guard against an activation that races a write,
 * a list refused for its problems, or for what happened while it was written,
 * and, for a kind the market reads flag a collateral by, what a decision
 * changes in them.
 */
function decisionScenarios(harness: RegistryHarness, kind: DecisionKindUnderTest): void {
  const admin = adminClient(harness.server);
  // the first statement of a write, which a race is let in just before (interleaved)
  const writing = new RegExp(`INSERT INTO ${kind.tables.events}`);

  const decide = (subject: Subject, flag: boolean, reason: string) =>
    admin.patch<Decided>(kind.path(1, subject), { [kind.flag]: flag, reason });

  t.test('a decision is set, kept, and reversed, with one audit event per change', async t => {
    const db        = await harness.freshDatabase();
    const versionId = await seedValidated(db);
    await admin.switchTo(versionId);
    const registryVersion = { id: versionId, checksum: snapshot.registryVersion.checksum };

    // checksummed addresses name the same subject
    const set = await admin.patch<Decided>(kind.path(1, checksummed(kind.subject)), { [kind.flag]: true, reason: '  approved by governance  ' });
    t.equal(set.status, 200);
    t.match(set.body.updatedAt, ISO_TIME);
    t.same(
      set.body,
      { registryVersion, chainId: 1, ...kind.subject, [kind.flag]: true, changed: true, updatedAt: set.body.updatedAt },
      'the answer is the decision in force, for the lowercase addresses',
    );
    t.equal(set.header('x-registry-version'), versionId, 'and names the version it was checked against');
    t.equal(set.header('access-control-allow-origin'), null, 'an administrative answer carries no CORS header');

    const again = await decide(kind.subject, true, 'again');
    t.same([ again.body.changed, again.body[kind.flag], again.body.updatedAt ], [ false, true, set.body.updatedAt ],
      'asking for the decision in force changes nothing and keeps its time');

    const undecided = await decide(kind.other, false, 'reviewed, left as it is');
    t.same([ undecided.body.changed, undecided.body[kind.flag], undecided.body.updatedAt ], [ false, false, null ],
      `a ${kind.noun} nobody decided about already has the flag unset, and has no decision to date`);

    const reversed = await decide(kind.subject, false, 'reversed');
    t.same([ reversed.body.changed, reversed.body[kind.flag] ], [ true, false ], 'a decision is reversed by the opposite one');

    const detail = await admin.read<Detail>(kind.path(1, kind.subject));
    t.equal(detail.status, 200);
    t.same(
      [ detail.body.inActiveVersion, detail.body[kind.flag], detail.body.updatedAt, detail.body.updatedBy ],
      [ true, false, reversed.body.updatedAt, ADMIN_ACTOR ],
      `the ${kind.noun} reads back with the decision in force and who made it`,
    );
    t.same(
      detail.body.events.map(event => [ event[kind.previous], event[kind.flag], event.actor, event.reason ]),
      [
        [ true, false, ADMIN_ACTOR, 'reversed' ],
        [ null, true,  ADMIN_ACTOR, 'approved by governance' ],
      ],
      'with every change newest first, each with its actor and its trimmed reason',
    );

    t.same(
      (await db.prepare(`SELECT * FROM ${kind.tables.rows}`).all()).results,
      [ columnsOf({ chainId: 1, ...kind.subject, [kind.flag]: 0, updatedAt: reversed.body.updatedAt, updatedBy: ADMIN_ACTOR }) ],
      `the database holds one row, for the one ${kind.noun} decided about`,
    );
    t.equal(await count(db, kind.tables.events), 2, 'and one event per change, none for the requests that changed nothing');
    t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
  });

  t.test(`identical requests racing for one ${kind.noun} write one change`, async t => {
    const db = await harness.freshDatabase();
    await admin.switchTo(await seedValidated(db));

    const answers = await Promise.all(Array.from({ length: 5 }, () => decide(kind.other, true, 'raced')));
    t.same(answers.map(answer => answer.status), [ 200, 200, 200, 200, 200 ], 'every request succeeds');
    t.equal(answers.filter(answer => answer.body.changed).length, 1, 'one of them changed the decision');
    t.equal(new Set(answers.map(answer => answer.body.updatedAt)).size, 1, 'and every one answers with the decision it made');
    t.equal(await count(db, kind.tables.events), 1, 'which is audited once');
  });

  t.test('a decision outlives the version it was made under', async t => {
    const db    = await harness.freshDatabase();
    const first = await seedValidated(db);
    await admin.switchTo(first);

    const dropped = await decide(kind.subject, true, 'decided under the first version');
    const kept    = await decide(kind.other, true, 'decided under the first version');
    t.same([ dropped.body.changed, kept.body.changed ], [ true, true ]);

    const second = await seedValidated(db, { networks: kind.without, versionId: randomUUID() });
    await admin.switchTo(second);

    const listed = await kind.listing(admin);
    t.equal(listed.versionId, second, 'the list is of the version switched on');
    t.equal(listed.decisionOf(kind.other), true, `a ${kind.noun} of both versions is listed with its decision`);
    const other = await admin.read<Detail>(kind.path(1, kind.other));
    t.same([ other.body.inActiveVersion, other.body[kind.flag], other.body.updatedAt ], [ true, true, kept.body.updatedAt ],
      'which is in force, and keeps when it was made');
    t.equal(listed.decisionOf(kind.subject), undefined, `a ${kind.noun} the version dropped is not listed`);
    t.same(listed.retained, [ kind.retained(kind.subject, dropped.body.updatedAt) ],
      `but its decision is, as one kept until a version brings the ${kind.noun} back`);

    const detail = await admin.read<Detail>(kind.path(1, kind.subject));
    t.same([ detail.status, detail.body.inActiveVersion, detail.body[kind.flag], detail.body.events.length ], [ 200, false, true, 1 ],
      'and the decision and its history stay readable meanwhile');
    t.equal((await decide(kind.subject, false, 'decided under the second version')).status, 404,
      `though it cannot be decided about while the version does not hold the ${kind.noun}`);

    await admin.switchTo(first, 'rollback');
    const restored = await admin.read<Detail>(kind.path(1, kind.subject));
    t.same(
      [ restored.status, restored.body.inActiveVersion, restored.body[kind.flag], restored.body.updatedAt ],
      [ 200, true, true, dropped.body.updatedAt ],
      `a version that brings the ${kind.noun} back brings its decision back with it, in force again`,
    );
    const relisted = await kind.listing(admin);
    t.same([ relisted.decisionOf(kind.subject), relisted.retained ], [ true, [] ], 'listed again, and no longer kept apart');
  });

  /*
   * A request reads the active version, finds its subject, and writes. Here
   * the version switches between the two: the command is the one a request
   * runs, and the activation is committed just before its write
   * (interleaved). The trigger checks membership inside the write's
   * transaction, so the event is rolled back with the row.
   */
  t.test(`an activation that drops the ${kind.noun} between the read and the write aborts the write`, async t => {
    const db    = await harness.freshDatabase();
    const first = await seedValidated(db);
    await admin.switchTo(first);
    const second    = await seedValidated(db, { networks: kind.without, versionId: randomUUID() });
    const switching = () => interleaved(db, writing, () => admin.switchTo(second));

    const change = { subject: kind.subject, actor: 'test-admin', reason: 'raced an activation' };
    await t.rejects(
      () => kind.set(switching(), { ...change, flag: true }),
      { code: 'CONFLICT', details: { code: kind.left.code }, message: kind.left.message },
      `a change for a ${kind.noun} the active version no longer holds is refused`,
    );
    t.equal(await count(db, kind.tables.events), 0, 'and its event is rolled back with it');
    t.equal(await count(db, kind.tables.rows), 0, 'as is the row');

    await admin.switchTo(first, 'rollback');
    await t.rejects(
      () => kind.set(switching(), { ...change, flag: false }),
      { code: 'CONFLICT', details: { code: kind.left.code } },
      `a request that would change nothing is refused too, rather than answered for a version that does not hold the ${kind.noun}`,
    );
  });

  t.test('a list with any problem is refused whole, and its problems are named row by row', async t => {
    const db = await harness.freshDatabase();
    await admin.switchTo(await seedValidated(db));
    const refusedRows = kind.problems.named.filter(([ , problem ]) => problem !== null).map(([ row ]) => row);

    const review = await admin.post<Reviewed>(kind.list.review, kind.problems.list);
    t.equal(review.status, 200, 'a review answers with the problems as part of the diff');
    t.same((review.body[kind.list.key] as Array<{ row: number, problem: string | null }>).map(row => [ row.row, row.problem ]),
      kind.problems.named, 'each row with its problem, or none');
    t.equal(review.body.summary.problems, refusedRows.length);

    const refused = await admin.post<Refused>(kind.list.apply, kind.problems.list);
    t.equal(refused.status, 422, 'apply refuses a list with any problem');
    t.same((refused.body.error.details?.problems as Array<{ row: number }>).map(problem => problem.row), refusedRows,
      'naming every row it refuses');
    t.equal(await count(db, kind.tables.events), 0, 'and writes nothing, not even the rows that were fine');
  });

  /*
   * What apply's own comparison cannot see: the version switching between it
   * and the write, which is where the activation is committed here
   * (interleaved). The list is written whole or not at all.
   */
  t.test('a list that meets an activation while it is written writes nothing', async t => {
    const db    = await harness.freshDatabase();
    const first = await seedValidated(db);
    await admin.switchTo(first);
    const second    = await seedValidated(db, { networks: kind.without, versionId: randomUUID() });
    const switching = () => interleaved(db, writing, () => admin.switchTo(second));

    await t.rejects(
      () => kind.apply(switching(), { reason: null, rows: [ [ kind.other, true, 'approved' ], [ kind.subject, true, 'approved' ] ] }, 'test-admin'),
      { code: 'CONFLICT', details: { code: kind.left.code }, message: /activated while it was being applied; nothing was written/ },
      `a change for a ${kind.noun} the active version no longer holds aborts the list`,
    );
    await admin.switchTo(first, 'rollback');
    await t.rejects(
      () => kind.apply(switching(), { reason: null, rows: [ [ kind.other, true, 'approved' ], [ kind.subject, false, null ] ] }, 'test-admin'),
      { code: 'CONFLICT', details: { code: kind.left.code }, message: /activated while it was being applied/ },
      `and so does a row that changes nothing, once its ${kind.noun} is gone`,
    );
    t.equal(await count(db, kind.tables.events), 0, 'none of them wrote anything');
    t.equal(await count(db, kind.tables.rows, ...rowOf(kind.other)), 0, 'not even the rows that were fine');
  });

  /*
   * Between apply's own comparison and its write. A row that comparison found
   * unchanged is asserted rather than written, so a decision made in that
   * window aborts the list instead of being reverted by it — with the reason
   * given once for the whole list, as the runbook has it.
   */
  t.test('a decision made while a list is being applied aborts the list, rather than being reverted', async t => {
    const db = await harness.freshDatabase();
    await admin.switchTo(await seedValidated(db));
    const racing = interleaved(db, writing, async () => {
      await decide(kind.other, true, 'decided meanwhile');
    });

    await t.rejects(
      () => kind.apply(racing, { reason: 'the list\'s reason', rows: [ [ kind.subject, true, null ], [ kind.other, false, null ] ] }, 'test-admin'),
      { code: 'CONFLICT', details: { code: 'DECISION_CHANGED' }, message: /changed by someone else while it was being applied; nothing was written/ },
      'a row asserted rather than written, whose decision changed meanwhile, aborts the list',
    );
    t.equal(await count(db, kind.tables.rows, ...rowOf(kind.subject)), 0, 'nothing of the list is written');
    t.equal(await count(db, kind.tables.rows, ...rowOf({ ...kind.other, [kind.flag]: 1 })), 1, 'and the decision made meanwhile stands');
  });

  if (!kind.flagged) {
    return;
  }

  /*
   * What a decision changes for every client: the market reads flag a
   * collateral from the moment it is decided until the decision is reversed,
   * and only in a version whose Comet takes it.
   */
  t.test(`the market reads flag a collateral while it is ${kind.adjective}`, async t => {
    const db    = await harness.freshDatabase();
    const first = await seedValidated(db);
    await admin.switchTo(first);
    const symbol  = mainnet.markets.flatMap(market => market.collateralAssets).find(asset => asset.token.address === kind.subject.tokenAddress)!.token.symbol;
    const flaggedHere = async () => {
      const { body } = await admin.read<{ market: ActiveMarketV1 }>(`/registry/v1/networks/1/markets/${kind.subject.cometAddress}`, {});
      return body.market.collateralAssets
        .filter(asset => (asset as unknown as Record<string, unknown>)[kind.flag] === true)
        .map(asset => asset.token.symbol);
    };

    t.same(await flaggedHere(), [], 'nothing is flagged before anybody decides');
    await decide(kind.subject, true, 'decided for the market reads');
    t.same(await flaggedHere(), [ symbol ], 'the market reads flag the collateral at once');
    await decide(kind.subject, false, 'reversed');
    t.same(await flaggedHere(), [], 'and stop flagging it once the decision is reversed');

    await decide(kind.subject, true, 'decided again');
    await admin.switchTo(await seedValidated(db, { networks: kind.without, versionId: randomUUID() }));
    t.same(await flaggedHere(), [], 'a version whose Comet does not take the collateral has nothing of it to flag');
    await admin.switchTo(first, 'rollback');
    t.same(await flaggedHere(), [ symbol ], 'and a version that brings it back flags it again');
  });
}

/*
 * What the routes of one kind refuse, through the real worker: a caller
 * without the token, a malformed request, a chain or a subject the active
 * registry does not hold, a registry with nothing active, and a database
 * without the kind's migration. Every refusal writes nothing.
 */
function decisionRouteScenarios(harness: RegistryHarness, kind: DecisionKindUnderTest): void {
  const admin   = adminClient(harness.server);
  const valid   = { [kind.flag]: true, reason: 'approved' };
  const written = async (db: D1Database) => await count(db, kind.tables.events) + await count(db, kind.tables.rows);

  t.test(`the ${kind.label} routes are behind the token and closed to browsers`, async t => {
    const { db } = await freshActive(harness, { activate: true });

    const anonymous = await admin.patch(kind.path(1, kind.subject), valid, {});
    t.equal(anonymous.status, 401, 'a change without the token is refused');
    t.equal(anonymous.header('access-control-allow-origin'), null, 'without a CORS header');
    const reads: Array<[ string, string ]> = [
      [ `one ${kind.noun}`, kind.path(1, kind.subject) ],
      [ 'the export',       kind.list.export ],
      ...kind.reads(1),
    ];
    for (const [ name, path ] of reads) {
      t.equal((await admin.read(path, {})).status, 401, `and so is a read of ${name}`);
    }
    t.equal((await admin.post(kind.list.apply, { [kind.list.key]: [] }, {})).status, 401, 'and an apply');

    const wrongVerb = await admin.post(kind.path(1, kind.subject), {});
    t.equal(wrongVerb.status, 405, 'a decision is changed with PATCH');
    t.equal(wrongVerb.header('allow'), 'GET, PATCH, OPTIONS', 'and the refusal says which verbs the path takes');
    const wrongListVerb = await admin.read(kind.list.apply);
    t.equal(wrongListVerb.status, 405, 'a list is applied with POST');
    t.equal(wrongListVerb.header('allow'), 'POST, OPTIONS');
    // each path of a kind takes its own verbs and no other, and HEAD is not taken for a GET
    for (const method of [ 'HEAD', 'PUT', 'DELETE' ]) {
      const refused = await admin.send(method, kind.path(1, kind.subject));
      t.equal(refused.status, 405, `${method} is refused on a decision`);
      t.equal(refused.header('allow'), 'GET, PATCH, OPTIONS', 'with the verbs a decision takes');
    }
    const lists: Array<[ string, string ]> = [ [ kind.list.export, 'GET, OPTIONS' ], [ kind.list.review, 'POST, OPTIONS' ] ];
    for (const [ path, allow ] of lists) {
      const refused = await admin.patch(path, {});
      t.equal(refused.status, 405, `PATCH is refused on ${path}`);
      t.equal(refused.header('allow'), allow, 'with the verbs the path takes');
    }

    const preflight = await admin.send('OPTIONS', kind.path(1, kind.subject), undefined, {});
    t.equal(preflight.status, 204);
    t.equal(preflight.header('access-control-allow-origin'), null, 'a preflight advertises nothing to a browser');

    t.equal(await written(db), 0, 'nothing was written');
  });

  t.test(`a decision about a ${kind.noun} is checked before anything is written`, async t => {
    const { db, versionId } = await freshActive(harness, { activate: true });

    // the path is read the same way by the read and the change, so it is probed through the read
    for (const chainId of [ '0', '-1', 'mainnet', '1.5', '01', '9007199254740993' ]) {
      const refused = await admin.read<Refused>(kind.path(chainId, kind.subject));
      t.equal(refused.status, 400, `chain id ${chainId} is refused`);
      t.equal(refused.body.error.message, `${chainId} is not a chain id`);
    }
    for (const [ name, address ] of Object.entries(kind.subject)) {
      for (const malformed of [ 'weth', '0x1234', `0x${'g'.repeat(40)}`, `${address}00` ]) {
        const refused = await admin.read<Refused>(kind.path(1, { ...kind.subject, [name]: malformed }));
        t.equal(refused.status, 400, `${name} ${malformed} is refused`);
        t.equal(refused.body.error.message, `${malformed} is not an address`);
      }
    }

    const bodies: Array<[ string, unknown, RegExp ]> = [
      [ 'an empty body',                 {},                                                 new RegExp(`${kind.flag} must be a boolean`) ],
      [ 'a value that is not a boolean', { [kind.flag]: 'true', reason: 'approved' },          new RegExp(`${kind.flag} must be a boolean`) ],
      [ 'a missing reason',              { [kind.flag]: true },                                /reason/ ],
      [ 'a blank reason',                { [kind.flag]: true, reason: '   ' },                 /reason/ ],
      [ 'an unbounded reason',           { [kind.flag]: true, reason: 'x'.repeat(1001) },      /reason/ ],
      [ 'an actor of its own',           { [kind.flag]: true, reason: 'x', actor: 'someone' }, /unexpected properties: actor/ ],
      // SQLite would read it as empty, and refuse it with a database error rather than this answer
      [ 'a reason that starts with NUL', { [kind.flag]: true, reason: '\u0000approved' },      /cannot contain a NUL character/ ],
      [ 'malformed JSON',                '{',                                                  /not valid JSON/ ],
    ];
    for (const [ name, body, message ] of bodies) {
      const response = await admin.patch<Refused>(kind.path(1, kind.subject), body);
      t.equal(response.status, 400, `${name} is refused`);
      t.match(response.body.error.message, message);
    }
    // a change reads its body, the reason included, before its path, so one wrong in both is refused for its body
    const lacking: Array<[ string, unknown, string ]> = [
      [ 'its flag',   {},                    `${kind.flag} must be a boolean` ],
      [ 'its reason', { [kind.flag]: true }, 'a non-empty reason of at most 1000 characters is required' ],
    ];
    for (const [ name, body, message ] of lacking) {
      const refused = await admin.patch<Refused>(kind.path('01', kind.subject), body);
      t.equal(refused.status, 400, `a change on a malformed path without ${name} is refused`);
      t.equal(refused.body.error.message, message, 'for its body');
    }
    // a change takes an ordinary command's body, 64 KiB: only a list's review and apply take more
    const opening  = `${JSON.stringify({ [kind.flag]: true }).slice(0, -1)},"reason":"`;
    const tooLarge = `${opening}${'r'.repeat(64 * 1024 + 1 - opening.length - 2)}"}`;
    t.equal(tooLarge.length, 64 * 1024 + 1, 'a change one byte past 64 KiB');
    t.equal((await admin.patch(kind.path(1, kind.subject), tooLarge)).status, 413, 'is refused for its size');

    const chain = await admin.patch<Refused>(kind.path(10, kind.subject), valid);
    t.equal(chain.status, 404, 'a chain the active registry does not hold is not found');
    t.match(chain.body.error.message, /chain 10 is not part of the active registry/);
    t.equal(chain.body.error.details?.registryVersion?.id, versionId, 'and the refusal names the version it was decided against');
    t.equal(chain.header('x-registry-version'), versionId, 'in its headers too');
    t.equal((await admin.patch(kind.path(11155111, kind.subject), valid)).status, 404, 'nor is a testnet, which the registry does not import');

    for (const [ name, subject, message ] of kind.unheld) {
      const response = await admin.patch<Refused>(kind.path(1, subject), valid);
      t.equal(response.status, 404, `nor ${name}`);
      t.match(response.body.error.message, message);
      t.equal((await admin.read(kind.path(1, subject))).status, 404, 'nor its history, since nobody decided about it');
    }
    for (const [ name, path ] of kind.reads(10)) {
      t.equal((await admin.read(path)).status, 404, `a read of ${name} on a chain the active registry does not hold is not found`);
    }

    t.equal(await written(db), 0, 'none of it wrote anything');
  });

  t.test(`without an active version there is no ${kind.noun} to decide about`, async t => {
    const { db } = await freshActive(harness, { activate: false });
    const list = { [kind.list.key]: [ { chainId: 1, ...kind.subject, ...valid } ] };

    const requests: Array<[ string, () => Promise<Answer<Refused>> ]> = [
      [ 'a change',                   () => admin.patch(kind.path(1, kind.subject), valid) ],
      [ `a read of one ${kind.noun}`, () => admin.read(kind.path(1, kind.subject)) ],
      [ 'the export',                 () => admin.read(kind.list.export) ],
      [ 'a review',                   () => admin.post(kind.list.review, list) ],
      [ 'an apply',                   () => admin.post(kind.list.apply, list) ],
      ...kind.reads(1).map(([ name, path ]): [ string, () => Promise<Answer<Refused>> ] => [ `a read of ${name}`, () => admin.read(path) ]),
    ];
    for (const [ name, request ] of requests) {
      const response = await request();
      t.equal(response.status, 503, `${name} answers 503 without an active version`);
      t.equal(response.body.error.code, 'REGISTRY_NOT_ACTIVE', 'with the versionless code');
      t.equal(response.header('x-registry-version'), null, 'and no version it could name');
    }
    t.equal(await written(db), 0, 'nothing was written');
  });

  /*
   * A list is checked the same way by review and apply, so the shape is
   * probed through review, which spends no write budget, and once through
   * apply.
   */
  t.test('a list of decisions is checked completely before anything is read or written', async t => {
    const { db } = await freshActive(harness, { activate: true });
    const row    = { chainId: 1, ...kind.subject, [kind.flag]: true };
    const listOf = (rows: unknown) => ({ [kind.list.key]: rows });
    const size   = new RegExp(`${kind.list.key} must be a list of 1 to 500 decisions`);

    const shapes: Array<[ string, unknown, RegExp ]> = [
      [ `a body without ${kind.list.key}`, { reason: 'x' },                                size ],
      [ 'an empty list',                   listOf([]),                                     size ],
      [ 'a list longer than 500',          listOf(Array.from({ length: 501 }, () => row)), size ],
      [ 'a property of its own',           { ...listOf([ row ]), actor: 'someone' },       /unexpected properties: actor/ ],
      [ 'the other kind\'s list',          { [kind.list.other]: [ row ] },                 new RegExp(`unexpected properties: ${kind.list.other}`) ],
      [ 'a list reason that is not text',  { reason: 5, ...listOf([ row ]) },              new RegExp(`the list of ${kind.list.what} is invalid`) ],
      [ 'a bare array',                    [ row ],                                        /must be a JSON object/ ],
    ];
    for (const [ name, body, message ] of shapes) {
      const response = await admin.post<Refused>(kind.list.review, body);
      t.equal(response.status, 400, `${name} is refused`);
      t.match(response.body.error.message, message);
    }

    const rows = await admin.post<Refused>(kind.list.review, kind.malformed.list);
    t.equal(rows.status, 400, 'a list with malformed rows is refused');
    t.same(rows.body.error.details?.problems, kind.malformed.problems,
      `naming every problem of every row at once, a repeated ${kind.noun} in any case included`);

    t.equal((await admin.post(kind.list.apply, listOf([ { ...row, [kind.flag]: 'yes' } ]))).status, 400, 'apply checks a list the same way');

    /*
     * A reviewed list may carry a reason on every row, which is more than an
     * ordinary command's body allows: these routes take up to a mebibyte.
     */
    const long = listOf(Array.from({ length: 80 }, (_, index) => ({ ...row, chainId: index + 1, [kind.flag]: false, reason: 'r'.repeat(1000) })));
    t.ok(JSON.stringify(long).length > 64 * 1024, 'a list past the ordinary 64 KiB');
    t.equal((await admin.post(kind.list.review, long)).status, 200, 'is read, and reviewed');
    t.equal((await admin.post(kind.list.apply, long)).status, 422, 'and by apply, which refuses it for its rows, not for its size');

    t.equal(await written(db), 0, 'none of it wrote anything');
  });

  /*
   * A release deployed before its migration finds the kind's tables missing.
   * Every route that reads them says so, with what to do about it, rather
   * than answering an internal error only the logs explain.
   */
  t.test(`a database without the ${kind.label} migration says so`, async t => {
    const list = { [kind.list.key]: [ { chainId: 1, ...kind.subject, ...valid } ] };
    for (const through of kind.migrations.through) {
      await freshActive(harness, { activate: true, through });

      const requests: Array<[ string, () => Promise<Answer<Refused>> ]> = [
        [ `a read of one ${kind.noun}`, () => admin.read(kind.path(1, kind.subject)) ],
        [ 'the export',                 () => admin.read(kind.list.export) ],
        [ 'a change',                   () => admin.patch(kind.path(1, kind.subject), valid) ],
        [ 'a review',                   () => admin.post(kind.list.review, list) ],
        [ 'an apply',                   () => admin.post(kind.list.apply, list) ],
        ...kind.migrations.reads.map(([ name, path ]): [ string, () => Promise<Answer<Refused>> ] => [ name, () => admin.read(path, {}) ]),
      ];
      for (const [ name, request ] of requests) {
        const response = await request();
        t.equal(response.status, 503, `through ${through}: ${name} answers 503`);
        t.equal(response.body.error.code, 'UPSTREAM_UNAVAILABLE');
        t.match(response.body.error.message, /apply the D1 migrations/, 'naming the remedy');
      }
      t.equal((await admin.read('/registry/v1/networks', {})).status, 200, 'while a read that needs no decision answers as before');
    }
  });
}

const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;
const marketOf = (key: string) => mainnet.markets.find(market => market.deploymentKey === key)!;

// the fixture without one collateral of its mainnet USDT market, the one market that takes it
function withoutCollateral(address: Address): NetworkV1[] {
  return snapshot.networks.map(network => ({
    ...network,
    markets: network.markets.map(market => {
      const collateralAssets = market.collateralAssets.filter(asset => asset.token.address !== address);
      return collateralAssets.length === market.collateralAssets.length ? market : {
        ...market,
        collateralAssets: collateralAssets.map((asset, assetIndex) => ({ ...asset, assetIndex })),
      };
    }),
  }));
}

// tokens of the fixture, as the registry stores them
const WETH  = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WBTC  = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const USDC  = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
// collateral of the mainnet USDT market alone, so a version without that collateral holds no wUSDM at all
const WUSDM = '0x57f5e098cad7a3d1eed53991d4d66c45c9af7812';
// the base of the fixture's one Base market
const AERO  = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
// an address that is nothing in the fixture
const NOWHERE: Address = `0x${'0'.repeat(39)}1`;

// a row of a token policy list, which the malformed rows are made from
const POLICY_ROW = { chainId: 1, tokenAddress: WETH, isStrategic: true };

const TOKEN_POLICIES: DecisionKindUnderTest = {
  noun:     'token',
  label:    'token policy',
  adjective: 'strategic',
  flagged:  false,
  flag:     'isStrategic',
  previous: 'previousIsStrategic',
  tables:   { rows: 'token_policies', events: 'token_policy_events' },
  left:     { code: 'TOKEN_LEFT_REGISTRY', message: /left the active registry/ },
  path:     (chainId, { tokenAddress }) => `/registry/v1/admin/networks/${chainId}/tokens/${tokenAddress}/policy`,
  list:     {
    export: '/registry/v1/admin/token-policies',
    review: '/registry/v1/admin/token-policies/review',
    apply:  '/registry/v1/admin/token-policies/apply',
    key:    'policies',
    what:   'token policies',
    other:  'collaterals',
  },
  reads:    chainId => [ [ 'a network\'s tokens', `/registry/v1/admin/networks/${chainId}/tokens` ] ],
  subject:  { tokenAddress: WUSDM },
  other:    { tokenAddress: WETH },
  without:  withoutCollateral(WUSDM),
  set:      (db, { subject, flag, actor, reason }) =>
    setTokenPolicy(db, { chainId: 1, tokenAddress: subject.tokenAddress, isStrategic: flag, actor, reason }),
  apply:    (db, list, actor) => applyTokenPolicies(db, {
    reason:    list.reason,
    decisions: list.rows.map(([ { tokenAddress }, isStrategic, reason ]) => ({ chainId: 1, tokenAddress, symbol: null, isStrategic, reason })),
  }, actor),
  // the tokens of mainnet, which keep the decisions for tokens of the chain the version does not hold
  listing:  async admin => {
    const { body } = await admin.read<TokenPoliciesV1>('/registry/v1/admin/networks/1/tokens');
    return {
      versionId:  body.registryVersion.id,
      decisionOf: subject => body.tokens.find(token => token.address === subject.tokenAddress)?.isStrategic,
      retained:   body.retained,
    };
  },
  retained: ({ tokenAddress }, updatedAt) => ({ address: tokenAddress, isStrategic: true, updatedAt, updatedBy: ADMIN_ACTOR }),
  // a missing token, a missing chain, a symbol that names another token, and a change without a reason
  problems: {
    list: {
      reason:   null,
      policies: [
        { chainId: 1,  tokenAddress: WETH, symbol: 'WETH', isStrategic: true, reason: 'approved' },
        { chainId: 1,  tokenAddress: NOWHERE, isStrategic: true, reason: 'approved' },
        { chainId: 10, tokenAddress: USDC, isStrategic: true, reason: 'approved' },
        { chainId: 1,  tokenAddress: WBTC, symbol: 'WETH', isStrategic: true, reason: 'approved' },
        { chainId: 1,  tokenAddress: USDC, isStrategic: true },
        { chainId: 1,  tokenAddress: AERO.replace('0x9', '0x8'), isStrategic: false },
      ],
    },
    named: [
      [ 1, null ],
      [ 2, `${NOWHERE} is not a token of the active registry on chain 1` ],
      [ 3, 'chain 10 is not part of the active registry' ],
      [ 4, `the list names ${WBTC} WETH, which the active registry calls WBTC` ],
      [ 5, `${USDC} (USDC) changes, and needs a reason: its own or the list's` ],
      [ 6, `${AERO.replace('0x9', '0x8')} is not a token of the active registry on chain 1` ],
    ],
  },
  unheld:   [ [ 'a token it does not hold', { tokenAddress: NOWHERE }, /is not a token of the active registry on chain 1/ ] ],
  malformed: {
    list: {
      reason:   '\u0000approved',
      policies: [
        'WETH',
        { ...POLICY_ROW, note: 'x' },
        { chainId: '1', tokenAddress: '0x12', isStrategic: 'yes', symbol: 5, reason: ' ' },
        { ...POLICY_ROW, reason: 'x'.repeat(1001) },
        POLICY_ROW,
        // the same address in another case, which names the same token
        { ...POLICY_ROW, tokenAddress: WETH.toUpperCase().replace('0X', '0x') },
      ],
    },
    problems: [
      'reason cannot contain a NUL character',
      'row 1 must be an object',
      'row 2 has unexpected properties: note',
      'row 3: chainId must be a positive integer',
      'row 3: tokenAddress must be an address',
      'row 3: symbol must be null or a string',
      'row 3: isStrategic must be a boolean',
      'row 3: reason must be null or a non-empty string of at most 1000 characters',
      'row 4: reason must be null or a non-empty string of at most 1000 characters',
      `row 6 repeats row 5 (chain 1, ${WETH})`,
    ],
  },
  // no public read needs the tables
  migrations: { through: [ '0004' ], reads: [] },
};

// the Comets of the fixture's mainnet markets, by deployment key
const USDT_COMET = marketOf('usdt').contracts.comet!;
const USDC_COMET = marketOf('usdc').contracts.comet!;
const WETH_COMET = marketOf('weth').contracts.comet!;
// a collateral of a market of the fixture's mainnet, by symbol
const collateralOf = (key: string, symbol: string) => marketOf(key).collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address;
// collateral of the USDT market alone, so a version without it in that market holds no mETH at all
const METH  = collateralOf('usdt', 'mETH');
// collateral of the USDC, WETH and USDT markets
const WEETH = collateralOf('usdt', 'weETH');

// the public reads that need a collateral kind's tables: the active reads mark every collateral by both kinds' decisions
const MARKING_READS: Array<[ string, string ]> = [
  [ 'the bootstrap read', '/registry/v1/active' ],
  [ 'the market list',    '/registry/v1/networks/1/markets' ],
  [ 'a market',           `/registry/v1/networks/1/markets/${USDT_COMET}` ],
];

/*
 * A kind of decision about a collateral of a Comet, as the scenarios drive
 * it. The two kinds are decided about alike, about the same collaterals of
 * the same Comets, each under tables, routes and a flag named for what a
 * decision makes a collateral, and each list under a member of its own, so
 * that neither kind's review takes the other's export.
 */
function collateralKindUnderTest<Flag extends string, Column extends string, Rows extends string>({ kind, adjective, flag, list, listReason, through }: {
  // the kind as the store takes it, which its commands are called with
  kind:       CollateralDecisionKind<Flag, Column, Rows>,
  adjective:  string,
  flag:       Flag,
  // the member of a list that holds its rows, and the one another kind's list holds them under
  list:       { key: Rows, other: string },
  // the reason the kind's lists give
  listReason: string,
  through:    string[],
}): DecisionKindUnderTest {
  const lists = `/registry/v1/admin/${adjective}-collaterals`;
  // a row of a list, which the malformed rows are made from
  const row   = { chainId: 1, cometAddress: USDT_COMET, tokenAddress: METH, [flag]: true };
  return {
    noun:      'collateral',
    label:     `${adjective} collateral`,
    adjective,
    flagged:   true,
    flag,
    previous:  `previous${flag.charAt(0).toUpperCase()}${flag.slice(1)}`,
    tables:    { rows: `${adjective}_collaterals`, events: `${adjective}_collateral_events` },
    left:      { code: 'COLLATERAL_LEFT_REGISTRY', message: /left the collateral of/ },
    path:      (chainId, { cometAddress, tokenAddress }) =>
      `/registry/v1/admin/networks/${chainId}/markets/${cometAddress}/collaterals/${tokenAddress}/${adjective}`,
    list:      {
      export: lists,
      review: `${lists}/review`,
      apply:  `${lists}/apply`,
      key:    list.key,
      what:   `${adjective} collaterals`,
      other:  list.other,
    },
    reads:     () => [],
    subject:   { cometAddress: USDT_COMET, tokenAddress: METH },
    other:     { cometAddress: USDT_COMET, tokenAddress: WEETH },
    without:   withoutCollateral(METH),
    set:       (db, { subject, flag: decided, actor, reason }) => setCollateral(db, kind, {
      chainId: 1, cometAddress: subject.cometAddress, tokenAddress: subject.tokenAddress, ...member(kind.flag, decided), actor, reason,
    }),
    apply:     (db, { reason, rows }, actor) => applyCollaterals(db, kind, {
      reason,
      decisions: rows.map(([ { cometAddress, tokenAddress }, decided, given ]) => ({
        chainId: 1, cometAddress, deploymentKey: null, tokenAddress, symbol: null, ...member(kind.flag, decided), reason: given,
      })),
    }, actor),
    // the export, which keeps the decisions for collaterals the version does not hold in their Comet
    listing:   async admin => {
      const { body } = await admin.read<CollateralDecisionListV1<Flag, Rows>>(lists);
      return {
        versionId:  body.registryVersion?.id,
        decisionOf: subject => body[list.key].find(listed =>
          listed.chainId === 1 && listed.cometAddress === subject.cometAddress && listed.tokenAddress === subject.tokenAddress)?.[flag],
        retained:   body.retained,
      };
    },
    retained:  (subject, updatedAt) => ({ chainId: 1, ...subject, [flag]: true, updatedAt, updatedBy: ADMIN_ACTOR }),
    // a missing chain, a missing Comet, a token that Comet does not take, a market and a symbol that are another's, and a change without a reason
    problems:  {
      list: {
        reason:     null,
        [list.key]: [
          { chainId: 1,  cometAddress: USDT_COMET, deploymentKey: 'usdt', tokenAddress: METH, symbol: 'mETH', [flag]: true, reason: listReason },
          { chainId: 10, cometAddress: USDT_COMET, tokenAddress: METH, [flag]: true, reason: listReason },
          { chainId: 1,  cometAddress: NOWHERE, tokenAddress: METH, [flag]: true, reason: listReason },
          { chainId: 1,  cometAddress: USDC_COMET, tokenAddress: METH, [flag]: true, reason: listReason },
          { chainId: 1,  cometAddress: USDC_COMET, deploymentKey: 'usdt', tokenAddress: WEETH, [flag]: true, reason: listReason },
          { chainId: 1,  cometAddress: WETH_COMET, tokenAddress: WEETH, symbol: 'eETH', [flag]: true, reason: listReason },
          { chainId: 1,  cometAddress: USDT_COMET, tokenAddress: WEETH, [flag]: true },
        ],
      },
      named: [
        [ 1, null ],
        [ 2, 'chain 10 is not part of the active registry' ],
        [ 3, `${NOWHERE} is not a market of the active registry on chain 1` ],
        [ 4, `${METH} is not a collateral of ${USDC_COMET} in the active registry on chain 1` ],
        [ 5, `the list names ${USDC_COMET} usdt, which the active registry calls usdc` ],
        [ 6, `the list names ${WEETH} eETH, which the active registry calls weETH` ],
        [ 7, `${WEETH} (weETH of usdt) changes, and needs a reason: its own or the list's` ],
      ],
    },
    unheld:    [
      [ 'a Comet no market of the chain has', { cometAddress: NOWHERE, tokenAddress: METH }, /is not a market of the active registry on chain 1/ ],
      [
        'a token another market takes, which is no collateral of the Comet',
        { cometAddress: USDC_COMET, tokenAddress: METH },
        new RegExp(`${METH} is not a collateral of ${USDC_COMET}`),
      ],
      // the base of the USDC market, which no market of the fixture takes as collateral there
      [
        'the market\'s base, which is no collateral of the Comet',
        { cometAddress: USDC_COMET, tokenAddress: USDC },
        new RegExp(`${USDC} is not a collateral of ${USDC_COMET}`),
      ],
    ],
    // `retained` is what an export keeps for collaterals the version does not hold, and a list does not read it
    malformed: {
      list: {
        reason:     `\u0000${listReason}`,
        retained:   [ { anything: 'is not read' } ],
        [list.key]: [
          'mETH',
          { ...row, note: 'x' },
          { chainId: '1', cometAddress: 'usdt', tokenAddress: '0x12', deploymentKey: 5, symbol: 5, [flag]: 'yes', reason: ' ' },
          { ...row, reason: 'x'.repeat(1001) },
          row,
          // the same addresses in another case, which name the same collateral
          { ...row, cometAddress: USDT_COMET.toUpperCase().replace('0X', '0x'), tokenAddress: METH.toUpperCase().replace('0X', '0x') },
        ],
      },
      problems: [
        'reason cannot contain a NUL character',
        'row 1 must be an object',
        'row 2 has unexpected properties: note',
        'row 3: chainId must be a positive integer',
        'row 3: cometAddress must be an address',
        'row 3: deploymentKey must be null or a string',
        'row 3: tokenAddress must be an address',
        'row 3: symbol must be null or a string',
        `row 3: ${flag} must be a boolean`,
        'row 3: reason must be null or a non-empty string of at most 1000 characters',
        'row 4: reason must be null or a non-empty string of at most 1000 characters',
        `row 6 repeats row 5 (chain 1, ${USDT_COMET}, ${METH})`,
      ],
    },
    migrations: { through, reads: MARKING_READS },
  };
}

// through 0005 the tables are not there, and through 0006 they are under the names 0007 changes, which this release does not read
const DEPRECATED_COLLATERALS = collateralKindUnderTest({
  kind:       DEPRECATED_COLLATERAL_KIND,
  adjective:  'deprecated',
  flag:       'isDeprecated',
  list:       { key: 'collaterals', other: 'policies' },
  listReason: 'no longer offered',
  through:    [ '0005', '0006' ],
});

// through 0007 every table is there but these
const HIDDEN_COLLATERALS = collateralKindUnderTest({
  kind:       HIDDEN_COLLATERAL_KIND,
  adjective:  'hidden',
  flag:       'isHidden',
  list:       { key: 'hiddenCollaterals', other: 'collaterals' },
  listReason: 'not listed',
  through:    [ '0007' ],
});

export type { DecisionKindUnderTest };
export { DEPRECATED_COLLATERALS, HIDDEN_COLLATERALS, TOKEN_POLICIES, decisionRouteScenarios, decisionScenarios, statementsOf };
