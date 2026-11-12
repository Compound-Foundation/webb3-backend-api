import type {
  Address,
  CollateralDecisionApplyV1,
  CollateralDecisionDetailV1,
  CollateralDecisionListV1,
  CollateralDecisionResultV1,
  CollateralDecisionReviewV1,
  RetainedCollateralDecisionV1,
  VersionRefV1,
} from '../../lib/model/comet-registry.js';

import type { ApiError } from '../http/errors.js';

import type { DecisionKind, DecisionList, KindNames, KindTables, Planned, StateRow } from './decision-store.js';
import {
  activeVersionOf,
  activeVersionStatement,
  applyDecisions,
  decisionWrites,
  historyOf,
  identityOf,
  member,
  readDecision,
  reviewDecisions,
  setDecision,
} from './decision-store.js';
import { conflict } from './errors.js';
import type { CollateralDecisionEventRow, CollateralDecisionRow } from './rows.js';
import { rowsOf } from './sql-condition.js';

/*
 * The decisions about a collateral of a Comet, of two kinds: which
 * collaterals of which Comets an administrator has marked deprecated, and
 * which ones hidden, each with the audit of every change to it. Discovery
 * does not show a token where its Comet hides it; the market still takes it
 * as collateral.
 *
 * Each is a kind of the decision store (decision-store.ts), as token policies
 * are: the store writes, reads, reviews and applies every kind, and this
 * module describes the two to it (DEPRECATED_COLLATERAL_KIND,
 * HIDDEN_COLLATERAL_KIND), answers for both in one set of types under each
 * kind's own names (lib/model/comet-registry.ts), and reads what only these
 * decisions are read for. A decision is keyed by chain id, Comet address and
 * token address, all lowercase, rather than by a versioned row, so it
 * outlives every activation; the migrations that create the tables explain
 * why and enforce the rest in the database. Every read here that answers for
 * the active version resolves it in the same statement or batch as the
 * decisions, so an answer never names one version while describing another.
 *
 * The two kinds' tables are one shape under two sets of names (migrations
 * 0006, under the names 0007 gave it, and 0008), so each kind's statements
 * are built from its tables' names: those every kind shares by the store
 * (decision-store.ts, KindTables), and the others here, the same text for
 * both kinds, naming the kind's own tables and no other's. A read of one kind
 * never reads the other's decisions, so it answers or fails on its own. A
 * release ahead of 0008 fails the hidden reads alone: /summary leaves out
 * what the hidden decisions decide (summary-tokens.ts, collateralFields), and
 * the active reads refuse for want of them. And where D1 does not answer one
 * kind's read, the active reads take that kind from its record
 * (decision-records.ts).
 */

// how many changes one decision read lists, newest first; a collateral's decision changes rarely
const MAX_COLLATERAL_EVENTS = 100;

// a collateral of a Comet, as a decision names it: lowercase, as the registry stores every address
type CollateralOfComet = {
  chainId:      number,
  cometAddress: Address,
  tokenAddress: Address,
};

/*
 * What tells a collateral of a Comet from another: in a list, in a set of
 * decisions, and in the digests the active reads tag their answers with
 * (collateral-decisions.ts). Clients hold copies under those tags, so its
 * form stays as it is.
 */
function collateralKey({ chainId, cometAddress, tokenAddress }: CollateralOfComet): string {
  return `${chainId}:${cometAddress}:${tokenAddress}`;
}

// what a row of a list names beside its collateral, for the person editing the file
type ListedNames = { deploymentKey: string | null, symbol: string | null };

// a collateral the active version holds: its chain, its market and its token, each found, with their names
type FoundCollateral = {
  network_id:     string,
  market_id:      string,
  deployment_key: string,
  token_id:       string,
  symbol:         string,
};

// one it does not hold: its chain, or its chain and its market, may be found, but its token is not
type MissingCollateral = {
  market_id:      string | null,
  deployment_key: string | null,
  token_id:       null,
  symbol:         null,
};

/*
 * Each collateral of a JSON parameter (`c` its chain, `m` its Comet, `t` its
 * token) as the active version and the stored decision describe it, beside the
 * kind's column of the flag: found, or missing (collateralIn).
 */
type CollateralState = StateRow & (FoundCollateral | MissingCollateral);

// what one write records for a collateral: a command's decision, or one row of a list
type CollateralDecision<Flag extends string> = CollateralOfComet & Record<Flag, boolean> & {
  // null for a row that leaves its collateral as it is, and so needs no reason
  reason: string | null,
};

// the administrative command for one collateral
type CollateralChange<Flag extends string> = CollateralDecision<Flag> & { reason: string, actor: string };

