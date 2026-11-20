import t from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';

import { activeRegistryDatabase } from '../../util/registry-database.js';
import { ADMIN_TOKEN, adminTestEnv } from '../../util/test-env.js';

import type { DecisionKindUnderTest } from './decision-scenarios.js';
import { DEPRECATED_COLLATERALS, HIDDEN_COLLATERALS, TOKEN_POLICIES } from './decision-scenarios.js';

import '../../../shim/node-self.js';

/*
 * The read of one decision of each kind, through the worker's own entry point
 * in Node, where a test holds the database binding the worker reads through:
 * the other answers of its route are decision-scenarios.ts's, in workerd.
 * Beside it, which budget of the limiter each route of a kind spends, which
 * the limiter of a test in Node is asked for by name.
 *
 * A read hands the kind's states statement its subject in the form a write
 * hands it a decision, as the decision not taken and without a reason
 * (decision-store.ts). The statement does not read the decision or the
 * reason, and no read uses what it finds by the event id, so a read that
 * bound anything else would answer as this one does: the bind is held here as
 * it is written. And a read about a subject nobody ever decided about, which
 * the active version does not hold, is refused with what the version does not
 * hold, as a change would be.
 */
let seed = 0;

type Refused = { error: { code: string, message: string, details?: { registryVersion?: { id: string } } } };

function envOf(db: D1Database, overrides: Partial<Env> = {}): Promise<Env> {
  return adminTestEnv({ APP_DB: db, MEMORY_CACHE_SEED: `decision-read-${seed++}`, ...overrides });
}

function read(path: string): Request {
  return new Request(`https://api.test.local${path}`, { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } });
}

