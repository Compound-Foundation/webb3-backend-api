import t from 'tap';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { format } from 'node:util';

import { createTestHarness } from 'wrangler';

import * as Debug from '../../../lib/debug-log.js';

import type { Env } from '../../../entrypoint.js';
import type * as jsonRpc from '../../../lib/json-rpc.js';
import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { cacheDepsOf } from '../../../src/registry/cache.js';
import { proxyTransport } from '../../../src/registry/enrichment.js';
import { runInvocation } from '../../../src/registry/importer.js';
import {
  CreationReader,
  FeedReader,
  replaceMarketOverlay,
  replaceNetworkOverlay,
  validateStoredVersion,
} from '../../../src/registry/admin.js';
import { overlayOfMarket } from '../../../src/registry/overlay.js';
import { gitBlobSha } from '../../../src/registry/source/github.js';
import {
  SUPERSEDED_CHECK,
  createCandidate,
  readSnapshot,
  readUnreviewed,
  readValidationSummary,
  recordValidationResults,
  snapshotChecksum,
  supersedeEarlierAttempts,
} from '../../../src/registry/repository.js';
import { registryStatus } from '../../../src/registry/status.js';
import { cancelRun } from '../../../src/registry/sync.js';

import { applyMigrations } from '../../util/d1.js';
import { interleaved } from '../../util/interleave.js';
import {
  activateSeeded,
  loadRegistrySnapshotFixture,
  overlayOfNetwork,
  seedCandidate,
  validateSeeded,
} from '../../util/registry-fixture.js';

/*
 * The whole import, end to end against real local D1: discovery, the fenced
 * run, per-root checkpoints, chain reads, the inherited overlay, and
 * validation. GitHub and the chain are stubbed from recorded fixtures, so the
 * test exercises the orchestration rather than the network.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

const COMMIT     = 'a34d9b571c833b5d77f052ab8e2dbdbe10df726d';
const REPOSITORY = 'Compound-Foundation/comet';
const USDC_ROOT  = 'deployments/mainnet/usdc/roots.json';
const WETH_ROOT  = 'deployments/mainnet/weth/roots.json';

const snapshot    = loadRegistrySnapshotFixture();
const usdcContent = readFileSync('./tests/fixtures/registry/source/roots/mainnet-usdc.json', 'utf8');
const wethContent = JSON.stringify({
  comet:        '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
  configurator: '0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3',
  rewards:      '0x1B0e765F6224C21223AeA2af16c1C46E38885a40',
});
const recording: { responses: Record<string, string> } =
  JSON.parse(readFileSync('./tests/fixtures/registry/chain/ethereum-mainnet-usdc.json', 'utf8'));

// the reward feed the reviewed overlay names is not one enrichment reads by
// itself, so its decimals are answered here
const REWARD_FEED = snapshot.networks
  .find(network => network.chainId === 1)!.markets
  .find(market => market.deploymentKey === 'usdc')!.rewardAsset!.priceFeed!;

// a chain that confirms every creation block a review states, which overlay-feeds.test.ts holds against one that does not
const blocksConfirmed: CreationReader = async () => [];

function word(value: number): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

// what GitHub gets wrong: the status it answers the ref with, and a tree it says it truncated
type Faults = { commits?: number, truncated?: boolean };

function githubStub(roots: Array<{ path: string, content: string, sha: string }>, faults: Faults = {}) {
  const requests: string[] = [];
  const fetch = async (url: string) => {
    requests.push(url);
    if (url.endsWith(`/commits/main`)) {
      return faults.commits === undefined ? new Response(COMMIT) : new Response('bad gateway', { status: faults.commits });
    }
    if (url.includes('/git/trees/')) {
      return new Response(JSON.stringify({
        truncated: faults.truncated === true,
        tree: roots.map(root => ({ path: root.path, type: 'blob', sha: root.sha, size: root.content.length })),
      }));
    }
    const root = roots.find(candidate => url.endsWith(candidate.path));
    return root === undefined ? new Response('not found', { status: 404 }) : new Response(root.content);
  };
  return { fetch, requests };
}

/*
 * Answers from the recorded mainnet responses. Anything the recording does
 * not cover throws, which is how a market the chain cannot answer for is
 * exercised.
 */
function chainStub() {
  const transport = async (calls: jsonRpc.Call[]) => calls.map(call => {
    const key = call.method === 'eth_chainId' ? 'eth_chainId'
      : call.method === 'eth_getCode' ? `eth_getCode:${call.params[0]}`
      : `eth_call:${call.params[0].to}:${call.params[0].data}`;

    // decimals() of the reward feed named by the overlay
    if (key === `eth_call:${REWARD_FEED.address}:0x313ce567`) {
      return { result: word(REWARD_FEED.decimals) };
    }
    const result = recording.responses[key];
    if (result === undefined) {
      throw new Error(`the chain has no recorded answer for ${key}`);
    }
    return { result };
  });
  return transport;
}

function deps(
  db: D1Database,
  roots: Array<{ path: string, content: string, sha: string }>,
  marketsPerInvocation = 2,
  faults: Faults = {},
) {
  const github = githubStub(roots, faults);
  return {
    db,
    source: { repository: REPOSITORY, ref: 'main', fetch: github.fetch },
    transportFor: () => chainStub(),
    config: {
      leaseSeconds:            900,
      marketsPerInvocation,
      upstreamIntervalSeconds: 86400,
    },
    actor: 'registry-cron',
  };
}

/*
 * The overlay an import inherits comes from the active version, so the
 * fixture is seeded and activated first: this is the second import of a
 * registry, which is the normal case.
 */
async function activateFixture(db: D1Database, source: RegistrySnapshotV1 = snapshot): Promise<string> {
  const { versionId } = await seedCandidate(db, source);
  await activateSeeded(db, versionId);
  return versionId;
}

t.test('an import reads the source, the chain, and the reviewed overlay', async t => {
  const db = await freshDatabase();
  await activateFixture(db);

  const usdcSha = await gitBlobSha(usdcContent);
  const result  = await runInvocation(deps(db, [ { path: USDC_ROOT, content: usdcContent, sha: usdcSha } ]));

  t.equal(result.kind, 'imported', 'the run finishes with a new version');
  t.equal(result.processed, 1, 'having imported one market');

  const candidate = await db.prepare(
    `SELECT * FROM registry_versions WHERE id = ?1`
  ).bind(result.versionId).first<{ status: string, source_commit_sha: string, source_checksum: string, snapshot_checksum: string }>();
  t.equal(candidate?.status, 'validated', 'the candidate validated');
  t.equal(candidate?.source_commit_sha, COMMIT, 'and records the commit it was built from');
  t.match(candidate?.source_checksum, /^[0-9a-f]{64}$/, 'with the checksum of the pinned roots');

  const [ network ] = await readSnapshot(db, result.versionId!);
  t.equal(network?.chainId, 1);
  t.equal(network?.markets.length, 1, 'the candidate holds the imported market');

  const market = network!.markets[0]!;
  const fixture = snapshot.networks.find(entry => entry.chainId === 1)!.markets.find(entry => entry.deploymentKey === 'usdc')!;
  t.equal(market.deploymentKey, 'usdc');
  t.equal(market.baseAsset.token.symbol, 'USDC', 'the base asset comes from the chain');
  t.equal(market.collateralAssets.length, 13, 'with every collateral asset the Comet reports');
  t.same({
    displayName:     market.displayName,
    contractName:    market.contractName,
    slug:            market.slug,
    isInstitutional: market.isInstitutional,
    isDefault:       market.isDefault,
    status:          market.status,
    capabilities:    market.capabilities,
  }, {
    displayName:     fixture.displayName,
    contractName:    fixture.contractName,
    slug:            fixture.slug,
    isInstitutional: fixture.isInstitutional,
    isDefault:       fixture.isDefault,
    status:          fixture.status,
    capabilities:    fixture.capabilities,
  }, 'and the reviewed decisions inherited from the active version');
  t.same(market.rewardAsset?.priceFeed, REWARD_FEED, 'the overlay feed is read for its decimals');

  const run = await db.prepare(`SELECT * FROM sync_runs WHERE id = ?1`).bind(result.runId).first<{
    status: string, outcome: string, completed_count: number, registry_version_id: string,
  }>();
  t.equal(run?.status, 'completed');
  t.equal(run?.completed_count, 1, 'every root is checkpointed as done');
  t.equal(run?.registry_version_id, result.versionId, 'and the run names the version it produced');
});

/*
 * The decisions under a deployment key were made for the Comet it named. A
 * key the source gives another Comet brings that Comet in as a market nobody
 * has reviewed — switched off, with none of the other's decisions — and the
 * log says why the review was not inherited.
 */
