import t from 'tap';

import { randomUUID } from 'node:crypto';

import type {
  Address,
  MarketV1,
  NetworkV1,
  ParsedRoot,
  PriceFeedV1,
} from '../../../lib/model/comet-registry.js';
import { CONTRACT_ROLES, CONTRACT_ROLE_KEYS } from '../../../lib/model/comet-registry.js';

import { applyMarketOverlay, applyNetworkOverlay, orderNetworks, overlayOfMarket } from '../../../src/registry/overlay.js';
import { readImportOverlays, readOverlays } from '../../../src/registry/overlay-store.js';
import type { ClonedOverlays } from '../../../src/registry/overlay-store.js';
import { activateVersion, snapshotChecksum } from '../../../src/registry/repository.js';
import type { MarketEnrichment } from '../../../src/registry/enrichment.js';

import { activateSeeded, loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';
import { registryHarness } from '../../util/registry-harness.js';
import { readActiveOverlays } from '../../util/registry-repository.js';

/*
 * Overlay cloning, against real local D1: the reviewed decisions of a stored
 * version are read back and reapplied to the same markets. The rebuilt
 * snapshot must be byte-identical to the one it was cloned from, which is
 * what lets an import inherit review instead of asking an operator to restate
 * it for every unchanged market.
 */
const { freshDatabase } = await registryHarness();

const snapshot = loadRegistrySnapshotFixture();

/*
 * The pinned-source and on-chain halves of a market, taken from the fixture
 * itself: this test is about the overlay half, so the other two are given.
 */
function rootOf(network: NetworkV1, market: MarketV1): ParsedRoot {
  const contracts = Object.fromEntries(
    CONTRACT_ROLES
      .map(role => [ role, market.contracts[CONTRACT_ROLE_KEYS[role]] ])
      .filter(([ , address ]) => address !== null)
  );
  return {
    rootPath:           `deployments/${network.upstreamKey}/${market.deploymentKey}/roots.json`,
    upstreamNetworkKey: network.upstreamKey,
    deploymentKey:      market.deploymentKey,
    network:            network.key,
    chainId:            network.chainId,
    sourceBlobSha:      'a'.repeat(40),
    contracts,
    otherRoots:         {},
    checksum:           'b'.repeat(64),
  };
}

function enrichmentOf(market: MarketV1): MarketEnrichment {
  return {
    baseToken:        market.baseAsset.token,
    basePriceFeed:    market.baseAsset.priceFeed,
    rewardToken:      market.rewardAsset?.token ?? null,
    collateralAssets: market.collateralAssets,
  };
}

/*
 * The feeds an overlay names, with the decimals enrichment would read for
 * them: the base USD conversion, the reward feed, and any remap replacement.
 */
function feedsOf(network: NetworkV1): Map<Address, PriceFeedV1> {
  const feeds = new Map<Address, PriceFeedV1>();
  for (const market of network.markets) {
    for (const feed of [ market.baseAsset.usdPriceFeed, market.rewardAsset?.priceFeed ]) {
      if (feed !== null && feed !== undefined) {
        feeds.set(feed.address, feed);
      }
    }
  }
  for (const exception of network.priceExceptions) {
    if (exception.kind === 'deprecated_price_remap') {
      feeds.set(exception.replacementPriceFeed.address, exception.replacementPriceFeed);
    }
  }
  return feeds;
}

t.test('a stored version yields the overlay it was built from', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);

  const overlays = await readOverlays(db, versionId);
  t.equal(overlays.networks.size, snapshot.networks.length, 'every network yields an overlay');
  t.equal(
    overlays.markets.size,
    snapshot.networks.reduce((total, network) => total + network.markets.length, 0),
    'so does every market',
  );

  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const network = overlays.networks.get(1)!;
  t.equal(network.displayName, mainnet.displayName);
  t.same(network.assetDisplayOverrides, mainnet.presentation.assetDisplayOverrides, 'presentation survives the round trip');
  t.same(
    network.priceExceptions.map(exception => [ exception.kind, exception.priceFeedAddress ]),
    mainnet.priceExceptions.map(exception => [ exception.kind, exception.priceFeedAddress ]),
    'price exceptions survive with their kinds',
  );

  const weth = mainnet.markets.find(market => market.deploymentKey === 'weth')!;
  t.same(overlays.markets.get('1/weth'), overlayOfMarket(weth), 'every reviewed decision of a market is recovered');

  const scroll = overlays.markets.get('534352/usdc')!;
  t.equal(scroll.rewardPriceFeed, null, 'a market with no reward feed clones without one');
});

