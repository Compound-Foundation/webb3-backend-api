import type { VersionRefV1 } from '../../lib/model/comet-registry.js';

import { ApiError, noActiveVersion } from '../http/errors.js';

import { conflict } from './errors.js';
import { changedRows, rowsOf } from './sql-condition.js';
import { registryHeaders } from './version-headers.js';

/*
 * The decisions an administrator makes about what the registry serves, with
 * the audit of every change to each: token policies
 * (token-policy-repository.ts), and the deprecated and the hidden collaterals
 * of Comets (collateral-decision-repository.ts, which describes both kinds).
 * All are written, read, reviewed and applied here, the same way: each kind
 * describes itself to the store (DecisionKind), and its module answers in the
 * types lib/model/comet-registry.ts gives it.
 *
 * One decision and a whole list of them are written alike, by one batch
 * whose statements take the decisions as one JSON parameter: a list of any
 * length is a handful of statements, and it is written completely or not at
 * all.
 */

/*
 * What every kind's state read answers for each decision, beside the kind's
 * own columns: one row per decision, in the order of the JSON parameter. The
 * pointer is a seeded singleton, so every decision has a row and every miss
 * is a null column. `written_id` names the event a write recorded for the
 * decision, and is null where it changed nothing.
 */
type StateRow = {
  version_id: string | null,
  checksum:   string | null,
  network_id: string | null,
  updated_at: string | null,
  updated_by: string | null,
  written_id: string | null,
};

// what every kind's decision says beside what it is about
type DecisionBase = {
  // null for a row that leaves what it is about as it is, and so needs no reason
  reason: string | null,
};

/*
 * A kind of decision, as the store writes, reads, reviews and applies it:
 * `Subject` is what a decision is about, and all a read asks for, `Decision`
 * what one write records, `Listed` a row of a list. Its statements name its
 * own tables and no other kind's. The statements every kind writes and reads
 * alike are built here from its tables (KindTables), since the kinds' tables
 * differ only in their names and in the columns that key a decision. The read
 * of each decision's state is the kind's own: how the active version holds
 * what a decision is about differs from kind to kind.
 *
 * The store's functions take their types from the kind alone. The subjects
 * and decisions handed to them are NoInfer, so a literal is checked against
 * the kind rather than taken for a kind of its own.
 */
type DecisionKind<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow> = {
  // names the kind's writes in a defect: 'token policy', 'deprecated collateral'
  label:       string,
  // name a list and what its rows are about in a defect: 'token policies' and 'token'
  listOf:      string,
  subject:     string,
  // what a decision is about, as the kind's statements read it from the JSON parameter
  identity:    (subject: Subject) => Record<string, string | number>,
  // what makes two rows of a list one decision
  keyOf:       (subject: Subject) => string,
  flagOf:      (decision: Decision) => boolean,
  // the decision stored, as its column holds it: 1, 0, or null where nothing is stored
  storedOf:    (state: State) => number | null,
  // the state of every decision of the JSON parameter
  states:      (db: D1Database, payload: string) => D1PreparedStatement,
  writes:      { events: string, rows: string, expectations: string },
  // what the kind's triggers abort with when the active version does not hold what a decision is about
  leftAbort:   string,
  // why the active version cannot take a decision about the subject, or null where it can
  missingFrom: (state: State, subject: Subject) => string | null,
  // what a row names that the active version names otherwise, or null
  misnamed:    (decision: Listed, state: State) => string | null,
  // what a row is about, as a problem names it: its address, then its name in brackets
  named:       (state: State, subject: Subject) => string,
};

type DecisionList<Listed> = { reason: string | null, decisions: Listed[] };

/*
 * What a kind is called outside the store: its answers name the flag `flag`
 * and the member that holds a list's rows `listKey`, and its routes end one
 * subject's path with `segment` and name its list `listPath`
 * (admin-router.ts).
 */
