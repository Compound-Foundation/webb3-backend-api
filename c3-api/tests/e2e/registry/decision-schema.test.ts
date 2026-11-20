import t from 'tap';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { Address } from '../../../lib/model/comet-registry.js';
import {
  DEPRECATED_COLLATERAL_KIND,
  HIDDEN_COLLATERAL_KIND,
  readCollateral,
  setCollateral,
} from '../../../src/registry/collateral-decision-repository.js';
import { readTokenPolicy, setTokenPolicy } from '../../../src/registry/token-policy-repository.js';
import {
  Row,
  applyMigration,
  applySql,
  foreignKeyViolations,
  insertRow,
  insertStatement,
} from '../../util/d1.js';
import { count } from '../../util/registry-admin.js';
import {
  loadRegistrySnapshotFixture,
  seedCandidate,
} from '../../util/registry-fixture.js';
import { registryHarness } from '../../util/registry-harness.js';
import type { Candidate } from '../../util/registry-rows.js';
import {
  NOW,
  activate,
  activeVersionId,
  address,
  collateralAssetRow,
  insertCandidate,
  run,
  validate,
} from '../../util/registry-rows.js';

/*
 * The decisions of migrations 0005, 0006 and 0008, the second under the names
 * 0007 gave it, in the database itself, run as d1-schema.test.ts runs the
 * rest of the schema: a token policy is decided for a token of the active
 * registry, and a deprecated or a hidden collateral for a collateral of a
 * Comet of it. Whatever code writes them, the schema keeps their audit
 * complete: a decision row is written only beside the event describing that
 * exact change, events are never edited, replaced or deleted, and neither is
 * a decision row.
 *
 * All three kinds are one store of decisions (src/registry/decision-store.ts)
 * whose triggers are alike, so what they share is tested once, over a
 * description of each kind (DecisionTables), as decision-scenarios.ts tests
 * their routes. Beside it are what only a collateral has, its Comet, and the
 * migrations that brought the collaterals' tables.
 */
const { freshEnv } = await registryHarness();

const CHECK_FAILED = { message: /CHECK constraint failed/ };

const COMET = address('comet');

const addressOf = (db: D1Database, tokenId: string) => db.prepare(`SELECT address FROM tokens WHERE id = ?1`).bind(tokenId).first<string>('address');

/*
 * A candidate whose market declares its Comet, at the same address in every
 * version, and takes its second token as collateral.
 */
async function insertCollateralCandidate(db: D1Database): Promise<Candidate & { token: string, base: string }> {
  const candidate = await insertCandidate(db, randomUUID(), 1);
  const scope     = { registry_version_id: candidate.registry_version_id, network_id: candidate.network_id };
  await db.batch([
    insertStatement(db, 'market_contracts', { market_id: candidate.marketId, role: 'comet', address: COMET }),
    insertStatement(db, 'market_assets', collateralAssetRow(scope, candidate.marketId, candidate.collateralTokenId)),
  ]);
  return { ...candidate, token: (await addressOf(db, candidate.collateralTokenId))!, base: (await addressOf(db, candidate.baseTokenId))! };
}

/*
 * A kind of decision as its tables hold it: the tables and the flag a
 * decision sets in them, a candidate holding a subject to decide about, and
 * the kind's own read of a decision. A subject is on mainnet, and is named by
 * its columns beside chain_id.
 */
type DecisionTables = {
  // the kind and what it decides about, in the names of the tests, and what a decision makes a subject
  name:         string,
  held:         string,
  noun:         string,
  adjective:    string,
  // the decisions in force, their audit, and the view a write states what it expects in
  rows:         string,
  events:       string,
  expectations: string,
  // the column of the flag, and an event's column of the flag it replaces
  flag:         string,
  previous:     string,
  // a version, not yet validated, that holds a subject
  candidate:    (db: D1Database) => Promise<{ versionId: string, subject: Row }>,
  // the decision in force about a subject, and its changes newest committed first, as the kind's repository reads them
  history:      (db: D1Database, subject: Row) => Promise<{ decided: boolean, changes: Array<[ boolean | null, boolean, string ]> }>,
};

// a change a test writes: about the subject, or about another whose differing columns `subject` names
type Change = { chainId?: number, subject?: Row, value: number, at: string, actor?: string };