t.test('a deployment key the source gives another Comet does not hand it the review', async t => {
  const db = await freshDatabase();
  await activateFixture(db);

  // a Comet the chain answers for as the recording answers for the mainnet usdc one, under weth's key
  const comet  = '0x1111111111111111111111111111111111111111';
  const usdc   = '0xc3d688b66703497daa19211eedff47f25384cdc3';
  const copied = JSON.stringify({ ...JSON.parse(usdcContent), comet });
  const answer = chainStub();
  const warned: unknown[][] = [];
  const result = await runInvocation({
    ...deps(db, [
      { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
      { path: WETH_ROOT, content: copied,      sha: await gitBlobSha(copied) },
    ]),
    transportFor: () => async (calls: jsonRpc.Call[]) => answer(calls.map(call => JSON.parse(
      JSON.stringify(call).replaceAll(comet.slice(2), usdc.slice(2)),
    ))),
    debug: { error: () => {}, warn: (...parameters: unknown[]) => warned.push(parameters) },
  });
  t.equal(result.kind, 'imported', 'the commit imports, and validates');

  const [ network ] = await readSnapshot(db, result.versionId!);
  const weth = network!.markets.find(market => market.deploymentKey === 'weth')!;
  t.same({ comet: weth.contracts.comet, status: weth.status, displayName: weth.displayName, creationBlock: weth.creationBlock }, {
    comet, status: 'disabled', displayName: 'weth', creationBlock: 0,
  }, 'the key now names the new Comet, switched off, with none of the old one\'s decisions');
  t.same((await readUnreviewed(db, result.versionId!)).markets, [ '1/weth' ], 'as a market nobody has reviewed');
  t.equal(network!.markets.find(market => market.deploymentKey === 'usdc')!.status, 'enabled',
    'while a Comet still under its own key keeps its review');
  t.same(warned.filter(([ message ]) => String(message).startsWith('registry overlay')), [ [
    'registry overlay not inherited: the deployment key names another Comet',
    { market: '1/weth', reviewedFor: '0xa17581a9e3356d9a858b789d68b4d866e593ae94', comet },
  ] ], 'and the log says why');

  /*
   * The version validated by itself, and switching it on would stop serving
   * the old weth Comet and every market the commit no longer has: the status
   * says so before anybody does.
   */
  const env    = await server.getWorker<Env>().getEnv();
  const status = await registryStatus(env, cacheDepsOf(env));
  t.same(status.candidates.validated.map(({ versionId, unserved }) => ({ versionId, unserved })), [ {
    versionId: result.versionId,
    unserved:  [ '1/usdt', '1/wbtc', '1/weth', '8453/aero', '534352/usdc' ],
  } ], 'the status names every market of the active version it would stop serving');
  t.ok(status.alerts.includes('candidate-drops-markets'), 'and raises it');
});

t.test('an already imported commit is a no-change outcome', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const usdcSha = await gitBlobSha(usdcContent);
  const roots   = [ { path: USDC_ROOT, content: usdcContent, sha: usdcSha } ];

  const first = await runInvocation(deps(db, roots));
  t.equal(first.kind, 'imported');

  // discovery is bounded, so the next invocation does not even ask upstream
  const idle = await runInvocation(deps(db, roots));
  t.equal(idle.kind, 'idle', 'nothing is due');
  t.equal(idle.reason, 'upstream was checked recently');

  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1`).bind('2020-01-01T00:00:00.000Z').run();
  const unchanged = await runInvocation(deps(db, roots));
  t.equal(unchanged.kind, 'unchanged', 'the same commit is not imported twice');
  t.equal(unchanged.versionId, first.versionId, 'the existing version is reported instead');
});

t.test('an import continues across invocations', async t => {
  const db = await freshDatabase();
  await activateFixture(db);

  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];
  // one market per invocation, as the Cron configuration bounds it
  const first = await runInvocation(deps(db, roots, 1));
  t.equal(first.kind, 'running', 'the run stays open while roots remain');
  t.equal(first.processed, 1, 'and only the configured number of markets is imported');

  const held = await db.prepare(`SELECT lease_owner FROM sync_runs WHERE id = ?1`).bind(first.runId)
    .first<string | null>('lease_owner');
  t.equal(held, null, 'the lease is released, so the next invocation continues at once');

  const second = await runInvocation(deps(db, roots, 1));
  t.equal(second.runId, first.runId, 'the next invocation resumes the same run');
  t.equal(second.versionId, first.versionId, 'and the same candidate');

  const items = await db.prepare(
    `SELECT root_path, status, attempts, last_error FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`
  ).bind(first.runId).all<{ root_path: string, status: string, attempts: number, last_error: string | null }>();
  t.same(
    (items.results ?? []).map(item => [ item.root_path, item.status ]),
    [ [ USDC_ROOT, 'completed' ], [ WETH_ROOT, 'failed' ] ],
    'the market the chain could not answer for is checkpointed as failed',
  );
  const failure = (items.results ?? []).find(item => item.root_path === WETH_ROOT)?.last_error;
  t.match(failure, /^CHAIN_REQUEST_FAILED: /, 'its diagnostic is classified by what went wrong');
  t.notMatch(failure, /recorded answer/, 'and carries no upstream message');
});

t.test('a root that never imports cannot produce a validated version', async t => {
  const db = await freshDatabase();
  await activateFixture(db);

  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];

  /*
   * The chain cannot answer for weth, so that root fails every attempt. Once
   * it exhausts them it stops being outstanding work, and the run finishes —
   * but the candidate is missing a market and must not validate.
   */
  let result = await runInvocation(deps(db, roots, 2));
  for (let invocation = 0; invocation < 10 && result.kind === 'running'; invocation++) {
    result = await runInvocation(deps(db, roots, 2));
  }

  t.equal(result.kind, 'invalid', 'the run ends, and its candidate is invalid');
  const version = await db.prepare(`SELECT status FROM registry_versions WHERE id = ?1`)
    .bind(result.versionId).first<string>('status');
  t.equal(version, 'invalid', 'and the candidate is invalid, not validated');

  const failed = await db.prepare(
    `SELECT check_name, details FROM validation_results
     WHERE registry_version_id = ?1 AND passed = 0 AND check_name = 'all-roots-imported'`
  ).bind(result.versionId).first<{ check_name: string, details: string }>();
  t.ok(failed, 'the diagnostic names the incomplete import');
  t.same(JSON.parse(failed?.details ?? '{}'), { expected: 2, imported: 1, missing: [ 'mainnet/weth' ] },
    'and says which roots never made it');

  t.equal(
    await db.prepare(`SELECT COUNT(*) AS n FROM markets WHERE registry_version_id = ?1`)
      .bind(result.versionId).first<number>('n'),
    1,
    'the market that did import is kept for review',
  );

  // an attempt that gave a root up is tried again, so its commit is not one discovery rejects
  const env    = await server.getWorker<Env>().getEnv();
  const status = await registryStatus(env, cacheDepsOf(env));
  t.match(status.sync.lastRun, { status: 'failed', registryVersionId: result.versionId },
    'the status names the failed run, with its version');
  t.ok(status.alerts.includes('last-sync-failed'), 'and raises it');
  t.notOk(status.alerts.includes('commit-rejected'), 'but not the commit as rejected');
});

/*
 * A market no version has reviewed is imported all the same. Its rows exist,
 * so they can be reviewed in place, but it is disabled with every capability
 * off until someone decides otherwise — and it does not fail the commit it
 * arrived with, which refusing it would.
 */
t.test('a market nobody has reviewed is imported, but not served', async t => {
  const db = await freshDatabase();

  /*
   * An active version that has never seen the usdc deployment, so the source
   * adds it: the same thing a new market in the Comet repository looks like.
   */
  await activateFixture(db, {
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets
        .filter(market => market.deploymentKey !== 'usdc')
        .map(market => market.deploymentKey === 'weth' ? { ...market, isDefault: true } : market),
    }),
  });

  const result = await runInvocation(deps(db, [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ]));
  t.equal(result.kind, 'invalid', 'this source holds nothing but the new market, so there is no default to validate');

  const market = await db.prepare(
    `SELECT deployment_key, status, is_default, reviewed, display_name,
            rewards_enabled, account_rewards_enabled, transaction_history_enabled
     FROM markets WHERE registry_version_id = ?1`
  ).bind(result.versionId).first<Record<string, unknown>>();
  t.same(market, {
    deployment_key:              'usdc',
    status:                      'disabled',
    is_default:                  0,
    reviewed:                    0,
    display_name:                'usdc',
    rewards_enabled:             0,
    account_rewards_enabled:     0,
    transaction_history_enabled: 0,
  }, 'the new market is imported disabled, named by its deployment key, with every capability off');

  const network = await db.prepare(
    `SELECT reviewed, display_name FROM registry_networks WHERE registry_version_id = ?1`
  ).bind(result.versionId).first<{ reviewed: number, display_name: string }>();
  t.same(network, { reviewed: 1, display_name: 'Ethereum' }, 'its network keeps the decisions the active version made');

  /*
   * The unreviewed market contributes no failure of its own: what this
   * version lacks is a default, which only a reviewed market can be. With the
   * rest of the source beside it, the commit would validate.
   */
  const summary = await readValidationSummary(db, result.versionId!);
  t.same(summary.checks.filter(check => !check.passed).map(check => check.name), [ 'single-default-market' ],
    'nothing about the unreviewed market fails');
});

/*
 * The first import of a registry, which is the one case where nothing can be
 * inherited: there is no active version to clone an overlay from. Every market
 * is imported unreviewed, and the run leaves the candidate open, because a
 * version of nothing but unreviewed markets could only ever end invalid.
 */
t.test('the first import of a registry is held for review, then reviewed in place', async t => {
  const db    = await freshDatabase();
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  const imported = await runInvocation(deps(db, roots));
  t.equal(imported.kind, 'held', 'every root is imported, and the candidate is held for review');
  t.match(imported.reason, /^every root is imported; the candidate is held for review; \d+ of its checks failed$/,
    'which is what its answer says');

  const versionId = imported.versionId!;
  const status    = async () => db.prepare(`SELECT status FROM registry_versions WHERE id = ?1`)
    .bind(versionId).first<string>('status');
  t.equal(await status(), 'importing', 'so it stays open, where its rows can still be reviewed');
  t.same(await readUnreviewed(db, versionId), { networks: [ 1 ], markets: [ '1/usdc' ] },
    'and it says what is left to review');

  /*
   * Until discovery is due, a request has nothing to start and names no
   * candidate, even one the hourly job has just held: an operator finds that
   * one through the status (REGISTRY_RUNBOOK.md, "If the hourly job got there
   * first").
   */
  const early = await runInvocation(deps(db, roots), { requestedBy: 'test-admin' });
  t.equal(early.kind, 'idle', 'a request within the interval has nothing to do');
  t.equal(early.reason, 'upstream was checked recently');
  t.equal(early.versionId, undefined, 'and names no candidate');

  /*
   * Once discovery is due again, the same commit is found with a candidate
   * already importing. Starting a new attempt over it would throw away the
   * review in progress, so discovery leaves it alone.
   */
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1`).bind('2020-01-01T00:00:00.000Z').run();
  const again = await runInvocation(deps(db, roots));
  t.equal(again.kind, 'idle', 'a later sync leaves a held candidate alone');
  t.match(again.reason, /held for review/, 'and says why');
  t.equal(again.versionId, versionId, 'naming the candidate it is waiting on');

  /*
   * That was a check of the source like any other, and the interval starts
   * again from it: while the candidate is held, the hourly job checks the
   * source once a day, and a request between two of its checks names nothing.
   */
  const after = await runInvocation(deps(db, roots), { requestedBy: 'test-admin' });
  t.equal(after.reason, 'upstream was checked recently', 'the check the job made starts the interval again');
  t.equal(after.versionId, undefined, 'so a request after it names no candidate either');

  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const usdc    = mainnet.markets.find(market => market.deploymentKey === 'usdc')!;
  const noFeeds: FeedReader = async () => new Map();

  await replaceNetworkOverlay(db, {
    versionId,
    chainId: 1,
    actor:   'test-admin',
    reason:  'bootstrap: review ethereum mainnet',
    overlay: overlayOfNetwork(mainnet),
  }, noFeeds);
  const reviewed = await replaceMarketOverlay(db, {
    versionId,
    chainId:       1,
    deploymentKey: 'usdc',
    actor:         'test-admin',
    reason:        'bootstrap: review the mainnet usdc market',
    overlay:       overlayOfMarket(usdc),
  }, async () => new Map([ [ REWARD_FEED.address, REWARD_FEED ] ]), blocksConfirmed);
  t.equal(reviewed.changed, true, 'the review is applied to the rows the import wrote');
  t.same(await readUnreviewed(db, versionId), { networks: [], markets: [] }, 'and nothing is left unreviewed');

  const validated = await validateStoredVersion(db, versionId);
  t.equal(validated.version.status, 'validated', 'so the first version of the registry validates');

  const [ stored ] = await readSnapshot(db, versionId);
  t.same({
    displayName:  stored?.markets[0]?.displayName,
    contractName: stored?.markets[0]?.contractName,
    isDefault:    stored?.markets[0]?.isDefault,
    capabilities: stored?.markets[0]?.capabilities,
  }, {
    displayName:  usdc.displayName,
    contractName: usdc.contractName,
    isDefault:    usdc.isDefault,
    capabilities: usdc.capabilities,
  }, 'carrying the decisions that were reviewed for it');
});

