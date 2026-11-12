import t from 'tap';

import type * as jsonRpc from '../../../lib/json-rpc.js';
import type { Address, PriceFeedV1 } from '../../../lib/model/comet-registry.js';

import { overlayDocuments } from '../../../src/registry/admin-router.js';
import { CreationReader, FeedReader, replaceMarketOverlay, replaceNetworkOverlay, replaceOverlays } from '../../../src/registry/admin.js';
import { readCreationBlocks, readFeeds } from '../../../src/registry/enrichment.js';
import { overlayOfMarket } from '../../../src/registry/overlay.js';
import { readSnapshot } from '../../../src/registry/repository.js';
import { asApiError } from '../../../src/registry/router.js';
import { bodyFor } from '../../util/registry-seed.js';

import { loadRegistrySnapshotFixture, overlayOfNetwork, seedCandidate } from '../../util/registry-fixture.js';
import { registryHarness } from '../../util/registry-harness.js';

/*
 * What an overlay write reads of the chain: the scale of a feed it
 * introduces, and whether a creation block it states is the block the
 * market's Comet was deployed in.
 *
 * What the chain answers decides whose problem it is. A feed that reverts,
 * or an address with no code on that chain — a feed of another chain is the
 * usual one — is the document naming something that is not a feed there:
 * the document has to change, which is a 422 naming the feed. So is a
 * creation block the chain contradicts. A node that did not serve the read
 * says nothing about the document, and is a 503 worth trying again.
 */
const { freshDatabase } = await registryHarness();

const snapshot = loadRegistrySnapshotFixture();
const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;
const usdc     = mainnet.markets.find(market => market.deploymentKey === 'usdc')!;

// a reward feed the version has never stored, so its decimals are read from the chain
const FEED = '0x00000000000000000000000000000000000000f1' as Address;

async function freshCandidate(): Promise<{ db: D1Database, versionId: string }> {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  return { db, versionId };
}

// a chain that answers every read the way `answer` says, through the reader the importer uses
function chainAnswering(answer: { result: string } | { error: jsonRpc.Error }): FeedReader {
  const transport = async (calls: jsonRpc.Call[]) => calls.map(() => answer);
  return (network, addresses) => readFeeds(transport, addresses, network);
}

// the document keeps the market's creation block, so only the feed is read
function rewardFeed(db: D1Database, versionId: string, readFeeds: FeedReader) {
  return replaceMarketOverlay(db, {
    versionId,
    chainId:       1,
    deploymentKey: 'usdc',
    actor:         'test-admin',
    reason:        'price the rewards with another feed',
    overlay:       { ...overlayOfMarket(usdc), rewardPriceFeed: { address: FEED, quote: 'usd' } },
  }, readFeeds, async () => []);
}

t.test('a feed the chain answers for, but not with decimals, is the document\'s to fix', async t => {
  const { db, versionId } = await freshCandidate();

  for (const [ what, answer ] of [
    [ 'a feed that reverts',                    { error: { code: 3, message: 'execution reverted' } } ],
    [ 'an address with no code on that chain',  { result: '0x' } ],
    [ 'an answer that does not decode',         { result: '0x1234' } ],
  ] as const) {
    const failure = await rewardFeed(db, versionId, chainAnswering(answer)).then(() => null, (error: unknown) => error as Error & { code?: string });
    t.equal(failure?.code, 'OVERLAY_FEED_UNREADABLE', `${what} is a feed the overlay cannot use`);
    t.match(failure?.message, FEED, 'naming the feed');
    t.equal(asApiError(failure)?.status, 422, 'which is answered 422, not as a provider that is down');
  }

  const limited = await rewardFeed(db, versionId, chainAnswering({ error: { code: -32005, message: 'limit exceeded' } }))
    .then(() => null, (error: unknown) => error as Error & { code?: string });
  t.equal(limited?.code, 'CHAIN_REQUEST_FAILED', 'a node that did not serve the read is not the document\'s mistake');
  t.equal(asApiError(limited)?.status, 503, 'and is answered 503, worth trying again');

  const written = await rewardFeed(db, versionId, chainAnswering({ result: `0x${(18).toString(16).padStart(64, '0')}` }));
  t.equal(written.changed, true, 'a feed that answers its decimals is written');
  t.equal(await db.prepare(
    `SELECT asset.price_feed_decimals FROM market_assets AS asset
     JOIN markets AS market ON market.id = asset.market_id
     JOIN registry_networks AS network ON network.id = market.network_id
     WHERE asset.registry_version_id = ?1 AND network.chain_id = 1 AND market.deployment_key = 'usdc' AND asset.role = 'reward'`
  ).bind(versionId).first<number>('price_feed_decimals'), 18, 'with the decimals the chain answered');
});