t.test('cloned overlays rebuild the same snapshot', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  const overlays = await readOverlays(db, versionId);

  const rebuilt = orderNetworks(snapshot.networks.map(network => {
    const feeds = feedsOf(network);
    const markets = network.markets.map(market => applyMarketOverlay(
      rootOf(network, market),
      enrichmentOf(market),
      overlays.markets.get(`${network.chainId}/${market.deploymentKey}`)!,
      feeds,
      market.id,
    ));
    return applyNetworkOverlay(
      { chainId: network.chainId, key: network.key, upstreamKey: network.upstreamKey, testnet: network.testnet },
      overlays.networks.get(network.chainId)!,
      markets,
      feeds,
    );
  }));

  t.same(rebuilt, snapshot.networks, 'the rebuilt networks equal the frozen snapshot');
  t.equal(
    await snapshotChecksum(rebuilt),
    snapshot.registryVersion.checksum,
    'and reproduce its checksum, so a rediscovered market keeps its reviewed data',
  );
});

/*
 * What an overlay write records beside the rows it changes: one audit event
 * per scope it reviewed. An earlier attempt of a commit hands down what such
 * an event says was reviewed for it, and nothing else.
 */
async function reviewedIn(db: D1Database, versionId: string, scopes: Array<[ 'network' | 'market', string ]>): Promise<void> {
  await db.batch(scopes.map(([ scopeType, scopeKey ]) => db.prepare(
    `INSERT INTO registry_overlay_events (
       id, registry_version_id, scope_type, scope_key, previous_digest, new_digest, actor, reason, created_at
     ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'test-admin', 'reviewed', ?6)`
  ).bind(randomUUID(), versionId, scopeType, scopeKey, 'd'.repeat(64), new Date().toISOString())));
}

// every network and market a seeded candidate holds, as the scopes an overlay names them by
function scopesOf(networks: NetworkV1[]): Array<[ 'network' | 'market', string ]> {
  return networks.flatMap(network => [
    [ 'network', String(network.chainId) ] as [ 'network', string ],
    ...network.markets.map(market => [ 'market', `${network.chainId}/${market.deploymentKey}` ] as [ 'market', string ]),
  ]);
}

t.test('the active overlay is what an import inherits', async t => {
  const db = await freshDatabase();

  t.same(
    await readActiveOverlays(db),
    { networks: new Map(), markets: new Map(), comets: new Map() },
    'before the first activation there is nothing to inherit',
  );

  const { versionId } = await seedCandidate(db, snapshot);
  await activateSeeded(db, versionId);

  const active = await readActiveOverlays(db);
  t.equal(active.networks.size, snapshot.networks.length, 'the active version supplies network overlays');
  t.equal(active.markets.get('1/usdc')?.displayName, 'USDC', 'and market overlays');
  t.equal(active.comets.get('1/usdc'), snapshot.networks[0]!.markets.find(market => market.deploymentKey === 'usdc')!.contracts.comet,
    'each with the Comet it was made for');
});

/*
 * Attempts of one commit accumulate review: a market reviewed for an attempt
 * that later failed is not reviewed again for the next one. Reading only the
 * attempt before this one would lose what an earlier attempt decided about a
 * market that attempt never imported.
 */