/*
 * A candidate that is importing means one of two things, and they need
 * opposite answers: nobody is working on it and it is waiting for review, or
 * another invocation is importing into it right now. Telling the second one
 * to "validate it or force a new attempt" would invite an operator to
 * restart a run that is in progress.
 */
t.test('a candidate another invocation is importing is not one held for review', async t => {
  const db    = await freshDatabase();
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  const imported  = await runInvocation(deps(db, roots));
  const versionId = imported.versionId!;
  t.equal(imported.kind, 'held', 'the first import of a registry is held');
  t.ok(imported.kind === 'held' && imported.checksFailed > 0, 'and says how many of its checks failed');
  t.match(imported.reason, /checks failed/, 'so an operator is not told only that it completed');

  // another invocation, importing into that same candidate, with a live lease
  const runId = randomUUID();
  await db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, registry_version_id, trigger_kind,
       status, lease_owner, lease_expires_at, expected_count, started_at
     ) VALUES (?1, ?2, 'main', ?3, 'scheduled', 'running', ?4, ?5, 1, ?6)`
  ).bind(
    runId, COMMIT, versionId, randomUUID(),
    new Date(Date.now() + 900_000).toISOString(), new Date().toISOString(),
  ).run();

  /*
   * Whether discovery is due does not matter, and the source is not asked
   * for a commit only for the one running slot to refuse it: the run that
   * holds the lease is what decides the answer.
   */
  const asked    = deps(db, roots);
  const requests: string[] = [];
  const fetch    = asked.source.fetch;
  asked.source.fetch = async (url: string) => {
    requests.push(url);
    return fetch(url);
  };

  await t.rejects(
    runInvocation(asked, { requestedBy: 'test-admin' }),
    { code: 'SYNC_ALREADY_RUNNING' },
    'a person who asks hears that a sync is running, not that the candidate awaits review',
  );
  const scheduled = await runInvocation(asked);
  t.same([ scheduled.kind, scheduled.runId, scheduled.versionId ], [ 'idle', runId, versionId ],
    'the schedule has nothing to do this hour, and names the run that is importing');
  t.same(requests, [], 'and neither of them asked the source anything');
});

/*
 * A review happens in place, so a candidate that ends invalid is frozen with
 * the reviews in it. Rebuilding the same source must not mean reviewing every
 * market again.
 */
t.test('a new attempt at the same commit inherits what was reviewed for the last one', async t => {
  const db    = await freshDatabase();
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  const first  = await runInvocation(deps(db, roots));
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  await replaceNetworkOverlay(db, {
    versionId: first.versionId!,
    chainId:   1,
    actor:     'test-admin',
    reason:    'reviewed for the attempt that is about to fail',
    overlay:   overlayOfNetwork(mainnet),
  }, async () => new Map());

  // validated before the market was reviewed: no default market, so invalid
  const failed = await validateStoredVersion(db, first.versionId!);
  t.equal(failed.version.status, 'invalid');

  const next = await runInvocation(deps(db, roots), { forceNewAttempt: true, reason: 'rebuild after review' });
  t.not(next.versionId, first.versionId, 'a new attempt is a new candidate');

  const [ network ] = await readSnapshot(db, next.versionId!);
  t.equal(network?.displayName, mainnet.displayName, 'which carries the network the previous attempt reviewed');
  t.same(await readUnreviewed(db, next.versionId!), { networks: [], markets: [ '1/usdc' ] },
    'and still lists the market nobody reviewed');
});

/*
 * An import that is not finished answers with how far it has got. Without
 * that, a resumable import looks erratic: two invocations of the same run
 * report different counts of markets processed, and nothing in the answer
 * says how much of the source is left.
 */
t.test('an unfinished import says how many roots are imported and how many are left', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];

  const first = await runInvocation(deps(db, roots, 1));
  t.equal(first.kind, 'running', 'one root of two leaves the run open');
  t.same(
    { expected: first.expected, completed: first.completed, outstanding: first.outstanding },
    { expected: 2, completed: 1, outstanding: 1 },
    'and the answer says what the commit has, what is imported, and what is still to attempt',
  );

  /*
   * The second root is one the chain cannot answer for, so it is attempted
   * and stays outstanding: the counts, not the status, are what show that
   * the invocation made no progress.
   */
  const second = await runInvocation(deps(db, roots, 1));
  t.equal(second.kind, 'running');
  t.same(
    { expected: second.expected, completed: second.completed, outstanding: second.outstanding },
    { expected: 2, completed: 1, outstanding: 1 },
    'a root that failed is still outstanding, and nothing new is imported',
  );
});

/*
 * The five attempts a root gets are for the root being wrong. An invocation
 * that ran out of what a Worker is given fails every root it has left at
 * once, and those failures say nothing about them.
 */
t.test('an interrupted invocation does not spend the budget of the roots it never read', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];

  const attemptsOf = async (runId: string) => {
    const rows = await db.prepare(
      `SELECT root_path, attempts, status FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`
    ).bind(runId).all<{ root_path: string, attempts: number, status: string }>();
    return Object.fromEntries((rows.results ?? []).map(row => [ row.root_path, row.attempts ]));
  };

  const first = await runInvocation(deps(db, roots, 2));
  t.equal(first.kind, 'running');
  t.same(await attemptsOf(first.runId!), { [USDC_ROOT]: 1, [WETH_ROOT]: 0 },
    'the root the chain did not answer for is back where it started');

  /*
   * Five more invocations. If the failures were spending attempts, the root
   * would be abandoned and the run would end; it does not, because every one
   * of those invocations imported nothing new and therefore... spends them.
   */
  let last = first;
  for (let invocation = 0; invocation < 5; invocation++) {
    last = await runInvocation(deps(db, roots, 2));
  }
  t.equal(last.kind, 'invalid', 'an invocation that imports nothing does spend them, so the run ends');
  t.same(await attemptsOf(first.runId!), { [USDC_ROOT]: 1, [WETH_ROOT]: 5 },
    'and the root that never answered is abandoned after its five attempts');
});

/*
 * A root whose content is not what the tree names is the source being wrong
 * about that root, not a carrier that did not answer: it fails alone, the
 * import goes on with the others, and the attempt is spent even after a root
 * imported. Weth is the one tampered, because the chain answers only for usdc.
 */
t.test('a root whose content does not match the tree fails alone, and spends an attempt', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: `${wethContent} `, sha: await gitBlobSha(wethContent) },
  ];

  const result = await runInvocation(deps(db, roots, 2));
  t.same([ result.kind, result.processed ], [ 'running', 2 ], 'the invocation attempts both roots, and goes on');

  const items = await db.prepare(
    `SELECT deployment_key, status, attempts, last_error FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`
  ).bind(result.runId).all<{ deployment_key: string, status: string, attempts: number, last_error: string | null }>();
  const [ usdc, weth ] = items.results ?? [];
  t.same([ usdc?.status, usdc?.attempts ], [ 'completed', 1 ], 'usdc is imported');
  t.same([ weth?.status, weth?.attempts ], [ 'failed', 1 ], 'weth fails, having spent its attempt');
  t.match(weth?.last_error, /^SOURCE_BLOB_MISMATCH: /, 'and says why');
});

// a database whose batch committing the second root fails with `error`, writing none of it, and answers the rest
function failingSecondCommit(db: D1Database, error: Error): D1Database {
  let commits = 0;
  let failing = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'prepare') {
        return (sql: string) => {
          if (/completed_count = completed_count \+ 1/.test(sql)) {
            commits += 1;
            failing  = commits === 2;
          }
          return target.prepare(sql);
        };
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (failing) {
            failing = false;
            throw error;
          }
          return target.batch(statements);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as D1Database;
}

/*
 * The database can fail a root's commit with nothing wrong with the root:
 * D1 restarts under it to update its code, say. The root then says that the
 * database did not answer, not that a fault interrupted the import, and
 * spends its attempt all the same, unless the connection to the database was
 * lost after the invocation imported a market. A fault is still a fault, and
 * spends its attempt, even one that names a timeout setting.
 */
t.test('a root the database failed says so, and spends its attempt unless only the connection was lost', async t => {
  const sha   = await gitBlobSha(usdcContent);
  // usdc's content again, which the chain answers for, imported after usdc as a market nobody has reviewed
  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha },
    { path: 'deployments/mainnet/usds/roots.json', content: usdcContent, sha },
  ];

  for (const [ error, attempts, lastError ] of [
    [ new Error('D1_ERROR: D1 DB reset because its code was updated.'), 1, 'the database did not answer' ],
    [ new Error('D1_ERROR: D1 DB is overloaded. Too many requests queued.'), 1, 'the database did not answer' ],
    [ new Error('D1_ERROR: Network connection lost.'), 0, 'the database did not answer' ],
    [ new Error(`D1_ERROR: Can't read from request stream because client disconnected.`), 1, 'the database did not answer' ],
    [ new Error('D1_ERROR: UNIQUE constraint failed: markets.id: SQLITE_CONSTRAINT'), 1, 'an unexpected error interrupted the import' ],
    [ new TypeError(`Cannot read properties of undefined (reading 'timeoutMs')`), 1, 'an unexpected error interrupted the import' ],
  ] as const) {
    const db = await freshDatabase();
    await activateFixture(db);

    const result = await runInvocation({ ...deps(db, roots), db: failingSecondCommit(db, error) });
    t.same([ result.kind, result.processed ], [ 'running', 2 ], `${error.message}: the invocation goes on past the root`);

    const items = await db.prepare(
      `SELECT deployment_key, status, attempts, last_error FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`
    ).bind(result.runId).all();
    t.same(items.results, [
      { deployment_key: 'usdc', status: 'completed', attempts: 1, last_error: null },
      { deployment_key: 'usds', status: 'failed', attempts, last_error: lastError },
    ], `the root it failed records ${attempts === 0 ? 'no attempt' : 'its attempt'}, and why`);
    t.equal(
      await db.prepare(`SELECT last_error FROM sync_runs WHERE id = ?1`).bind(result.runId).first<string | null>('last_error'),
      lastError,
      'which the run reports',
    );
  }
});

