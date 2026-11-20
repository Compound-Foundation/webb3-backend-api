import t from 'tap';

import { DEPRECATED_RECORD, HIDDEN_RECORD } from '../../../src/registry/collateral-decisions.js';
import {
  DEPRECATED_COLLATERAL_KIND,
  HIDDEN_COLLATERAL_KIND,
  exportCollaterals,
  readCollateral,
} from '../../../src/registry/collateral-decision-repository.js';
import {
  exportTokenPolicies,
  readStrategicTokensByChain,
  readTokenPolicies,
  readTokenPolicy,
} from '../../../src/registry/token-policy-repository.js';

import { activeRegistryDatabase } from '../../util/registry-database.js';

import type { DecisionKindUnderTest } from './decision-scenarios.js';
import { DEPRECATED_COLLATERALS, HIDDEN_COLLATERALS, TOKEN_POLICIES } from './decision-scenarios.js';

/*
 * The statements each kind of decision prepares, held as their text. What
 * the store sends D1 for a decision is the protocol its audit rests on: the
 * condition a write is made on, what it expects of every row once it is
 * done, the order a history is read in. However the statements come to be
 * built, or shared between kinds, each keeps every byte, and a call sends
 * them in the order it always has: the texts here are those each kind has
 * always prepared, and one that differs fails with the difference.
 *
 * Each call is made as a request makes it, against a real D1 in Node, so a
 * text held here is one D1 runs.
 */

/*
 * Each kind's statements, named for what they are to it: the state of what a
 * JSON parameter's decisions are about, a write's three, one decision's
 * history, the decisions in force, and the export's version, list and kept
 * decisions. The read of a network's token policies has a list and kept
 * policies of its own.
 */

// the active version, which every kind's export reads first
const POINTER = `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum
       FROM registry_state AS state
       LEFT JOIN registry_versions AS version ON version.id = state.active_version_id
       WHERE state.singleton_id = 1`;

