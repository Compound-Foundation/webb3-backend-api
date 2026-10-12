import t, { Test } from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';
import type { Address, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { sha256Hex } from '../../../src/http/bearer-auth.js';
import { cacheDepsOf } from '../../../src/registry/cache.js';
import { ChainCheckDeps, checkChain, readChainCheck } from '../../../src/registry/drift.js';
import { registryStatus } from '../../../src/registry/status.js';

import { FakeChain, fakeChain } from '../../util/fake-chain.js';
import { MemoryKv } from '../../util/kv.js';
import { RegistryDatabase, activeRegistryDatabase } from '../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { makeTestEnv } from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * The chain drift check: the version on, held against what its Comets answer
 * now. A fact the chain has moved away from is a drift, named with its
 * market, its asset and both values; a chain that does not answer is unread,
 * which neither raises a drift nor clears one; and the version itself is left
 * as it is.
 */
const snapshot = loadRegistrySnapshotFixture();
const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;
const marketOf = (deploymentKey: string) => mainnet.markets.find(market => market.deploymentKey === deploymentKey)!;
const usdc     = marketOf('usdc');
const USDC     = usdc.contracts.comet!;

// the feed governance moved Unichain's rsETH to, standing in for any feed the version does not store
const MOVED = '0x3fb418b74ec30bc3e940221f58a04e16afc6378b' as Address;

const DAY  = 86_400;
const HOUR = 3_600_000;

// an hourly invocation of the Cron; `later(n)` is the one n hours after it
const NOW   = new Date('2026-10-07T01:00:00.000Z');
const later = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

// a check of `version`, as the version on under `versionId`, against `chain`, by an invocation at `now`
function depsOf(
  chain: FakeChain,
  { kv = MemoryKv({}), version = snapshot, versionId = version.registryVersion.id, now = NOW }: {
    kv?:        KVNamespace,
    version?:   RegistrySnapshotV1,
    versionId?: string,
    now?:       Date,
  } = {},
): ChainCheckDeps {
  return {
    kv,
    active: async () => ({
      snapshot: { ...version, registryVersion: { ...version.registryVersion, id: versionId } },
      staleFor: null,
    }),
    transportFor:    chain.transportFor,
    intervalSeconds: DAY,
    now:             () => now,
  };
}

// the collateral of a market as its Comet answers it, with the feed of the asset at `moved` replaced
function collateralOf(deploymentKey: string, moved?: number): Array<{ token: Address, priceFeed: Address }> {
  return marketOf(deploymentKey).collateralAssets.map(asset => ({
    token:     asset.token.address,
    priceFeed: asset.assetIndex === moved ? MOVED : asset.priceFeed.address,
  }));
}

// the fixture with 1/usdc's base asset priced by `feed`, as an import made after governance moved it would store it
function withBaseFeed(feed: Address): RegistrySnapshotV1 {
  return {
    ...snapshot,
    networks: snapshot.networks.map(network => ({
      ...network,
      markets: network.markets.map(market => market.contracts.comet !== USDC ? market : {
        ...market,
        baseAsset: { ...market.baseAsset, priceFeed: { ...market.baseAsset.priceFeed, address: feed } },
      }),
    })),
  };
}

function rounds(chain: FakeChain): Record<string, number> {
  return chain.asked.reduce<Record<string, number>>((counted, network) => ({ ...counted, [network]: (counted[network] ?? 0) + 1 }), {});
}

t.test('a chain that answers what the version stores raises no drift', async t => {
  const chain = fakeChain(snapshot);
  const kv    = MemoryKv({});
  const check = await checkChain(depsOf(chain, { kv }));

  t.same(check, { versionId: snapshot.registryVersion.id, checkedAt: NOW.toISOString(), drifts: [], unreadable: [] });
  t.same(rounds(chain), { 'ethereum-mainnet': 2, 'base-mainnet': 2, 'scroll-mainnet': 2 },
    'every network that serves a market is read, in two round trips whatever its markets');
  t.same(await readChainCheck(kv), check, 'and the check is recorded for the status to read');
});

/*
 * What Nikita found on Unichain and Linea: governance gave a collateral of a
 * WETH market another price feed after the version was imported, and the
 * source did not move.
 */
t.test('a collateral feed the chain moved is a drift, named with all of it', async t => {
  const chain = fakeChain(snapshot, { changes: { [USDC]: { collateralAssets: collateralOf('usdc', 2) } } });
  const check = await checkChain(depsOf(chain));

  const weth = usdc.collateralAssets[2]!;
  t.same(check?.drifts, [ {
    chainId: 1,
    network: 'ethereum-mainnet',
    market:  '1/usdc',
    comet:   USDC,
    asset:   { role: 'collateral', assetIndex: 2, token: weth.token.address, symbol: weth.token.symbol },
    field:   'priceFeed',
    stored:  weth.priceFeed.address,
    current: MOVED,
    seenAt:  NOW.toISOString(),
  } ], 'the network, the market, the asset, what the version stores, what the chain answers, and when it did');
  t.same(check?.unreadable, []);
});

t.test('a base feed moved, and a collateral added or removed, are drifts too', async t => {
  const weth  = marketOf('weth');
  const wbtc  = marketOf('wbtc');
  const added = { token: `0x${'a'.repeat(40)}` as Address, priceFeed: `0x${'b'.repeat(40)}` as Address };
  const chain = fakeChain(snapshot, { changes: {
    [USDC]:                  { basePriceFeed: MOVED },
    [weth.contracts.comet!]: { collateralAssets: [ ...collateralOf('weth'), added ] },
    [wbtc.contracts.comet!]: { collateralAssets: collateralOf('wbtc').slice(0, -1) },
  } });
  const check = await checkChain(depsOf(chain));

  const removed = wbtc.collateralAssets[wbtc.collateralAssets.length - 1]!;
  t.same(check?.drifts.map(({ market, asset, field, stored, current }) => ({ market, asset, field, stored, current })), [
    {
      market: '1/usdc', field: 'priceFeed', stored: usdc.baseAsset.priceFeed.address, current: MOVED,
      asset:  { role: 'base', assetIndex: null, token: usdc.baseAsset.token.address, symbol: usdc.baseAsset.token.symbol },
    },
    {
      market: '1/weth', field: 'token', stored: null, current: added.token,
      asset:  { role: 'collateral', assetIndex: weth.collateralAssets.length, token: added.token, symbol: null },
    },
    {
      market: '1/wbtc', field: 'token', stored: removed.token.address, current: null,
      asset:  { role: 'collateral', assetIndex: removed.assetIndex, token: removed.token.address, symbol: removed.token.symbol },
    },
  ], 'each named on the side that has it');
});

t.test('a chain that does not answer is unread, never a drift', async t => {
  const chain = fakeChain(snapshot, {
    changes:    { [USDC]: { basePriceFeed: MOVED } },
    unreadable: [ 'ethereum-mainnet' ],
  });
  const check = await checkChain(depsOf(chain));

  t.same(check?.drifts, [], 'what moved on a chain that did not answer is not known, so it is not reported');
  t.same(check?.unreadable, [
    { chainId: 1, network: 'ethereum-mainnet', error: 'CHAIN_REQUEST_FAILED: a node provider request failed' },
  ], 'the chain is reported as unread instead');
  t.same(Object.keys(rounds(chain)).sort(), [ 'base-mainnet', 'ethereum-mainnet', 'scroll-mainnet' ],
    'and the other chains are read all the same');
});

/*
 * Nor is a drift once found forgotten because its chain stopped answering:
 * nothing says it has gone. It stands, with when the chain last answered it,
 * until a read of that chain says otherwise.
 */
t.test('a drift found before stands while its chain cannot be read', async t => {
  const kv      = MemoryKv({});
  const changes = { [USDC]: { basePriceFeed: MOVED } };
  const down    = fakeChain(snapshot, { changes, unreadable: [ 'ethereum-mainnet' ] });

  const found = await checkChain(depsOf(fakeChain(snapshot, { changes }), { kv }));
  t.same(found?.drifts.map(({ market, field, seenAt }) => ({ market, field, seenAt })), [
    { market: '1/usdc', field: 'priceFeed', seenAt: NOW.toISOString() },
  ], 'a moved feed is found');

  const unread = await checkChain(depsOf(down, { kv, now: later(24) }));
  t.same(unread?.drifts, found?.drifts, 'the next day, its chain not answering, it stands as it was seen');
  t.same(unread?.unreadable.map(({ network }) => network), [ 'ethereum-mainnet' ], 'and the chain is listed as unread');
  t.same((await checkChain(depsOf(down, { kv, now: later(25) })))?.drifts, found?.drifts,
    'however many times the chain is not read');

  const seen = await checkChain(depsOf(fakeChain(snapshot, { changes }), { kv, now: later(26) }));
  t.same(seen?.drifts.map(drift => drift.seenAt), [ later(26).toISOString() ], 'a read that finds it again says when');
  const back = await checkChain(depsOf(fakeChain(snapshot), { kv, now: later(48) }));
  t.same([ back?.drifts, back?.unreadable ], [ [], [] ], 'and one that finds the chain changed back clears it');
});

/*
 * The drift of a collateral the chain added or removed stands too: the
 * version still stores what it stored where the drift was found — nothing at
 * the index the chain added, the removed token at the one it emptied — and
 * nothing says the chain has changed back.
 */
t.test('a collateral added or removed stands while its chain cannot be read', async t => {
  const kv      = MemoryKv({});
  const weth    = marketOf('weth');
  const wbtc    = marketOf('wbtc');
  const added   = { token: `0x${'a'.repeat(40)}` as Address, priceFeed: `0x${'b'.repeat(40)}` as Address };
  const changes = {
    [weth.contracts.comet!]: { collateralAssets: [ ...collateralOf('weth'), added ] },
    [wbtc.contracts.comet!]: { collateralAssets: collateralOf('wbtc').slice(0, -1) },
  };

  const found = await checkChain(depsOf(fakeChain(snapshot, { changes }), { kv }));
  t.same(found?.drifts.map(({ market, field }) => ({ market, field })), [
    { market: '1/weth', field: 'token' },
    { market: '1/wbtc', field: 'token' },
  ], 'a collateral added to one market and one removed from another are found');

  const down   = fakeChain(snapshot, { changes, unreadable: [ 'ethereum-mainnet' ] });
  const unread = await checkChain(depsOf(down, { kv, now: later(24) }));
  t.same(unread?.drifts, found?.drifts, 'the next day, their chain not answering, both stand as they were seen');
  t.same(unread?.unreadable.map(({ network }) => network), [ 'ethereum-mainnet' ], 'and the chain is listed as unread');
});

/*
 * A version switched on is checked at the next invocation. Where that check
 * cannot read a chain, a drift the version before had there stands for the
 * new one only if it stores the same: a version rolled back to stores what
 * drifted, while one imported again since reads the chain anew.
 */
t.test('a version switched on keeps a drift of the one before only where it stores the same', async t => {
  const kv      = MemoryKv({});
  const changes = { [USDC]: { basePriceFeed: MOVED } };
  const down    = fakeChain(snapshot, { changes, unreadable: [ 'ethereum-mainnet' ] });
  await checkChain(depsOf(fakeChain(snapshot, { changes }), { kv, versionId: 'version-before' }));

  const rolledBack = await checkChain(depsOf(down, { kv, versionId: 'version-rolled-back-to', now: later(1) }));
  t.same(rolledBack?.drifts.map(({ market, field, stored, current }) => ({ market, field, stored, current })), [
    { market: '1/usdc', field: 'priceFeed', stored: usdc.baseAsset.priceFeed.address, current: MOVED },
  ], 'a version that stores the feed the chain moved away from keeps the drift');

  const reimported = await checkChain(depsOf(down, {
    kv,
    version:   withBaseFeed(MOVED),
    versionId: 'version-reimported',
    now:       later(2),
  }));
  t.same(reimported?.drifts, [], 'one that stores the feed the chain moved to does not');
  t.same(reimported?.unreadable.map(({ network }) => network), [ 'ethereum-mainnet' ], 'and its chain is unread all the same');
});

/*
 * Nor does a version switched on keep a drift of a market it no longer
 * serves: nothing it serves is described otherwise than the chain describes
 * it, whether the chain can be read or not.
 */
t.test('a version switched on keeps no drift of a market it does not serve', async t => {
  const kv      = MemoryKv({});
  const changes = { [USDC]: { basePriceFeed: MOVED } };
  await checkChain(depsOf(fakeChain(snapshot, { changes }), { kv, versionId: 'version-before' }));

  const withoutUsdc: RegistrySnapshotV1 = {
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets.filter(market => market.contracts.comet !== USDC),
    }),
  };
  const switched = await checkChain(depsOf(fakeChain(snapshot, { changes, unreadable: [ 'ethereum-mainnet' ] }), {
    kv,
    version:   withoutUsdc,
    versionId: 'version-without-usdc',
    now:       later(1),
  }));
  t.same(switched?.drifts, [], 'the drift of the market it dropped is not carried');
  t.same(switched?.unreadable.map(({ network }) => network), [ 'ethereum-mainnet' ], 'while its chain is unread all the same');
});