/*
 * A run's commit, its attempt and whether it holds the candidate are decided
 * when the run is created. An invocation that continues one cannot honour a
 * request to change any of them, and must not look as though it did.
 */
t.test('a request that continues a run refuses what only a new run could do', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];

  const started = await runInvocation(deps(db, roots, 1));
  t.equal(started.kind, 'running', 'a run is in progress');

  for (const request of [
    { forceNewAttempt: true, reason: 'rebuild' },
    { holdForReview: true,   reason: 'hold it' },
    { sourceCommitSha: 'b'.repeat(40), reason: 'that commit' },
  ]) {
    await t.rejects(
      runInvocation(deps(db, roots, 1), request),
      { code: 'SYNC_ALREADY_RUNNING' },
      `${Object.keys(request)[0]} is refused while a run is in progress`,
    );
  }

  const continued = await runInvocation(deps(db, roots, 1));
  t.equal(continued.runId, started.runId, 'and the run is still there to continue, with its lease free');
  t.equal(continued.expected, 2);

  /*
   * The refusal must not disturb a run that is being imported right now. An
   * invocation whose lease has not expired owns its fence; taking that lease
   * to decide whether to refuse would make the running invocation lose the
   * market it is in the middle of importing.
   */
  const owner   = randomUUID();
  const expires = new Date(Date.now() + 900_000).toISOString();
  await db.prepare(
    `UPDATE sync_runs SET lease_owner = ?1, lease_expires_at = ?2 WHERE id = ?3`
  ).bind(owner, expires, started.runId!).run();

  await t.rejects(
    runInvocation(deps(db, roots, 1), { forceNewAttempt: true, reason: 'rebuild' }),
    { code: 'SYNC_ALREADY_RUNNING' },
    'a request for a new run is refused while one is being imported',
  );

  const fence = await db.prepare(`SELECT lease_owner, lease_expires_at FROM sync_runs WHERE id = ?1`)
    .bind(started.runId!).first<{ lease_owner: string, lease_expires_at: string }>();
  t.same(fence, { lease_owner: owner, lease_expires_at: expires },
    'and the invocation that holds the run keeps its fence');
});

/*
 * Only the newest attempt of a commit is ever finished. A draft an earlier
 * attempt left importing is closed the moment a newer attempt replaces it,
 * with a failed check that says so — otherwise it stays open forever, is
 * listed as work to review, and is what discovery stops at.
 */
const statusOf = async (db: D1Database, versionId: string) => db.prepare(
  `SELECT status FROM registry_versions WHERE id = ?1`
).bind(versionId).first<string>('status');

const supersededCheckOf = async (db: D1Database, versionId: string) => db.prepare(
  `SELECT check_name, passed, details FROM validation_results
   WHERE registry_version_id = ?1 AND check_name = ?2`
).bind(versionId, SUPERSEDED_CHECK).first<{ check_name: string, passed: number, details: string }>();

t.test('a new attempt closes the draft it replaces', async t => {
  const db    = await freshDatabase();
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  const first = await runInvocation(deps(db, roots));
  t.equal(first.kind, 'held', 'the first import of a registry is held for review');
  t.equal(await statusOf(db, first.versionId!), 'importing');

  const second = await runInvocation(deps(db, roots), { forceNewAttempt: true, reason: 'rebuild' });
  t.not(second.versionId, first.versionId, 'a forced attempt is a new candidate');

  t.equal(await statusOf(db, first.versionId!), 'invalid', 'and the draft it replaced is closed');
  const check = await supersededCheckOf(db, first.versionId!);
  t.equal(check?.passed, 0, 'by a failed check');
  t.same(JSON.parse(check!.details), { supersededBy: second.versionId, attempt: 2 },
    'that names the attempt which replaced it, once that attempt has every root');
});

/*
 * The state an environment is left in by attempts made before drafts were
 * closed: a newer attempt validated, older ones still importing. Discovery
 * used to find the newest of those drafts below the validated attempt, call
 * it held for review, and stop there every day; it now closes what was
 * replaced and sees the commit as imported.
 */
t.test('discovery closes the drafts a validated attempt replaced', async t => {
  const db = await freshDatabase();

  const make = (attempt: number) => createCandidate(db, {
    repository:     REPOSITORY,
    commitSha:      COMMIT,
    sourceChecksum: 'a'.repeat(64),
    attempt,
    createdBy:      'test-seed',
  });
  const stale   = [ await make(1), await make(2) ];
  const current = await make(3);
  await validateSeeded(db, current.id);

  const roots  = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];
  const result = await runInvocation(deps(db, roots));
  t.equal(result.kind, 'unchanged', 'the commit is recognised as imported, not as held for review');
  t.equal(result.versionId, current.id);

  for (const draft of stale) {
    t.equal(await statusOf(db, draft.id), 'invalid', `attempt ${draft.attempt} is closed`);
    t.same(JSON.parse((await supersededCheckOf(db, draft.id))!.details), { supersededBy: current.id, attempt: 3 });
  }
  t.equal(await statusOf(db, current.id), 'validated', 'and the attempt that replaced them is untouched');
});

/*
 * The other order: a draft of the commit opened after one of its attempts
 * validated, as describing a market does over the version that is on. That
 * draft is under review, so a sync names it as held instead of answering
 * that the commit is imported.
 */
t.test('a draft newer than the attempt that validated is answered as held', async t => {
  const db = await freshDatabase();

  const make = (attempt: number) => createCandidate(db, {
    repository: REPOSITORY, commitSha: COMMIT, sourceChecksum: 'a'.repeat(64), attempt, createdBy: 'test-seed',
  });
  const validated = await make(1);
  await validateSeeded(db, validated.id);
  const draft = await make(2);

  const roots     = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];
  const discovery = await runInvocation(deps(db, roots));
  t.same([ discovery.kind, discovery.versionId ], [ 'idle', draft.id ],
    'discovery names the draft, not the version that validated');
  t.match(discovery.reason, /held for review/);

  const held = await runInvocation(deps(db, roots), { holdForReview: true, reason: 'review' });
  t.same([ held.kind, held.versionId ], [ 'idle', draft.id ],
    'and so does a request that holds without forcing an attempt');
  t.equal(await statusOf(db, draft.id), 'importing', 'the draft stays open');
});

t.test('closing a draft twice is not an error', async t => {
  const db    = await freshDatabase();
  const draft = await createCandidate(db, {
    repository: REPOSITORY, commitSha: COMMIT, sourceChecksum: 'a'.repeat(64), attempt: 1, createdBy: 'test-seed',
  });
  const newer = await createCandidate(db, {
    repository: REPOSITORY, commitSha: COMMIT, sourceChecksum: 'a'.repeat(64), attempt: 2, createdBy: 'test-seed',
  });

  t.same(await supersedeEarlierAttempts(db, newer), [ draft.id ], 'the first call closes it');
  t.same(await supersedeEarlierAttempts(db, newer), [], 'a second call closes nothing, and does not fail');
  const checks = await db.prepare(
    `SELECT COUNT(*) AS n FROM validation_results WHERE registry_version_id = ?1`
  ).bind(draft.id).first<number>('n');
  t.equal(checks, 1, 'and the failed check is recorded once');
  t.equal(await statusOf(db, newer.id), 'importing', 'the replacing version is never closed');
});

/*
 * A draft keeps telling an operator what was wrong with it. Closing it adds
 * one failed check to its latest validation attempt; a new attempt holding
 * only that check would hide everything that had failed before.
 */
t.test('a closed draft keeps reporting what had failed on it', async t => {
  const db    = await freshDatabase();
  const draft = await createCandidate(db, {
    repository: REPOSITORY, commitSha: COMMIT, sourceChecksum: 'a'.repeat(64), attempt: 1, createdBy: 'test-seed',
  });
  await recordValidationResults(db, draft.id, 1, [
    { check_name: 'all-roots-imported', scope: 'global', passed: 0, details: { expected: 29, imported: 28 } },
    { check_name: 'single-default-market', scope: 'global', passed: 1 },
  ]);
  const newer = await createCandidate(db, {
    repository: REPOSITORY, commitSha: COMMIT, sourceChecksum: 'a'.repeat(64), attempt: 2, createdBy: 'test-seed',
  });
  await supersedeEarlierAttempts(db, newer);

  const summary = await readValidationSummary(db, draft.id) as {
    attempt: number, checks: Array<{ name: string, passed: boolean }>,
  };
  t.equal(summary.attempt, 1, 'the latest attempt is still the one the draft was validated in');
  t.same(
    summary.checks.filter(check => !check.passed).map(check => check.name).sort(),
    [ 'all-roots-imported', SUPERSEDED_CHECK ].sort(),
    'and it reports both what failed before and why the draft was closed',
  );
});

/*
 * Reviews are inherited between attempts of one commit, not across commits.
 * A draft of a commit the tracked ref has moved past may hold review work
 * nothing else carries, so importing the new commit leaves it open: it is for
 * an operator to validate or replace, and the status keeps saying so.
 */
