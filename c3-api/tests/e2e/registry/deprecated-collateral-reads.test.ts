import t from 'tap';

import { keccak256 } from '../../../lib/hash.js';
import type { CollateralOfComet } from '../../../src/registry/collateral-decision-repository.js';
import { DEPRECATED_KEY, DEPRECATED_RECORD, HIDDEN_RECORD } from '../../../src/registry/collateral-decisions.js';
import type { RecordedKind } from '../../../src/registry/decision-records.js';
import { decisionSetOf, markedDecisions, recordDecisions } from '../../../src/registry/decision-records.js';

import { settledWithin } from '../../util/execution-context.js';
import { MemoryKv } from '../../util/kv.js';
import { quietLog } from '../../util/quiet-log.js';

import { DEPRECATED_READS, HIDDEN_READS, bindingOf, decisionReadScenarios, envOf, fixture, get } from './collateral-read-scenarios.js';
import { DEPRECATED_COLLATERALS, statementsOf } from './decision-scenarios.js';

import '../../../shim/node-self.js';

/*
 * What the active reads answer about deprecated collaterals, through the
 * worker's own entry point: what they answer for every kind of decision
 * about a collateral is in collateral-read-scenarios.ts, run here for
 * deprecated collaterals. Beside it, the form of the digest a tag names each
 * kind's flags by, and how the reads keep the record an outage answers with
 * in step under load and races, which the tests below drive through the
 * deprecated kind's record: the two kinds keep their records by the same code.
 */
decisionReadScenarios(DEPRECATED_READS);

/*
 * The copies clients hold were tagged by these digests, and a record is
 * checked by the same digest of its decisions. The other tests read only the
 * digest's shape, so its form is held here, written out.
 */
t.test('a tag names each kind\'s flags by a digest of their collaterals, as the decisions of the kind are named', async t => {
  const { registry, collateral, decide } = await fixture(t);
  const env = await envOf(registry.db, MemoryKv({}));
  const [ mEth, weEth, lBtc ] = [ collateral('usdt', 'mETH'), collateral('usdc', 'weETH'), collateral('wbtc', 'LBTC') ];
  await decide(DEPRECATED_READS, 'usdt', 'mETH', true);
  await decide(DEPRECATED_READS, 'usdc', 'weETH', true);
  await decide(HIDDEN_READS, 'wbtc', 'LBTC', true);

  // keys given in their sorted order
  const digestOf   = (...keys: string[]) => keccak256(keys.join(',')).slice(0, 16);
  const deprecated = digestOf(`1:${mEth.cometAddress}:${mEth.tokenAddress}`, `1:${weEth.cometAddress}:${weEth.tokenAddress}`);
  const hidden     = digestOf(`1:${lBtc.cometAddress}:${lBtc.tokenAddress}`);
  t.equal((await get(env, '/registry/v1/active')).headers.get('etag'),
    `"v1-r5-snapshot+deprecated-${deprecated}+hidden-${hidden}-${registry.versionId}-${registry.snapshot.registryVersion.checksum}"`,
    'the active snapshot names the collaterals it flags deprecated, and those it flags hidden, each by the digest of their keys');
  t.same(
    [ decisionSetOf(DEPRECATED_RECORD, [ weEth, mEth ]).digest, decisionSetOf(HIDDEN_RECORD, [ lBtc ]).digest ],
    [ deprecated, hidden ],
    'and so are the decisions of each kind, in whatever order they were listed');
});

// waits for a condition, for five seconds at most: one never met fails the assertions after it, not the run
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

/*
 * The database, and how many reads of the deprecated decisions it has answered:
 * what a test waits on to know that a read has gone past it. Whatever a read
 * does with the answer before it next waits on I/O is done by the time a
 * timer sees the count.
 */
function counting(db: D1Database): { db: D1Database, answered: () => number } {
  const reads  = statementsOf(DEPRECATED_COLLATERALS);
  let answered = 0;
  const wrapped = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== 'prepare') {
        return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
      }
      return (sql: string) => {
        const statement = (value as D1Database['prepare']).call(target, sql);
        if (!reads.test(sql)) {
          return statement;
        }
        return new Proxy(statement, {
          get(inner, name) {
            const method = Reflect.get(inner, name) as unknown;
            if (name === 'all') {
              return async (...parameters: unknown[]) => {
                const result = await (method as (...parameters: unknown[]) => Promise<unknown>).apply(inner, parameters);
                answered += 1;
                return result;
              };
            }
            return typeof(method) === 'function' ? (method as () => unknown).bind(inner) : method;
          },
        });
      };
    },
  });
  return { db: wrapped, answered: () => answered };
}