const TOKEN_POLICY_STATEMENTS: Record<string, string> = {
  states: `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
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
     ORDER BY row.key`,
  events: `
  INSERT INTO token_policy_events (
    id, chain_id, token_address, previous_is_strategic, is_strategic, actor, reason, created_at
  )
  SELECT json_extract(row.value, '$.i'), json_extract(row.value, '$.c'), json_extract(row.value, '$.t'),
         policy.is_strategic, json_extract(row.value, '$.s'), ?2, json_extract(row.value, '$.r'), ?3
  FROM json_each(?1) AS row
  LEFT JOIN token_policies AS policy
    ON policy.chain_id = json_extract(row.value, '$.c')
   AND policy.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(policy.is_strategic, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key`,
  rows: `
  INSERT INTO token_policies (chain_id, token_address, is_strategic, updated_at, updated_by)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.t'), json_extract(row.value, '$.s'), ?3, ?2
  FROM json_each(?1) AS row
  LEFT JOIN token_policies AS policy
    ON policy.chain_id = json_extract(row.value, '$.c')
   AND policy.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(policy.is_strategic, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key
  ON CONFLICT (chain_id, token_address) DO UPDATE
  SET is_strategic = excluded.is_strategic, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  expectations: `
  INSERT INTO token_policy_expectations (chain_id, token_address, is_strategic)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.t'), json_extract(row.value, '$.s')
  FROM json_each(?1) AS row`,
  history: `SELECT * FROM token_policy_events
       WHERE chain_id = ?1 AND token_address = ?2
       ORDER BY rowid DESC
       LIMIT ?3`,
  marked: `SELECT chain_id, token_address FROM token_policies WHERE is_strategic = 1`,
  pointer: POINTER,
  listed: `SELECT network.chain_id AS chain_id, token.address AS address, token.symbol AS symbol,
              COALESCE(policy.is_strategic, 0) AS is_strategic
       FROM registry_state AS state
       JOIN registry_networks AS network ON network.registry_version_id = state.active_version_id
       JOIN tokens AS token
         ON token.registry_version_id = state.active_version_id AND token.network_id = network.id
       LEFT JOIN token_policies AS policy
         ON policy.chain_id = network.chain_id AND policy.token_address = token.address
       WHERE state.singleton_id = 1
       ORDER BY network.chain_id, token.symbol COLLATE NOCASE, token.address`,
  tokens: `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
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
       ORDER BY token.symbol COLLATE NOCASE, token.address`,
  kept: `SELECT policy.token_address AS address, policy.is_strategic AS is_strategic,
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
       ORDER BY policy.token_address`,
};

const DEPRECATED_COLLATERAL_STATEMENTS: Record<string, string> = {
  states: `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
            network.id AS network_id, market.id AS market_id, market.deployment_key AS deployment_key,
            token.id AS token_id, token.symbol AS symbol,
            decision.is_deprecated AS is_deprecated, decision.updated_at AS updated_at, decision.updated_by AS updated_by,
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
     LEFT JOIN deprecated_collaterals AS decision
       ON decision.chain_id = json_extract(row.value, '$.c')
      AND decision.comet_address = json_extract(row.value, '$.m')
      AND decision.token_address = json_extract(row.value, '$.t')
     LEFT JOIN deprecated_collateral_events AS written ON written.id = json_extract(row.value, '$.i')
     ORDER BY row.key`,
  events: `
  INSERT INTO deprecated_collateral_events (
    id, chain_id, comet_address, token_address, previous_is_deprecated, is_deprecated, actor, reason, created_at
  )
  SELECT json_extract(row.value, '$.i'), json_extract(row.value, '$.c'), json_extract(row.value, '$.m'),
         json_extract(row.value, '$.t'), decision.is_deprecated, json_extract(row.value, '$.s'), ?2,
         json_extract(row.value, '$.r'), ?3
  FROM json_each(?1) AS row
  LEFT JOIN deprecated_collaterals AS decision
    ON decision.chain_id = json_extract(row.value, '$.c')
   AND decision.comet_address = json_extract(row.value, '$.m')
   AND decision.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(decision.is_deprecated, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key`,
  rows: `
  INSERT INTO deprecated_collaterals (chain_id, comet_address, token_address, is_deprecated, updated_at, updated_by)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.m'), json_extract(row.value, '$.t'),
         json_extract(row.value, '$.s'), ?3, ?2
  FROM json_each(?1) AS row
  LEFT JOIN deprecated_collaterals AS decision
    ON decision.chain_id = json_extract(row.value, '$.c')
   AND decision.comet_address = json_extract(row.value, '$.m')
   AND decision.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(decision.is_deprecated, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key
  ON CONFLICT (chain_id, comet_address, token_address) DO UPDATE
  SET is_deprecated = excluded.is_deprecated, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  expectations: `
  INSERT INTO deprecated_collateral_expectations (chain_id, comet_address, token_address, is_deprecated)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.m'), json_extract(row.value, '$.t'),
         json_extract(row.value, '$.s')
  FROM json_each(?1) AS row`,
  history: `SELECT * FROM deprecated_collateral_events
       WHERE chain_id = ?1 AND comet_address = ?2 AND token_address = ?3
       ORDER BY rowid DESC
       LIMIT ?4`,
  marked: `SELECT chain_id, comet_address, token_address FROM deprecated_collaterals
     WHERE is_deprecated = 1
     ORDER BY chain_id, comet_address, token_address`,
  pointer: POINTER,
  listed: `SELECT network.chain_id AS chain_id, contract.address AS comet_address, market.deployment_key AS deployment_key,
              token.address AS token_address, token.symbol AS symbol, COALESCE(decision.is_deprecated, 0) AS is_deprecated
       FROM registry_state AS state
       JOIN registry_networks AS network ON network.registry_version_id = state.active_version_id
       JOIN markets AS market
         ON market.registry_version_id = state.active_version_id AND market.network_id = network.id
       JOIN market_contracts AS contract ON contract.market_id = market.id AND contract.role = 'comet'
       JOIN market_assets AS asset ON asset.market_id = market.id AND asset.role = 'collateral'
       JOIN tokens AS token ON token.id = asset.token_id
       LEFT JOIN deprecated_collaterals AS decision
         ON decision.chain_id = network.chain_id
        AND decision.comet_address = contract.address
        AND decision.token_address = token.address
       WHERE state.singleton_id = 1
       ORDER BY network.chain_id, market.deployment_key, asset.asset_index`,
  kept: `SELECT decision.chain_id AS chain_id, decision.comet_address AS comet_address, decision.token_address AS token_address,
              decision.is_deprecated AS is_deprecated, decision.updated_at AS updated_at, decision.updated_by AS updated_by
       FROM deprecated_collaterals AS decision
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
       ORDER BY decision.chain_id, decision.comet_address, decision.token_address`,
};

const HIDDEN_COLLATERAL_STATEMENTS: Record<string, string> = {
  states: `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
            network.id AS network_id, market.id AS market_id, market.deployment_key AS deployment_key,
            token.id AS token_id, token.symbol AS symbol,
            decision.is_hidden AS is_hidden, decision.updated_at AS updated_at, decision.updated_by AS updated_by,
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
     LEFT JOIN hidden_collaterals AS decision
       ON decision.chain_id = json_extract(row.value, '$.c')
      AND decision.comet_address = json_extract(row.value, '$.m')
      AND decision.token_address = json_extract(row.value, '$.t')
     LEFT JOIN hidden_collateral_events AS written ON written.id = json_extract(row.value, '$.i')
     ORDER BY row.key`,
  events: `
  INSERT INTO hidden_collateral_events (
    id, chain_id, comet_address, token_address, previous_is_hidden, is_hidden, actor, reason, created_at
  )
  SELECT json_extract(row.value, '$.i'), json_extract(row.value, '$.c'), json_extract(row.value, '$.m'),
         json_extract(row.value, '$.t'), decision.is_hidden, json_extract(row.value, '$.s'), ?2,
         json_extract(row.value, '$.r'), ?3
  FROM json_each(?1) AS row
  LEFT JOIN hidden_collaterals AS decision
    ON decision.chain_id = json_extract(row.value, '$.c')
   AND decision.comet_address = json_extract(row.value, '$.m')
   AND decision.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(decision.is_hidden, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key`,
  rows: `
  INSERT INTO hidden_collaterals (chain_id, comet_address, token_address, is_hidden, updated_at, updated_by)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.m'), json_extract(row.value, '$.t'),
         json_extract(row.value, '$.s'), ?3, ?2
  FROM json_each(?1) AS row
  LEFT JOIN hidden_collaterals AS decision
    ON decision.chain_id = json_extract(row.value, '$.c')
   AND decision.comet_address = json_extract(row.value, '$.m')
   AND decision.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(decision.is_hidden, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key
  ON CONFLICT (chain_id, comet_address, token_address) DO UPDATE
  SET is_hidden = excluded.is_hidden, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  expectations: `
  INSERT INTO hidden_collateral_expectations (chain_id, comet_address, token_address, is_hidden)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.m'), json_extract(row.value, '$.t'),
         json_extract(row.value, '$.s')
  FROM json_each(?1) AS row`,
  history: `SELECT * FROM hidden_collateral_events
       WHERE chain_id = ?1 AND comet_address = ?2 AND token_address = ?3
       ORDER BY rowid DESC
       LIMIT ?4`,
  marked: `SELECT chain_id, comet_address, token_address FROM hidden_collaterals
     WHERE is_hidden = 1
     ORDER BY chain_id, comet_address, token_address`,
  pointer: POINTER,
  listed: `SELECT network.chain_id AS chain_id, contract.address AS comet_address, market.deployment_key AS deployment_key,
              token.address AS token_address, token.symbol AS symbol, COALESCE(decision.is_hidden, 0) AS is_hidden
       FROM registry_state AS state
       JOIN registry_networks AS network ON network.registry_version_id = state.active_version_id
       JOIN markets AS market
         ON market.registry_version_id = state.active_version_id AND market.network_id = network.id
       JOIN market_contracts AS contract ON contract.market_id = market.id AND contract.role = 'comet'
       JOIN market_assets AS asset ON asset.market_id = market.id AND asset.role = 'collateral'
       JOIN tokens AS token ON token.id = asset.token_id
       LEFT JOIN hidden_collaterals AS decision
         ON decision.chain_id = network.chain_id
        AND decision.comet_address = contract.address
        AND decision.token_address = token.address
       WHERE state.singleton_id = 1
       ORDER BY network.chain_id, market.deployment_key, asset.asset_index`,
  kept: `SELECT decision.chain_id AS chain_id, decision.comet_address AS comet_address, decision.token_address AS token_address,
              decision.is_hidden AS is_hidden, decision.updated_at AS updated_at, decision.updated_by AS updated_by
       FROM hidden_collaterals AS decision
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
       ORDER BY decision.chain_id, decision.comet_address, decision.token_address`,
};

function recording(db: D1Database): { db: D1Database, prepared: string[] } {
  const prepared: string[] = [];
  const wrapped = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== 'prepare') {
        return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
      }
      return (sql: string) => {
        prepared.push(sql);
        return target.prepare(sql);
      };
    },
  });
  return { db: wrapped, prepared };
}

type Call = [ name: string, call: (db: D1Database) => Promise<unknown>, roles: string[] ];

// a command's write and a list's alike: the state read first, then the batch that writes and reads it back
const WRITE = [ 'states', 'events', 'rows', 'expectations', 'states' ];

// what every kind's commands prepare, a decision about one subject and then a list about another, as the scenarios make them
function commands(kind: DecisionKindUnderTest): Call[] {
  const reason = 'decided for the statements test';
  return [
    [ 'a command', db => kind.set(db, { subject: kind.subject, flag: true, actor: 'test', reason }), WRITE ],
    [ 'an apply',  db => kind.apply(db, { reason, rows: [ [ kind.other, true, null ] ] }, 'test'), WRITE ],
  ];
}

const collateralOf = ({ subject }: DecisionKindUnderTest) => ({ chainId: 1, cometAddress: subject.cometAddress, tokenAddress: subject.tokenAddress });

const KINDS: Array<[ kind: DecisionKindUnderTest, statements: Record<string, string>, reads: Call[] ]> = [
  [ TOKEN_POLICIES, TOKEN_POLICY_STATEMENTS, [
    [ 'a read of one decision', db => readTokenPolicy(db, 1, TOKEN_POLICIES.subject.tokenAddress), [ 'states', 'history' ] ],
    [ 'the export',             db => exportTokenPolicies(db), [ 'pointer', 'listed' ] ],
    [ 'a network\'s tokens',    db => readTokenPolicies(db, 1), [ 'tokens', 'kept' ] ],
    [ 'the decisions in force', db => readStrategicTokensByChain(db), [ 'marked' ] ],
  ] ],
  [ DEPRECATED_COLLATERALS, DEPRECATED_COLLATERAL_STATEMENTS, [
    [ 'a read of one decision', db => readCollateral(db, DEPRECATED_COLLATERAL_KIND, collateralOf(DEPRECATED_COLLATERALS)), [ 'states', 'history' ] ],
    [ 'the export',             db => exportCollaterals(db, DEPRECATED_COLLATERAL_KIND), [ 'pointer', 'listed', 'kept' ] ],
    [ 'the decisions in force', db => DEPRECATED_RECORD.read(db), [ 'marked' ] ],
  ] ],
  [ HIDDEN_COLLATERALS, HIDDEN_COLLATERAL_STATEMENTS, [
    [ 'a read of one decision', db => readCollateral(db, HIDDEN_COLLATERAL_KIND, collateralOf(HIDDEN_COLLATERALS)), [ 'states', 'history' ] ],
    [ 'the export',             db => exportCollaterals(db, HIDDEN_COLLATERAL_KIND), [ 'pointer', 'listed', 'kept' ] ],
    [ 'the decisions in force', db => HIDDEN_RECORD.read(db), [ 'marked' ] ],
  ] ],
];

for (const [ kind, statements, reads ] of KINDS) {
  t.test(`the statements of ${kind.list.what} keep their texts, each call's in its order`, async t => {
    const registry = await activeRegistryDatabase();
    t.teardown(() => registry.dispose());
    const { db, prepared } = recording(registry.db);

    for (const [ name, call, roles ] of [ ...commands(kind), ...reads ]) {
      prepared.length = 0;
      await call(db);
      t.equal(prepared.length, roles.length, `${name} prepares ${roles.join(', ')}`);
      roles.forEach((role, index) => {
        t.equal(prepared[index], statements[role], `${name}: statement ${index + 1}, the ${role} statement`);
      });
    }
  });
}