t.test('an attempt inherits what every earlier attempt of the commit reviewed', async t => {
  const db = await freshDatabase();

  const first = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 1 });
  await db.prepare(`UPDATE markets SET display_name = 'reviewed first' WHERE registry_version_id = ?1`)
    .bind(first.versionId).run();
  await reviewedIn(db, first.versionId, scopesOf(snapshot.networks));

  /*
   * The second attempt failed before it reached the mainnet weth market, so
   * it has nothing to say about it — and it renamed the one it did import.
   */
  const second = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await db.batch([
    db.prepare(
      `DELETE FROM markets WHERE registry_version_id = ?1 AND deployment_key = 'weth'`
    ).bind(second.versionId),
    db.prepare(
      `UPDATE markets SET display_name = 'reviewed again' WHERE registry_version_id = ?1`
    ).bind(second.versionId),
  ]);
  await reviewedIn(db, second.versionId, scopesOf(snapshot.networks).filter(([ , key ]) => key !== '1/weth'));

  const third     = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 3 });
  const inherited = await readImportOverlays(db, third.versionId);

  t.equal(inherited.markets.get('1/usdc')?.displayName, 'reviewed again',
    'the latest attempt that reviewed a market decides it');
  t.equal(inherited.markets.get('1/weth')?.displayName, 'reviewed first',
    'and a market only an earlier attempt reviewed keeps that review');
  t.equal(inherited.networks.get(1)?.displayName, snapshot.networks.find(network => network.chainId === 1)!.displayName,
    'networks are inherited the same way');
});

/*
 * An attempt's rows are all marked reviewed, but most of them are copies of
 * the version that was on when it was imported. That version can be replaced
 * before the next attempt of the commit — by a hotfix, or by a rollback — and
 * its copies must not bring the replaced decisions back over the ones on now.
 * What the attempt hands down is what was reviewed for it.
 */
t.test('an attempt hands down what was reviewed for it, not its copies of a version since replaced', async t => {
  const db = await freshDatabase();

  const before = await seedCandidate(db, snapshot, { versionId: randomUUID(), commitSha: 'b'.repeat(40) });
  await activateSeeded(db, before.versionId);

  // the attempt copied what was on, and a market of it was reviewed in place
  const first = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 1 });
  await db.prepare(
    `UPDATE markets SET display_name = 'WETH, reviewed for the attempt' WHERE registry_version_id = ?1 AND deployment_key = 'weth'`
  ).bind(first.versionId).run();
  await reviewedIn(db, first.versionId, [ [ 'market', '1/weth' ] ]);

  // then a hotfix renamed another market of the version that is on
  const hotfix = await seedCandidate(db, snapshot, { versionId: randomUUID(), commitSha: 'c'.repeat(40) });
  await db.batch([
    db.prepare(
      `UPDATE markets SET display_name = 'USDC, hotfixed' WHERE registry_version_id = ?1 AND deployment_key = 'usdc'
       AND network_id = (SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1)`
    ).bind(hotfix.versionId),
    db.prepare(`UPDATE registry_networks SET display_name = 'Ethereum, hotfixed' WHERE registry_version_id = ?1 AND chain_id = 1`)
      .bind(hotfix.versionId),
  ]);
  await activateSeeded(db, hotfix.versionId);

  const second    = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  const inherited = await readImportOverlays(db, second.versionId);
  t.equal(inherited.markets.get('1/usdc')?.displayName, 'USDC, hotfixed',
    'a market the attempt only copied takes what is on now');
  t.equal(inherited.networks.get(1)?.displayName, 'Ethereum, hotfixed', 'and so does a network');
  t.equal(inherited.markets.get('1/weth')?.displayName, 'WETH, reviewed for the attempt',
    'while what was reviewed for the attempt is handed down over it');
});

/*
 * A market overlay comes with the Comet it was made for, from the same row
 * as the overlay that wins: a key the commit gives another Comet, reviewed
 * for an earlier attempt, hands that review down for the Comet it reviewed,
 * not for the one the version on holds under the key.
 */
t.test('a market overlay is handed down with the Comet it was made for', async t => {
  const db = await freshDatabase();
  const on = await seedCandidate(db, snapshot, { versionId: randomUUID(), commitSha: 'b'.repeat(40) });
  await activateSeeded(db, on.versionId);

  const comet = '0x1111111111111111111111111111111111111111';
  const first = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 1 });
  await db.prepare(
    `UPDATE market_contracts SET address = ?2 WHERE role = 'comet' AND market_id = (
       SELECT id FROM markets WHERE registry_version_id = ?1 AND deployment_key = 'weth'
     )`
  ).bind(first.versionId, comet).run();
  await reviewedIn(db, first.versionId, [ [ 'market', '1/weth' ] ]);

  const second    = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  const inherited = await readImportOverlays(db, second.versionId);
  const mainnet   = snapshot.networks.find(network => network.chainId === 1)!;
  t.equal(inherited.comets.get('1/weth'), comet, 'the review an earlier attempt made is handed down with the Comet it reviewed');
  t.equal(inherited.comets.get('1/usdc'), mainnet.markets.find(market => market.deploymentKey === 'usdc')!.contracts.comet,
    'and what the version on decided, with the Comet it decided it for');
});