type ListedCollateralDecision<Flag extends string> = CollateralDecision<Flag> & ListedNames;

/*
 * What a kind of decision about a collateral is called, and where, beside the
 * names every kind has (KindNames): `label` names its writes in a defect, and
 * its decisions in a log line and a refusal, and `listOf` a list of them in a
 * defect; its answers name an event's flag before the change `previous`; and
 * its record is kept in KV under `recordKey` (decision-records.ts).
 */
type CollateralKindNames<Flag extends string, Column extends string, Rows extends string> = KindNames<Flag, Rows> & {
  label:     string,
  listOf:    string,
  tables:    Omit<KindTables<CollateralOfComet, Column>, 'keys' | 'alias'>,
  previous:  `previous${Capitalize<Flag>}`,
  recordKey: string,
};

// a kind as the store takes it, beside what it is called (collateralKind)
type CollateralDecisionKind<Flag extends string, Column extends string, Rows extends string> = DecisionKind<
  CollateralOfComet,
  CollateralDecision<Flag>,
  ListedCollateralDecision<Flag>,
  CollateralState & Record<Column, number | null>
> & Omit<CollateralKindNames<Flag, Column, Rows>, 'tables'> & { tables: KindTables<CollateralOfComet, Column> };

/*
 * The market and the token are found by subqueries that name one row each, so
 * every collateral of the list has exactly one row of the answer: a validated
 * version holds one market per Comet of a network, and lists a token once
 * among a market's collateral.
 */
function statesStatement(db: D1Database, { decisions, events, flag }: KindTables<CollateralOfComet>, collaterals: string): D1PreparedStatement {
  return db.prepare(
    `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
            network.id AS network_id, market.id AS market_id, market.deployment_key AS deployment_key,
            token.id AS token_id, token.symbol AS symbol,
            decision.${flag} AS ${flag}, decision.updated_at AS updated_at, decision.updated_by AS updated_by,
            written.id AS written_id
     FROM json_each(?1) AS row
     JOIN registry_state AS state ON state.singleton_id = 1
     LEFT JOIN registry_versions AS version ON version.id = state.active_version_id
     LEFT JOIN registry_networks AS network
       ON network.registry_version_id = state.active_version_id
      AND network.chain_id = json_extract(row.value, '$.c')
     LEFT JOIN markets AS market
       ON market.id = (
         SELECT candidate.id
         FROM markets AS candidate
         JOIN market_contracts AS contract
           ON contract.market_id = candidate.id
          AND contract.role = 'comet'
         WHERE candidate.registry_version_id = state.active_version_id
           AND candidate.network_id = network.id
           AND contract.address = json_extract(row.value, '$.m')
       )
     LEFT JOIN tokens AS token
       ON token.id = (
         SELECT asset.token_id
         FROM market_assets AS asset
         JOIN tokens AS held ON held.id = asset.token_id
         WHERE asset.market_id = market.id
           AND asset.role = 'collateral'
           AND held.address = json_extract(row.value, '$.t')
       )
     LEFT JOIN ${decisions} AS decision
       ON decision.chain_id = json_extract(row.value, '$.c')
      AND decision.comet_address = json_extract(row.value, '$.m')
      AND decision.token_address = json_extract(row.value, '$.t')
     LEFT JOIN ${events} AS written ON written.id = json_extract(row.value, '$.i')
     ORDER BY row.key`
  ).bind(collaterals);
}

/*
 * Whether the active version holds a collateral, by its state: the state
 * found, or why the collateral is missing — a chain the version does not
 * hold, a Comet that is no market of it, or a token that is no collateral of
 * that market.
 */
function collateralIn(state: CollateralState, collateral: CollateralOfComet): { found: StateRow & FoundCollateral } | { missing: string } {
  if (state.network_id === null) {
    return { missing: `chain ${collateral.chainId} is not part of the active registry` };
  }
  if (state.market_id === null) {
    return { missing: `${collateral.cometAddress} is not a market of the active registry on chain ${collateral.chainId}` };
  }
  if (state.token_id === null) {
    return { missing: `${collateral.tokenAddress} is not a collateral of ${collateral.cometAddress} in the active registry on chain ${collateral.chainId}` };
  }
  return { found: state };
}

function missingFrom(state: CollateralState, collateral: CollateralOfComet): string | null {
  const held = collateralIn(state, collateral);
  return 'missing' in held ? held.missing : null;
}

