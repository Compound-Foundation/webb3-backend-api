import { readFileSync } from 'node:fs';

import type { DeprecatedCollateralListV1, RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';
import { marketKey } from '../../lib/model/comet-registry.js';

/*
 * The checked-in decisions of an environment's first registry version
 * (registry/seed), read as the tests read their fixtures: from the c3-api
 * directory they run in. Nothing imports the files, so they reach neither
 * dist nor the Worker's bundle.
 */
const SEED_PATH   = './registry/seed/production.json';
const COMETS_PATH = './registry/seed/production.comets.json';

// the body of PUT …/overlays, as the file holds it
type SeedBody = {
  reason:           string,
  networks:         Record<string, unknown>,
  markets:          Record<string, unknown>,
  expectedDigests?: Record<string, string | null>,
};

function readSeedText(): string {
  return readFileSync(SEED_PATH, 'utf8');
}

function readSeed(): SeedBody {
  return JSON.parse(readSeedText()) as SeedBody;
}

// each market's Comet, lowercase, which the overlays do not carry
function readSeedComets(): Record<string, string> {
  return JSON.parse(readFileSync(COMETS_PATH, 'utf8')) as Record<string, string>;
}

/*
 * The collaterals the app hid by its own list, which an environment marks
 * deprecated once its first version is on: the body of
 * `POST …/deprecated-collaterals/review` and `/apply`, as the file holds it.
 */
const DEPRECATED_PATH = './registry/seed/production.deprecated-collaterals.json';

function readSeedDeprecatedText(): string {
  return readFileSync(DEPRECATED_PATH, 'utf8');
}

function readSeedDeprecated(): DeprecatedCollateralListV1 {
  return JSON.parse(readSeedDeprecatedText()) as DeprecatedCollateralListV1;
}

/*
 * The body cut down to the networks and markets a snapshot holds, in the
 * file's order, and its expectations with them: a key in expectedDigests
 * without its document is refused with 400.
 */
function bodyFor(snapshot: Pick<RegistrySnapshotV1, 'networks'>, seed: SeedBody = readSeed()): SeedBody {
  const held = new Set(snapshot.networks.flatMap(network => [
    String(network.chainId),
    ...network.markets.map(market => marketKey(network.chainId, market.deploymentKey)),
  ]));
  const pick = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([ key ]) => held.has(key)));
  return {
    reason:   seed.reason,
    networks: pick(seed.networks),
    markets:  pick(seed.markets),
    ...(seed.expectedDigests === undefined ? {} : { expectedDigests: pick(seed.expectedDigests) }),
  };
}

export type { SeedBody };
export { bodyFor, readSeed, readSeedComets, readSeedDeprecated, readSeedDeprecatedText, readSeedText };