// renames a mainnet market of a version in place, as a review of it does
async function rename(db: D1Database, versionId: string, deploymentKey: string, displayName: string): Promise<void> {
  await db.prepare(
    `UPDATE markets SET display_name = ?3 WHERE registry_version_id = ?1 AND deployment_key = ?2
     AND network_id = (SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1)`
  ).bind(versionId, deploymentKey, displayName).run();
}

const nameOf = (deploymentKey: string) => snapshot.networks.find(network => network.chainId === 1)!.markets
  .find(market => market.deploymentKey === deploymentKey)!.displayName;

/*
 * An attempt switched on and then off hands nothing down: what was reviewed
 * for it was decided against when it was switched off. So was what the
 * attempts before it reviewed, which it carried when it went on.
 */
t.test('an attempt switched on and then off hands down nothing that was reviewed for it', async t => {
  const db = await freshDatabase();
  const first = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 1 });
  await activateSeeded(db, first.versionId);

  const second = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await rename(db, second.versionId, 'weth', 'WETH, switched off');
  await reviewedIn(db, second.versionId, [ [ 'market', '1/weth' ] ]);
  await activateSeeded(db, second.versionId);
  await activateVersion(db, { versionId: first.versionId, action: 'rollback', actor: 'test-admin', reason: 'test' });

  const third = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 3 });
  t.equal((await readImportOverlays(db, third.versionId)).markets.get('1/weth')?.displayName, nameOf('weth'),
    'the next attempt takes what is on');
});

t.test('a review carried into an attempt switched on and then off is not handed down either', async t => {
  const db = await freshDatabase();
  const first = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 1 });
  await activateSeeded(db, first.versionId);

  // a draft never switched on reviewed weth
  const second = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await rename(db, second.versionId, 'weth', 'WETH, reviewed for the draft');
  await reviewedIn(db, second.versionId, [ [ 'market', '1/weth' ] ]);

  // the attempt after it inherited that review, reviewed usdc, and was switched on and off
  const third = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 3 });
  await rename(db, third.versionId, 'weth', 'WETH, reviewed for the draft');
  await rename(db, third.versionId, 'usdc', 'USDC, switched off');
  await reviewedIn(db, third.versionId, [ [ 'market', '1/usdc' ] ]);
  await activateSeeded(db, third.versionId);
  await activateVersion(db, { versionId: first.versionId, action: 'rollback', actor: 'test-admin', reason: 'test' });

  const fourth    = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 4 });
  const inherited = await readImportOverlays(db, fourth.versionId);
  t.equal(inherited.markets.get('1/weth')?.displayName, nameOf('weth'), 'the draft\'s review went off with the attempt that carried it');
  t.equal(inherited.markets.get('1/usdc')?.displayName, nameOf('usdc'), 'and so did that attempt\'s own');
});

/*
 * A review still waiting to be switched on is handed down whatever else is
 * switched on and off meanwhile: a hotfix of another commit replacing the
 * attempt that was on decided nothing about it.
 */
t.test('a review waiting to be switched on is handed down past a hotfix', async t => {
  const db = await freshDatabase();
  const first = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 1 });
  await activateSeeded(db, first.versionId);

  const second = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await rename(db, second.versionId, 'weth', 'WETH, reviewed for the draft');
  await reviewedIn(db, second.versionId, [ [ 'market', '1/weth' ] ]);

  const hotfix = await seedCandidate(db, snapshot, { versionId: randomUUID(), commitSha: 'c'.repeat(40) });
  await activateSeeded(db, hotfix.versionId);

  const third = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 3 });
  t.equal((await readImportOverlays(db, third.versionId)).markets.get('1/weth')?.displayName, 'WETH, reviewed for the draft',
    'the draft\'s review is still handed down');
});