// what a row names that the active version names otherwise: its market, or its token's symbol
function misnamed(decision: CollateralOfComet & ListedNames, state: CollateralState): string | null {
  if (decision.deploymentKey !== null && state.deployment_key !== decision.deploymentKey) {
    return `the list names ${decision.cometAddress} ${decision.deploymentKey}, which the active registry calls ${state.deployment_key}`;
  }
  if (decision.symbol !== null && state.symbol !== decision.symbol) {
    return `the list names ${decision.tokenAddress} ${decision.symbol}, which the active registry calls ${state.symbol}`;
  }
  return null;
}

/*
 * A kind of decision about a collateral of a Comet, as the store takes it:
 * the kind's names, its flag, and its tables. A decision is about a
 * collateral of a market the registry serves; one about anything else would
 * be a decision nobody could check. Both migrations' triggers abort the same
 * way where the active version does not hold the collateral, and both key a
 * decision alike.
 */
function collateralKind<Flag extends string, Column extends string, Rows extends string>(
  names: CollateralKindNames<Flag, Column, Rows>,
): CollateralDecisionKind<Flag, Column, Rows> {
  const { flag } = names;
  const tables: KindTables<CollateralOfComet, Column> = {
    ...names.tables,
    keys:  { chainId: [ 'c', 'chain_id' ], cometAddress: [ 'm', 'comet_address' ], tokenAddress: [ 't', 'token_address' ] },
    alias: 'decision',
  };
  return {
    ...names,
    tables,
    subject:     'collateral',
    identity:    identityOf(tables),
    keyOf:       collateralKey,
    flagOf:      decision => decision[flag],
    storedOf:    state => state[tables.flag],
    states:      (db, collaterals) => statesStatement(db, tables, collaterals),
    writes:      decisionWrites(tables),
    leftAbort:   'collateral is not in the active registry',
    missingFrom,
    misnamed,
    named:       (state, collateral) =>
      `${collateral.tokenAddress} (${state.symbol ?? collateral.tokenAddress} of ${state.deployment_key ?? collateral.cometAddress})`,
  };
}

const DEPRECATED_COLLATERAL_KIND = collateralKind<'isDeprecated', 'is_deprecated', 'collaterals'>({
  label:     'deprecated collateral',
  listOf:    'deprecated collaterals',
  tables:    {
    decisions:    'deprecated_collaterals',
    events:       'deprecated_collateral_events',
    expectations: 'deprecated_collateral_expectations',
    flag:         'is_deprecated',
    previous:     'previous_is_deprecated',
  },
  flag:      'isDeprecated',
  previous:  'previousIsDeprecated',
  listKey:   'collaterals',
  segment:   'deprecated',
  listPath:  'deprecated-collaterals',
  recordKey: 'deprecated-collaterals:v1',
});

const HIDDEN_COLLATERAL_KIND = collateralKind<'isHidden', 'is_hidden', 'hiddenCollaterals'>({
  label:     'hidden collateral',
  listOf:    'hidden collaterals',
  tables:    {
    decisions:    'hidden_collaterals',
    events:       'hidden_collateral_events',
    expectations: 'hidden_collateral_expectations',
    flag:         'is_hidden',
    previous:     'previous_is_hidden',
  },
  flag:      'isHidden',
  previous:  'previousIsHidden',
  listKey:   'hiddenCollaterals',
  segment:   'hidden',
  listPath:  'hidden-collaterals',
  recordKey: 'hidden-collaterals:v1',
});

async function setCollateral<Flag extends string, Column extends string, Rows extends string>(
  db: D1Database,
  kind: CollateralDecisionKind<Flag, Column, Rows>,
  change: NoInfer<CollateralChange<Flag>>,
): Promise<CollateralDecisionResultV1<Flag>> {
  const after = await setDecision(db, kind, change, () => leftWhileWritten(change));
  return {
    registryVersion: activeVersionOf(after),
    chainId:         change.chainId,
    cometAddress:    change.cometAddress,
    tokenAddress:    change.tokenAddress,
    ...member(kind.flag, after[kind.tables.flag] === 1),
    changed:         after.written_id !== null,
    updatedAt:       after.updated_at,
  };
}

/*
 * One collateral's decision and the changes that led to it (readDecision),
 * the first of which is always the change that set the decision in force
 * (historyOf; migrations/0006_legacy_collaterals.sql says why).
 */