/*
 * A remap names the feed to read instead, never its scale: the chain answers
 * that, and the remap is stored and served with it, as an import stores one.
 */
t.test('a remap is stored with the decimals the chain answers for the feed it reads instead', async t => {
  const { db, versionId } = await freshCandidate();
  const overlay = overlayOfNetwork(mainnet);
  const remap   = {
    kind:                        'deprecated_price_remap',
    priceFeedAddress:            '0x00000000000000000000000000000000000000f2',
    replacementPriceFeedAddress: FEED,
    provenance:                  'the feed was replaced',
    expiresAt:                   null,
  };

  const written = await replaceNetworkOverlay(db, {
    versionId,
    chainId: 1,
    actor:   'test-admin',
    reason:  'read the replacement feed instead',
    overlay: { ...overlay, priceExceptions: [ ...overlay.priceExceptions, remap ] },
  }, chainAnswering({ result: `0x${(18).toString(16).padStart(64, '0')}` }));
  t.equal(written.changed, true);

  const stored = await db.prepare(
    `SELECT replacement_price_feed_address AS address, replacement_price_feed_decimals AS decimals
     FROM network_price_exceptions WHERE registry_version_id = ?1 AND kind = 'deprecated_price_remap'`
  ).bind(versionId).all<{ address: string, decimals: number }>();
  t.same(stored.results, [ { address: FEED, decimals: 18 } ], 'the replacement is stored with the decimals the chain answered');

  const served = (await readSnapshot(db, versionId)).find(network => network.chainId === 1)!.priceExceptions;
  t.same(served.find(exception => exception.kind === 'deprecated_price_remap'), {
    kind:                 'deprecated_price_remap',
    priceFeedAddress:     remap.priceFeedAddress,
    replacementPriceFeed: { address: FEED, decimals: 18 },
    provenance:           remap.provenance,
    expiresAt:            null,
  }, 'and the version serves the remap with them');
});

// the feeds every document below names are ones the version already knows
const knownFeeds: FeedReader = async () => new Map<Address, PriceFeedV1>();

/*
 * A chain whose latest block is `head`, where every Comet has code from block
 * `deployed` on, answering through the reader the overlay routes use.
 */
function chainDeployedAt(deployed: number, head: number = deployed + 1_000_000): CreationReader {
  const transport = async (calls: jsonRpc.Call[]) => calls.map(call => call.method === 'eth_blockNumber'
    ? { result: `0x${head.toString(16)}` }
    : { result: Number.parseInt(call.params[1] as string, 16) >= deployed ? '0x6080604052' : '0x' });
  return (network, markets) => readCreationBlocks(transport, markets, network);
}

// a node provider that does not answer
const chainDown: CreationReader = (network, markets) => readCreationBlocks(async () => {
  throw new TypeError('fetch failed');
}, markets, network);

type Asked = { network: string, markets: Array<{ scope: string, comet: Address | null, block: number }> };

// a reader that finds every block right, and keeps what it was asked
function askedOf(): { readCreations: CreationReader, asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    readCreations: async (network, markets) => {
      asked.push({ network, markets });
      return [];
    },
    asked,
  };
}

function creationBlock(
  db: D1Database,
  versionId: string,
  readCreations: CreationReader,
  changes: { creationBlock: number, status?: 'enabled' | 'disabled', displayName?: string },
) {
  return replaceMarketOverlay(db, {
    versionId,
    chainId:       1,
    deploymentKey: 'usdc',
    actor:         'test-admin',
    reason:        'state when the market was deployed',
    overlay:       { ...overlayOfMarket(usdc), isDefault: changes.status !== 'disabled', ...changes },
  }, knownFeeds, readCreations);
}

const storedBlock = (db: D1Database, versionId: string) => db.prepare(
  `SELECT market.creation_block FROM markets AS market
   JOIN registry_networks AS network ON network.id = market.network_id
   WHERE market.registry_version_id = ?1 AND network.chain_id = 1 AND market.deployment_key = 'usdc'`
).bind(versionId).first<number>('creation_block');

