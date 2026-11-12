import type {
  Address,
  TokenPoliciesV1,
  TokenPolicyApplyV1,
  TokenPolicyDetailV1,
  TokenPolicyListV1,
  TokenPolicyResultV1,
  TokenPolicyReviewV1,
  VersionRefV1,
} from '../../lib/model/comet-registry.js';

import {
  DecisionKind,
  DecisionList,
  KindNames,
  KindTables,
  Planned,
  StateRow,
  activeVersionOf,
  activeVersionStatement,
  applyDecisions,
  decisionWrites,
  historyOf,
  identityOf,
  member,
  readDecision,
  refusal,
  reviewDecisions,
  setDecision,
} from './decision-store.js';
import { conflict } from './errors.js';
import type { TokenPolicyEventRow, TokenPolicyRow } from './rows.js';
import { rowsOf } from './sql-condition.js';

/*
 * Token policies: which tokens an administrator has marked strategic, and the
 * audit of every change to that decision. They are a kind of the decision
 * store (decision-store.ts), which writes, reads, reviews and applies them:
 * this module describes a token to it, answers in the policies' own types,
 * and reads what only policies are read for.
 *
 * A policy is keyed by chain id and lowercase address rather than by a
 * versioned token row, so it outlives every activation; the migration that
 * creates the tables explains why and enforces the rest in the database.
 * Every read here resolves the active version in the same statement or batch
 * as the policy rows, so an answer never names one version while describing
 * another.
 */

// how many changes one policy read lists, newest first; a token's decision changes rarely
const MAX_POLICY_EVENTS = 100;

// a token of a chain, as a policy names it
type TokenOfChain = {
  chainId:      number,
  // lowercase, as the registry stores every address
  tokenAddress: Address,
};

// what one write records for a token: a command's decision, or one row of a list
type Decision = TokenOfChain & {
  isStrategic: boolean,
  // null for a row that leaves its token as it is, and so needs no reason
  reason:      string | null,
};

// the administrative command for one token
type PolicyChange = Decision & { reason: string, actor: string };

type ListedDecision = Decision & { symbol: string | null };

// each token of a JSON parameter (`c` its chain, `t` its address) as the active version and the stored decision describe it
type TokenState = StateRow & { token_id: string | null, symbol: string | null, is_strategic: number | null };

function statesStatement(db: D1Database, tokens: string): D1PreparedStatement {
  return db.prepare(
    `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
            network.id AS network_id, token.id AS token_id, token.symbol AS symbol,
            policy.is_strategic AS is_strategic, policy.updated_at AS updated_at, policy.updated_by AS updated_by,
            written.id AS written_id
     FROM json_each(?1) AS row
     JOIN registry_state AS state ON state.singleton_id = 1
     LEFT JOIN registry_versions AS version ON version.id = state.active_version_id
     LEFT JOIN registry_networks AS network
       ON network.registry_version_id = state.active_version_id
      AND network.chain_id = json_extract(row.value, '$.c')
     LEFT JOIN tokens AS token
       ON token.registry_version_id = state.active_version_id
      AND token.network_id = network.id
      AND token.address = json_extract(row.value, '$.t')
     LEFT JOIN token_policies AS policy
       ON policy.chain_id = json_extract(row.value, '$.c')
      AND policy.token_address = json_extract(row.value, '$.t')
     LEFT JOIN token_policy_events AS written ON written.id = json_extract(row.value, '$.i')
     ORDER BY row.key`
  ).bind(tokens);
}

function missingFrom(state: TokenState, token: TokenOfChain): string | null {
  if (state.network_id === null) {
    return `chain ${token.chainId} is not part of the active registry`;
  }
  if (state.token_id === null) {
    return `${token.tokenAddress} is not a token of the active registry on chain ${token.chainId}`;
  }
  return null;
}