async function readCollateral<Flag extends string, Column extends string, Rows extends string>(
  db: D1Database,
  kind: CollateralDecisionKind<Flag, Column, Rows>,
  collateral: CollateralOfComet,
): Promise<CollateralDecisionDetailV1<Flag>> {
  const { registryVersion, state, events } = await readDecision(
    db,
    kind,
    collateral,
    () => historyOf(db, kind.tables, collateral, MAX_COLLATERAL_EVENTS),
  );
  return {
    registryVersion,
    chainId:         collateral.chainId,
    cometAddress:    collateral.cometAddress,
    tokenAddress:    collateral.tokenAddress,
    inActiveVersion: state.token_id !== null,
    ...member(kind.flag, state[kind.tables.flag] === 1),
    updatedAt:       state.updated_at,
    updatedBy:       state.updated_by,
    events: rowsOf<CollateralDecisionEventRow<Column>>(events).map(event => ({
      id:        event.id,
      ...member(kind.previous, event[kind.tables.previous] === null ? null : event[kind.tables.previous] === 1),
      ...member(kind.flag, event[kind.tables.flag] === 1),
      actor:     event.actor,
      reason:    event.reason,
      createdAt: event.created_at,
    })),
  };
}

// a collateral of the export, beside the decision in force, which the kind's column of the flag holds
type ListedCollateralRow = {
  chain_id:       number,
  comet_address:  Address,
  deployment_key: string,
  token_address:  Address,
  symbol:         string,
};

/*
 * The export, as one batch for one version: the active version; every
 * collateral of every market of it, disabled ones included, with the decision
 * in force; and the decisions kept for collaterals it does not hold, each of
 * which applies again if a version brings its collateral back to its Comet.
 * A disabled market's collaterals are listed because a decision about one is
 * made while nobody is offered the market, and applies once it is served.
 */
function exportStatements(db: D1Database, { tables: { decisions, flag } }: { tables: KindTables<CollateralOfComet> }): D1PreparedStatement[] {
  return [
    activeVersionStatement(db),
    db.prepare(
      `SELECT network.chain_id AS chain_id, contract.address AS comet_address, market.deployment_key AS deployment_key,
              token.address AS token_address, token.symbol AS symbol, COALESCE(decision.${flag}, 0) AS ${flag}
       FROM registry_state AS state
       JOIN registry_networks AS network ON network.registry_version_id = state.active_version_id
       JOIN markets AS market
         ON market.registry_version_id = state.active_version_id AND market.network_id = network.id
       JOIN market_contracts AS contract ON contract.market_id = market.id AND contract.role = 'comet'
       JOIN market_assets AS asset ON asset.market_id = market.id AND asset.role = 'collateral'
       JOIN tokens AS token ON token.id = asset.token_id
       LEFT JOIN ${decisions} AS decision
         ON decision.chain_id = network.chain_id
        AND decision.comet_address = contract.address
        AND decision.token_address = token.address
       WHERE state.singleton_id = 1
       ORDER BY network.chain_id, market.deployment_key, asset.asset_index`
    ),
    db.prepare(
      `SELECT decision.chain_id AS chain_id, decision.comet_address AS comet_address, decision.token_address AS token_address,
              decision.${flag} AS ${flag}, decision.updated_at AS updated_at, decision.updated_by AS updated_by
       FROM ${decisions} AS decision
       WHERE NOT EXISTS (
         SELECT 1
         FROM registry_state AS state
         JOIN registry_networks AS network
           ON network.registry_version_id = state.active_version_id AND network.chain_id = decision.chain_id
         JOIN markets AS market
           ON market.registry_version_id = state.active_version_id AND market.network_id = network.id
         JOIN market_contracts AS contract
           ON contract.market_id = market.id AND contract.role = 'comet' AND contract.address = decision.comet_address
         JOIN market_assets AS asset ON asset.market_id = market.id AND asset.role = 'collateral'
         JOIN tokens AS token ON token.id = asset.token_id AND token.address = decision.token_address
         WHERE state.singleton_id = 1
       )
       ORDER BY decision.chain_id, decision.comet_address, decision.token_address`
    ),
  ];
}

/*
 * Every collateral of every market of the active version with the decision in
 * force, as a list review and apply take back: the file an operator edits
 * instead of writing addresses by hand. Beside it, the decisions kept for
 * collaterals the active version does not hold (exportStatements).
 */
