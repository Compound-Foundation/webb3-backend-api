import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type * as KnownNetwork from '../../lib/well-known/networks/network.js';
import type { Address, MarketV1, NetworkV1, RegistryComet, RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';
import type { Catalog } from '../../src/registry/catalog.js';
import { catalogOf } from '../../src/registry/catalog.js';
import type { NetworkOverlay } from '../../src/registry/overlay.js';
import { orderNetworks, overlayOfException } from '../../src/registry/overlay.js';
import {
  activateVersion,
  createCandidate,
  markValidated,
  marketWrites,
  readSnapshot,
  recordValidationResults,
  snapshotChecksum,
} from '../../src/registry/repository.js';

/*
 * Loads the frozen RegistrySnapshotV1 fixture and seeds it into D1 as an
 * importing candidate. Writing goes through the writes the importer makes, so
 * tests exercise the same mapping it uses rather than a second copy of it.
 * tests/lib/registry/registry-snapshot-v1-fixture.test.ts is what enforces
 * the contract of the file itself.
 */
const FIXTURE_PATH = './tests/fixtures/registry/registry-snapshot-v1.json';

function loadRegistrySnapshotFixture(): RegistrySnapshotV1 {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

/*
 * The fixture as a request catalog, for tests of computations that resolve
 * markets and tokens through the registry. It is the same materialization the
 * worker builds per request, so a test exercises the path production takes.
 */
function fixtureCatalog(snapshot: RegistrySnapshotV1 = loadRegistrySnapshotFixture()): Catalog {
  return catalogOf(snapshot);
}

/*
 * One Comet of the fixture, as the catalog materializes it: the only kind of
 * Comet a computation is handed, so the one a test of a computation hands it.
 */
function fixtureComet(network: KnownNetwork.Name, address: string): RegistryComet {
  const comet = fixtureCatalog().marketAt(network, address as Address)?.comet;
  if (comet === undefined) {
    throw new Error(`the registry fixture has no market at ${address} on ${network}`);
  }
  return comet;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// the rows a snapshot is written as, by table
type SnapshotCounts = {
  networks:        number,
  markets:         number,
  tokens:          number,
  contracts:       number,
  assets:          number,
  priceExceptions: number,
};

function tokensOf(market: MarketV1): string[] {
  return [
    market.baseAsset.token.address,
    ...(market.rewardAsset === null ? [] : [ market.rewardAsset.token.address ]),
    ...market.collateralAssets.map(asset => asset.token.address),
  ];
}

/*
 * Writes a whole snapshot into an importing candidate, the way an import
 * writes it: market by market, each network with its first market, and the
 * tokens of a network once however many of its markets name them. A whole
 * snapshot is a document someone decided, so every row is written as
 * reviewed. What it reports is the rows the snapshot describes, which a test
 * checks the database against.
 *
 * A network without markets is refused before anything is written: an import
 * writes a network only with its first market, so that network would not be
 * written, and the rows reported would not be the rows the database holds.
 */
async function writeCandidateSnapshot(db: D1Database, versionId: string, networks: NetworkV1[]): Promise<SnapshotCounts> {
  const empty = networks.find(network => network.markets.length === 0);
  if (empty !== undefined) {
    throw new Error(`the snapshot's network ${empty.key} has no markets, and an import writes a network only with its first market`);
  }
  for (const network of networks) {
    for (const market of network.markets) {
      const writes = await marketWrites(db, versionId, { network, market, networkReviewed: true, marketReviewed: true });
      await db.batch(writes());
    }
  }
  const markets = networks.flatMap(network => network.markets);
  return {
    networks:        networks.length,
    markets:         markets.length,
    tokens:          networks.reduce((total, network) => total + new Set(network.markets.flatMap(tokensOf)).size, 0),
    contracts:       markets.reduce((total, market) => total + Object.values(market.contracts).filter(address => address !== null).length, 0),
    assets:          markets.reduce((total, market) => total + tokensOf(market).length, 0),
    priceExceptions: networks.reduce((total, network) => total + network.priceExceptions.length, 0),
  };
}

/*
 * Removes the snapshot rows of a candidate, which the triggers allow only
 * while it is importing.
 */
async function clearCandidateSnapshot(db: D1Database, versionId: string): Promise<void> {
  await db.batch([
    // assets and contracts follow their markets and networks by cascade
    db.prepare(`DELETE FROM market_assets WHERE registry_version_id = ?1`).bind(versionId),
    db.prepare(`DELETE FROM markets WHERE registry_version_id = ?1`).bind(versionId),
    db.prepare(`DELETE FROM tokens WHERE registry_version_id = ?1`).bind(versionId),
    db.prepare(`DELETE FROM network_price_exceptions WHERE registry_version_id = ?1`).bind(versionId),
    db.prepare(`DELETE FROM registry_networks WHERE registry_version_id = ?1`).bind(versionId),
  ]);
}

type SeedOptions = {
  // defaults to the fixture's own version id
  versionId?: string,
  attempt?:   number,
  // defaults to the fixture's own commit, so seeded candidates are attempts of one commit
  commitSha?: string,
};

type SeededCandidate = {
  versionId:        string,
  snapshotChecksum: string,
  // row counts by table, so a test can assert what reached the database
  counts:           Record<string, number>,
};

async function seedCandidate(
  db: D1Database,
  snapshot: RegistrySnapshotV1,
  options: SeedOptions = {},
): Promise<SeededCandidate> {
  const versionId = options.versionId ?? snapshot.registryVersion.id;
  const version = await createCandidate(db, {
    versionId,
    repository:     snapshot.registryVersion.sourceRepository,
    commitSha:      options.commitSha ?? snapshot.registryVersion.sourceCommitSha,
    sourceChecksum: sha256Hex(`source:${versionId}`),
    attempt:        options.attempt ?? 1,
    createdBy:      'test-seed',
  });

  /*
   * A market row id is a primary key across versions, so seeding the same
   * fixture a second time needs fresh ids. The fixture's own version keeps
   * the ids it was frozen with, which is what lets a test address a market
   * by the id the fixture states.
   */
  const networks = versionId === snapshot.registryVersion.id
    ? snapshot.networks
    : snapshot.networks.map(network => ({
        ...network,
        markets: network.markets.map(market => ({ ...market, id: randomUUID() })),
      }));

  const counts = await writeCandidateSnapshot(db, version.id, networks);
  return {
    versionId:        version.id,
    snapshotChecksum: snapshot.registryVersion.checksum,
    counts: {
      registry_networks:        counts.networks,
      network_price_exceptions: counts.priceExceptions,
      markets:                  counts.markets,
      tokens:                   counts.tokens,
      market_contracts:         counts.contracts,
      market_assets:            counts.assets,
    },
  };
}

/*
 * Validates a candidate as it stands, without judging it: one passing check,
 * and the checksum validation would store for its rows, which is the one the
 * cache verifies a version against. A test about a version this release
 * cannot verify states another.
 */
async function validateSeeded(db: D1Database, versionId: string, { checksum }: { checksum?: string } = {}): Promise<void> {
  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, checksum ?? await snapshotChecksum(orderNetworks(await readSnapshot(db, versionId))));
}

async function activateSeeded(db: D1Database, versionId: string): Promise<void> {
  await validateSeeded(db, versionId);
  await activateVersion(db, { versionId, action: 'activate', actor: 'test-admin', reason: 'test' });
}

/*
 * The decisions a network of a snapshot states, as the network overlay route
 * takes them. Production reads a network's overlay from its rows rather than
 * from the wire shape, so this mapping is the tests' own; an exception is
 * mapped as production maps one it reads from a row (overlayOfException).
 */
function overlayOfNetwork(network: NetworkV1): NetworkOverlay {
  return {
    displayName:               network.displayName,
    assetDisplayOverrides:     network.presentation.assetDisplayOverrides,
    unwrappedCollateralAssets: network.presentation.unwrappedCollateralAssets,
    priceExceptions:           network.priceExceptions.map(overlayOfException),
  };
}

export type { SeedOptions, SeededCandidate };

export {
  activateSeeded,
  clearCandidateSnapshot,
  fixtureCatalog,
  fixtureComet,
  loadRegistrySnapshotFixture,
  overlayOfNetwork,
  seedCandidate,
  sha256Hex,
  validateSeeded,
  writeCandidateSnapshot,
};