const eventsOf = (db: D1Database, versionId: string) => db.prepare(
  `SELECT COUNT(*) AS n FROM registry_overlay_events WHERE registry_version_id = ?1`
).bind(versionId).first<number>('n');

/*
 * The creation block is where every index of a market starts, and the block
 * a Comet was deployed in is the one where it has code and had none the block
 * before. A block that is not that one is the document's to fix, and nothing
 * of the document is written.
 */
t.test('a creation block the chain contradicts is the document\'s to fix', async t => {
  const { db, versionId } = await freshCandidate();
  const deployed = usdc.creationBlock + 100;

  for (const [ what, block, head, message ] of [
    [ 'a block past the latest one',           deployed + 10, deployed + 5, /^overlay\.creationBlock \d+ is past the latest block, \d+$/ ],
    [ 'a block before the Comet was deployed', deployed - 1,  undefined,    /^overlay\.creationBlock \d+ is before the Comet 0x[0-9a-f]{40} was deployed: it has no code at that block$/ ],
    [ 'a block after it was',                  deployed + 1,  undefined,    /^overlay\.creationBlock \d+ is after the Comet 0x[0-9a-f]{40} was deployed: it has code at block \d+$/ ],
  ] as const) {
    const failure = await creationBlock(db, versionId, chainDeployedAt(deployed, head), { creationBlock: block })
      .then(() => null, (error: unknown) => error as Error & { code?: string });
    t.equal(failure?.code, 'OVERLAY_CREATION_BLOCK_WRONG', `${what} is refused`);
    t.match(failure?.message, message, 'saying what is wrong with it');
    t.equal(asApiError(failure)?.status, 422, 'which is answered 422, as the document\'s mistake');
  }
  t.equal(await storedBlock(db, versionId), usdc.creationBlock, 'the market keeps the block it had');
  t.equal(await eventsOf(db, versionId), 0, 'and nothing is recorded');

  const down = await creationBlock(db, versionId, chainDown, { creationBlock: deployed })
    .then(() => null, (error: unknown) => error as Error & { code?: string });
  t.equal(down?.code, 'CHAIN_REQUEST_FAILED', 'a node that did not answer is not the document\'s mistake');
  t.equal(asApiError(down)?.status, 503, 'and is answered 503, worth trying again');

  const written = await creationBlock(db, versionId, chainDeployedAt(deployed), { creationBlock: deployed });
  t.equal(written.changed, true, 'the block the Comet was deployed in is written');
  t.equal(await storedBlock(db, versionId), deployed, 'and is the block the market holds');
});

/*
 * A document that keeps the block reads nothing of the chain for it, as one
 * that keeps its feeds does. One that changes it has it checked whether or
 * not it serves the market, so a later document that switches the market on
 * and keeps the block serves a block that was checked.
 */
t.test('a creation block is read from the chain only when a document changes it', async t => {
  const { db, versionId } = await freshCandidate();
  const { readCreations, asked } = askedOf();

  await creationBlock(db, versionId, readCreations, { creationBlock: usdc.creationBlock, displayName: 'Renamed' });
  t.same(asked, [], 'a document that keeps the block reads nothing for it');

  await creationBlock(db, versionId, readCreations, { creationBlock: 0, status: 'disabled' });
  t.same(asked, [], 'and neither does one that switches the market off stating none');

  await creationBlock(db, versionId, readCreations, { creationBlock: usdc.creationBlock, status: 'disabled' });
  t.same(asked, [ {
    network: 'ethereum-mainnet',
    markets: [ { scope: 'overlay', comet: usdc.contracts.comet, block: usdc.creationBlock } ],
  } ], 'a block stated for a market switched off is checked all the same');

  await creationBlock(db, versionId, readCreations, { creationBlock: usdc.creationBlock });
  t.equal(asked.length, 1, 'so switching the market on with it reads nothing more');
});