async function exportCollaterals<Flag extends string, Column extends string, Rows extends string>(
  db: D1Database,
  kind: CollateralDecisionKind<Flag, Column, Rows>,
): Promise<CollateralDecisionListV1<Flag, Rows> & { registryVersion: VersionRefV1, retained: Array<RetainedCollateralDecisionV1<Flag>> }> {
  const [ pointer, listed, kept ] = await db.batch(exportStatements(db, kind));

  const registryVersion = activeVersionOf(rowsOf<{ version_id: string | null, checksum: string | null }>(pointer)[0]);
  return {
    registryVersion,
    reason: null,
    ...member(kind.listKey, rowsOf<ListedCollateralRow & Record<Column, number>>(listed).map(row => ({
      chainId:       row.chain_id,
      cometAddress:  row.comet_address,
      deploymentKey: row.deployment_key,
      tokenAddress:  row.token_address,
      symbol:        row.symbol,
      ...member(kind.flag, row[kind.tables.flag] === 1),
    }))),
    retained: rowsOf<CollateralDecisionRow<Column>>(kept).map(row => ({
      chainId:      row.chain_id,
      cometAddress: row.comet_address,
      tokenAddress: row.token_address,
      ...member(kind.flag, row[kind.tables.flag] === 1),
      updatedAt:    row.updated_at,
      updatedBy:    row.updated_by,
    })),
  };
}

// the refusal of one collateral's decision, which a version activated meanwhile without the collateral aborted
function leftWhileWritten(collateral: CollateralOfComet): ApiError {
  return conflict(
    'COLLATERAL_LEFT_REGISTRY',
    `${collateral.tokenAddress} left the collateral of ${collateral.cometAddress} in the active registry on chain ${collateral.chainId} `
      + `while its decision was being written`,
  );
}

/*
 * How applying a list is refused: a row that cannot be applied, named by its
 * collateral, and a version activated meanwhile without one of the list's
 * collaterals.
 */
const LIST_REFUSALS = {
  // typed by what it reads, so that applyDecisions takes the type of a row's state from the kind rather than from it
  problemOf: ({ row, decision, problem }: Pick<Planned<CollateralOfComet, CollateralState>, 'row' | 'decision' | 'problem'>) => (
    { row, chainId: decision.chainId, cometAddress: decision.cometAddress, tokenAddress: decision.tokenAddress, problem }
  ),
  left:      () => conflict(
    'COLLATERAL_LEFT_REGISTRY',
    `a version that does not hold every collateral of the list was activated while it was being applied; nothing was written`,
  ),
};

async function reviewCollaterals<Flag extends string, Column extends string, Rows extends string>(
  db: D1Database,
  kind: CollateralDecisionKind<Flag, Column, Rows>,
  list: NoInfer<DecisionList<ListedCollateralDecision<Flag>>>,
): Promise<CollateralDecisionReviewV1<Rows>> {
  const { registryVersion, summary, planned } = await reviewDecisions(db, kind, list);
  return {
    registryVersion,
    summary,
    ...member(kind.listKey, planned.map(({ row, decision, state, current, action, problem }) => ({
      row,
      chainId:       decision.chainId,
      cometAddress:  decision.cometAddress,
      deploymentKey: state.deployment_key,
      tokenAddress:  decision.tokenAddress,
      symbol:        state.symbol,
      current,
      requested:     kind.flagOf(decision),
      action,
      reason:        decision.reason,
      problem,
    }))),
  };
}

/*
 * Each row of a list applied, as the transaction that wrote it left it. The
 * write's expectations abort the list unless the active version holds every
 * row's collateral (writeDecisions), so each row's state is found; one that
 * is not is a defect, and must not be answered as written.
 */
async function applyCollaterals<Flag extends string, Column extends string, Rows extends string>(
  db: D1Database,
  kind: CollateralDecisionKind<Flag, Column, Rows>,
  list: NoInfer<DecisionList<ListedCollateralDecision<Flag>>>,
  actor: string,
): Promise<CollateralDecisionApplyV1<Flag, Rows>> {
  const { registryVersion, summary, applied } = await applyDecisions(db, kind, list, actor, LIST_REFUSALS);
  return {
    registryVersion,
    summary,
    ...member(kind.listKey, applied.map(({ row, decision, state }) => {
      const held = collateralIn(state, decision);
      if ('missing' in held) {
        throw new Error(`a list of ${kind.listOf} was applied with a row the active registry does not hold: ${held.missing}`);
      }
      return {
        row,
        chainId:       decision.chainId,
        cometAddress:  decision.cometAddress,
        deploymentKey: held.found.deployment_key,
        tokenAddress:  decision.tokenAddress,
        symbol:        held.found.symbol,
        ...member(kind.flag, state[kind.tables.flag] === 1),
        changed:       state.written_id !== null,
        updatedAt:     state.updated_at,
      };
    })),
  };
}

export type { CollateralDecisionKind, CollateralOfComet, ListedCollateralDecision };
export {
  DEPRECATED_COLLATERAL_KIND,
  HIDDEN_COLLATERAL_KIND,
  applyCollaterals,
  collateralKey,
  exportCollaterals,
  readCollateral,
  reviewCollaterals,
  setCollateral,
};