/*
 * A disabled market is not compared: nothing the registry serves describes
 * it, so its Comet is not asked, and what the chain says of it is no drift.
 * A network whose every market is disabled serves nothing, and is not read.
 */
t.test('a disabled market is not compared, and a network of them is not read', async t => {
  const weth    = marketOf('weth');
  const version = {
    ...snapshot,
    networks: snapshot.networks.map(network => ({
      ...network,
      markets: network.markets.map(market => (
        market.contracts.comet === USDC || network.key === 'scroll-mainnet' ? { ...market, status: 'disabled' as const } : market
      )),
    })),
  };
  const chain = fakeChain(snapshot, { changes: {
    [USDC]:                  { basePriceFeed: MOVED },
    [weth.contracts.comet!]: { basePriceFeed: MOVED },
  } });
  // the Comets the check asks anything of
  const comets = new Set<string>();
  const check  = await checkChain({
    ...depsOf(chain, { version }),
    transportFor: network => async calls => {
      calls.forEach(call => comets.add(call.params[0].to));
      return chain.transportFor(network)(calls);
    },
  });

  t.same(check?.drifts.map(({ market, field }) => ({ market, field })), [ { market: '1/weth', field: 'priceFeed' } ],
    'a feed the chain moved is a drift of the market served, and of none disabled');
  t.notOk(comets.has(USDC), 'whose Comet is not asked anything');
  t.ok(comets.has(weth.contracts.comet!), 'while the Comets of its network that are served are');
  t.same(Object.keys(rounds(chain)).sort(), [ 'base-mainnet', 'ethereum-mainnet' ],
    'and a network whose markets are all disabled is not read at all');
});