t.test('a draft of a commit the ref moved past stays open', async t => {
  const db       = await freshDatabase();
  const previous = await createCandidate(db, {
    repository: REPOSITORY, commitSha: 'c'.repeat(40), sourceChecksum: 'a'.repeat(64), attempt: 1, createdBy: 'test-seed',
  });

  const roots    = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];
  const imported = await runInvocation(deps(db, roots));
  t.ok(imported.versionId, 'the current commit is imported');
  t.equal(await statusOf(db, previous.id), 'importing', 'and the draft of the earlier commit is left as it was');
});

/*
 * A forced attempt replaces the draft before it only once it has succeeded.
 * Closing the draft when the new attempt was merely created would leave
 * nothing to validate if that attempt then failed.
 */
t.test('a draft stays open when the attempt meant to replace it fails', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const usdcOnly = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];
  const withWeth = [ ...usdcOnly, { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) } ];

  const draft = await runInvocation(deps(db, usdcOnly), { holdForReview: true, reason: 'review the new market' });
  t.equal(draft.kind, 'held', 'a complete draft is held for review');

  // a forced attempt whose second root the chain never answers for
  let attempt = await runInvocation(deps(db, withWeth, 2), { forceNewAttempt: true, reason: 'rebuild' });
  t.equal(await statusOf(db, draft.versionId!), 'importing', 'the draft stays open while the new attempt runs');
  for (let invocation = 0; invocation < 6 && attempt.kind === 'running'; invocation++) {
    attempt = await runInvocation(deps(db, withWeth, 2));
  }
  t.equal(attempt.kind, 'invalid', 'the new attempt fails once its last root runs out of attempts');
  t.equal(await statusOf(db, attempt.versionId!), 'invalid');

  t.equal(await statusOf(db, draft.versionId!), 'importing', 'and the draft it was meant to replace is still open');
  t.equal(await supersededCheckOf(db, draft.versionId!), null, 'with nothing recorded against it');
});

/*
 * The first import is held whatever it brought in, so one that gave a root up
 * ends as one with every root does: its run completed, its draft open for
 * review. What tells the two apart is the run's count of roots, which the
 * status shows beside the draft, and an operator checks it before using the
 * draft (REGISTRY_RUNBOOK.md, "If the hourly job got there first"). A new
 * attempt that imports every root then takes the incomplete draft's place.
 */
t.test('a first import that gives a root up is held all the same, and the status says so', async t => {
  const db       = await freshDatabase();
  const usdcOnly = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];
  const withWeth = [ ...usdcOnly, { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) } ];

  // the chain never answers for weth, so the root is given up once its attempts run out
  let result = await runInvocation(deps(db, withWeth, 2));
  for (let invocation = 0; invocation < 10 && result.kind === 'running'; invocation++) {
    result = await runInvocation(deps(db, withWeth, 2));
  }
  t.equal(result.kind, 'held', 'the import ends with its draft held, not invalid');
  t.same([ result.expected, result.completed, result.outstanding ], [ 2, 1, 0 ],
    'with one root of two imported and none left to attempt');
  t.match(result.reason, /^the import gave up 1 of its 2 roots; the candidate is held for review, and cannot validate without them; \d+ of its checks failed$/,
    'and its answer says the root was given up');
  t.notMatch(result.reason, /every root is imported/, 'never that every root is imported');
  const draft = result.versionId!;

  const env    = await server.getWorker<Env>().getEnv();
  const status = await registryStatus(env, cacheDepsOf(env));
  t.same(status.candidates.importing.map(candidate => candidate.versionId), [ draft ], 'the status lists the draft');
  t.match(status.sync.lastRun, {
    status:         'completed',
    outcome:        'imported',
    expectedCount:  2,
    completedCount: 1,
    failedCount:    1,
  }, 'and its run as completed, with one root of two imported and the other given up');
  t.same([ ...status.alerts ].sort(), [ 'candidate-awaiting-review', 'no-active-version' ],
    'which raises a draft to review, and no failed sync');

  // an attempt with every root: here, a source of the one market the chain answers for
  const forced = await runInvocation(deps(db, usdcOnly), {
    forceNewAttempt: true,
    reason:          'first import',
    requestedBy:     'test-admin',
  });
  t.equal(forced.kind, 'held', 'a new attempt that imports every root is held in its turn');
  t.equal(await statusOf(db, draft), 'invalid', 'and closes the incomplete draft');
});

/*
 * A request to hold the candidate holds it once no root is left to attempt,
 * as a first import is held: a run that gave roots up leaves its draft open
 * all the same, and the answer says how many it gave up, since the draft
 * cannot validate without them (REGISTRY_RUNBOOK.md, "Describing a new
 * market").
 */
t.test('a held attempt that gives a root up is held all the same, and says so', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];

  // the chain never answers for weth, so the root is given up once its attempts run out
  let result = await runInvocation(deps(db, roots, 2), {
    forceNewAttempt: true, holdForReview: true, reason: 'describe 1/weth', requestedBy: 'test-admin',
  });
  for (let invocation = 0; invocation < 10 && result.kind === 'running'; invocation++) {
    result = await runInvocation(deps(db, roots, 2));
  }
  t.match(result, { kind: 'held', expected: 2, completed: 1, outstanding: 0, checksFailed: 1 },
    'the attempt ends with its draft held, one root of two imported and none left to attempt');
  t.equal(
    result.reason,
    'the import gave up 1 of its 2 roots; the candidate is held for review, and cannot validate without them; 1 of its checks failed',
    'and its answer says the root was given up',
  );
  t.equal(await statusOf(db, result.versionId!), 'importing', 'the draft is open for review');
  const summary = await readValidationSummary(db, result.versionId!);
  t.same(summary.checks.filter(check => !check.passed).map(check => check.name), [ 'all-roots-imported' ],
    'and the one check it fails is the root it lacks');
});

/*
 * The Cron imports a couple of markets an hour. An operator bringing an
 * environment up asks for the whole source at once — but a failing root is
 * still attempted once per request, never retried inside it.
 */
t.test('one invocation can import the whole source, one attempt per root', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];

  const result = await runInvocation(deps(db, roots, 1), { markets: 50 });
  t.equal(result.processed, 2, 'both roots in one invocation, despite a batch of one configured');

  const attempts = await db.prepare(
    `SELECT root_path, attempts FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`
  ).bind(result.runId).all<{ root_path: string, attempts: number }>();
  t.same((attempts.results ?? []).map(item => item.attempts), [ 1, 0 ],
    'and the root the chain did not answer for kept its budget: the invocation had already imported one, '
      + 'so the failure was the invocation running out, not the root being wrong');
});

/*
 * The database and the chain of an invocation that is stopped in the middle
 * of weth: once it asks the chain about weth's Comet it writes nothing more,
 * as a deploy, or the time or the CPU a Worker is given, leaves it. Every
 * other read is answered from the recording.
 */
function stoppedOnWeth(db: D1Database) {
  const weth  = (JSON.parse(wethContent) as { comet: string }).comet.slice(2).toLowerCase();
  const chain = chainStub();
  let stopped = false;
  return {
    db: new Proxy(db, {
      get(target, property, receiver) {
        if (stopped) {
          throw new Error('the invocation was stopped');
        }
        const value = Reflect.get(target, property, receiver);
        return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
      },
    }),
    transportFor: () => async (calls: jsonRpc.Call[]) => {
      if (JSON.stringify(calls).toLowerCase().includes(weth)) {
        stopped = true;
        throw new Error('the invocation was stopped');
      }
      return chain(calls);
    },
  };
}

/*
 * An invocation can be stopped in the middle of a root and write nothing
 * more: a deploy, or the time or the CPU a Worker is given. The invocation
 * that takes the run over records that attempt as failed, so a root whose
 * invocations keep stopping on it is retried as any failing root is, given
 * up after its five attempts and counted among the run's failed roots; and
 * while it repeats, the status names an import that keeps failing.
 */
t.test('a root whose invocations keep stopping on it is failed, retried and given up like any other', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];
  const env = await server.getWorker<Env>().getEnv();

  // the hourly invocations: each one is stopped once it reads weth from the chain, and writes nothing more
  let hour = Date.now();
  const invocation = async () => {
    const answer = await runInvocation({
      ...deps(db, roots),
      ...stoppedOnWeth(db),
      now: () => new Date(hour),
    }).catch(() => null);
    hour += 3_600_000;
    return answer;
  };
  const wethRoot = () => db.prepare(
    `SELECT status, attempts, last_error FROM sync_run_items WHERE root_path = ?1`
  ).bind(WETH_ROOT).first<{ status: string, attempts: number, last_error: string | null }>();
  // the status half an hour after the last invocation, once its lease has run out
  const alerts = async () => (await registryStatus(env, { ...cacheDepsOf(env), now: () => new Date(hour - 1_800_000) })).alerts;

  t.equal(await invocation(), null, 'the first invocation imports usdc, and is stopped on weth');
  t.same(await wethRoot(), { status: 'processing', attempts: 1, last_error: null }, 'which it leaves in progress');
  t.notOk((await alerts()).includes('sync-failing'), 'one stopped attempt is not yet an import that keeps failing');

  t.equal(await invocation(), null, 'the next invocation is stopped on weth too');
  t.same(await wethRoot(), { status: 'processing', attempts: 2, last_error: 'the invocation importing this root did not finish' },
    'having recorded why the attempt before its own failed');
  t.ok((await alerts()).includes('sync-failing'), 'and the import is one that keeps failing');

  for (let attempt = 3; attempt <= 5; attempt++) {
    t.equal(await invocation(), null, `invocation ${attempt} is stopped on weth`);
  }
  const ended = await invocation();
  t.match(ended, { kind: 'invalid', expected: 2, completed: 1, outstanding: 0 },
    'the invocation after the fifth gives weth up, and the candidate fails without it');
  t.same(await wethRoot(), { status: 'failed', attempts: 5, last_error: 'the invocation importing this root did not finish' },
    'leaving the root failed, with why');
  const run = await db.prepare(`SELECT status, completed_count, failed_count FROM sync_runs WHERE id = ?1`)
    .bind(ended?.runId).first();
  t.same(run, { status: 'failed', completed_count: 1, failed_count: 1 }, 'and counted among the roots the run gave up');
});