/*
 * KV keeps whichever write reaches it last, and takes one write a second to a
 * key. The reads of an isolate check the record once between them, and write
 * it only where it does not hold the decisions they found: the isolates of a
 * deploy, starting together, find it right and write nothing.
 */
t.test('the reads of an isolate check the record once between them, and write it only where it differs', async t => {
  const { registry, decide } = await fixture(t);
  const store = MemoryKv({});
  let gets = 0;
  let puts = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const counted = (gate: Promise<void>) => new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'get' || property === 'put') {
        return async (...parameters: unknown[]) => {
          if (property === 'get') {
            gets += 1;
            await gate;
          } else {
            puts += 1;
          }
          return (value as (...parameters: unknown[]) => Promise<unknown>).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  const warnings: unknown[] = [];
  const { db, answered } = counting(registry.db);
  const depsOf = (kv: KVNamespace) => ({
    db,
    kv,
    ttlSeconds:   300,
    staleSeconds: 3600,
    debug:        { error: () => {}, warn: (message: unknown) => { warnings.push(message); } },
  });

  const deps  = depsOf(counted(held));
  let settled = 0;
  const burst = Array.from({ length: 8 }, () => markedDecisions(DEPRECATED_RECORD, deps).then(read => { settled += 1; return read; }));
  await until(() => settled >= 7);
  t.equal(gets, 1, 'eight reads arriving together check the record once, the other seven leaving it to that check');
  const command = recordDecisions(DEPRECATED_RECORD, deps);
  await until(() => answered() === 9);
  t.equal(answered(), 9, 'the command reads the decisions, as each of the eight reads did, while the check is held');
  release();
  await Promise.all([ ...burst, command ]);
  t.same([ gets, puts, warnings ], [ 1, 1, [] ],
    'and the one check writes what it did not find, once, as does a command that decided nothing meanwhile');

  const started = depsOf(counted(Promise.resolve()));
  await Promise.all(Array.from({ length: 8 }, () => markedDecisions(DEPRECATED_RECORD, started)));
  t.same([ gets, puts ], [ 2, 1 ], 'an isolate starting after it finds the record right, and writes nothing');

  await decide(DEPRECATED_READS, 'usdt', 'mETH', true);
  await markedDecisions(DEPRECATED_RECORD, started);
  t.same([ gets, puts ], [ 3, 2 ], 'until the decisions change, when its next read finds the record behind them and writes it');
  await markedDecisions(DEPRECATED_RECORD, deps);
  t.same([ gets, puts ], [ 4, 2 ], 'which another isolate then finds written');

  await store.put(DEPRECATED_KEY, JSON.stringify({ collaterals: 'not a list' }));
  await markedDecisions(DEPRECATED_RECORD, depsOf(counted(Promise.resolve())));
  t.equal(puts, 3, 'and a record that is not one is written over');
  t.equal((await store.get(DEPRECATED_KEY, 'json') as { collaterals: unknown[] }).collaterals.length, 1, 'with the decisions');
});

/*
 * A read that began before a decision can write after the decision's own
 * record, and put back the decisions before it. Every isolate checks the
 * record again every five minutes, even while the decisions it reads stay the
 * same, so such a record is put right by the first check after it.
 */
t.test('a record a read put back after a decision is put right by the next check', async t => {
  const { registry, decide } = await fixture(t);
  const store = MemoryKv({});
  let now = Date.parse('2026-10-08T12:00:00.000Z');
  const depsOf = (kv: KVNamespace) => ({
    db:           registry.db,
    kv,
    ttlSeconds:   300,
    staleSeconds: 3600,
    now:          () => new Date(now),
    debug:        quietLog,
  });
  const recorded = async () => (await store.get(DEPRECATED_KEY, 'json') as { collaterals: unknown[] }).collaterals.length;

  // isolate A reads the decisions before one is made, and its write of them is slow
  let reached!: () => void;
  let release!: () => void;
  const atWrite  = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const a = depsOf(bindingOf(store, { put: async (_parameters, write) => { reached(); await released; await write(); } }));
  const b = depsOf(bindingOf(store));
  const reading = markedDecisions(DEPRECATED_RECORD, a);
  await atWrite;

  // isolate B makes a decision meanwhile, and its command records it
  await decide(DEPRECATED_READS, 'usdt', 'mETH', true);
  await recordDecisions(DEPRECATED_RECORD, b);
  t.equal(await recorded(), 1, 'the command records its decision');
  release();
  t.equal((await reading).decisions.subjects.length, 0, 'A read the decisions before it');
  t.equal(await recorded(), 0, 'and its write, landing last, put back the decisions before the decision');

  now += 4 * 60_000;
  await markedDecisions(DEPRECATED_RECORD, b);
  t.equal(await recorded(), 0, 'B, which recorded the decision itself, checks the record again only after five minutes');
  now += 60_000;
  await markedDecisions(DEPRECATED_RECORD, b);
  t.equal(await recorded(), 1, 'and puts it right at that check');
});

/*
 * KV takes one write a second to a key, which the isolates of a deploy can
 * still exceed together, where the record is behind the decisions. One whose
 * write failed records again a minute later, or as soon as the decisions
 * change, rather than on every read it answers.
 */
t.test('a record that could not be written is written again a minute later, not on every read', async t => {
  const { registry, decide } = await fixture(t);
  const kv = MemoryKv({});
  let refusing = true;
  let puts     = 0;
  const throttled = new Proxy(kv, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'put') {
        return async (...parameters: unknown[]) => {
          puts += 1;
          if (refusing) {
            throw new Error('KV PUT failed: 429 Too Many Requests');
          }
          return (value as (...parameters: unknown[]) => Promise<void>).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  const warnings: unknown[] = [];
  let now = Date.parse('2026-10-08T12:00:00.000Z');
  const deps = {
    db:           registry.db,
    kv:           throttled,
    ttlSeconds:   300,
    staleSeconds: 3600,
    now:          () => new Date(now),
    debug:        { error: () => {}, warn: (message: unknown) => { warnings.push(message); } },
  };

  t.equal((await markedDecisions(DEPRECATED_RECORD, deps)).recorded, false, 'the decisions come from the database');
  t.same([ puts, warnings ], [ 1, [ 'deprecated collateral record unwritable' ] ], 'and a refused write is a warning, never a failure');
  await markedDecisions(DEPRECATED_RECORD, deps);
  now += 30_000;
  await markedDecisions(DEPRECATED_RECORD, deps);
  t.equal(puts, 1, 'the reads of the next minute do not write again');

  now += 31_000;
  refusing = false;
  await markedDecisions(DEPRECATED_RECORD, deps);
  t.equal(puts, 2, 'a minute later a read writes again');
  t.same((await kv.get(DEPRECATED_KEY, 'json') as { collaterals: unknown[] }).collaterals, [], 'and the record is written');
  await markedDecisions(DEPRECATED_RECORD, deps);
  t.equal(puts, 2, 'after which reads of the same decisions write nothing');

  await decide(DEPRECATED_READS, 'usdt', 'mETH', true);
  await markedDecisions(DEPRECATED_RECORD, deps);
  t.equal(puts, 3, 'and the first read of changed decisions records them');
});

// a read does not wait for its check of the record: it hands the check to its waitUntil, `defer` here
t.test('a read hands its check of the record to waitUntil, and is answered before the record is written', async t => {
  const { registry, decide } = await fixture(t);
  await decide(DEPRECATED_READS, 'usdt', 'mETH', true);
  const store = MemoryKv({});
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const deferred: Array<Promise<unknown>> = [];
  const deps = {
    db:           registry.db,
    kv:           bindingOf(store, { put: async (_parameters, write) => { await released; await write(); } }),
    ttlSeconds:   300,
    staleSeconds: 3600,
    debug:        quietLog,
    defer:        (work: Promise<unknown>) => { deferred.push(work); },
  };

  const read = markedDecisions(DEPRECATED_RECORD, deps);
  t.ok(await settledWithin(read, 5000), 'the read is answered while the write of the record is held');
  t.equal(deferred.length, 1, 'having handed its check over');
  t.equal(await store.get(DEPRECATED_KEY), null, 'which has not written the record yet');
  release();
  t.equal((await read).decisions.subjects.length, 1, 'the read answers with the decisions');
  await Promise.all(deferred);
  t.equal((await store.get(DEPRECATED_KEY, 'json') as { collaterals: unknown[] } | null)?.collaterals.length, 1,
    'which the record holds once the namespace takes the write');
});

/*
 * A binding of `store` whose first write never finishes, as one the runtime
 * cut off, and the reads of the record through it, on a clock the test moves
 * and with what they hand to waitUntil kept.
 */
function cutOff(db: D1Database, store: KVNamespace) {
  let puts = 0;
  const kv = bindingOf(store, {
    put: async (_parameters, write) => {
      puts += 1;
      await (puts === 1 ? new Promise<void>(() => {}) : write());
    },
  });
  const clock = { now: Date.parse('2026-10-08T12:00:00.000Z') };
  const deferred: Array<Promise<unknown>> = [];
  const deps = {
    db,
    kv,
    ttlSeconds:   300,
    staleSeconds: 3600,
    now:          () => new Date(clock.now),
    debug:        quietLog,
    defer:        (work: Promise<unknown>) => { deferred.push(work); },
  };
  return { deps, clock, deferred, puts: () => puts };
}

/*
 * A check the runtime cut off never finishes. It holds the record for a
 * minute, as a write KV refused does: the reads of the same decisions leave
 * the record to it meanwhile, and check it again after.
 */
t.test('a check of the record that never finished is made again a minute later', async t => {
  const { registry } = await fixture(t);
  const store = MemoryKv({});
  const { deps, clock, deferred, puts } = cutOff(registry.db, store);

  t.ok(await settledWithin(markedDecisions(DEPRECATED_RECORD, deps), 5000), 'a read is answered while its check is under way');
  await until(() => puts() === 1);
  clock.now += 59_000;
  await markedDecisions(DEPRECATED_RECORD, deps);
  t.same([ puts(), deferred.length ], [ 1, 1 ], 'the reads of the minute after a check began leave the record to it, though it never finishes');

  clock.now += 2_000;
  await markedDecisions(DEPRECATED_RECORD, deps);
  await deferred[1];
  t.same([ puts(), deferred.length ], [ 2, 2 ], 'a read past that minute checks it again');
  t.same((await store.get(DEPRECATED_KEY, 'json') as { collaterals: unknown[] } | null)?.collaterals, [], 'and writes the record');
});

/*
 * A command that finds a check of the decisions it read under way waits for
 * it rather than write the record again: KV takes one write a second to a
 * key, and the check writes what the command would.
 */
t.test('a command waits for a check of the same decisions under way, and leaves the record to it', async t => {
  const { registry, decide } = await fixture(t);
  await decide(DEPRECATED_READS, 'usdt', 'mETH', true);
  const store = MemoryKv({});
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let puts = 0;
  const deps = {
    db:           registry.db,
    // the namespace takes the first write it is given, the check's, once released
    kv:           bindingOf(store, { put: async (_parameters, write) => { puts += 1; await (puts === 1 ? released.then(write) : write()); } }),
    ttlSeconds:   300,
    staleSeconds: 3600,
    debug:        quietLog,
    defer:        () => {},
  };

  t.ok(await settledWithin(markedDecisions(DEPRECATED_RECORD, deps), 5000), 'a read is answered while its check is under way');
  await until(() => puts === 1);
  const command = recordDecisions(DEPRECATED_RECORD, deps);
  t.notOk(await settledWithin(command, 300), 'a command that read the same decisions waits for that check');
  t.equal(puts, 1, 'and writes nothing of its own meanwhile');
  release();
  t.ok(await settledWithin(command, 5000), 'it is done once the check is');
  t.equal(puts, 1, 'the check having made the one write');
  t.equal((await store.get(DEPRECATED_KEY, 'json') as { collaterals: unknown[] } | null)?.collaterals.length, 1, 'of the decisions');
});

/*
 * It waits only while the check holds the record: one the runtime cut off
 * never finishes, and the command then records the decisions itself.
 */
t.test('a command waits for a check of the same decisions no longer than the check holds the record', async t => {
  const { registry, decide } = await fixture(t);
  await decide(DEPRECATED_READS, 'usdt', 'mETH', true);
  const store = MemoryKv({});
  const { deps, clock, puts } = cutOff(registry.db, store);

  t.ok(await settledWithin(markedDecisions(DEPRECATED_RECORD, deps), 5000), 'a read is answered while its check is under way');
  await until(() => puts() === 1);
  clock.now += 60_000 - 50;
  t.ok(await settledWithin(recordDecisions(DEPRECATED_RECORD, deps), 5000), 'a command near the end of that minute waits out the rest of it');
  t.equal(puts(), 2, 'then writes the record itself');
  t.equal((await store.get(DEPRECATED_KEY, 'json') as { collaterals: unknown[] } | null)?.collaterals.length, 1, 'with the decisions');
});

/*
 * A check of other decisions, which a read began before the command decided,
 * does not hold the command: the check would write the decisions the command
 * replaced, so the command records its own at once.
 */
t.test('a command does not wait for a check of other decisions', async t => {
  const { registry, decide } = await fixture(t);
  const store = MemoryKv({});
  const { deps, puts } = cutOff(registry.db, store);

  t.ok(await settledWithin(markedDecisions(DEPRECATED_RECORD, deps), 5000), 'a read is answered while its check is under way');
  await until(() => puts() === 1);
  await decide(DEPRECATED_READS, 'usdt', 'mETH', true);
  t.ok(await settledWithin(recordDecisions(DEPRECATED_RECORD, deps), 5000), 'a command that decided meanwhile does not wait for it');
  t.equal(puts(), 2, 'and writes the record itself');
  t.equal((await store.get(DEPRECATED_KEY, 'json') as { collaterals: unknown[] } | null)?.collaterals.length, 1, 'with its decision');
});

/*
 * What an isolate knows of a record is kept by the record, not by the kind
 * that describes it: a kind made anew for every read, as a factory called
 * where the record is read would make one, leaves the record to the check
 * under way, and so does a command through another. The kind is made member
 * by member, since a copy spread from the kind would share whatever the kind
 * held.
 */
t.test('reads and a command through a kind made anew each time leave the record to the one check under way', async t => {
  const { registry, decide } = await fixture(t);
  await decide(DEPRECATED_READS, 'usdt', 'mETH', true);
  const store = MemoryKv({});
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let puts = 0;
  const deferred: Array<Promise<unknown>> = [];
  const deps = {
    db:           registry.db,
    // the namespace takes the first write it is given, the check's, once released
    kv:           bindingOf(store, { put: async (_parameters, write) => { puts += 1; await (puts === 1 ? released.then(write) : write()); } }),
    ttlSeconds:   300,
    staleSeconds: 3600,
    debug:        quietLog,
    defer:        (work: Promise<unknown>) => { deferred.push(work); },
  };
  const anew = (): RecordedKind<CollateralOfComet> => ({
    key:       DEPRECATED_RECORD.key,
    noun:      DEPRECATED_RECORD.noun,
    member:    DEPRECATED_RECORD.member,
    read:      DEPRECATED_RECORD.read,
    keyOf:     DEPRECATED_RECORD.keyOf,
    subjectOf: DEPRECATED_RECORD.subjectOf,
  });

  await Promise.all(Array.from({ length: 8 }, () => markedDecisions(anew(), deps)));
  await until(() => puts === 1);
  t.same([ deferred.length, puts ], [ 1, 1 ], 'eight reads arriving together, each through a kind made anew, check the record once');
  const command = recordDecisions(anew(), deps);
  t.notOk(await settledWithin(command, 300), 'a command through another waits for that check of the same decisions');
  t.equal(puts, 1, 'and writes nothing of its own meanwhile');
  release();
  t.ok(await settledWithin(command, 5000), 'it is done once the check is');
  await Promise.all(deferred);
  t.equal(puts, 1, 'the check having made the one write');
  t.equal((await store.get(DEPRECATED_KEY, 'json') as { collaterals: unknown[] } | null)?.collaterals.length, 1, 'of the decisions');
});