/*
 * The check is made once a day, by the first invocation of the day. One that
 * could not read a chain is made again an hour later, at the next
 * invocation; and a version switched on since the last check is checked at
 * the next invocation too, without waiting for the next day.
 */
t.test('the version on is checked once a day, again until every chain is read, and when another is switched on', async t => {
  const kv      = MemoryKv({});
  const answers = fakeChain(snapshot);
  const down    = fakeChain(snapshot, { unreadable: [ 'base-mainnet' ] });
  const checked = async (chain: FakeChain, hours: number, versionId = snapshot.registryVersion.id) =>
    (await checkChain(depsOf(chain, { kv, versionId, now: later(hours) }))) !== null;

  t.equal(await checked(answers, 0), true, 'the first invocation checks');
  t.equal(await checked(answers, 1), false, 'the next one does not');
  t.equal(await checked(answers, 22), false, 'nor does the last one of the day');
  t.equal(answers.asked.length, 6, 'and neither asked the chain anything');

  t.equal(await checked(down, 23), true, 'the first one of the next day checks again');
  t.equal(await checked(answers, 24), true, 'a check that did not read a chain is made again an hour later');
  t.equal(await checked(answers, 25), false, 'until it reads them all');

  t.equal(await checked(answers, 26, 'f0000000-0000-4000-8000-000000000002'), true,
    'a version switched on since is checked at the next invocation, whatever the day');
  t.equal(await checked(answers, 27, 'f0000000-0000-4000-8000-000000000002'), false,
    'and then once a day');
});