type KindNames<Flag extends string, Rows extends string> = {
  flag:     Flag,
  listKey:  Rows,
  segment:  string,
  listPath: string,
};

/*
 * A kind's tables, from which the store builds the statements every kind
 * writes and reads alike: the decisions in force, their audit, and the view a
 * write states what it expects in; the column of the flag, and an event's
 * column of the flag it replaces; and the columns that key a decision, each
 * under the member of the subject that holds it, with the member of the JSON
 * parameter that carries it, in the order the tables declare them.
 */
type KindTables<Subject extends Record<keyof Subject, string | number>, Column extends string = string> = {
  decisions:    string,
  events:       string,
  expectations: string,
  flag:         Column,
  previous:     `previous_${Column}`,
  keys:         { readonly [Member in keyof Subject]-?: readonly [ json: string, column: string ] },
  // what the statements call a stored decision: the token policies' were written calling it a policy, and each statement keeps its text
  alias:        'decision' | 'policy',
};

/*
 * A row of a list compared with what is stored: what it would change, and
 * why the list cannot be applied where it cannot. Review answers this as it
 * is; apply refuses on any problem before writing anything.
 */
type Planned<Listed, State> = {
  row:      number,
  // with the reason it is written with
  decision: Listed,
  state:    State,
  current:  boolean,
  action:   'change' | 'unchanged',
  problem:  string | null,
};

/*
 * A member under the name its kind gives it: the flag, an event's flag before
 * the change, or the rows of a list. An object literal types a key it
 * computes from a generic name as any string, so an answer, a decision or a
 * row of a list spreads such a member into its place with this, typed by its
 * name.
 */
function member<Name extends string, Value>(name: Name, value: Value): Record<Name, Value> {
  return { [name]: value } as Record<Name, Value>;
}

function activeVersionOf(row: { version_id: string | null, checksum: string | null } | null | undefined): VersionRefV1 {
  if (row === null || row === undefined || row.version_id === null || row.checksum === null) {
    throw noActiveVersion();
  }
  return { id: row.version_id, checksum: row.checksum };
}

/*
 * A refusal decided against a version names it, as a success would: what it
 * is about is missing from that version, and may be in the next one.
 */
function refusal(
  code: 'NOT_FOUND' | 'UNPROCESSABLE',
  message: string,
  registryVersion: VersionRefV1,
  details: Record<string, unknown> = {},
): ApiError {
  return new ApiError(code, message, { registryVersion, ...details }, registryHeaders(registryVersion));
}

// how every kind refuses a list in whose write someone else changed a decision of a row it leaves as it is
function changedWhileApplied(): ApiError {
  return conflict(
    'DECISION_CHANGED',
    `a decision of the list was changed by someone else while it was being applied; nothing was written`,
  );
}

/*
 * The statements built from a kind's tables are put together line by line:
 * each keeps the text its kind's own module wrote by hand, to the byte, and
 * the kinds wrote them at different depths.
 */

function fromParameter(member: string): string {
  return `json_extract(row.value, '$.${member}')`;
}

function keyColumns<Subject extends Record<keyof Subject, string | number>>(
  { keys }: KindTables<Subject>,
): Array<{ member: Extract<keyof Subject, string>, json: string, column: string }> {
  const columns: Array<{ member: Extract<keyof Subject, string>, json: string, column: string }> = [];
  for (const member in keys) {
    const [ json, column ] = keys[member];
    columns.push({ member, json, column });
  }
  return columns;
}

function identityOf<Subject extends Record<keyof Subject, string | number>>(
  tables: KindTables<Subject>,
): (subject: Subject) => Record<string, string | number> {
  const columns = keyColumns(tables);
  return subject => Object.fromEntries(columns.map(({ member, json }): [ string, string | number ] => [ json, subject[member] ]));
}