/*
 * An invocation can import a root and then be stopped on the next. The root
 * it imported cleared the run's error, and nothing records the attempt it was
 * stopped in until another invocation takes the run over; but once its lease
 * has run out, that attempt is the run's latest, and failed, and the status
 * counts it so.
 */
t.test('an attempt stopped after a root that imported is a failure once its lease has run out', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];
  const env    = await server.getWorker<Env>().getEnv();
  const hour   = Date.now();
  const alerts = async (at: number) => (await registryStatus(env, { ...cacheDepsOf(env), now: () => new Date(at) })).alerts;

  // the invocations of the first two hours reach no node provider, and each spends an attempt of both roots
  for (const at of [ hour, hour + 3_600_000 ]) {
    await runInvocation({
      ...deps(db, roots),
      transportFor: () => async () => {
        throw new Error('the node provider did not answer');
      },
      now: () => new Date(at),
    });
  }
  t.ok((await alerts(hour + 3_660_000)).includes('sync-failing'), 'the import keeps failing');

  t.equal(await runInvocation({
    ...deps(db, roots),
    ...stoppedOnWeth(db),
    now: () => new Date(hour + 7_200_000),
  }).catch(() => null), null, 'the third invocation is stopped on weth');
  const run   = await db.prepare(`SELECT id, last_error FROM sync_runs WHERE status = 'running'`)
    .first<{ id: string, last_error: string | null }>();
  const items = await db.prepare(
    `SELECT deployment_key, status, attempts FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`
  ).bind(run?.id).all();
  t.same(items.results, [
    { deployment_key: 'usdc', status: 'completed', attempts: 3 },
    { deployment_key: 'weth', status: 'processing', attempts: 3 },
  ], 'having imported usdc first');
  t.equal(run?.last_error, null, 'which cleared the run\'s error');

  t.notOk((await alerts(hour + 7_260_000)).includes('sync-failing'),
    'so while its lease runs, the latest attempt recorded is one that succeeded');
  t.ok((await alerts(hour + 9_000_000)).includes('sync-failing'),
    'and once it has run out, the attempt at weth is the latest, and failed: the import keeps failing');
});

/*
 * Ending a candidate and closing its run are one transaction. A finish the
 * database refuses leaves both as they were, and the next invocation finishes
 * them; a candidate never ends under a run that stays open.
 */
const failClosingRuns = (db: D1Database) => db.prepare(
  `CREATE TRIGGER test_closing_fails BEFORE UPDATE OF status ON sync_runs
   WHEN NEW.status <> 'running'
   BEGIN SELECT RAISE(ABORT, 'the database stopped answering'); END`
).run();
const allowClosingRuns = (db: D1Database) => db.prepare(`DROP TRIGGER test_closing_fails`).run();
const openRun = (db: D1Database) => db.prepare(
  `SELECT id, status, registry_version_id, last_error FROM sync_runs ORDER BY started_at DESC LIMIT 1`
).first<{ id: string, status: string, registry_version_id: string, last_error: string | null }>();

t.test('a candidate ends together with its run, or not at all', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  await failClosingRuns(db);
  await t.rejects(runInvocation(deps(db, roots)), { message: /the database stopped answering/ });
  await allowClosingRuns(db);

  const run = await openRun(db);
  t.equal(run?.status, 'running', 'the run the database refused to close is still open');
  t.equal(await statusOf(db, run!.registry_version_id), 'importing', 'and its candidate did not end without it');
  t.equal(run?.last_error, 'an unexpected error interrupted the import', 'the run says something interrupted it');

  const finished = await runInvocation(deps(db, roots));
  t.same([ finished.kind, finished.versionId ], [ 'imported', run!.registry_version_id ],
    'the next invocation finishes both, at once: the one that failed gave the run back');
  t.equal(await statusOf(db, run!.registry_version_id), 'validated');
  const closed = await openRun(db);
  t.same([ closed?.status, closed?.last_error ], [ 'completed', null ],
    'and a run that completes with every root imported keeps no error from the invocation it got past');
});

/*
 * A release before this one ended the candidate and closed its run in two
 * writes, and an invocation interrupted between them left the run open for
 * good: every later invocation took it, failed to validate an ended
 * candidate again, and held the lease. Such a run is now closed.
 */
t.test('a run left open under a candidate that has already ended is closed', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  await failClosingRuns(db);
  await t.rejects(runInvocation(deps(db, roots)), { message: /the database stopped answering/ });
  await allowClosingRuns(db);
  // what the earlier release had written before it was interrupted: the attempt, and the status it decided
  const run = (await openRun(db))!;
  await validateSeeded(db, run.registry_version_id);
  const attempts = () => db.prepare(
    `SELECT MAX(validation_attempt) AS n FROM validation_results WHERE registry_version_id = ?1`
  ).bind(run.registry_version_id).first<number>('n');
  const before = await attempts();

  const closed = await runInvocation(deps(db, roots));
  t.same([ closed.kind, closed.runId ], [ 'imported', run.id ], 'the next invocation closes the run');
  const after = await openRun(db);
  t.same([ after?.status, after?.last_error ], [ 'completed', null ],
    'completed, without the error of the invocation that was interrupted closing it');
  t.equal(await attempts(), before, 'without validating the ended candidate again');
});

t.test('an invocation that loses its lease before the candidate ends writes nothing, and says so', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  // another invocation takes the lease over once the last root is in, before the candidate is decided
  await db.prepare(
    `CREATE TRIGGER test_taken_over AFTER UPDATE OF status ON sync_run_items
     WHEN NEW.status = 'completed'
     BEGIN UPDATE sync_runs SET lease_owner = 'another-invocation' WHERE id = NEW.sync_run_id; END`
  ).run();
  const result = await runInvocation(deps(db, roots));
  await db.prepare(`DROP TRIGGER test_taken_over`).run();

  t.same([ result.kind, result.reason ], [ 'running', 'the lease was taken over' ], 'not completed: nothing was completed');
  t.equal(await statusOf(db, result.versionId!), 'importing', 'the candidate did not end');
  t.equal((await openRun(db))?.status, 'running', 'and its run is left to the invocation that took it over');
  t.equal(
    await db.prepare(`SELECT COUNT(*) AS n FROM validation_results WHERE registry_version_id = ?1`)
      .bind(result.versionId).first<number>('n'),
    0,
    'not even its checks are recorded: they belong to whoever ends it',
  );
});

// a database that fails as `message` says on each statement `pattern` matches, and answers every other
function failingOn(db: D1Database, pattern: RegExp, message: string): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'prepare') {
        return (sql: string) => {
          if (pattern.test(sql)) {
            throw new Error(message);
          }
          return target.prepare(sql);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as D1Database;
}

/*
 * Once the run is closed, the import has happened. A database that stops
 * answering right after that does not turn it into a failure, which would
 * also skip the snapshot the Cron warms for an imported version.
 */
t.test('an import that has closed its run is answered as imported, whatever fails after', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  // the database stops answering once the batch that closes the run has committed
  let closing = false;
  let closed  = false;
  const down = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'prepare') {
        return (sql: string) => {
          if (closed) {
            throw new Error('D1_ERROR: Network connection lost.');
          }
          closing ||= /SET status = \?1, outcome = \?2/.test(sql);
          return target.prepare(sql);
        };
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          closed ||= closing;
          return results;
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as D1Database;

  const result = await runInvocation({ ...deps(db, roots), db: down });
  t.ok(closed, 'the database stopped answering after the run was closed');
  t.match(result, { kind: 'imported', expected: 1, completed: 1, outstanding: 0 },
    'and the import is answered as imported, with how far it got');
});

const leaseOf = (db: D1Database) => db.prepare(
  `SELECT id, lease_owner, lease_expires_at, last_error FROM sync_runs ORDER BY started_at DESC LIMIT 1`
).first<{ id: string, lease_owner: string | null, lease_expires_at: string | null, last_error: string | null }>();

/*
 * An invocation that fails while it holds the run gives it back. A request
 * sent again at once continues the run, rather than being told until the
 * lease runs out that another invocation is importing when none is. A
 * database that did not answer says nothing about the run, which keeps no
 * error for it.
 */
t.test('an invocation that fails gives the run back at once', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  await t.rejects(
    runInvocation({ ...deps(db, roots), db: failingOn(db, /SET status = 'processing'/, 'D1_ERROR: Network connection lost.') }),
    { message: /Network connection lost/ },
    'the database does not answer the claim of a root',
  );
  const run = await leaseOf(db);
  t.same([ run?.lease_owner, run?.lease_expires_at, run?.last_error ], [ null, null, null ],
    'the run is given back, without an error of its own');

  const asked = await runInvocation(deps(db, roots), { requestedBy: 'registry-admin:test' });
  t.same([ asked.kind, asked.runId ], [ 'imported', run?.id ], 'and a request sent at once continues it');
});

/*
 * What an invocation gives back is only ever its own: one that fails after
 * another invocation took the run over leaves that one's lease, and the
 * run's error, as they are.
 */
t.test('an invocation that fails after losing the run leaves it to the one that took it', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  // another invocation takes the run over once the candidate is bound, and the statement after that fails
  await db.prepare(
    `CREATE TRIGGER test_taken_over AFTER UPDATE OF registry_version_id ON sync_runs
     BEGIN UPDATE sync_runs SET lease_owner = 'another-invocation' WHERE id = NEW.id; END`
  ).run();
  await t.rejects(
    runInvocation({ ...deps(db, roots), db: failingOn(db, /AS outstanding/, 'D1_ERROR: no such column: outstanding') }),
    { message: /no such column/ },
  );
  await db.prepare(`DROP TRIGGER test_taken_over`).run();

  const run = await leaseOf(db);
  t.same([ run?.lease_owner, run?.last_error ], [ 'another-invocation', null ],
    'the lease stays with the invocation that took it, and the failure is not written over its run');
});

/*
 * A run is held from the moment it is started, so a failure recording that
 * upstream was checked gives the new run back too. A fault is the run's to
 * report: it is kept as the run's error, sanitized as a root's is, until an
 * attempt at a root replaces it.
 */