t.test('a version the database could not confirm is not checked', async t => {
  const chain = fakeChain(snapshot);
  const check = await checkChain({
    ...depsOf(chain),
    active: async () => ({ snapshot, staleFor: 120 }),
  });
  t.equal(check, null, 'it may no longer be the version on');
  t.same(chain.asked, [], 'so the chain is not asked');
});

// the Cron as the platform runs it, scheduled for `scheduledTime`, with the work it leaves to waitUntil finished
async function cron(env: Env, scheduledTime: number): Promise<'ok' | 'exception'> {
  const work: Array<Promise<unknown>> = [];
  const controller = { cron: '0 * * * *', scheduledTime, noRetry: () => {} };
  const context    = { waitUntil: (promise: Promise<unknown>) => { work.push(promise); }, passThroughOnException: () => {} };
  try {
    await C3Api.scheduled(controller as unknown as ScheduledController, env, context as unknown as ExecutionContext);
    return 'ok';
  } catch {
    return 'exception';
  } finally {
    await Promise.allSettled(work);
  }
}

/*
 * The registry of the Cron tests, with the fixture on: GitHub names the
 * commit it was imported from, and `chain` answers for its Comets.
 */
async function servedRegistry(
  t: Test,
  chainOf: (snapshot: RegistrySnapshotV1) => FakeChain,
): Promise<{ registry: RegistryDatabase, chain: FakeChain }> {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());

  const chain       = chainOf(registry.snapshot);
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    return request.url.endsWith('/commits/main')
      ? new Response(registry.snapshot.registryVersion.sourceCommitSha)
      : chain.fetch(request);
  }) as unknown as typeof globalThis.fetch;
  t.teardown(() => { globalThis.fetch = fetchBefore; });
  const warn = console.warn;
  console.warn = () => {};
  t.teardown(() => { console.warn = warn; });

  return { registry, chain };
}

