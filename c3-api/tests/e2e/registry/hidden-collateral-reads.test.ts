import t from 'tap';

import { DEPRECATED_KEY, DEPRECATED_RECORD, HIDDEN_KEY, HIDDEN_RECORD } from '../../../src/registry/collateral-decisions.js';
import { markedDecisions, recordDecisions } from '../../../src/registry/decision-records.js';

import { MemoryKv } from '../../util/kv.js';
import { quietLog } from '../../util/quiet-log.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { failingStatements } from '../../util/test-env.js';

import {
  DEPRECATED_READS,
  HIDDEN_READS,
  captureLogs,
  decisionReadScenarios,
  depsOf,
  envOf,
  fixture,
  get,
  recorded,
} from './collateral-read-scenarios.js';
import { DEPRECATED_COLLATERALS, HIDDEN_COLLATERALS, statementsOf } from './decision-scenarios.js';

import '../../../shim/node-self.js';

/*
 * What the active reads answer about hidden collaterals, through the
 * worker's own entry point: what they answer for every kind of decision
 * about a collateral is in collateral-read-scenarios.ts, run here for hidden
 * collaterals. How a record is kept in step under load and races is the
 * deprecated kind's to test (deprecated-collateral-reads.test.ts): the two
 * kinds keep their records by the same code. Beside them, what the hidden
 * kind is to the deprecated one: each keeps a record of its own, under the
 * key and in the bytes another release reads it by, and a read that can take
 * neither kind's decisions fails for one of them.
 */
decisionReadScenarios(HIDDEN_READS);

type Envelope = { error: { code: string, message: string } };

/*
 * Each kind keeps a record of its own, and what an isolate knows of one says
 * nothing of the other: the record of one kind's decisions, the same as the
 * other's as none are made, is no reason to leave the other's unwritten.
 */
t.test('the hidden and the deprecated decisions are recorded apart', async t => {
  const { registry, collateral, decide } = await fixture(t);
  const kv   = MemoryKv({});
  const deps = depsOf(registry.db, kv);

  await markedDecisions(HIDDEN_RECORD, deps);
  await markedDecisions(DEPRECATED_RECORD, deps);
  t.same([ await recorded(kv, HIDDEN_KEY), await recorded(kv, DEPRECATED_KEY) ], [ [], [] ],
    'a read of each kind, neither decided, writes each record');

  const mEth = collateral('usdt', 'mETH');
  await decide(HIDDEN_READS, 'usdt', 'mETH', true);
  await decide(DEPRECATED_READS, 'usdc', 'weETH', true);
  await recordDecisions(HIDDEN_RECORD, deps);
  t.same([ await recorded(kv, HIDDEN_KEY), await recorded(kv, DEPRECATED_KEY) ], [ [ mEth ], [] ],
    'a hidden command records the hidden decisions alone');
  t.same((await markedDecisions(DEPRECATED_RECORD, deps)).decisions.subjects, [ collateral('usdc', 'weETH') ],
    'while the deprecated ones are their own');
  t.same((await markedDecisions(HIDDEN_RECORD, deps)).decisions.subjects, [ mEth ], 'as the hidden ones are');
});

/*
 * The bytes each record is written as, for the decisions a database gives,
 * in the order it gives them, at a fixed time: a record outlives the release
 * that wrote it, and the one after reads it. Both are held to the strings
 * they have always been written as, for the same decisions.
 */
t.test('each kind writes its record in the bytes it always has', async t => {
  const comet = '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840';
  const rows  = (sql: string) => sql.includes('deprecated_collaterals') ? [
    { chain_id: 1, comet_address: comet, token_address: '0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa' },
    { chain_id: 1, comet_address: comet, token_address: '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee' },
  ] : [];
  const db = { prepare: (sql: string) => ({ all: async () => ({ results: rows(sql) }) }) } as unknown as D1Database;
  const kv = MemoryKv({});
  const deps = { db, kv, ttlSeconds: 300, staleSeconds: 3600, debug: quietLog, now: () => new Date('2026-10-27T09:00:00.000Z') };

  await recordDecisions(DEPRECATED_RECORD, deps);
  await recordDecisions(HIDDEN_RECORD, deps);
  t.equal(await kv.get(DEPRECATED_KEY),
    '{"at":"2026-10-27T09:00:00.000Z","collaterals":[{"chainId":1,"cometAddress":"0x3afdc9bca9213a35503b077a6072f3d0d5ab0840","tokenAddress":"0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa"},{"chainId":1,"cometAddress":"0x3afdc9bca9213a35503b077a6072f3d0d5ab0840","tokenAddress":"0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee"}]}',
    'the deprecated collaterals');
  t.equal(await kv.get(HIDDEN_KEY), '{"at":"2026-10-27T09:00:00.000Z","collaterals":[]}',
    'the hidden ones, none');
});

/*
 * A record is read by its key, by the release after the one that wrote it,
 * and two kinds under one key would write over each other's decisions.
 */
t.test('each kind keeps its record under a key of its own, the one it always has', async t => {
  const keys = [ DEPRECATED_RECORD.key, HIDDEN_RECORD.key ];
  t.same(keys, [ 'deprecated-collaterals:v1', 'hidden-collaterals:v1' ],
    'the deprecated collaterals and the hidden ones, each under the key it is read by');
  t.equal(new Set(keys).size, keys.length, 'no two kinds share one');
});

/*
 * The active reads mark every collateral with both kinds or answer nothing
 * (collateral-decisions.ts, readMarks), and an answer refused for want of
 * both is the same 503 whichever kind it names. It names the deprecated
 * one, which is what its log line puts the request's failure down to.
 */
t.test('a read that can take neither kind of decision fails for want of the deprecated ones', async t => {
  const { registry } = await fixture(t);
  const logs    = captureLogs(t);
  const neither = failingStatements(failingStatements(registry.db, statementsOf(DEPRECATED_COLLATERALS)), statementsOf(HIDDEN_COLLATERALS));

  const unread = await get(await envOf(neither, MemoryKv({})), '/registry/v1/active');
  t.same([ unread.status, (await unread.json() as Envelope).error.code ], [ 503, 'UPSTREAM_UNAVAILABLE' ],
    'neither kind given by the database, nor recorded, is a 503');
  t.ok(logs.some(line => line.includes('RegistryUnavailable: the deprecated collateral decisions could not be read')),
    'which the log puts down to the deprecated decisions');
  t.notOk(logs.some(line => line.includes('hidden collateral decisions')), 'and not to the hidden ones');

  logs.length = 0;
  const unmigrated = await activeRegistryDatabase({ through: '0005' });
  t.teardown(() => unmigrated.dispose());
  const early = await get(await envOf(unmigrated.db, MemoryKv({})), '/registry/v1/active');
  t.same([ early.status, (await early.json() as Envelope).error.code ], [ 503, 'UPSTREAM_UNAVAILABLE' ],
    'and so is a database migrated before either kind\'s tables');
  t.ok(logs.some(line => line.includes('no such table: deprecated_collaterals')), 'which the log puts down to the deprecated table');
  t.notOk(logs.some(line => line.includes('no such table: hidden_collaterals')), 'and not to the hidden one');
});