// the SELECT list of a write, which moves to a new line an item that would take its line past 120 columns: where each kind broke its own by hand
function selectList(items: string[]): string {
  const lines: string[] = [];
  let line = '';
  items.forEach((item, index) => {
    const comma = index < items.length - 1 ? ',' : '';
    if (line !== '' && `  SELECT ${line}, ${item}${comma}`.length > 120) {
      lines.push(line);
      line = item;
    } else {
      line = line === '' ? item : `${line}, ${item}`;
    }
  });
  return `  SELECT ${[ ...lines, line ].join(',\n         ')}`;
}

// the statements of a write, which writeDecisions explains: a subject without a row has the flag unset
function decisionWrites<Subject extends Record<keyof Subject, string | number>>(
  tables: KindTables<Subject>,
): { events: string, rows: string, expectations: string } {
  const { decisions, events, expectations, flag, previous, alias } = tables;
  const keys    = keyColumns(tables);
  const columns = keys.map(({ column }) => column).join(', ');
  const values  = keys.map(({ json }) => fromParameter(json));
  const differing = [
    `  LEFT JOIN ${decisions} AS ${alias}`,
    ...keys.map(({ json, column }, index) => `${index === 0 ? '    ON' : '   AND'} ${alias}.${column} = ${fromParameter(json)}`),
    `  WHERE ${fromParameter('r')} IS NOT NULL`,
    `    AND COALESCE(${alias}.${flag}, 0) <> ${fromParameter('s')}`,
    '  ORDER BY row.key',
  ];
  return {
    events: [
      '',
      `  INSERT INTO ${events} (`,
      `    id, ${columns}, ${previous}, ${flag}, actor, reason, created_at`,
      '  )',
      selectList([ fromParameter('i'), ...values, `${alias}.${flag}`, fromParameter('s'), '?2', fromParameter('r'), '?3' ]),
      '  FROM json_each(?1) AS row',
      ...differing,
    ].join('\n'),
    rows: [
      '',
      `  INSERT INTO ${decisions} (${columns}, ${flag}, updated_at, updated_by)`,
      selectList([ ...values, fromParameter('s'), '?3', '?2' ]),
      '  FROM json_each(?1) AS row',
      ...differing,
      `  ON CONFLICT (${columns}) DO UPDATE`,
      `  SET ${flag} = excluded.${flag}, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ].join('\n'),
    expectations: [
      '',
      `  INSERT INTO ${expectations} (${columns}, ${flag})`,
      selectList([ ...values, fromParameter('s') ]),
      '  FROM json_each(?1) AS row',
    ].join('\n'),
  };
}

// the changes that led to one subject's decision, as readDecision reads them: newest committed first, which is rowid order
function historyOf<Subject extends Record<keyof Subject, string | number>>(
  db: D1Database,
  tables: KindTables<Subject>,
  subject: Subject,
  limit: number,
): D1PreparedStatement {
  const keys = keyColumns(tables);
  return db.prepare([
    `SELECT * FROM ${tables.events}`,
    `       WHERE ${keys.map(({ column }, index) => `${column} = ?${index + 1}`).join(' AND ')}`,
    '       ORDER BY rowid DESC',
    `       LIMIT ?${keys.length + 1}`,
  ].join('\n')).bind(...keys.map(({ member }) => subject[member]), limit);
}

/*
 * The subjects whose flag is set, of every chain, for a read that takes every
 * decision of the kind at once: one statement, through the kind's partial
 * index. It does not resolve the active version: each such read answers for a
 * version it has already resolved, and a decision belongs to no version, so
 * an answer from an older version takes the decisions D1 gives all the same.
 */
async function readMarked<Subject extends Record<keyof Subject, string | number>>(
  db: D1Database,
  tables: KindTables<Subject>,
): Promise<Subject[]> {
  const keys    = keyColumns(tables);
  const columns = keys.map(({ column }) => column).join(', ');
  const { results } = await db.prepare([
    `SELECT ${columns} FROM ${tables.decisions}`,
    `     WHERE ${tables.flag} = 1`,
    `     ORDER BY ${columns}`,
  ].join('\n')).all<Record<string, string | number>>();
  return (results ?? []).map(row => Object.fromEntries(
    keys.map(({ member, column }): [ string, string | number ] => [ member, row[column] ]),
  ) as Subject);
}

function activeVersionStatement(db: D1Database): D1PreparedStatement {
  return db.prepare([
    'SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum',
    '       FROM registry_state AS state',
    '       LEFT JOIN registry_versions AS version ON version.id = state.active_version_id',
    '       WHERE state.singleton_id = 1',
  ].join('\n'));
}

/*
 * The decisions a statement is about, as the one JSON parameter it reads with
 * json_each: `i` is the event id a write records for the decision, then what
 * the decision is about, `s` the decision as 0 or 1, and `r` the reason or
 * null.
 */
function keyed<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow>(
  kind: DecisionKind<Subject, Decision, Listed, State>,
  decisions: Array<NoInfer<Decision>>,
): string {
  return JSON.stringify(decisions.map(decision => ({
    i: crypto.randomUUID(),
    ...kind.identity(decision),
    s: kind.flagOf(decision) ? 1 : 0,
    r: decision.reason,
  })));
}

/*
 * The parameter of a read about one subject. The states statement reads a
 * write's parameter too, so a read hands it one of the same form, for the
 * decision not taken: `s` 0 and `r` null, which the statement does not read.
 */
function keyedSubject<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow>(
  kind: DecisionKind<Subject, Decision, Listed, State>,
  subject: NoInfer<Subject>,
): string {
  return JSON.stringify([ { i: crypto.randomUUID(), ...kind.identity(subject), s: 0, r: null } ]);
}

/*
 * The version a request about one decision resolves against, refusing what
 * that version does not hold. A decision is about something the registry
 * serves; one about anything else would be a decision nobody could check.
 */
function requireActive<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow>(
  kind: DecisionKind<Subject, Decision, Listed, State>,
  state: State | undefined,
  subject: NoInfer<Subject>,
): VersionRefV1 {
  const registryVersion = activeVersionOf(state);
  const missing = kind.missingFrom(state!, subject);
  if (missing !== null) {
    throw refusal('NOT_FOUND', missing, registryVersion);
  }
  return registryVersion;
}

/*
 * Writes the decisions of `payload` (as keyed() wrote them) in one batch, and
 * reads back what each holds when it is done. The answer comes from the
 * batch's own final read, never from what the request saw on the way in.
 *
 * The kind's statements each read the decisions from ?1, with the actor as ?2
 * and the time as ?3. The event and the decision row are written only for a
 * decision that differs from the one stored, where nothing stored is the
 * decision not taken, and only for a row that states a reason. The condition
 * is evaluated inside the batch, against what is stored when the batch runs,
 * not against a read taken before it: two identical requests write one event
 * between them, and a request for what already applies writes nothing.
 *
 * The triggers check, row by row, that the active version holds what the
 * decision is about, and that each decision row is written beside its newest
 * event. The expectations then state what every decision of the request must
 * hold now, the ones left unchanged included, and abort the transaction where
 * one does not: a version activated meanwhile without what it is about
 * (`left`), or a decision someone else changed meanwhile for a row that
 * states no reason and so was not written (`changed`).
 */
async function writeDecisions<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow>(
  db: D1Database,
  kind: DecisionKind<Subject, Decision, Listed, State>,
  payload: string,
  actor: string,
  conflicts: { left: () => ApiError, changed: () => ApiError },
): Promise<State[]> {
  const timestamp = new Date().toISOString();

  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(kind.writes.events).bind(payload, actor, timestamp),
      db.prepare(kind.writes.rows).bind(payload, actor, timestamp),
      db.prepare(kind.writes.expectations).bind(payload),
      kind.states(db, payload),
    ]);
  } catch (error) {
    const message = String(error);
    if (message.includes(kind.leftAbort)) {
      throw conflicts.left();
    }
    if (message.includes('changed while they were being written')) {
      throw conflicts.changed();
    }
    throw error;
  }

  const audited = changedRows(results[0]!);
  const written = changedRows(results[1]!);
  const states  = rowsOf<State>(results[3]);
  // both writes carry one condition, so a difference is a defect, and it must not be reported as a success
  if (audited !== written || states.filter(state => state.written_id !== null).length !== written) {
    throw new Error(`${kind.label} writes and their audit disagree: ${audited} event(s), ${written} row(s)`);
  }
  return states;
}

/*
 * The administrative command for one decision: refuse a request the active
 * version cannot answer before writing anything, then write, and answer what
 * is stored once the write is done.
 *
 * The read first is only for a precise refusal — what the version does not
 * hold, no active version — and decides nothing: the write checks membership
 * again inside its own transaction. A command states a reason, so its row is
 * written wherever it differs, and only a version activated in between
 * (`left`) aborts it.
 */
async function setDecision<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow>(
  db: D1Database,
  kind: DecisionKind<Subject, Decision, Listed, State>,
  change: NoInfer<Decision> & { actor: string },
  left: () => ApiError,
): Promise<State> {
  const [ before ] = rowsOf<State>(await kind.states(db, keyed(kind, [ change ])).all());
  requireActive(kind, before, change);
  const [ after ] = await writeDecisions(db, kind, keyed(kind, [ change ]), change.actor, { left, changed: left });
  return after!;
}

/*
 * The decision about one subject and the changes that led to it, as `events`
 * lists them, read in one batch so that the history and the decision it
 * explains are the same moment's.
 *
 * A decision outlives a version that drops what it is about, and comes back
 * with a later version that brings it back, so it stays readable meanwhile.
 * Only what the active version does not hold and nobody ever decided about is
 * not found.
 */
async function readDecision<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow>(
  db: D1Database,
  kind: DecisionKind<Subject, Decision, Listed, State>,
  subject: NoInfer<Subject>,
  events: () => D1PreparedStatement,
): Promise<{ registryVersion: VersionRefV1, state: State, events: D1Result }> {
  const [ head, history ] = await db.batch([ kind.states(db, keyedSubject(kind, subject)), events() ]);

  const [ state ]   = rowsOf<State>(head);
  const everDecided = (state !== undefined && kind.storedOf(state) !== null) || rowsOf(history).length > 0;
  const registryVersion = everDecided ? activeVersionOf(state) : requireActive(kind, state, subject);
  return { registryVersion, state: state!, events: history };
}

function decisionsOf<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow>(
  kind: DecisionKind<Subject, Decision, Listed, State>,
  list: DecisionList<NoInfer<Listed>>,
): Listed[] {
  const decisions = list.decisions.map(decision => ({ ...decision, reason: decision.reason ?? list.reason }));
  const keys = new Set(decisions.map(decision => kind.keyOf(decision)));
  if (keys.size !== decisions.length) {
    // the router refuses a repeated row; two events for one decision in one write would break its history
    throw new Error(`a list of ${kind.listOf} names a ${kind.subject} twice`);
  }
  return decisions;
}

async function planDecisions<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow>(
  db: D1Database,
  kind: DecisionKind<Subject, Decision, Listed, State>,
  list: DecisionList<NoInfer<Listed>>,
): Promise<{ registryVersion: VersionRefV1, planned: Array<Planned<Listed, State>> }> {
  const decisions = decisionsOf(kind, list);
  const states    = rowsOf<State>(await kind.states(db, keyed(kind, decisions)).all());
  const registryVersion = activeVersionOf(states[0]);

  const planned = decisions.map((decision, index) => {
    const state   = states[index]!;
    const current = kind.storedOf(state) === 1;
    const action  = current === kind.flagOf(decision) ? 'unchanged' as const : 'change' as const;
    const problem = kind.missingFrom(state, decision)
      ?? kind.misnamed(decision, state)
      ?? (action === 'change' && decision.reason === null
        ? `${kind.named(state, decision)} changes, and needs a reason: its own or the list's`
        : null);
    return { row: index + 1, decision, state, current, action, problem };
  });
  return { registryVersion, planned };
}

