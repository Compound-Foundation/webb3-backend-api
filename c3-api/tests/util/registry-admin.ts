import type { NetworkV1 } from '../../lib/model/comet-registry.js';

import { loadRegistrySnapshotFixture, seedCandidate, validateSeeded } from './registry-fixture.js';

/*
 * What the registry tests share: the fixture seeded as a validated version,
 * and a count of a table's rows.
 */

const snapshot = loadRegistrySnapshotFixture();

/*
 * Seeds a validated version of the fixture, or of the networks given, and
 * answers its id. A second version needs an id of its own, and the seed
 * gives it fresh market ids. Nothing is activated: a test about activation
 * goes through the API, as an administrator does.
 */
async function seedValidated(
  db: D1Database,
  { networks = snapshot.networks, versionId }: { networks?: NetworkV1[], versionId?: string } = {},
): Promise<string> {
  const { versionId: id } = await seedCandidate(
    db,
    { ...snapshot, networks },
    versionId === undefined ? {} : { versionId, attempt: 2 },
  );
  await validateSeeded(db, id);
  return id;
}

// the rows of a table, or those of them that match a condition
async function count(db: D1Database, table: string, where: string = '1 = 1', ...bindings: unknown[]): Promise<number> {
  return await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...bindings).first<number>('n') ?? 0;
}

export { count, seedValidated };
