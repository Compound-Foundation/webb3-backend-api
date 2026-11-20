import t, { Test } from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';
import type { ActiveMarketV1, ActiveSnapshotV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';
import type { CollateralOfComet } from '../../../src/registry/collateral-decision-repository.js';
import { DEPRECATED_RECORD, HIDDEN_RECORD } from '../../../src/registry/collateral-decisions.js';
import type { RecordedKind } from '../../../src/registry/decision-records.js';
import { markedDecisions } from '../../../src/registry/decision-records.js';

import { consoleLines } from '../../util/console.js';
import { executionContext, settledWithin } from '../../util/execution-context.js';
import { MemoryKv } from '../../util/kv.js';
import { quietLog } from '../../util/quiet-log.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { ADMIN_TOKEN, adminTestEnv, failingStatements } from '../../util/test-env.js';

import type { DecisionKindUnderTest } from './decision-scenarios.js';
import { DEPRECATED_COLLATERALS, HIDDEN_COLLATERALS, statementsOf } from './decision-scenarios.js';

import '../../../shim/node-self.js';

/*
 * What the active reads answer about one kind of decision about a collateral
 * of a Comet, through the worker's own entry point in Node: the flag on every
 * collateral of /active and the market reads, by the decisions in force when
 * they answer; ETags that change with the flags they name, and only then; and
 * while the database cannot be reached, the decisions the Worker last
 * recorded, said to be unconfirmed. Then the record those answers come from:
 * every command that decides records the kind's decisions once it has
 * committed, and before it answers, leaving the other kind's record as it
 * is; a read takes them from D1, keeps the record in step, and while D1
 * cannot be reached answers with the record, saying so.
 *
 * Both kinds are read, recorded and answered with alike
 * (decision-records.ts), so the scenarios are written once, over a
 * description of each kind (CollateralReadKind), and each kind runs them
 * from its own file, beside the tests only it has:
 * deprecated-collateral-reads.test.ts and hidden-collateral-reads.test.ts.
 * Where the other kind decides about the same collaterals, a scenario makes
 * its decisions too, so that each kind answers by its own. This module is
 * not a test file, and tap does not run it on its own.
 *
 * Decisions are made through the repository, or through the command where
 * what it records is the point, so nothing here spends the limiter's budget.
 * Every scenario has a database binding and a namespace of its own: what an
 * isolate knows of a record is kept by its namespace, and how often it logs
 * a fallback by its database.
 */
let seed = 0;

type Envelope = { error: { code: string, message: string } };

// matches no statement, so that a database fails only while it is down
const NO_STATEMENT = /^$/;

// a kind of decision as the active reads mark collaterals with it: as the decision scenarios drive it, and its record
type MarkingKind = { decisions: DecisionKindUnderTest, record: RecordedKind<CollateralOfComet> };

type CollateralReadKind = MarkingKind & { other: MarkingKind };

const DEPRECATED_MARKS: MarkingKind = { decisions: DEPRECATED_COLLATERALS, record: DEPRECATED_RECORD };
const HIDDEN_MARKS: MarkingKind     = { decisions: HIDDEN_COLLATERALS, record: HIDDEN_RECORD };

const DEPRECATED_READS: CollateralReadKind = { ...DEPRECATED_MARKS, other: HIDDEN_MARKS };
const HIDDEN_READS: CollateralReadKind     = { ...HIDDEN_MARKS, other: DEPRECATED_MARKS };

function envOf(db: D1Database, kv: KVNamespace, overrides: Partial<Env> = {}): Promise<Env> {
  return adminTestEnv({
    APP_DB:            db,
    kv_registry:       kv,
    MEMORY_CACHE_SEED: `collateral-reads-${seed++}`,
    ...overrides,
  });
}

/*
 * Without an execution context, so the request writes the records an outage
 * reads before it answers, not past the answer: what a request records is
 * there for the request after it.
 */
async function get(env: Env, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return C3Api.fetch(new Request(`https://api.test.local${path}`, { headers }), env);
}

async function json<T>(env: Env, path: string): Promise<T> {
  const response = await get(env, path);
  if (response.status !== 200) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return await response.json() as T;
}

function command(method: string, path: string, body: unknown): Request {
  return new Request(`https://api.test.local${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

// what the reads of an isolate read the decisions with, and where they warn: nowhere, or into `warnings`
function depsOf(db: D1Database, kv: KVNamespace, warnings?: unknown[]) {
  const debug = warnings === undefined ? quietLog : { error: () => {}, warn: (message: unknown) => { warnings.push(message); } };
  return { db, kv, ttlSeconds: 300, staleSeconds: 3600, debug };
}

// what the worker logged, for the length of a test, each line after its level
function captureLogs(t: Test): string[] {
  return consoleLines(t, [ 'error', 'warn' ], { prefixed: true });
}

async function fixture(t: Test) {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const mainnet    = registry.snapshot.networks.find(network => network.chainId === 1)!;
  const market     = (key: string) => mainnet.markets.find(entry => entry.deploymentKey === key)!;
  const collateral = (key: string, symbol: string) => ({
    chainId:      1,
    cometAddress: market(key).contracts.comet!,
    tokenAddress: market(key).collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address,
  });
  const decide = (kind: MarkingKind, key: string, symbol: string, flag: boolean) => {
    const { cometAddress, tokenAddress } = collateral(key, symbol);
    return kind.decisions.set(registry.db, {
      subject: { cometAddress, tokenAddress },
      flag,
      actor:   'test',
      reason:  `decided for a ${kind.decisions.label} read test`,
    });
  };
  return { registry, collateral, decide };
}

// the collaterals an answer flags, as `market/symbol`
function flaggedIn(networks: Array<{ markets: ActiveMarketV1[] }>, flag: string): string[] {
  return networks.flatMap(network => network.markets.flatMap(market => market.collateralAssets
    .filter(asset => (asset as unknown as Record<string, unknown>)[flag] === true)
    .map(asset => `${market.deploymentKey}/${asset.token.symbol}`)));
}

async function recorded(kv: KVNamespace, key: string): Promise<unknown[] | null> {
  return (await kv.get(key, 'json') as { collaterals: unknown[] } | null)?.collaterals ?? null;
}

/*
 * Another binding of a namespace: what another isolate reads and writes the
 * same store through, since an isolate knows the record by its own binding.
 * `put` stands in for its writes, given the write itself to make.
 */
function bindingOf(store: KVNamespace, { put }: { put?: (parameters: unknown[], write: () => Promise<void>) => Promise<void> } = {}): KVNamespace {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'put' && put !== undefined) {
        return (...parameters: unknown[]) => put(parameters, () => (value as (...parameters: unknown[]) => Promise<void>).apply(target, parameters));
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
}

// the flags whose digest differs between two tags of the same answer, each as the tag names it
function changedDigests(before: string, after: string): string[] {
  const digests = (etag: string) => new Map([ ...etag.matchAll(/\+(deprecated|hidden)-([0-9a-f]{16})/g) ].map(match => [ match[1]!, match[2]! ]));
  const [ was, is ] = [ digests(before), digests(after) ];
  return [ ...is.keys() ].filter(name => is.get(name) !== was.get(name));
}

function decisionReadScenarios(kind: CollateralReadKind): void {
  const { other } = kind;
  const { adjective, flag, label } = kind.decisions;

  t.test(`the active reads mark every collateral ${adjective} by the decisions in force, apart from the ${other.decisions.adjective} ones`, async t => {
    const { registry, collateral, decide } = await fixture(t);
    const env = await envOf(registry.db, MemoryKv({}));

    const before = await json<ActiveSnapshotV1>(env, '/registry/v1/active');
    const assets = before.networks.flatMap(network => network.markets.flatMap(market => market.collateralAssets));
    t.ok(assets.length > 0 && assets.every(asset => (asset as unknown as Record<string, unknown>)[flag] === false),
      `no collateral is ${adjective} while nobody has decided`);
    t.same(Object.keys(assets[0]!), [ 'assetIndex', 'token', 'priceFeed', 'isDeprecated', 'isHidden' ],
      'the flags stand beside what the version says, the deprecated one first');
    t.same(
      before.networks.map(network => ({ ...network, markets: network.markets.map(market => ({
        ...market,
        collateralAssets: market.collateralAssets.map(({ isDeprecated: _isDeprecated, isHidden: _isHidden, ...asset }) => asset),
      })) })),
      registry.snapshot.networks,
      'and everything else is the version as it was stored',
    );

    await decide(kind, 'usdt', 'mETH', true);
    await decide(kind, 'usdc', 'weETH', true);
    await decide(other, 'wbtc', 'LBTC', true);
    const after = await json<ActiveSnapshotV1>(env, '/registry/v1/active');
    t.same(flaggedIn(after.networks, flag), [ 'usdc/weETH', 'usdt/mETH' ], `the next answer flags each ${adjective} collateral in its own market`);
    t.same(flaggedIn(after.networks, other.decisions.flag), [ 'wbtc/LBTC' ], `and each ${other.decisions.adjective} one by its own decisions`);

    const markets = await json<{ markets: ActiveMarketV1[] }>(env, '/registry/v1/networks/1/markets');
    t.same(flaggedIn([ markets ], flag), [ 'usdc/weETH', 'usdt/mETH' ], 'and so does the chain\'s market list');
    const usdt = await json<{ market: ActiveMarketV1 }>(env, `/registry/v1/networks/1/markets/${collateral('usdt', 'mETH').cometAddress}`);
    t.same(flaggedIn([ { markets: [ usdt.market ] } ], flag), [ 'usdt/mETH' ], 'and the market itself, its own decisions only');
    t.same(flaggedIn([ await json<{ markets: ActiveMarketV1[] }>(env, '/registry/v1/networks/8453/markets') ], flag), [],
      'while another chain flags nothing');

    const pinned = await json<RegistrySnapshotV1>(env, `/registry/v1/versions/${registry.versionId}`);
    t.same(pinned.networks, registry.snapshot.networks, 'the version read by id is the version as it was imported, without a flag');
  });

  t.test(`a ${adjective} decision changes the tag of every answer whose flags it changes, and of no other`, async t => {
    const { registry, collateral, decide } = await fixture(t);
    const env   = await envOf(registry.db, MemoryKv({}));
    const tag   = async (path: string) => (await get(env, path)).headers.get('etag')!;
    const paths = [
      '/registry/v1/active',
      '/registry/v1/networks/1/markets',
      `/registry/v1/networks/1/markets/${collateral('usdt', 'mETH').cometAddress}`,
      `/registry/v1/networks/1/markets/${collateral('usdc', 'weETH').cometAddress}`,
      '/registry/v1/networks/8453/markets',
      `/registry/v1/versions/${registry.versionId}`,
      '/registry/v1/networks',
    ];
    const first = Object.fromEntries(await Promise.all(paths.map(async path => [ path, await tag(path) ] as const)));
    t.match(first['/registry/v1/active'], new RegExp(`^"v1-r5-snapshot\\+deprecated-[0-9a-f]{16}\\+hidden-[0-9a-f]{16}-${registry.versionId}-[0-9a-f]{64}"$`),
      'the bootstrap tag names the flags it carries beside the version');
    t.equal(first[`/registry/v1/versions/${registry.versionId}`], `"v1-r5-snapshot-${registry.versionId}-${registry.snapshot.registryVersion.checksum}"`,
      'and the version read by id, which carries none, is another representation');

    await decide(kind, 'usdt', 'mETH', true);
    const answered = async (path: string, etag: string) => (await get(env, path, { 'If-None-Match': etag })).status;
    for (const path of paths.slice(0, 3)) {
      t.equal(await answered(path, first[path]!), 200, `${path} sends the body again to a client holding a copy without the flag`);
      const next = await tag(path);
      t.not(next, first[path], 'under a new tag');
      t.equal(await answered(path, next), 304, 'which it then confirms');
      t.equal(await answered(path, `W/${next}`), 304, 'weak or strong');
    }
    for (const path of paths.slice(3)) {
      t.equal(await answered(path, first[path]!), 304, `${path}, which flags nothing the decision changed, still confirms its copy`);
    }
    const decided = await tag('/registry/v1/active');
    t.same(changedDigests(first['/registry/v1/active']!, decided), [ adjective ], `the decision changes the digest of the ${adjective} flags alone`);

    await decide(kind, 'usdt', 'mETH', false);
    t.equal(await tag('/registry/v1/active'), first['/registry/v1/active'], 'taking the decision back is the first answer again, under its tag');
    t.equal(await answered('/registry/v1/active', first['/registry/v1/active']!), 304, 'which confirms the copy made before it');
    await decide(other, 'usdt', 'mETH', true);
    const otherwise = await tag('/registry/v1/active');
    t.same([ otherwise === first['/registry/v1/active'], otherwise === decided ], [ false, false ],
      `and the same collateral ${other.decisions.adjective} rather than ${adjective} is another answer again, under a tag of its own`);
  });

  /*
   * The fallback (cache.ts) answers with the version D1 last named; the flags
   * it marks are the decisions the Worker last recorded, which a read records
   * where the record does not hold them.
   */
  t.test(`during an outage the active reads answer with the ${adjective} decisions last recorded`, async t => {
    const { registry, collateral, decide } = await fixture(t);
    const logs = captureLogs(t);
    let down = false;
    const kv   = MemoryKv({});
    const env  = await envOf(failingStatements(registry.db, NO_STATEMENT, { down: () => down }), kv);
    const mEth = collateral('usdt', 'mETH');

    await decide(kind, 'usdt', 'mETH', true);
    t.equal((await get(env, '/registry/v1/active')).status, 200, 'a read while the database answers caches the version');
    t.same(await recorded(kv, kind.record.key), [ mEth ], `and records the ${adjective} decisions it read`);

    down = true;
    for (const path of [ '/registry/v1/active', '/registry/v1/networks/1/markets', `/registry/v1/networks/1/markets/${mEth.cometAddress}` ]) {
      const response = await get(env, path);
      t.equal(response.status, 200, `${path} answers from the cache`);
      t.match(response.headers.get('x-registry-stale'), /^[0-9]+$/, 'saying how old its answer is');
      t.equal(response.headers.get('cache-control'), 'no-store', 'and that nothing may keep it');
      const body = await response.json() as { networks?: Array<{ markets: ActiveMarketV1[] }>, markets?: ActiveMarketV1[], market?: ActiveMarketV1 };
      t.same(flaggedIn(body.networks ?? [ { markets: body.markets ?? [ body.market! ] } ], flag), [ 'usdt/mETH' ],
        `with the ${adjective} decisions last recorded`);
      t.equal((await get(env, path, { 'If-None-Match': response.headers.get('etag')! })).status, 200, 'and confirms nothing');
    }
    t.ok(logs.includes(`warn: ${label} decisions unreadable; answering with the ones last recorded`), 'the log says where the flags came from');
    t.equal(logs.filter(line => line.includes(`${label} decisions unreadable`)).length, 1, 'once a minute, not once a request');
  });

  /*
   * The record is there for an outage right after the command, before any
   * read has checked it; an environment without a fallback window answers
   * nothing from a record, so its commands keep none.
   */
  t.test(`a ${adjective} decision a command makes is recorded at once, for an outage to answer with`, async t => {
    const { registry, collateral } = await fixture(t);
    captureLogs(t);
    const weEth = collateral('usdc', 'weETH');
    const path  = kind.decisions.path(1, { cometAddress: weEth.cometAddress, tokenAddress: weEth.tokenAddress });

    let down = false;
    const kv  = MemoryKv({});
    const db  = failingStatements(registry.db, NO_STATEMENT, { down: () => down });
    const env = await envOf(db, kv);
    t.same(flaggedIn((await json<ActiveSnapshotV1>(env, '/registry/v1/active')).networks, flag), [], `nothing is ${adjective} at first`);
    t.equal((await C3Api.fetch(command('PATCH', path, { [flag]: true, reason: 'decided by a command' }), env)).status, 200, 'the command commits');

    down = true;
    const response = await get(env, '/registry/v1/active');
    t.equal(response.status, 200, 'an outage right after it is answered');
    t.same(flaggedIn((await response.json() as ActiveSnapshotV1).networks, flag), [ 'usdc/weETH' ],
      'and an outage right after it, before any read, answers with its decision');
    const read = await markedDecisions(kind.record, depsOf(db, kv));
    t.same([ read.recorded, read.decisions.subjects ], [ true, [ weEth ] ], 'as a read of the decisions themselves does, from the record');
    t.ok(read.decisions.has(weEth), 'which marks the collateral in its Comet');
    t.notOk(read.decisions.has({ ...weEth, cometAddress: collateral('usdt', 'weETH').cometAddress }), 'and not in another');

    down = false;
    const windowless = MemoryKv({});
    const reversed = await C3Api.fetch(command('PATCH', path, { [flag]: false, reason: 'taken back by a command' }),
      await envOf(registry.db, windowless, { REGISTRY_STALE_FALLBACK_MAX_S: '0' }));
    t.equal(reversed.status, 200, 'a command without a fallback window commits');
    t.equal(await windowless.get(kind.record.key), null, 'and records nothing');
  });

  t.test(`${adjective} decisions the database does not give are answered from the record, and said to be unconfirmed`, async t => {
    const { registry, decide } = await fixture(t);
    const logs = captureLogs(t);
    const kv = MemoryKv({});
    await decide(kind, 'wbtc', 'LBTC', true);
    await json(await envOf(registry.db, kv), '/registry/v1/active');

    const env = await envOf(failingStatements(registry.db, statementsOf(kind.decisions)), kv);
    const response = await get(env, '/registry/v1/active');
    t.equal(response.status, 200, 'a version the database confirms is answered');
    t.equal(response.headers.get('x-registry-version'), registry.versionId, 'under the version on');
    t.equal(response.headers.get('x-registry-stale'), '0', 'as no older than now, since the version is the one on');
    t.equal(response.headers.get('cache-control'), 'no-store', `but not to be kept, since its ${adjective} flags are as last recorded`);
    t.same(flaggedIn((await response.json() as ActiveSnapshotV1).networks, flag), [ 'wbtc/LBTC' ], 'which they are');
    t.equal((await get(env, '/registry/v1/active', { 'If-None-Match': response.headers.get('etag')! })).status, 200,
      'and such an answer confirms no copy');
    t.ok(logs.includes(`warn: ${label} decisions unreadable; answering with the ones last recorded`), 'the log says the flags came from the record');
  });

  /*
   * Nothing recorded, or a record that is not one, is nothing to answer with,
   * and only a read the version answers waits for the decisions.
   */
  t.test(`without a record to answer with, ${adjective} decisions the database does not give are a 503`, async t => {
    const { registry, collateral, decide } = await fixture(t);
    captureLogs(t);
    await decide(kind, 'wbtc', 'LBTC', true);
    const failing = failingStatements(registry.db, statementsOf(kind.decisions));

    for (const path of [ '/registry/v1/active', '/registry/v1/networks/1/markets', `/registry/v1/networks/1/markets/${collateral('wbtc', 'LBTC').cometAddress}` ]) {
      const response = await get(await envOf(failing, MemoryKv({})), path);
      t.same([ response.status, (await response.json() as Envelope).error.code ], [ 503, 'UPSTREAM_UNAVAILABLE' ],
        `${path}: nothing recorded is nothing to answer with`);
    }
    const garbled = MemoryKv({ seed: { [kind.record.key]: { collaterals: 'not a list' } } });
    t.equal((await get(await envOf(failing, garbled), '/registry/v1/active')).status, 503, 'nor is a record that is not one');
    const refused = await get(await envOf(failing, MemoryKv({})), '/registry/v1/networks/999/markets');
    t.same([ refused.status, (await refused.json() as Envelope).error.code ], [ 404, 'NOT_FOUND' ],
      'while a market read the version refuses is refused as before');

    /*
     * An environment that would rather fail than answer from the cache has no
     * fallback window, so nothing records the decisions and nothing answers
     * with them.
     */
    const kv = MemoryKv({});
    const windowless = { REGISTRY_STALE_FALLBACK_MAX_S: '0' };
    await json(await envOf(registry.db, kv, windowless), '/registry/v1/active');
    t.equal(await kv.get(kind.record.key), null, 'without a window, a read records nothing');
    t.equal((await get(await envOf(failing, kv, windowless), '/registry/v1/active')).status, 503,
      'and decisions the database does not give are a 503 there');
  });

  /*
   * The version selects what a market read asks for before the decisions mark
   * it, so a request the version refuses is refused as it always was, even
   * while the decisions cannot be read and nothing is recorded to answer with:
   * only a request the version answers waits for them.
   */
  t.test(`a market read the version refuses is refused as before, whatever the ${adjective} decisions did`, async t => {
    const { registry } = await fixture(t);
    captureLogs(t);
    const refused = [
      [ '/registry/v1/networks/01/markets',                                              400, 'BAD_REQUEST' ],
      [ '/registry/v1/networks/999/markets',                                             404, 'NOT_FOUND' ],
      [ '/registry/v1/networks/11155111/markets',                                        404, 'NOT_FOUND' ],
      [ '/registry/v1/networks/1/markets/not-an-address',                                400, 'BAD_REQUEST' ],
      [ '/registry/v1/networks/1/markets/0x0000000000000000000000000000000000000001',   404, 'NOT_FOUND' ],
      [ '/registry/v1/networks/0x1/markets/0x0000000000000000000000000000000000000001', 400, 'BAD_REQUEST' ],
    ] as const;
    for (const [ setting, overrides ] of [ [ 'nothing recorded', {} ], [ 'no fallback window', { REGISTRY_STALE_FALLBACK_MAX_S: '0' } ] ] as const) {
      const env = await envOf(failingStatements(registry.db, statementsOf(kind.decisions)), MemoryKv({}), overrides);
      for (const [ path, status, code ] of refused) {
        const response = await get(env, path);
        t.same([ response.status, (await response.json() as Envelope).error.code ], [ status, code ], `${setting}: ${path} is refused`);
      }
      const answered = await get(env, '/registry/v1/networks/1/markets');
      t.same([ answered.status, (await answered.json() as Envelope).error.code ], [ 503, 'UPSTREAM_UNAVAILABLE' ],
        `${setting}: while a read the version answers needs the ${adjective} decisions`);
    }
  });

  /*
   * A command does not leave its record to waitUntil, as a read leaves its
   * check: it answers once the record holds what it committed, so an outage
   * right after it answers with its decision. Each command comes through the
   * worker with an execution context, as in production; without one nothing
   * is handed to waitUntil, and a command that handed its record over would
   * look no different. The other kind's record holds what no decision in
   * force says, so a command that wrote it, or took it away, would be seen to.
   */
  t.test(`a command answers once the record holds its ${adjective} decisions, though it has a waitUntil to leave them to`, async t => {
    const { registry, collateral } = await fixture(t);
    const weEth = collateral('usdc', 'weETH');
    const mEth  = collateral('usdt', 'mETH');
    const kept  = JSON.stringify({ at: '2026-10-01T00:00:00.000Z', collaterals: [ collateral('wbtc', 'LBTC') ] });
    const commands = [
      [ 'PATCH', kind.decisions.path(1, { cometAddress: weEth.cometAddress, tokenAddress: weEth.tokenAddress }),
        { [flag]: true, reason: 'decided by a command' }, [ weEth ] ],
      [ 'POST', kind.decisions.list.apply,
        { reason: 'decided by a list', [kind.decisions.list.key]: [ { ...mEth, [flag]: true } ] }, [ mEth, weEth ] ],
    ] as const;

    for (const [ method, path, body, decisions ] of commands) {
      const store = MemoryKv({});
      await store.put(other.record.key, kept);
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      const env = await envOf(registry.db, bindingOf(store, { put: async (_parameters, write) => { await released; await write(); } }));
      const { context, handed } = executionContext();
      const answer = C3Api.fetch(command(method, path, body), env, context);
      t.notOk(await settledWithin(answer, 300), `${method} ${path} does not answer while the namespace holds the write of the record`);
      t.equal(handed.length, 0, 'and hands nothing to waitUntil');
      release();
      t.equal((await answer).status, 200, 'it answers once the record is written');
      t.same(await recorded(store, kind.record.key), decisions, `with the ${adjective} decisions in force once it committed`);
      t.equal(await store.get(other.record.key), kept, `and leaves the record of the ${other.decisions.adjective} ones alone`);
    }
  });

  t.test(`a read takes the ${adjective} decisions from the database, and from the record while it cannot be reached`, async t => {
    const { registry, collateral, decide } = await fixture(t);
    const warnings: unknown[] = [];
    const kv   = MemoryKv({});
    const mEth = collateral('usdt', 'mETH');
    const unavailable = { name: 'RegistryUnavailable', message: `the ${label} decisions could not be read` };
    await decide(kind, 'usdt', 'mETH', true);

    const read = await markedDecisions(kind.record, depsOf(registry.db, kv, warnings));
    t.same([ read.recorded, read.decisions.subjects ], [ false, [ mEth ] ], 'a read takes the decisions from the database');
    t.same(await recorded(kv, kind.record.key), [ mEth ], 'and records them');

    const unreachable = failingStatements(registry.db, statementsOf(kind.decisions));
    const fallback = await markedDecisions(kind.record, depsOf(unreachable, kv, warnings));
    t.same([ fallback.recorded, fallback.decisions.subjects ], [ true, [ mEth ] ],
      'while the database does not give them, a read answers with the record, and says so');
    await markedDecisions(kind.record, depsOf(unreachable, kv, warnings));
    t.same(warnings, [ `${label} decisions unreadable; answering with the ones last recorded` ],
      'which the log says once a minute, not once a request');

    await t.rejects(markedDecisions(kind.record, depsOf(unreachable, MemoryKv({}))), unavailable,
      'with nothing recorded, there is nothing to answer with');
    await t.rejects(markedDecisions(kind.record, depsOf(unreachable, MemoryKv({ seed: { [kind.record.key]: { collaterals: 'not a list' } } }))),
      unavailable, 'nor with a record that is not one');
    const at = '2026-10-27T09:00:00.000Z';
    const garbled = [
      { at, collaterals: 'not a list' },
      { collaterals: [ mEth ] },
      { at, collaterals: [ { ...mEth, chainId: 0 } ] },
      { at, collaterals: [ { ...mEth, cometAddress: 'usdt' } ] },
      { at, collaterals: [ { ...mEth, tokenAddress: 'mETH' } ] },
    ];
    for (const record of garbled) {
      await t.rejects(markedDecisions(kind.record, depsOf(unreachable, MemoryKv({ seed: { [kind.record.key]: record } }))), unavailable,
        `nor with a record that is not one: ${JSON.stringify(record)}`);
    }
    const otherCase = (address: string) => address.toUpperCase().replace('0X', '0x');
    const checksummed = MemoryKv({ seed: { [kind.record.key]: {
      at, collaterals: [ { ...mEth, cometAddress: otherCase(mEth.cometAddress), tokenAddress: otherCase(mEth.tokenAddress) } ],
    } } });
    t.same((await markedDecisions(kind.record, depsOf(unreachable, checksummed))).decisions.subjects, [ mEth ],
      'while a record that names a collateral in another case names the same one');

    const windowless = { ...depsOf(registry.db, MemoryKv({})), staleSeconds: 0 };
    await markedDecisions(kind.record, windowless);
    t.equal(await windowless.kv.get(kind.record.key), null, 'without a window, a read records nothing');
    await t.rejects(
      markedDecisions(kind.record, { ...windowless, db: unreachable }),
      { name: 'RegistryUnavailable', message: 'the comet registry could not be read' },
      'and decisions the database does not give are unavailable there',
    );
  });
}

export {
  DEPRECATED_READS,
  HIDDEN_READS,
  bindingOf,
  captureLogs,
  decisionReadScenarios,
  depsOf,
  envOf,
  fixture,
  get,
  recorded,
};