async function reviewDecisions<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow>(
  db: D1Database,
  kind: DecisionKind<Subject, Decision, Listed, State>,
  list: DecisionList<NoInfer<Listed>>,
): Promise<{
  registryVersion: VersionRefV1,
  summary:         { change: number, unchanged: number, problems: number },
  planned:         Array<Planned<Listed, State>>,
}> {
  const { registryVersion, planned } = await planDecisions(db, kind, list);
  return {
    registryVersion,
    summary: {
      change:    planned.filter(row => row.action === 'change').length,
      unchanged: planned.filter(row => row.action === 'unchanged').length,
      problems:  planned.filter(row => row.problem !== null).length,
    },
    planned,
  };
}

/*
 * The write of a list alone, without the review before it: every decision it
 * changes, with one event each, in one transaction that also requires every
 * row to hold what the list says once it is done. A list that met a
 * concurrent activation or change writes nothing: the kind says how the
 * activation is refused (`left`), and every kind refuses the change alike.
 */
async function writeDecisionList<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow>(
  db: D1Database,
  kind: DecisionKind<Subject, Decision, Listed, State>,
  list: DecisionList<NoInfer<Listed>>,
  actor: string,
  left: () => ApiError,
): Promise<State[]> {
  return await writeDecisions(db, kind, keyed(kind, decisionsOf(kind, list)), actor, { left, changed: changedWhileApplied });
}