/*
 * A version has one default market, and the versions an import merges can
 * each name another: the attempt that moved the default, and a version
 * switched on since that moved it elsewhere. The merge keeps one, the one
 * read at the highest precedence, so the import does not write two — which
 * the schema refuses — on every attempt of the commit.
 */
t.test('the overlays an import merges name one default market', async t => {
  const db = await freshDatabase();

  // an attempt that moved the default from mainnet usdc to mainnet weth
  const first = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 1 });
  await db.batch([
    db.prepare(`UPDATE markets SET is_default = 0 WHERE registry_version_id = ?1`).bind(first.versionId),
    db.prepare(`UPDATE markets SET is_default = 1 WHERE registry_version_id = ?1 AND deployment_key = 'weth'`)
      .bind(first.versionId),
  ]);
  await reviewedIn(db, first.versionId, [ [ 'market', '1/usdc' ], [ 'market', '1/weth' ] ]);

  // and a version switched on since, whose default is on Scroll
  const since = await seedCandidate(db, snapshot, { versionId: randomUUID(), commitSha: 'c'.repeat(40) });
  await db.batch([
    db.prepare(`UPDATE markets SET is_default = 0 WHERE registry_version_id = ?1`).bind(since.versionId),
    db.prepare(
      `UPDATE markets SET is_default = 1 WHERE registry_version_id = ?1
       AND network_id = (SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 534352)`
    ).bind(since.versionId),
  ]);
  await activateSeeded(db, since.versionId);

  const second    = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  const inherited = await readImportOverlays(db, second.versionId);
  const defaults  = [ ...inherited.markets ].filter(([ , overlay ]) => overlay.isDefault).map(([ key ]) => key);
  t.same(defaults, [ '1/weth' ], 'the default the attempt decided is the one kept');
  t.equal(inherited.markets.get('534352/usdc')?.isDefault, false, 'and the one switched on since is merged as not the default');
  t.equal(inherited.markets.get('534352/usdc')?.displayName, snapshot.networks.find(network => network.chainId === 534352)!
    .markets[0]!.displayName, 'with the rest of its decisions as they are');
});

/*
 * An expiry used to be stored as it was written, if Date.parse took it, and
 * Date.parse takes years RFC 3339 does not write. Every import of a commit and
 * every overlay written to a draft reads the stored overlays first, so a
 * version holding one has to read back all the same: as the instant it names,
 * in the years 0000 to 9999.
 */
t.test('an expiry stored in an older form is read back as the instant it names', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  const [ exception ] = snapshot.networks.find(network => network.chainId === 1)!.priceExceptions;
  const expiryOf = (overlays: ClonedOverlays) => overlays.networks.get(1)?.priceExceptions
    .find(entry => entry.priceFeedAddress === exception!.priceFeedAddress)?.expiresAt;

  for (const [ stored, read, what ] of [
    [ 'Mon, 21 Sep 2026 11:00:00 GMT', '2026-09-21T11:00:00.000Z', 'a date in words' ],
    [ '2026-09-21T13:00:00+02:00',     '2026-09-21T11:00:00.000Z', 'an instant with an offset' ],
    [ '0026-09-21T00:00:00Z',          '0026-09-21T00:00:00.000Z', 'a year before 100' ],
    [ '+275760-09-13T00:00:00Z',       '9999-12-31T23:59:59.999Z', 'a year after 9999, as the last instant RFC 3339 writes' ],
    [ '-000001-01-01T00:00:00Z',       '0000-01-01T00:00:00.000Z', 'a year before 0000, as the first' ],
  ] as const) {
    await db.prepare(
      `UPDATE network_price_exceptions SET expires_at = ?1 WHERE registry_version_id = ?2 AND price_feed_address = ?3`
    ).bind(stored, versionId, exception!.priceFeedAddress).run();
    t.equal(expiryOf(await readOverlays(db, versionId)), read, what);
  }

  await reviewedIn(db, versionId, [ [ 'network', '1' ] ]);
  const next = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  t.equal(expiryOf(await readImportOverlays(db, next.versionId)), '0000-01-01T00:00:00.000Z',
    'and the next attempt of the commit inherits it, as reviewed for the attempt before');
});