// one kind's rows about `subject`, as a writer could send them
function writerOf(db: D1Database, kind: DecisionTables, subject: Row) {
  const event = ({ chainId = 1, subject: other = {}, value, at, actor = 'test-admin' }: Change, previous: number | null): Row => ({
    id:              randomUUID(),
    chain_id:        chainId,
    ...subject,
    ...other,
    [kind.previous]: previous,
    [kind.flag]:     value,
    actor,
    reason:          'reviewed',
    created_at:      at,
  });
  const row = ({ chainId = 1, subject: other = {}, value, at, actor = 'test-admin' }: Change): Row => ({
    chain_id:    chainId,
    ...subject,
    ...other,
    [kind.flag]: value,
    updated_at:  at,
    updated_by:  actor,
  });
  // the repository's write: the event and the row in one batch, which is one transaction
  const decide = (change: Change, previous: number | null) => {
    const written = row(change);
    const columns = Object.keys(written);
    return db.batch([
      insertStatement(db, kind.events, event(change, previous)),
      db.prepare(
        `INSERT INTO ${kind.rows} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `?${index + 1}`).join(', ')})
         ON CONFLICT (${[ 'chain_id', ...Object.keys(subject) ].join(', ')}) DO UPDATE
         SET ${kind.flag} = excluded.${kind.flag}, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ).bind(...Object.values(written)),
    ]);
  };
  // what a write states the subject holds once it is done, which writes nothing
  const expect = (value: number, other: Row = {}) => insertRow(db, kind.expectations, { chain_id: 1, ...subject, ...other, [kind.flag]: value });
  return { event, row, decide, expect };
}

function decisionTableScenarios(kind: DecisionTables): void {
  t.test(`${kind.name} is decided for ${kind.held}, and every change is audited`, async t => {
    const { APP_DB: db } = await freshEnv();
    const { versionId, subject } = await kind.candidate(db);
    const { event, row, decide, expect } = writerOf(db, kind, subject);
    const NOT_ACTIVE = { message: new RegExp(`${kind.noun} is not in the active registry`) };
    const UNAUDITED  = { message: /changes only with its audit event/ };
    const APPENDED   = { message: /append-only/ };

    await t.rejects(() => decide({ value: 1, at: NOW }, null), NOT_ACTIVE, 'nothing is decided while no version is active');
    t.equal(await count(db, kind.events), 0, 'and the refused write leaves no event behind');

    await validate(db, versionId);
    await activate(db, versionId);

    await t.rejects(() => decide({ chainId: 10, value: 1, at: NOW }, null), NOT_ACTIVE, 'a chain the active version does not hold');
    await t.rejects(() => decide({ subject: { token_address: address('unknown') }, value: 1, at: NOW }, null), NOT_ACTIVE,
      'a token the active version does not hold');
    await t.rejects(() => insertRow(db, kind.rows, row({ value: 1, at: NOW })), UNAUDITED, 'a decision row without its event');
    await t.rejects(() => decide({ value: 1, at: NOW }, 0), UNAUDITED, 'or with an event that misstates the value it replaces');
    await t.rejects(() => insertRow(db, kind.events, event({ value: 0, at: NOW }, null)), CHECK_FAILED,
      `an event that changes nothing: a ${kind.noun} without a row is not ${kind.adjective}`);

    await t.resolves(() => decide({ value: 1, at: NOW }, null), 'a decision with its event');
    await t.resolves(() => decide({ value: 0, at: '2026-09-17T00:00:01.000Z' }, 1), 'and its reversal, which names what it replaced');
    await t.rejects(() => decide({ value: 1, at: '2026-09-17T00:00:02.000Z' }, null), UNAUDITED,
      'a change must name the decision in force, not the default');
    await t.rejects(() => run(db, `UPDATE ${kind.rows} SET ${kind.flag} = 1, updated_at = ?1`, '2026-09-17T00:00:03.000Z'), UNAUDITED,
      'a direct update has no event to stand beside');
    await t.rejects(() => run(db, `UPDATE ${kind.rows} SET updated_by = 'someone-else'`), UNAUDITED, 'and a row is not touched without a change');
    await t.rejects(() => run(db, `UPDATE ${kind.rows} SET token_address = ?1`, address('moved')), { message: new RegExp(`belongs to one ${kind.noun}`) },
      'a decision cannot move to another token');
    await t.rejects(() => run(db, `DELETE FROM ${kind.rows}`), { message: /changed, not deleted/ }, 'a decision is never deleted');
    await t.rejects(() => run(db, `UPDATE ${kind.events} SET reason = 'edited'`), APPENDED, 'an event is never edited');
    await t.rejects(() => run(db, `DELETE FROM ${kind.events}`), APPENDED, 'nor deleted');

    t.same(
      (await db.prepare(`SELECT ${[ 'chain_id', ...Object.keys(subject), kind.flag, 'updated_by' ].join(', ')} FROM ${kind.rows}`).all()).results,
      [ { chain_id: 1, ...subject, [kind.flag]: 0, updated_by: 'test-admin' } ],
      'one row holds the decision in force',
    );
    t.same(
      (await db.prepare(`SELECT ${kind.previous}, ${kind.flag} FROM ${kind.events} ORDER BY rowid`).all()).results,
      [ { [kind.previous]: null, [kind.flag]: 1 }, { [kind.previous]: 1, [kind.flag]: 0 } ],
      'and the events hold every change that led to it',
    );

    /*
     * An older event describing the same change as the one being written is
     * not its event: restoring a row to what it was before the latest change
     * would otherwise pass without a word about why.
     */
    await t.resolves(() => decide({ value: 1, at: '2026-09-17T00:00:02.000Z' }, 0), 'a third change');
    await t.rejects(() => run(db, `UPDATE ${kind.rows} SET ${kind.flag} = 0, updated_at = '2026-09-17T00:00:01.000Z'`), UNAUDITED,
      'a change cannot reuse an older event that happens to describe it');
    const [ first ] = (await db.prepare(`SELECT id FROM ${kind.events} ORDER BY rowid LIMIT 1`).all<{ id: string }>()).results ?? [];
    await t.rejects(() => insertRow(db, kind.events, { ...event({ value: 1, at: NOW }, null), id: first!.id, reason: 'edited' }, 'INSERT OR REPLACE'),
      APPENDED, 'nor is an event rewritten by replacing it');
    await t.rejects(() => insertRow(db, kind.rows, row({ value: 0, at: '2026-09-17T00:00:01.000Z' }), 'INSERT OR REPLACE'), UNAUDITED,
      'nor can a replace of the row reuse an older event');
    /*
     * History is read in rowid order, so an event takes no rowid a writer
     * chooses: -1 included, which a BEFORE trigger cannot tell from one the
     * table assigns.
     */
    for (const [ verb, rowid ] of [ [ 'INSERT OR REPLACE', 1 ], [ 'INSERT', 1000 ], [ 'INSERT', -1 ], [ 'INSERT OR REPLACE', -1 ] ] as const) {
      await t.rejects(() => insertRow(db, kind.events, { rowid, ...event({ value: 0, at: NOW }, 1) }, verb), APPENDED,
        `${verb} at rowid ${rowid} is refused: an event takes the next rowid, never one a writer chooses`);
    }
    await t.rejects(
      () => insertRow(db, kind.rows, { rowid: 1, ...row({ subject: { token_address: address('another') }, value: 1, at: NOW }) }, 'INSERT OR REPLACE'),
      { message: /rowid/ },
      `a decision row has no rowid through which a replace could reach another ${kind.noun}'s row`,
    );

    /*
     * History is read in the order it was committed. A Worker stamps a
     * request before it reaches D1, so a change can be stamped earlier than
     * one that committed before it; the newest change is still the one that
     * set the decision in force.
     */
    await t.resolves(() => decide({ value: 0, at: '2026-09-17T00:00:00.500Z' }, 1), 'a change stamped earlier than the one before it');
    const { decided, changes } = await kind.history(db, subject);
    t.same([ decided, changes[0] ], [ false, [ true, false, '2026-09-17T00:00:00.500Z' ] ],
      'is listed first, as the change that set the decision in force');

    /*
     * An expectation states what a subject must hold when a write is done.
     * Inserting one writes nothing; one that does not hold aborts.
     */
    await t.resolves(() => expect(0), 'an expectation that holds passes');
    t.equal(await count(db, kind.expectations), 0, 'and writes nothing');
    await t.rejects(() => expect(1), { message: /changed while they were being written/ }, 'one for another decision aborts');
    await t.rejects(() => expect(0, { token_address: address('unknown') }), NOT_ACTIVE,
      'and so does one for a token the active version does not hold');

    /*
     * The membership check runs on a plain UPDATE as well as on the upsert:
     * once the active version no longer holds the subject, a change beside a
     * matching event is refused, and the event goes with it.
     */
    const next = await kind.candidate(db);
    await validate(db, next.versionId);
    await activate(db, next.versionId);
    const events = await count(db, kind.events);
    await t.rejects(
      () => db.batch([
        insertStatement(db, kind.events, event({ value: 1, at: '2026-09-17T00:00:03.000Z' }, 0)),
        db.prepare(`UPDATE ${kind.rows} SET ${kind.flag} = 1, updated_at = ?1, updated_by = 'test-admin'`).bind('2026-09-17T00:00:03.000Z'),
      ]),
      NOT_ACTIVE,
      `a ${kind.noun} the active version no longer holds keeps its decision until a version brings it back`,
    );
    t.equal(await count(db, kind.events), events, 'and the refused change leaves no event');

    // a literal, so the value reaches the column as the integer it is rather than as a bound double
    const bound = Object.entries(event({ value: 1, at: NOW }, 0)).filter(([ column ]) => column !== 'chain_id');
    await t.rejects(
      () => run(db,
        `INSERT INTO ${kind.events} (chain_id, ${bound.map(([ column ]) => column).join(', ')})
         VALUES (9007199254740992, ${bound.map((_, index) => `?${index + 1}`).join(', ')})`,
        ...bound.map(([ , value ]) => value)),
      CHECK_FAILED,
      'a chain id past the safe integer range',
    );
    const cases: Array<[ string, Row ]> = [
      [ 'a chain id of zero', { chain_id: 0 } ],
      ...Object.entries(subject).flatMap(([ column, value ]): Array<[ string, Row ]> => [
        [ `a ${column} that is not lowercase`, { [column]: String(value).toUpperCase().replace('0X', '0x') } ],
        [ `a ${column} that is not hex`,       { [column]: `0x${'g'.repeat(40)}` } ],
      ]),
      [ 'a value that is not a flag', { [kind.flag]: 2, [kind.previous]: 0 } ],
      [ 'a blank reason', { reason: ' ' } ],
      [ 'an unbounded reason', { reason: 'x'.repeat(1001) } ],
      [ 'a blank actor', { actor: ' ' } ],
    ];
    for (const [ name, overrides ] of cases) {
      await t.rejects(() => insertRow(db, kind.events, { ...event({ value: 1, at: NOW }, 0), ...overrides }), CHECK_FAILED, name);
    }
    t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
  });
}

const TOKEN_POLICIES: DecisionTables = {
  name:         'a token policy',
  held:         'an active token',
  noun:         'token',
  adjective:    'strategic',
  rows:         'token_policies',
  events:       'token_policy_events',
  expectations: 'token_policy_expectations',
  flag:         'is_strategic',
  previous:     'previous_is_strategic',
  candidate:    async db => {
    const candidate = await insertCandidate(db, randomUUID(), 1);
    return { versionId: candidate.registry_version_id, subject: { token_address: (await addressOf(db, candidate.collateralTokenId))! } };
  },
  history:      async (db, subject) => {
    const policy = await readTokenPolicy(db, 1, subject.token_address as Address);
    return { decided: policy.isStrategic, changes: policy.events.map(event => [ event.previousIsStrategic, event.isStrategic, event.createdAt ]) };
  },
};

const DEPRECATED_COLLATERALS: DecisionTables = {
  name:         'a deprecated collateral',
  held:         'a collateral of an active Comet',
  noun:         'collateral',
  adjective:    'deprecated',
  rows:         'deprecated_collaterals',
  events:       'deprecated_collateral_events',
  expectations: 'deprecated_collateral_expectations',
  flag:         'is_deprecated',
  previous:     'previous_is_deprecated',
  candidate:    async db => {
    const candidate = await insertCollateralCandidate(db);
    return { versionId: candidate.registry_version_id, subject: { comet_address: COMET, token_address: candidate.token } };
  },
  history:      async (db, subject) => {
    const collateral = { chainId: 1, cometAddress: subject.comet_address as Address, tokenAddress: subject.token_address as Address };
    const decision   = await readCollateral(db, DEPRECATED_COLLATERAL_KIND, collateral);
    return { decided: decision.isDeprecated, changes: decision.events.map(event => [ event.previousIsDeprecated, event.isDeprecated, event.createdAt ]) };
  },
};

const HIDDEN_COLLATERALS: DecisionTables = {
  name:         'a hidden collateral',
  held:         'a collateral of an active Comet',
  noun:         'collateral',
  adjective:    'hidden',
  rows:         'hidden_collaterals',
  events:       'hidden_collateral_events',
  expectations: 'hidden_collateral_expectations',
  flag:         'is_hidden',
  previous:     'previous_is_hidden',
  candidate:    DEPRECATED_COLLATERALS.candidate,
  history:      async (db, subject) => {
    const collateral = { chainId: 1, cometAddress: subject.comet_address as Address, tokenAddress: subject.token_address as Address };
    const decision   = await readCollateral(db, HIDDEN_COLLATERAL_KIND, collateral);
    return { decided: decision.isHidden, changes: decision.events.map(event => [ event.previousIsHidden, event.isHidden, event.createdAt ]) };
  },
};

decisionTableScenarios(TOKEN_POLICIES);
decisionTableScenarios(DEPRECATED_COLLATERALS);
decisionTableScenarios(HIDDEN_COLLATERALS);

/*
 * What only a collateral has, the Comet it is a collateral of: a decision is
 * made about a token a market of the active version takes as collateral, at
 * the address that version holds the market's Comet at, and it stays that
 * Comet's.
 */
function cometScenarios(kind: DecisionTables): void {
  t.test(`${kind.name} is decided for a collateral of the Comet it names, and stays with that Comet`, async t => {
    const { APP_DB: db } = await freshEnv();
    const candidate = await insertCollateralCandidate(db);
    const { decide, expect } = writerOf(db, kind, { comet_address: COMET, token_address: candidate.token });
    const NOT_ACTIVE = { message: /collateral is not in the active registry/ };
    await validate(db, candidate.registry_version_id);
    await activate(db, candidate.registry_version_id);

    await t.rejects(() => decide({ subject: { comet_address: address('another comet') }, value: 1, at: NOW }, null), NOT_ACTIVE,
      'a Comet no market of the active version has');
    await t.rejects(() => decide({ subject: { token_address: candidate.base }, value: 1, at: NOW }, null), NOT_ACTIVE,
      'or a token of the market that is not one of its collateral: its base');
    await t.rejects(() => expect(0, { token_address: candidate.base }), NOT_ACTIVE,
      'and so does an expectation for a token that is no collateral of the Comet');

    await decide({ value: 1, at: NOW }, null);
    await t.rejects(() => run(db, `UPDATE ${kind.rows} SET comet_address = ?1`, address('moved')), { message: /belongs to one collateral/ },
      'a decision cannot move to another Comet');
  });
}

cometScenarios(DEPRECATED_COLLATERALS);
cometScenarios(HIDDEN_COLLATERALS);

/*
 * Migration 0006 only adds tables, so it applies over a database a release
 * before it serves from, while that release goes on serving: the version it
 * activated and the token policies it decided are left as they were.
 */
t.test('migration 0006 adds its tables beside a registry in use', async t => {
  const { APP_DB: db } = await freshEnv({ through: '0005' });

  const snapshot = loadRegistrySnapshotFixture();
  const { versionId, counts } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);
  const weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  await setTokenPolicy(db, { chainId: 1, tokenAddress: weth, isStrategic: true, actor: 'test-admin', reason: 'decided before 0006' });

  await applyMigration(db, '0006_legacy_collaterals.sql');

  t.equal(await activeVersionId(db), versionId, 'the version that was on is on');
  t.equal(await count(db, 'market_assets'), counts.market_assets, 'with every row of it');
  t.equal((await readTokenPolicy(db, 1, weth)).isStrategic, true, 'and the token policies decided before it stand');
  t.same([ await count(db, 'legacy_collaterals'), await count(db, 'legacy_collateral_events') ], [ 0, 0 ],
    'while nothing is decided about any collateral yet');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

/*
 * Migration 0007 renames what 0006 created: the tables and their columns in
 * place, the indexes, triggers and view by creating them again. What it leaves
 * is the schema 0006 would have created under the new names. SQLite quotes
 * the new name of a renamed table where it stores the table's statement, so
 * statements are compared without quotes, comments or spacing.
 */
type SchemaObject = { type: string, name: string, tbl_name: string, sql: string | null };

async function schemaOf(db: D1Database): Promise<SchemaObject[]> {
  const { results } = await db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE substr(name, 1, 4) <> '_cf_' ORDER BY type, name`
  ).all<SchemaObject>();
  return (results ?? []).map(object => ({
    ...object,
    sql: object.sql === null ? null : object.sql.replace(/--[^\n]*/g, '').replaceAll('"', '').replace(/\s+/g, ' ').trim(),
  }));
}

t.test('migration 0007 leaves the schema 0006 would have created under the deprecated names', async t => {
  const { APP_DB: migrated } = await freshEnv({ through: '0007' });
  const renamed = await schemaOf(migrated);
  t.same(renamed.filter(object => /legacy/.test(`${object.name} ${object.sql}`)), [], 'no object of 0001 to 0007 says legacy');

  const { APP_DB: db } = await freshEnv({ through: '0005' });
  await applySql(db, readFileSync('./migrations/0006_legacy_collaterals.sql', 'utf8').replaceAll('legacy', 'deprecated'));
  t.same(renamed, await schemaOf(db), 'and each is the object 0006 creates when it says deprecated, statement for statement');
});

/*
 * An environment that ran the release before 0007 may hold decisions made
 * under 0006. 0007 keeps every row as it was, every event at the rowid its
 * collateral's history is read by, and every invariant 0006 enforces, which
 * now refuses in the new words. Applying it again is refused before it
 * changes anything.
 */
t.test('migration 0007 keeps the decisions and events made under 0006, and every invariant', async t => {
  const { APP_DB: db } = await freshEnv({ through: '0006' });

  // a change as the release before 0007 wrote it: the event and the row beside it, under 0006's names
  const decide = (token: string, previous: number | null, value: number, at: string) => db.batch([
    insertStatement(db, 'legacy_collateral_events', {
      id:                 randomUUID(),
      chain_id:           1,
      comet_address:      COMET,
      token_address:      token,
      previous_is_legacy: previous,
      is_legacy:          value,
      actor:              'test-admin',
      reason:             'decided under 0006',
      created_at:         at,
    }),
    db.prepare(
      `INSERT INTO legacy_collaterals (chain_id, comet_address, token_address, is_legacy, updated_at, updated_by)
       VALUES (1, ?1, ?2, ?3, ?4, 'test-admin')
       ON CONFLICT (chain_id, comet_address, token_address) DO UPDATE
       SET is_legacy = excluded.is_legacy, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(COMET, token, value, at),
  ]);
  const first = await insertCollateralCandidate(db);
  await validate(db, first.registry_version_id);
  await activate(db, first.registry_version_id);
  await decide(first.token, null, 1, '2026-10-08T00:00:00.000Z');
  await decide(first.token, 1, 0, '2026-10-08T00:00:02.000Z');
  // committed after the change before it, though stamped earlier
  await decide(first.token, 0, 1, '2026-10-08T00:00:01.000Z');
  // a version whose market takes another token keeps the first token's decision until a version brings it back
  const second = await insertCollateralCandidate(db);
  await validate(db, second.registry_version_id);
  await activate(db, second.registry_version_id);
  await decide(second.token, null, 1, '2026-10-08T00:00:03.000Z');

  const events    = (await db.prepare(`SELECT rowid, * FROM legacy_collateral_events ORDER BY rowid`).all<Row>()).results ?? [];
  const decisions = (await db.prepare(`SELECT * FROM legacy_collaterals ORDER BY token_address`).all<Row>()).results ?? [];

  await applyMigration(db, '0007_deprecated_collaterals.sql');

  const renamed = (row: Row) => Object.fromEntries(Object.entries(row).map(([ column, value ]) => [ column.replace('legacy', 'deprecated'), value ]));
  t.equal(events.length, 4, 'four changes were recorded under 0006');
  t.same((await db.prepare(`SELECT rowid, * FROM deprecated_collateral_events ORDER BY rowid`).all<Row>()).results, events.map(renamed),
    'every event is kept as it was written, at its rowid');
  t.same((await db.prepare(`SELECT * FROM deprecated_collaterals ORDER BY token_address`).all<Row>()).results, decisions.map(renamed),
    'and so is every decision');

  const collateral = (token: string) => ({ chainId: 1, cometAddress: COMET as `0x${string}`, tokenAddress: token as `0x${string}` });
  const kept = await readCollateral(db, DEPRECATED_COLLATERAL_KIND, collateral(first.token));
  t.same(
    [ kept.inActiveVersion, kept.isDeprecated, kept.events.map(event => [ event.previousIsDeprecated, event.isDeprecated, event.createdAt ]) ],
    [ false, true, [
      [ false, true,  '2026-10-08T00:00:01.000Z' ],
      [ true,  false, '2026-10-08T00:00:02.000Z' ],
      [ null,  true,  '2026-10-08T00:00:00.000Z' ],
    ] ],
    'the release that reads the new names finds a kept decision, with its history newest committed first',
  );

  const UNAUDITED = { message: /a deprecated collateral decision changes only with its audit event/ };
  const APPENDED  = { message: /deprecated collateral events are append-only/ };
  await t.rejects(() => run(db, `UPDATE deprecated_collaterals SET is_deprecated = 0, updated_at = ?1 WHERE token_address = ?2`, NOW, second.token),
    UNAUDITED, 'a decision still changes only beside its event');
  await t.rejects(() => run(db, `UPDATE deprecated_collaterals SET token_address = ?1 WHERE token_address = ?2`, address('moved'), second.token),
    { message: /a deprecated collateral decision belongs to one collateral/ }, 'stays its own collateral\'s');
  await t.rejects(() => run(db, `DELETE FROM deprecated_collaterals`), { message: /deprecated collateral decisions are changed, not deleted/ },
    'and is never deleted');
  await t.rejects(
    () => db.batch([
      insertStatement(db, 'deprecated_collateral_events', {
        id:                     randomUUID(),
        chain_id:               1,
        comet_address:          COMET,
        token_address:          first.token,
        previous_is_deprecated: 1,
        is_deprecated:          0,
        actor:                  'test-admin',
        reason:                 'reviewed',
        created_at:             NOW,
      }),
      db.prepare(`UPDATE deprecated_collaterals SET is_deprecated = 0, updated_at = ?1, updated_by = 'test-admin' WHERE token_address = ?2`)
        .bind(NOW, first.token),
    ]),
    { message: /collateral is not in the active registry/ },
    'a kept decision is not changed while the active version does not hold its collateral',
  );
  await t.rejects(() => run(db, `UPDATE deprecated_collateral_events SET reason = 'edited'`), APPENDED, 'an event is never edited');
  await t.rejects(() => run(db, `DELETE FROM deprecated_collateral_events`), APPENDED, 'nor deleted');
  await t.rejects(
    () => run(db,
      `INSERT INTO deprecated_collateral_events
         (rowid, id, chain_id, comet_address, token_address, previous_is_deprecated, is_deprecated, actor, reason, created_at)
       VALUES (1000, ?1, 1, ?2, ?3, 1, 0, 'test-admin', 'reviewed', ?4)`,
      randomUUID(), COMET, second.token, NOW),
    APPENDED,
    'nor written at a rowid its writer chose',
  );
  await t.rejects(
    () => run(db,
      `INSERT INTO deprecated_collateral_expectations (chain_id, comet_address, token_address, is_deprecated) VALUES (1, ?1, ?2, 0)`,
      COMET, second.token),
    { message: /deprecated collateral decisions changed while they were being written/ },
    'and an expectation that does not hold aborts the write that states it',
  );

  const written = await setCollateral(db, DEPRECATED_COLLATERAL_KIND, {
    ...collateral(second.token), isDeprecated: false, actor: 'test-admin', reason: 'decided under 0007',
  });
  t.same([ written.changed, written.isDeprecated ], [ true, false ], 'the release that reads the new names writes beside them');
  t.equal(await db.prepare(`SELECT max(rowid) AS last FROM deprecated_collateral_events`).first<number>('last'), events.length + 1,
    'its event taking the rowid after the last one written under 0006');

  const before = [ await schemaOf(db), (await db.prepare(`SELECT rowid, * FROM deprecated_collateral_events ORDER BY rowid`).all()).results ];
  await t.rejects(() => applyMigration(db, '0007_deprecated_collaterals.sql'), { message: /no such trigger/ },
    'applying 0007 again is refused at its first statement');
  t.same([ await schemaOf(db), (await db.prepare(`SELECT rowid, * FROM deprecated_collateral_events ORDER BY rowid`).all()).results ], before,
    'and changes nothing, since a migration is applied as one batch');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

/*
 * Migration 0008 only adds tables, as 0006 did, so it applies over a database
 * a release before it serves from, while that release goes on serving: the
 * version it activated and the decisions it made are left as they were.
 */
t.test('migration 0008 adds its tables beside a registry in use', async t => {
  const { APP_DB: db } = await freshEnv({ through: '0007' });

  const snapshot = loadRegistrySnapshotFixture();
  const { versionId, counts } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);
  const weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const usdt = snapshot.networks.find(network => network.chainId === 1)!.markets.find(market => market.deploymentKey === 'usdt')!;
  const mEth = {
    chainId:      1,
    cometAddress: usdt.contracts.comet!,
    tokenAddress: usdt.collateralAssets.find(asset => asset.token.symbol === 'mETH')!.token.address,
  };
  await setTokenPolicy(db, { chainId: 1, tokenAddress: weth, isStrategic: true, actor: 'test-admin', reason: 'decided before 0008' });
  await setCollateral(db, DEPRECATED_COLLATERAL_KIND, { ...mEth, isDeprecated: true, actor: 'test-admin', reason: 'decided before 0008' });

  await applyMigration(db, '0008_hidden_collaterals.sql');

  t.equal(await activeVersionId(db), versionId, 'the version that was on is on');
  t.equal(await count(db, 'market_assets'), counts.market_assets, 'with every row of it');
  t.equal((await readTokenPolicy(db, 1, weth)).isStrategic, true, 'and the token policies decided before it stand');
  t.equal((await readCollateral(db, DEPRECATED_COLLATERAL_KIND, mEth)).isDeprecated, true, 'as do the deprecated collaterals');
  t.same([ await count(db, 'hidden_collaterals'), await count(db, 'hidden_collateral_events') ], [ 0, 0 ],
    'while nothing is hidden yet');
  const hidden = await setCollateral(db, HIDDEN_COLLATERAL_KIND, { ...mEth, isHidden: true, actor: 'test-admin', reason: 'decided after 0008' });
  t.same([ hidden.changed, hidden.isHidden ], [ true, true ], 'and a collateral of the version on can be hidden at once');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

/*
 * What 0008 creates for hidden collaterals is what 0007 left for deprecated
 * ones: the same tables, indexes, triggers and view under the hidden names,
 * so the schema holds both kinds of decision to the same rules, each in its
 * own words. Statements are compared as 0007's are above.
 */
t.test('migration 0008 creates what 0007 left for deprecated collaterals, under the hidden names', async t => {
  const schema = await schemaOf((await freshEnv()).APP_DB);
  const of     = (kind: string) => schema.filter(object => object.tbl_name.startsWith(`${kind}_collateral`));

  const hidden = of('hidden');
  t.same(
    [ 'table', 'index', 'trigger', 'view' ].map(type => hidden.filter(object => object.type === type && object.sql !== null).length),
    [ 2, 2, 12, 1 ],
    'two tables, their two indexes, ten triggers on the tables and two on the view, and the view',
  );
  t.same(
    hidden,
    of('deprecated').map(object => ({
      type:     object.type,
      name:     object.name.replaceAll('deprecated', 'hidden'),
      tbl_name: object.tbl_name.replaceAll('deprecated', 'hidden'),
      sql:      object.sql === null ? null : object.sql.replaceAll('deprecated', 'hidden'),
    })),
    'each the object deprecated collaterals have, statement for statement',
  );
});