/*
 * The administrative command for a list: refuse it whole, before writing
 * anything, if any row cannot be applied, naming each such row as `problemOf`
 * does, then write it.
 *
 * The list is compared with the decisions in force when it is applied, not
 * when it was reviewed. Only the rows that comparison finds to change are
 * written. Every other row is stated without a reason, so the write asserts
 * it rather than writing it: a decision someone makes on such a row between
 * the comparison and the write aborts the list instead of being reverted.
 */
async function applyDecisions<Subject extends object, Decision extends Subject & DecisionBase, Listed extends Decision, State extends StateRow>(
  db: D1Database,
  kind: DecisionKind<Subject, Decision, Listed, State>,
  list: DecisionList<NoInfer<Listed>>,
  actor: string,
  { problemOf, left }: {
    problemOf: (planned: Planned<Listed, State>) => Record<string, unknown>,
    left:      () => ApiError,
  },
): Promise<{
  registryVersion: VersionRefV1,
  summary:         { changed: number, unchanged: number },
  applied:         Array<{ row: number, decision: Listed, state: State }>,
}> {
  const { registryVersion, planned } = await planDecisions(db, kind, list);
  const problems = planned.filter(row => row.problem !== null);
  if (problems.length > 0) {
    throw refusal(
      'UNPROCESSABLE',
      `${problems.length} row(s) of the list cannot be applied; nothing was written`,
      registryVersion,
      { problems: problems.map(problemOf) },
    );
  }
  const decisions = planned.map(({ decision, action }) => action === 'change' ? decision : { ...decision, reason: null });
  const states    = await writeDecisionList(db, kind, { reason: null, decisions }, actor, left);
  return {
    registryVersion: activeVersionOf(states[0]),
    summary: {
      changed:   states.filter(state => state.written_id !== null).length,
      unchanged: states.filter(state => state.written_id === null).length,
    },
    applied: decisions.map((decision, index) => ({ row: index + 1, decision, state: states[index]! })),
  };
}

export type { DecisionKind, DecisionList, KindNames, KindTables, Planned, StateRow };
export {
  activeVersionOf,
  activeVersionStatement,
  applyDecisions,
  decisionWrites,
  historyOf,
  identityOf,
  member,
  readDecision,
  readMarked,
  refusal,
  reviewDecisions,
  setDecision,
};