t.test('an invocation that fails right after starting its run gives it back, saying so', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  await db.prepare(
    `CREATE TRIGGER test_check_fails BEFORE UPDATE OF last_upstream_checked_at ON registry_state
     BEGIN SELECT RAISE(ABORT, 'the database stopped answering'); END`
  ).run();
  await t.rejects(runInvocation(deps(db, roots)), { message: /the database stopped answering/ });
  await db.prepare(`DROP TRIGGER test_check_fails`).run();

  const run = await leaseOf(db);
  t.same([ run?.lease_owner, run?.last_error ], [ null, 'an unexpected error interrupted the import' ],
    'the run it started is given back, saying that something interrupted it');

  const next = await runInvocation(deps(db, roots));
  t.same([ next.kind, next.runId ], [ 'imported', run?.id ], 'the next invocation continues it at once');
  t.equal((await leaseOf(db))?.last_error, null, 'and the root it imports clears the error');
});

/*
 * A run whose every invocation fails the same way before it imports a root —
 * here a decision the version on stores, which the overlay parser has since
 * stopped taking — is never finished: the hourly job and every request fail
 * on it in turn, and spend no attempt. Each failure says why in the run's
 * error, and the status calls the run stalled. An operator ends it, fixes
 * the cause, and forces a new attempt.
 */
t.test('a run that fails the same way every time says why, and an operator can end it', async t => {
  const db     = await freshDatabase();
  const active = await activateFixture(db);
  const roots  = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];
  const env    = await server.getWorker<Env>().getEnv();
  const HOUR   = 3_600_000;
  const start  = Date.now();

  // a name longer than the parser allows, which only a parser tightened since the version was decided refuses
  await db.prepare(`DROP TRIGGER markets_update_requires_importing`).run();
  const rename = (name: string) => db.prepare(
    `UPDATE markets SET display_name = ?1 WHERE registry_version_id = ?2 AND deployment_key = 'usdc'`
  ).bind(name, active).run();
  const name = await db.prepare(`SELECT display_name FROM markets WHERE registry_version_id = ?1 AND deployment_key = 'usdc'`)
    .bind(active).first<string>('display_name');
  await rename('x'.repeat(300));

  for (const hour of [ 0, 1, 2 ]) {
    await t.rejects(runInvocation({ ...deps(db, roots), now: () => new Date(start + hour * HOUR) }),
      { code: 'OVERLAY_INVALID' }, `the invocation of hour ${hour} fails on it`);
  }
  const run = await leaseOf(db);
  t.equal(run?.lease_owner, null, 'each one gives the run back');
  t.match(run?.last_error, /^OVERLAY_INVALID: /, 'saying why it failed');
  t.same(
    (await db.prepare(`SELECT status, attempts FROM sync_run_items WHERE sync_run_id = ?1`).bind(run?.id).all()).results,
    [ { status: 'pending', attempts: 0 } ],
    'and having spent no attempt, so the run never ends by itself',
  );

  const status = await registryStatus(env, { ...cacheDepsOf(env), now: () => new Date(start + 2 * HOUR + 300_000) });
  t.ok(status.alerts.includes('sync-stalled'), 'minutes after the latest failure, the status calls the run stalled');
  t.match(status.sync.lastRun?.lastError, /^OVERLAY_INVALID: /, 'and says why');

  await t.rejects(
    runInvocation(deps(db, roots), { forceNewAttempt: true, reason: 'start over', requestedBy: 'registry-admin:test' }),
    { code: 'SYNC_ALREADY_RUNNING' },
    'a new attempt is refused while the run is running',
  );

  t.equal((await cancelRun(db, run!.id, { actor: 'registry-admin:test', reason: 'a stored name no longer parses' })).cancelled, true,
    'so an operator ends it');
  t.same(
    await db.prepare(`SELECT status, outcome, last_error, lease_owner FROM sync_runs WHERE id = ?1`).bind(run?.id).first(),
    { status: 'failed', outcome: null, last_error: 'cancelled by registry-admin:test: a stored name no longer parses', lease_owner: null },
    'saying who did, and why',
  );
  const cancelled = await registryStatus(env, cacheDepsOf(env));
  t.ok(cancelled.alerts.includes('last-sync-failed'), 'which the status raises as a failed run');
  t.match(cancelled.sync.lastRun?.lastError, /^cancelled by registry-admin:test: /, 'with who ended it');

  await rename(name!);
  const forced = await runInvocation(deps(db, roots), {
    forceNewAttempt: true, reason: 'the name is fixed', requestedBy: 'registry-admin:test',
  });
  t.equal(forced.kind, 'imported', 'and once the cause is fixed, the attempt the operator forces imports');
});

const usdcFixture = snapshot.networks.find(network => network.chainId === 1)!.markets
  .find(market => market.deploymentKey === 'usdc')!;
const rewardFeeds: FeedReader = async () => new Map([ [ REWARD_FEED.address, REWARD_FEED ] ]);

function usdcOverlay(displayName: string = usdcFixture.displayName) {
  return { ...overlayOfMarket(usdcFixture), displayName };
}

const runsOf = (db: D1Database) => db.prepare(`SELECT COUNT(*) AS n FROM sync_runs`).first<number>('n');

/*
 * A request that holds the candidate open is a decision, like naming a commit
 * or forcing an attempt: it is acted on when it is asked rather than at the
 * next daily discovery, and the run records that a person asked for it.
 */
t.test('a request to hold the candidate is acted on at once, as a manual run', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1`).bind(new Date().toISOString()).run();
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  t.equal((await runInvocation(deps(db, roots))).reason, 'upstream was checked recently', 'routine discovery is not due');

  const held = await runInvocation(deps(db, roots), {
    holdForReview: true, reason: 'review it before it validates', requestedBy: 'test-admin',
  });
  t.equal(held.kind, 'held', 'the request to hold one runs all the same, and holds the candidate it imports');
  t.same(
    await db.prepare(`SELECT trigger_kind, hold_for_review, requested_by, reason FROM sync_runs WHERE id = ?1`)
      .bind(held.runId).first(),
    { trigger_kind: 'manual', hold_for_review: 1, requested_by: 'test-admin', reason: 'review it before it validates' },
    'recorded as the manual run it is',
  );
});

/*
 * A version names who asked for the import that created it, as its run does:
 * the operator of an administrative sync, whatever the request asked for —
 * an empty one that found discovery due starts a routine run, which the
 * operator asked for all the same — and the schedule otherwise.
 */
t.test('a version is created by whoever asked for its run', async t => {
  const roots   = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];
  const creator = (db: D1Database, versionId: string) =>
    db.prepare(`SELECT created_by FROM registry_versions WHERE id = ?1`).bind(versionId).first<string>('created_by');
  const run     = (db: D1Database, runId: string) =>
    db.prepare(`SELECT trigger_kind, requested_by FROM sync_runs WHERE id = ?1`).bind(runId).first();

  const scheduledDb = await freshDatabase();
  await activateFixture(scheduledDb);
  const scheduled = await runInvocation(deps(scheduledDb, roots));
  t.equal(scheduled.kind, 'imported');
  t.equal(await creator(scheduledDb, scheduled.versionId!), 'registry-cron', 'the schedule\'s run creates the schedule\'s version');

  const forced = await runInvocation(deps(scheduledDb, roots), {
    forceNewAttempt: true, reason: 'read the chain again', requestedBy: 'registry-admin:test',
  });
  t.equal(forced.kind, 'imported');
  t.same(await run(scheduledDb, forced.runId!), { trigger_kind: 'manual', requested_by: 'registry-admin:test' });
  t.equal(await creator(scheduledDb, forced.versionId!), 'registry-admin:test', 'an operator\'s attempt creates the operator\'s');

  const askedDb = await freshDatabase();
  await activateFixture(askedDb);
  const asked = await runInvocation(deps(askedDb, roots), { requestedBy: 'registry-admin:test' });
  t.equal(asked.kind, 'imported');
  t.same(await run(askedDb, asked.runId!), { trigger_kind: 'scheduled', requested_by: 'registry-admin:test' },
    'an empty request that found discovery due starts a routine run');
  t.equal(await creator(askedDb, asked.versionId!), 'registry-admin:test', 'whose version is the operator\'s all the same');
});

/*
 * A commit whose newest attempt imported every root and still did not
 * validate would fail the same way on every retry: the same source, the same
 * chain, the decisions inherited from the attempt before. Discovery leaves it
 * alone rather than write another version of it every day; an attempt a
 * person forces is made all the same.
 */
t.test('a commit that imported completely and did not validate is not attempted again by itself', async t => {
  const db = await freshDatabase();
  // an active version that has never seen the usdc deployment, so the import holds no default market
  await activateFixture(db, {
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets
        .filter(market => market.deploymentKey !== 'usdc')
        .map(market => market.deploymentKey === 'weth' ? { ...market, isDefault: true } : market),
    }),
  });
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  const failed = await runInvocation(deps(db, roots));
  t.equal(failed.kind, 'invalid', 'the attempt imported its root, and did not validate');
  const env    = await server.getWorker<Env>().getEnv();
  const status = await registryStatus(env, cacheDepsOf(env));
  t.same(status.alerts.filter(alert => alert === 'commit-rejected' || alert === 'last-sync-failed'),
    [ 'commit-rejected', 'last-sync-failed' ], 'the status raises the failed run and the rejected commit together');
  t.match(status.sync, {
    lastRun:        { status: 'failed', registryVersionId: failed.versionId },
    rejectedCommit: { versionId: failed.versionId },
  }, 'and names the attempt in both');

  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1`).bind('2020-01-01T00:00:00.000Z').run();
  const again = await runInvocation(deps(db, roots));
  t.same([ again.kind, again.versionId ], [ 'idle', failed.versionId ], 'discovery does not start another attempt');
  t.match(again.reason, /attempt 1 of this commit imported every root and is invalid/, 'and says why');
  t.equal(await runsOf(db), 1, 'no run is created for it');
  t.not(
    await db.prepare(`SELECT last_upstream_checked_at FROM registry_state`).first<string>('last_upstream_checked_at'),
    '2020-01-01T00:00:00.000Z',
    'though upstream was checked, so the interval starts again',
  );

  const forced = await runInvocation(deps(db, roots), { forceNewAttempt: true, reason: 'the reviews are fixed' });
  t.not(forced.versionId, failed.versionId, 'an attempt somebody forces is made');
  t.equal(await runsOf(db), 2);
});