t.test('a directory has its creation blocks checked one network a read', async t => {
  const { db, versionId } = await freshCandidate();
  const { readCreations, asked } = askedOf();
  const base   = snapshot.networks.find(network => network.chainId === 8453)!;
  const market = (network: typeof base, key: string) => network.markets.find(entry => entry.deploymentKey === key)!;
  const moved  = (network: typeof base, key: string) => ({
    ...overlayOfMarket(market(network, key)),
    creationBlock: market(network, key).creationBlock + 1,
  });

  await replaceOverlays(db, {
    versionId,
    actor:    'test-admin',
    reason:   'state when the markets were deployed',
    networks: [],
    markets:  [
      { chainId: 1,    deploymentKey: 'usdc', overlay: moved(mainnet, 'usdc') },
      { chainId: 8453, deploymentKey: 'aero', overlay: moved(base, 'aero') },
      { chainId: 1,    deploymentKey: 'usdt', overlay: overlayOfMarket(market(mainnet, 'usdt')) },
      { chainId: 1,    deploymentKey: 'weth', overlay: moved(mainnet, 'weth') },
    ],
  }, knownFeeds, readCreations);

  t.same([ ...asked ].sort((left, right) => left.network.localeCompare(right.network)), [
    { network: 'base-mainnet', markets: [
      { scope: 'markets.8453/aero', comet: market(base, 'aero').contracts.comet, block: market(base, 'aero').creationBlock + 1 },
    ] },
    { network: 'ethereum-mainnet', markets: [
      { scope: 'markets.1/usdc', comet: market(mainnet, 'usdc').contracts.comet, block: market(mainnet, 'usdc').creationBlock + 1 },
      { scope: 'markets.1/weth', comet: market(mainnet, 'weth').contracts.comet, block: market(mainnet, 'weth').creationBlock + 1 },
    ] },
  ], 'each network is read once, for the markets whose block the directory changes, named by their keys');
});

/*
 * A first import states no creation block, since nobody has decided one
 * (provisionalMarketOverlay), so the seed an environment's first review
 * sends states every one: each is checked, one read a network, before
 * anything of the seed is written.
 */
t.test('the seed for a first import has every creation block it states checked', async t => {
  const { db, versionId } = await freshCandidate();
  await db.batch([
    db.prepare(
      `UPDATE markets SET creation_block = 0, status = 'disabled', is_default = 0, reviewed = 0 WHERE registry_version_id = ?1`
    ).bind(versionId),
    db.prepare(`UPDATE registry_networks SET reviewed = 0 WHERE registry_version_id = ?1`).bind(versionId),
  ]);
  const seed   = overlayDocuments(bodyFor(snapshot), versionId, 'test-admin');
  const seeded = (chainId: number, key: string) => (seed.markets
    .find(market => market.chainId === chainId && market.deploymentKey === key)!.overlay as { creationBlock: number }).creationBlock;

  const contradicted = await replaceOverlays(db, seed, knownFeeds, async (network, markets) => (
    network === 'base-mainnet' ? markets.map(({ scope }) => `${scope}.creationBlock is not the block its Comet was deployed in`) : []
  )).then(() => null, (error: unknown) => error as Error & { code?: string });
  t.equal(contradicted?.code, 'OVERLAY_CREATION_BLOCK_WRONG', 'one block the chain contradicts refuses the seed');
  t.equal(await eventsOf(db, versionId), 0, 'and nothing of it is written');

  const { readCreations, asked } = askedOf();
  const written = await replaceOverlays(db, seed, knownFeeds, readCreations);
  t.equal(written.changed, true, 'with every block right, the seed is written');
  t.same(
    asked
      .map(({ network, markets }) => ({ network, markets: [ ...markets ].sort((left, right) => left.scope.localeCompare(right.scope)) }))
      .sort((left, right) => left.network.localeCompare(right.network)),
    snapshot.networks
      .map(network => ({
        network: network.key,
        markets: network.markets
          .map(market => ({
            scope: `markets.${network.chainId}/${market.deploymentKey}`,
            comet: market.contracts.comet,
            block: seeded(network.chainId, market.deploymentKey),
          }))
          .sort((left, right) => left.scope.localeCompare(right.scope)),
      }))
      .sort((left, right) => left.network.localeCompare(right.network)),
    'each network was read once, for the block the seed states for every market',
  );
  t.ok(asked.every(({ markets }) => markets.every(({ block }) => block > 0)), 'which is a block for each of them');
  t.equal(await storedBlock(db, versionId), seeded(1, 'usdc'), 'and is the block the market then holds');
});