// the tables of migrations/0005_token_policies.sql: a token without a row is not strategic
const TOKEN_POLICY_TABLES: KindTables<TokenOfChain> = {
  decisions:    'token_policies',
  events:       'token_policy_events',
  expectations: 'token_policy_expectations',
  flag:         'is_strategic',
  previous:     'previous_is_strategic',
  keys:         { chainId: [ 'c', 'chain_id' ], tokenAddress: [ 't', 'token_address' ] },
  alias:        'policy',
};

/*
 * Token policies, as the store takes them and as their routes name them
 * (admin-router.ts). A policy is a decision about a token the registry
 * serves; one about an address the active version does not describe would be
 * a decision nobody could check.
 */
const TOKEN_POLICY_KIND: DecisionKind<TokenOfChain, Decision, ListedDecision, TokenState> & KindNames<'isStrategic', 'policies'> = {
  label:       'token policy',
  listOf:      'token policies',
  flag:        'isStrategic',
  listKey:     'policies',
  segment:     'policy',
  listPath:    'token-policies',
  subject:     'token',
  identity:    identityOf(TOKEN_POLICY_TABLES),
  keyOf:       token => `${token.chainId}:${token.tokenAddress}`,
  flagOf:      decision => decision.isStrategic,
  storedOf:    state => state.is_strategic,
  states:      statesStatement,
  writes:      decisionWrites(TOKEN_POLICY_TABLES),
  leftAbort:   'token is not in the active registry',
  missingFrom,
  misnamed:    (decision, state) => decision.symbol !== null && state.symbol !== decision.symbol
    ? `the list names ${decision.tokenAddress} ${decision.symbol}, which the active registry calls ${state.symbol}`
    : null,
  named:       (state, token) => `${token.tokenAddress} (${state.symbol ?? token.tokenAddress})`,
};

async function setTokenPolicy(db: D1Database, change: PolicyChange): Promise<TokenPolicyResultV1> {
  const after = await setDecision(db, TOKEN_POLICY_KIND, change, () => conflict(
    'TOKEN_LEFT_REGISTRY',
    `${change.tokenAddress} left the active registry on chain ${change.chainId} while its policy was being written`,
  ));
  return {
    registryVersion: activeVersionOf(after),
    chainId:         change.chainId,
    tokenAddress:    change.tokenAddress,
    isStrategic:     after.is_strategic === 1,
    changed:         after.written_id !== null,
    updatedAt:       after.updated_at,
  };
}

/*
 * One token's decision and the changes that led to it (readDecision).
 * `inActiveVersion` says whether the active version holds the token, in a
 * market of any status: a token only disabled markets name is held, and its
 * mark shows once a market that names it is served.
 *
 * The first of the changes is always the one that set the decision in force
 * (historyOf; migrations/0005_token_policies.sql says why).
 */
async function readTokenPolicy(db: D1Database, chainId: number, tokenAddress: Address): Promise<TokenPolicyDetailV1> {
  const { registryVersion, state, events } = await readDecision(
    db,
    TOKEN_POLICY_KIND,
    { chainId, tokenAddress },
    () => historyOf(db, TOKEN_POLICY_TABLES, { chainId, tokenAddress }, MAX_POLICY_EVENTS),
  );
  return {
    registryVersion,
    chainId,
    tokenAddress,
    inActiveVersion: state.token_id !== null,
    isStrategic:     state.is_strategic === 1,
    updatedAt:       state.updated_at,
    updatedBy:       state.updated_by,
    events: rowsOf<TokenPolicyEventRow>(events).map(event => ({
      id:                  event.id,
      previousIsStrategic: event.previous_is_strategic === null ? null : event.previous_is_strategic === 1,
      isStrategic:         event.is_strategic === 1,
      actor:               event.actor,
      reason:              event.reason,
      createdAt:           event.created_at,
    })),
  };
}

/*
 * The tokens an administrator has marked strategic, every chain's at once, by
 * chain id, for the summary of every network: one statement, not one a
 * chain. Unlike the reads above, this one does not resolve the active
 * version: the summary resolves it through the request's catalog, which
 * already names the version it answers for, and a decision belongs to no
 * version.
 */