/*
 * The case as it happened: the source still names the commit the version on
 * was imported from, so the daily discovery finds nothing to import — and the
 * chain has moved a feed since. The hourly job reads the chain all the same,
 * once that day, and the status names the drift, without anything being
 * imported or switched on by itself.
 */
t.test('the hourly job reads the chain once a day, the commit already imported, and the status says so', async t => {
  const { registry, chain } = await servedRegistry(t, served => fakeChain(served, {
    changes: { [USDC]: { collateralAssets: collateralOf('usdc', 2) } },
  }));
  const env   = makeTestEnv({ DEBUG: '', APP_DB: registry.db, kv_registry: MemoryKv({}) });
  const start = Date.now();
  const today = start - start % (DAY * 1000);

  t.equal(await cron(env, today), 'ok', 'the hourly job succeeds');
  const status = await registryStatus(env, cacheDepsOf(env));
  t.ok(status.alerts.includes('chain-drift'), 'the status raises the drift');
  t.same(status.chainCheck?.drifts.map(({ market, asset, field, current }) => ({ market, index: asset.assetIndex, field, current })), [
    { market: '1/usdc', index: 2, field: 'priceFeed', current: MOVED },
  ], 'naming it');
  t.equal(status.chainCheck?.checkedAt, new Date(today).toISOString(), 'as checked at the hour the job was scheduled for');
  t.ok(status.sync.upstreamCheckedAt !== null, 'while the import checked the source and found nothing to import');
  t.equal(status.active?.versionId, registry.versionId, 'and the version on is still the one it was');
  t.equal(await registry.db.prepare(`SELECT COUNT(*) AS n FROM registry_versions`).first<number>('n'), 1,
    'nothing was imported in its place');

  const asked = chain.asked.length;
  t.equal(await cron(env, today + HOUR), 'ok', 'the next invocation succeeds');
  t.equal(chain.asked.length, asked, 'and leaves the chain alone that day');
  t.equal(await cron(env, today + 24 * HOUR), 'ok');
  t.ok(chain.asked.length > asked, 'which the first invocation of the next day reads again');
});

/*
 * An administrative sync with nothing in its body checks the source when it
 * is due, in the hourly job's place. The chain check keeps its own time, so
 * the job reads the chain that day all the same.
 */
t.test('an administrative sync that checks the source leaves the chain to the hourly job', async t => {
  const { registry, chain } = await servedRegistry(t, served => fakeChain(served, {
    changes: { [USDC]: { basePriceFeed: MOVED } },
  }));
  const env = makeTestEnv({
    DEBUG:                            '',
    APP_DB:                           registry.db,
    kv_registry:                      MemoryKv({}),
    COMET_REGISTRY_ADMIN_TOKEN_HASH:  await sha256Hex('registry-admin-token-for-tests'),
    REGISTRY_ADMIN_RATE_LIMITER:      { limit: async () => ({ success: true }) },
    REGISTRY_ADMIN_AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });

  const response = await C3Api.fetch(new Request('https://api.test.local/registry/v1/admin/sync', {
    method:  'POST',
    headers: { 'Authorization': 'Bearer registry-admin-token-for-tests', 'Content-Type': 'application/json' },
    body:    '{}',
  }), env);
  t.equal(response.status, 200);
  t.match(await response.json(), { status: 'completed', outcome: 'no_change' },
    'the sync checked the source, which still names the commit on');
  t.ok((await registryStatus(env, cacheDepsOf(env))).sync.upstreamCheckedAt !== null, 'and recorded that it did');
  t.same(chain.asked, [], 'reading no chain');

  t.equal(await cron(env, Date.now()), 'ok', 'the hourly job that follows succeeds');
  const status = await registryStatus(env, cacheDepsOf(env));
  t.same(status.chainCheck?.drifts.map(({ market, field, current }) => ({ market, field, current })), [
    { market: '1/usdc', field: 'priceFeed', current: MOVED },
  ], 'and reads the chain, the source checked already');
  t.ok(status.alerts.includes('chain-drift'), 'which the status raises');
});