function command(method: string, path: string, body: unknown): Request {
  return new Request(`https://api.test.local${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

// `db`, and what every statement prepared through it was bound to
function recording(db: D1Database): { db: D1Database, bound: unknown[][] } {
  const bound: unknown[][] = [];
  const wrapped = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== 'prepare') {
        return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
      }
      return (sql: string) => new Proxy(target.prepare(sql), {
        get(statement, name) {
          const method = Reflect.get(statement, name) as unknown;
          if (name === 'bind') {
            return (...parameters: unknown[]) => {
              bound.push(parameters);
              return (method as D1PreparedStatement['bind']).apply(statement, parameters);
            };
          }
          return typeof(method) === 'function' ? (method as () => unknown).bind(statement) : method;
        },
      });
    },
  });
  return { db: wrapped, bound };
}

// the member of a statement's JSON parameter that names each address of a subject, after its chain (`c`)
const MEMBERS: Record<string, string> = { cometAddress: 'm', tokenAddress: 't' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Refusal = [ number, Record<string, string>, string ];

const [ [ , NOT_A_TOKEN ] ] = TOKEN_POLICIES.unheld;
const [ [ , NOT_A_MARKET ], [ , NOT_TAKEN ], [ , A_BASE ] ] = DEPRECATED_COLLATERALS.unheld;

const COLLATERAL_REFUSALS: Refusal[] = [
  [ 10, DEPRECATED_COLLATERALS.subject, 'chain 10 is not part of the active registry' ],
  [ 1, NOT_A_MARKET, `${NOT_A_MARKET.cometAddress} is not a market of the active registry on chain 1` ],
  [ 1, NOT_TAKEN, `${NOT_TAKEN.tokenAddress} is not a collateral of ${NOT_TAKEN.cometAddress} in the active registry on chain 1` ],
  [ 1, A_BASE, `${A_BASE.tokenAddress} is not a collateral of ${A_BASE.cometAddress} in the active registry on chain 1` ],
];

// each kind, with what it refuses a read about a subject nobody decided about with, as the refusal says it
const KINDS: Array<[ DecisionKindUnderTest, Refusal[] ]> = [
  [ TOKEN_POLICIES, [
    [ 10, TOKEN_POLICIES.subject, 'chain 10 is not part of the active registry' ],
    [ 1, NOT_A_TOKEN, `${NOT_A_TOKEN.tokenAddress} is not a token of the active registry on chain 1` ],
  ] ],
  [ DEPRECATED_COLLATERALS, COLLATERAL_REFUSALS ],
  [ HIDDEN_COLLATERALS, COLLATERAL_REFUSALS ],
];

for (const [ kind, refusals ] of KINDS) {
  t.test(`a read of one ${kind.label} decision hands its states statement the ${kind.noun} as a write would, with no decision and no reason`, async t => {
    const registry = await activeRegistryDatabase();
    t.teardown(() => registry.dispose());
    const { db, bound } = recording(registry.db);

    t.equal((await C3Api.fetch(read(kind.path(1, kind.subject)), await envOf(db))).status, 200, 'the read answers');
    const states = bound.filter(parameters => parameters.length === 1 && typeof(parameters[0]) === 'string' && parameters[0].startsWith('['));
    t.equal(states.length, 1, 'having bound one statement to a JSON parameter');
    const [ parameter ] = states[0] as [ string ];
    const { i } = (JSON.parse(parameter) as [ { i: string } ])[0];
    t.match(i, UUID, 'whose event id is a new one');
    const subject = Object.fromEntries(Object.entries(kind.subject).map(([ name, address ]) => [ MEMBERS[name], address ]));
    t.equal(parameter, JSON.stringify([ { i, c: 1, ...subject, s: 0, r: null } ]),
      'and whose one decision is the subject, as the decision not taken, without a reason');
  });

  t.test(`a read of a ${kind.label} decision about a ${kind.noun} nobody decided about, which the active version does not hold, is refused with why`, async t => {
    const registry = await activeRegistryDatabase();
    t.teardown(() => registry.dispose());
    const env = await envOf(registry.db);

    for (const [ chainId, subject, message ] of refusals) {
      const response = await C3Api.fetch(read(kind.path(chainId, subject)), env);
      const body = await response.json() as Refused;
      t.same(
        [ response.status, body.error.code, body.error.message, body.error.details?.registryVersion?.id, response.headers.get('x-registry-version') ],
        [ 404, 'NOT_FOUND', message, registry.versionId, registry.versionId ],
        `${message}, under the version that does not hold it`,
      );
    }
  });
}

/*
 * Which budget each route of a kind spends (admin-router.ts, limit): a read,
 * the export and a review the read family's, and a change and an apply the
 * policy family's, which every decision command shares. The limiter of a
 * test in Node lets everything through, and the one in workerd is tested on
 * other routes (security.test.ts), so the families are held here by the key
 * the limiter is asked for, `registry-admin:<fingerprint>:<family>`. A
 * request spends before its body is read, so a body refused for its shape
 * has spent all the same, and these write nothing.
 */
t.test('each route of a kind spends its family\'s budget: a change and an apply the policy family\'s, the rest the read family\'s', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const keys: string[] = [];
  const env = await envOf(registry.db, {
    REGISTRY_ADMIN_RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: true }; } },
  });

  for (const [ kind ] of KINDS) {
    keys.length = 0;
    const answers = [];
    for (const request of [
      read(kind.path(1, kind.subject)),
      command('PATCH', kind.path(1, kind.subject), {}),
      read(kind.list.export),
      command('POST', kind.list.review, {}),
      command('POST', kind.list.apply, {}),
    ]) {
      answers.push((await C3Api.fetch(request, env)).status);
    }
    t.same(answers, [ 200, 400, 200, 400, 400 ], `${kind.label}: each request reaches its route`);
    t.same(keys.map(key => key.slice(key.lastIndexOf(':') + 1)), [ 'read', 'policy', 'read', 'read', 'policy' ],
      `${kind.label}: a decision's read, its change, the export, a review and an apply spend, in turn, the families read, policy, read, read and policy`);
  }
});