async function readStrategicTokensByChain(db: D1Database): Promise<Map<number, Set<Address>>> {
  const { results } = await db.prepare(
    `SELECT chain_id, token_address FROM token_policies WHERE is_strategic = 1`
  ).all<{ chain_id: number, token_address: Address }>();
  const strategic = new Map<number, Set<Address>>();
  for (const row of results ?? []) {
    strategic.set(row.chain_id, (strategic.get(row.chain_id) ?? new Set<Address>()).add(row.token_address));
  }
  return strategic;
}

/*
 * Every token one network of the active version holds, with the decision in
 * force for each, and beside them the decisions kept for tokens of the chain
 * that the active version does not hold, each of which applies again if a
 * version brings its token back and serves a market that names it. A chain
 * the active version dropped entirely still answers with what is kept for it;
 * only a chain with neither tokens nor decisions is not found. One batch, so
 * the version it names is the version it lists.
 */
async function readTokenPolicies(db: D1Database, chainId: number): Promise<TokenPoliciesV1> {
  const [ listed, kept ] = await db.batch([
    db.prepare(
      `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
              network.id AS network_id,
              token.address AS address, token.symbol AS symbol, token.name AS name, token.decimals AS decimals,
              policy.is_strategic AS is_strategic, policy.updated_at AS updated_at, policy.updated_by AS updated_by
       FROM registry_state AS state
       LEFT JOIN registry_versions AS version ON version.id = state.active_version_id
       LEFT JOIN registry_networks AS network
         ON network.registry_version_id = state.active_version_id AND network.chain_id = ?1
       LEFT JOIN tokens AS token
         ON token.registry_version_id = state.active_version_id AND token.network_id = network.id
       LEFT JOIN token_policies AS policy
         ON policy.chain_id = ?1 AND policy.token_address = token.address
       WHERE state.singleton_id = 1
       ORDER BY token.symbol COLLATE NOCASE, token.address`
    ).bind(chainId),
    db.prepare(
      `SELECT policy.token_address AS address, policy.is_strategic AS is_strategic,
              policy.updated_at AS updated_at, policy.updated_by AS updated_by
       FROM token_policies AS policy
       WHERE policy.chain_id = ?1
         AND NOT EXISTS (
           SELECT 1
           FROM registry_state AS state
           JOIN registry_networks AS network
             ON network.registry_version_id = state.active_version_id AND network.chain_id = policy.chain_id
           JOIN tokens AS token
             ON token.registry_version_id = state.active_version_id
            AND token.network_id = network.id
            AND token.address = policy.token_address
           WHERE state.singleton_id = 1
         )
       ORDER BY policy.token_address`
    ).bind(chainId),
  ]);

  const rows = rowsOf<{
    version_id:   string | null,
    checksum:     string | null,
    network_id:   string | null,
    address:      Address | null,
    symbol:       string | null,
    name:         string | null,
    decimals:     number | null,
    is_strategic: number | null,
    updated_at:   string | null,
    updated_by:   string | null,
  }>(listed);
  const retained = rowsOf<Pick<TokenPolicyRow, 'is_strategic' | 'updated_at' | 'updated_by'> & { address: Address }>(kept);

  const registryVersion = activeVersionOf(rows[0]);
  const inActiveVersion = rows[0]!.network_id !== null;
  if (!inActiveVersion && retained.length === 0) {
    throw refusal('NOT_FOUND', `chain ${chainId} is not part of the active registry`, registryVersion);
  }
  return {
    registryVersion,
    chainId,
    inActiveVersion,
    tokens: rows.filter(row => row.address !== null).map(row => ({
      address:     row.address!,
      symbol:      row.symbol!,
      name:        row.name!,
      decimals:    row.decimals!,
      isStrategic: row.is_strategic === 1,
      updatedAt:   row.updated_at,
      updatedBy:   row.updated_by,
    })),
    retained: retained.map(row => ({
      address:     row.address,
      isStrategic: row.is_strategic === 1,
      updatedAt:   row.updated_at,
      updatedBy:   row.updated_by,
    })),
  };
}

