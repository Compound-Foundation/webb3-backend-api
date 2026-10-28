import { Miniflare } from 'miniflare';

import type { RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';

import { activateVersion } from '../../src/registry/repository.js';

import { applyMigrations } from './d1.js';
import { loadRegistrySnapshotFixture, seedCandidate, validateSeeded } from './registry-fixture.js';

/*
 * An APP_DB for tests that call the worker from Node.
 *
 * The worker itself runs in Node in those tests, but D1 only exists inside
 * workerd, so the binding comes from a Miniflare instance started for the
 * test. It is the real D1 implementation, running the real migrations, which
 * is what makes a Node-side test of a route that resolves markets worth
 * anything at all.
 *
 * Tests that run the whole worker inside workerd use the Wrangler harness
 * instead and take APP_DB from its environment.
 */
type RegistryDatabase = {
  db:          D1Database,
  versionId:   string,
  snapshot:    RegistrySnapshotV1,
  dispose():   Promise<void>,
};

type Options = {
  snapshot?: RegistrySnapshotV1,
  /*
   * Whether to activate the seeded version. A validated version that was
   * never activated is how a test reaches the no-active-version case: the
   * schema refuses to clear the pointer once it has been set, because a
   * registry that has served a version must not fall back to serving none.
   */
  activate?: boolean,
};

/*
 * A database holding the frozen snapshot fixture as the active version, which
 * is what a market, account, or history route needs before it can answer.
 */
async function activeRegistryDatabase(options: Options = {}): Promise<RegistryDatabase> {
  const { snapshot = loadRegistrySnapshotFixture(), activate = true } = options;
  const miniflare = new Miniflare({
    modules: true,
    script:  'export default { fetch() { return new Response(null, { status: 404 }); } };',
    d1Databases: { APP_DB: ':memory:' },
  });

  const db = await miniflare.getD1Database('APP_DB') as unknown as D1Database;
  await applyMigrations(db);

  const { versionId } = await seedCandidate(db, snapshot);
  await validateSeeded(db, versionId);
  if (activate) {
    await activateVersion(db, {
      versionId,
      action: 'activate',
      actor:  'test-seed',
      reason: 'seeded for a node-side test',
    });
  }

  return { db, versionId, snapshot, dispose: () => miniflare.dispose() };
}

export type { RegistryDatabase };
export { activeRegistryDatabase };