/*
 * An attempt that did not import every root failed on something that can
 * pass by — a chain that did not answer, or contracts the source names before
 * they are deployed — so it is tried again: at the next discovery, then two
 * discoveries after the second attempt, four after the third, instead of a
 * whole attempt every day. The test runs the schedule itself, an invocation
 * an hour and a discovery a day, and nothing else moves the time upstream was
 * last checked: an attempt takes hours, so a wait counted from its end would
 * always miss the discovery it was meant for.
 */
t.test('a commit whose roots did not all import is tried again, each time later', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];
  const HOUR  = 3_600_000;
  const start = Date.now();

  // a week of the hourly Cron; the weth root never answers, so every attempt ends without it
  const started: number[] = [];
  const waiting = new Map<number, string | undefined>();
  for (let hour = 0; hour <= 168; hour++) {
    const runs   = await runsOf(db);
    const result = await runInvocation({ ...deps(db, roots, 2), now: () => new Date(start + hour * HOUR) });
    if (await runsOf(db) !== runs) {
      started.push(hour);
    }
    if (result.kind === 'idle' && result.reason !== 'upstream was checked recently') {
      waiting.set(hour, result.reason);
    }
  }

  t.same(started, [ 0, 24, 72, 168 ], 'attempts start one, two and four daily discoveries apart');
  t.same([ ...waiting.keys() ], [ 48, 96, 120, 144 ], 'and the discoveries between them leave the commit alone');
  t.match(waiting.get(48), `tried again after ${new Date(start + 72 * HOUR).toISOString()}`, 'saying when it is tried again');
  t.match(waiting.get(96), `tried again after ${new Date(start + 168 * HOUR).toISOString()}`);
});

/*
 * The discovery interval is spent only once a run exists. A source that fails
 * before then — GitHub not answering for the ref, or a tree it says it
 * truncated — starts no run and leaves discovery due: the next invocation
 * asks again rather than a day later, and a source that keeps failing is what
 * `sync-overdue` reports.
 */
t.test('a source that fails before the run exists leaves discovery due', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const checked = '2020-01-01T00:00:00.000Z';
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1`).bind(checked).run();
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  for (const [ faults, code ] of [
    [ { commits: 502 },    'SOURCE_REQUEST_FAILED' ],
    [ { truncated: true }, 'SOURCE_TREE_TRUNCATED' ],
  ] as const) {
    await t.rejects(runInvocation(deps(db, roots, 2, faults)), { code }, `${code} fails the invocation`);
    t.equal(await runsOf(db), 0, 'which starts no run');
    t.equal(
      await db.prepare(`SELECT last_upstream_checked_at FROM registry_state`).first<string>('last_upstream_checked_at'),
      checked,
      'and leaves discovery due',
    );
  }

  const asked = await runInvocation(deps(db, roots));
  t.equal(asked.kind, 'imported', 'so the next invocation asks again, and imports');
});

/*
 * The candidate and the run's record of it are written in one transaction,
 * under the run's fence. An invocation that loses the run before it gets there
 * writes neither: there is no empty draft without a run, which discovery would
 * otherwise take for one held for review and stop at for good.
 */
t.test('an invocation that loses the run before its candidate exists creates none', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  // another invocation takes the run over as soon as it exists
  await db.prepare(
    `CREATE TRIGGER test_taken_over AFTER UPDATE OF last_upstream_checked_at ON registry_state
     BEGIN UPDATE sync_runs SET lease_owner = 'another-invocation' WHERE status = 'running'; END`
  ).run();
  const result = await runInvocation(deps(db, roots));
  await db.prepare(`DROP TRIGGER test_taken_over`).run();

  t.same([ result.kind, result.reason, result.versionId ], [ 'running', 'the lease was taken over', undefined ],
    'the invocation stops, naming no candidate');
  t.equal(
    await db.prepare(`SELECT COUNT(*) AS n FROM registry_versions WHERE source_commit_sha = ?1`).bind(COMMIT).first<number>('n'),
    0,
    'and none was created',
  );
  t.equal((await openRun(db))?.registry_version_id, null, 'the run creates its own under the invocation that holds it');
});

/*
 * What the fence on market writes is for. An invocation stalls in the middle
 * of a market — a node provider that does not answer — for longer than its
 * lease. Another one takes the run over, imports the market, finishes the run
 * and holds the candidate, and an operator reviews the market in place. When
 * the stalled invocation wakes up, what it read is stale, and writing it would
 * put back what the review replaced.
 */
t.test('a market whose invocation lost the run is not written over a review', async t => {
  const db    = await freshDatabase();
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];
  let versionId: string | undefined;

  const stalling = {
    ...deps(db, roots),
    transportFor: () => {
      const answer = chainStub();
      return async (calls: jsonRpc.Call[]) => {
        if (versionId === undefined) {
          // the lease runs out while the provider does not answer, and another invocation does the work
          await db.prepare(`UPDATE sync_runs SET lease_expires_at = ?1 WHERE status = 'running'`)
            .bind('2020-01-01T00:00:00.000Z').run();
          const finished = await runInvocation(deps(db, roots));
          versionId = finished.versionId!;
          await replaceMarketOverlay(db, {
            versionId, chainId: 1, deploymentKey: 'usdc', actor: 'test-admin', reason: 'review the market',
            overlay: usdcOverlay('Reviewed USDC'),
          }, rewardFeeds, blocksConfirmed);
        }
        return answer(calls);
      };
    },
  };

  const late = await runInvocation(stalling);
  t.same([ late.kind, late.reason ], [ 'idle', 'the lease was taken over, and the run has since finished' ],
    'the stalled invocation says it wrote nothing, and why');
  t.equal(
    await db.prepare(`SELECT display_name FROM markets WHERE registry_version_id = ?1 AND deployment_key = 'usdc'`)
      .bind(versionId).first<string>('display_name'),
    'Reviewed USDC',
    'and the review stands',
  );
});

/*
 * A review written while the import is checking its candidate changes rows
 * the checks have already read. Recording those checks, or the status they
 * decide, would describe a candidate that no longer exists: a version
 * validated with a checksum that is not the checksum of its rows.
 */
t.test('a candidate reviewed while its import checks it is checked again, not ended', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  const racing = interleaved(db, /INSERT INTO validation_results/, async () => {
    await replaceMarketOverlay(db, {
      versionId: (await openRun(db))!.registry_version_id, chainId: 1, deploymentKey: 'usdc',
      actor: 'test-admin', reason: 'renamed while the import checks it', overlay: usdcOverlay('Renamed meanwhile'),
    }, rewardFeeds, blocksConfirmed);
  });
  const interrupted = await runInvocation({ ...deps(db, roots), db: racing });
  t.equal(interrupted.kind, 'running', 'the import does not finish');
  t.match(interrupted.reason, /changed while it was being validated/, 'and says why');
  t.equal(await statusOf(db, interrupted.versionId!), 'importing', 'the candidate did not end');
  t.equal(
    await db.prepare(`SELECT COUNT(*) AS n FROM validation_results WHERE registry_version_id = ?1`)
      .bind(interrupted.versionId).first<number>('n'),
    0,
    'and no checks of the rows it read are recorded',
  );

  const finished = await runInvocation(deps(db, roots));
  t.same([ finished.kind, finished.versionId ], [ 'imported', interrupted.versionId ],
    'the next invocation, released at once, checks it as it now is');
  const version = await db.prepare(`SELECT status, snapshot_checksum FROM registry_versions WHERE id = ?1`)
    .bind(finished.versionId).first<{ status: string, snapshot_checksum: string }>();
  t.equal(version?.status, 'validated');
  t.equal(version?.snapshot_checksum, await snapshotChecksum(await readSnapshot(db, finished.versionId!)),
    'with the checksum of the rows it holds');
});

/*
 * The overlays an import applies are read for the markets it imports. An
 * invocation that only has the candidate left to decide reads none of them.
 */
t.test('an invocation with no root left to import reads no overlays', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  // the root is imported, and the candidate is not decided: the run is left with nothing but that
  await failClosingRuns(db);
  await t.rejects(runInvocation(deps(db, roots)), { message: /the database stopped answering/ });
  await allowClosingRuns(db);

  const statements: string[] = [];
  const watched = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'prepare') {
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as D1Database;

  const finished = await runInvocation({ ...deps(db, roots), db: watched });
  t.same([ finished.kind, finished.processed ], [ 'imported', 0 ], 'the invocation decides the candidate');
  t.ok(statements.some(sql => sql.includes('INSERT INTO validation_results')), 'every statement it prepared is watched');
  t.notOk(statements.some(sql => sql.includes('WITH sources')), 'and none of them reads an overlay');
});

/*
 * D1 keeps a root's failure as its code alone, so the log is what tells a
 * node proxy that failed from a chain that did. It names the status the proxy
 * answered and its URL as far as the network, written by the root logger
 * whatever DEBUG says, and never the proxy key in that URL or what the proxy
 * answered.
 */
t.test('a root the node proxy did not answer for is logged by its status and network, without the key', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  // what is written to the console, as the console would write it
  const written: string[] = [];
  for (const level of [ 'log', 'warn', 'error' ] as const) {
    const write = console[level];
    console[level] = (...parameters: unknown[]) => { written.push(format(...parameters)); };
    t.teardown(() => { console[level] = write; });
  }
  const result = await runInvocation({
    ...deps(db, roots),
    debug:        Debug.MakeLogger([]).configure({ DEBUG: '' }),
    transportFor: () => proxyTransport({
      apiHost:  'v3-api.test',
      nodeHost: 'node-proxy.test',
      nodeKey:  'node-proxy-key-0123456789',
      network:  'ethereum-mainnet',
      // what the proxy answers when no provider served the calls, with the URL fetch gives a response
      fetch:    async request => Object.defineProperty(
        new Response('upstream error', { status: 503 }),
        'url',
        { value: request.url },
      ),
    }),
  });
  t.equal(result.kind, 'running', 'the root is left to try again');

  const logged = written.join('\n');
  t.match(logged, /registry root failed/);
  t.match(logged, /CHAIN_REQUEST_FAILED/);
  t.match(logged, /JSON-RPC request failed: HTTP 503/, 'the log has the status the proxy answered');
  t.ok(logged.includes(`url: 'https://node-proxy.test/ethereum-mainnet/…'`), 'and the proxy, as far as the network');
  t.notOk(logged.includes('node-proxy-key'), 'but not the key');
  t.notOk(logged.includes('upstream error'), 'nor what the proxy answered');
});