/*
 * Every token of every network of the active version with the decision in
 * force, as a list review and apply take back: the file an operator edits
 * instead of writing addresses by hand. One batch, for one version.
 */
async function exportTokenPolicies(db: D1Database): Promise<TokenPolicyListV1 & { registryVersion: VersionRefV1 }> {
  const [ pointer, listed ] = await db.batch([
    activeVersionStatement(db),
    db.prepare(
      `SELECT network.chain_id AS chain_id, token.address AS address, token.symbol AS symbol,
              COALESCE(policy.is_strategic, 0) AS is_strategic
       FROM registry_state AS state
       JOIN registry_networks AS network ON network.registry_version_id = state.active_version_id
       JOIN tokens AS token
         ON token.registry_version_id = state.active_version_id AND token.network_id = network.id
       LEFT JOIN token_policies AS policy
         ON policy.chain_id = network.chain_id AND policy.token_address = token.address
       WHERE state.singleton_id = 1
       ORDER BY network.chain_id, token.symbol COLLATE NOCASE, token.address`
    ),
  ]);

  const registryVersion = activeVersionOf(rowsOf<{ version_id: string | null, checksum: string | null }>(pointer)[0]);
  return {
    registryVersion,
    reason: null,
    ...member(
      TOKEN_POLICY_KIND.listKey,
      rowsOf<{ chain_id: number, address: Address, symbol: string, is_strategic: number }>(listed).map(row => ({
        chainId:      row.chain_id,
        tokenAddress: row.address,
        symbol:       row.symbol,
        isStrategic:  row.is_strategic === 1,
      })),
    ),
  };
}

function reviewRow(
  { row, decision, state, current, action, problem }: Planned<ListedDecision, TokenState>,
): TokenPolicyReviewV1['policies'][number] {
  return {
    row,
    chainId:      decision.chainId,
    tokenAddress: decision.tokenAddress,
    symbol:       state.symbol,
    current,
    requested:    decision.isStrategic,
    action,
    reason:       decision.reason,
    problem,
  };
}

async function reviewTokenPolicies(db: D1Database, list: DecisionList<ListedDecision>): Promise<TokenPolicyReviewV1> {
  const { registryVersion, summary, planned } = await reviewDecisions(db, TOKEN_POLICY_KIND, list);
  return { registryVersion, summary, ...member(TOKEN_POLICY_KIND.listKey, planned.map(reviewRow)) };
}

async function applyTokenPolicies(db: D1Database, list: DecisionList<ListedDecision>, actor: string): Promise<TokenPolicyApplyV1> {
  const { registryVersion, summary, applied } = await applyDecisions(db, TOKEN_POLICY_KIND, list, actor, {
    problemOf: ({ row, decision, problem }) => ({ row, chainId: decision.chainId, tokenAddress: decision.tokenAddress, problem }),
    left:      () => conflict(
      'TOKEN_LEFT_REGISTRY',
      `a version that does not hold every token of the list was activated while it was being applied; nothing was written`,
    ),
  });
  return {
    registryVersion,
    summary,
    ...member(TOKEN_POLICY_KIND.listKey, applied.map(({ row, decision, state }) => ({
      row,
      chainId:      decision.chainId,
      tokenAddress: decision.tokenAddress,
      symbol:       state.symbol!,
      isStrategic:  state.is_strategic === 1,
      changed:      state.written_id !== null,
      updatedAt:    state.updated_at,
    }))),
  };
}

export type { ListedDecision, TokenOfChain };
export {
  TOKEN_POLICY_KIND,
  applyTokenPolicies,
  exportTokenPolicies,
  readStrategicTokensByChain,
  readTokenPolicies,
  readTokenPolicy,
  reviewTokenPolicies,
  setTokenPolicy,
};
