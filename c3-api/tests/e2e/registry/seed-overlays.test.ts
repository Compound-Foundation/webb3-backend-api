import t from 'tap';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';
import { marketKey } from '../../../lib/model/comet-registry.js';
import type { MarketOverlay } from '../../../src/registry/overlay.js';
import { readSnapshot, readUnreviewed } from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate, sha256Hex } from '../../util/registry-fixture.js';
import { bodyFor, readSeed, readSeedComets, readSeedText } from '../../util/registry-seed.js';

/*
 * An environment's first review as an operator sends it: the seed file, to
 * the draft the first import held. The fixture's draft holds six of the
 * seed's markets on three of its networks, and one market the seed does not
 * describe. Its rows already hold the creation blocks and feeds the seed
 * names, so the PUT reads nothing from the chain: that is the preflight's to
 * check, against a real node (REGISTRY_RUNBOOK.md).
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';

const server = createTestHarness({
  workers: [ {
    configPath: './wrangler.toml',
    secrets:    { COMET_REGISTRY_ADMIN_TOKEN_HASH: sha256Hex(ADMIN_TOKEN) },
  } ],
});

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

// a deployment the source has and the seed does not describe
const UNDESCRIBED = '0x5555555555555555555555555555555555555555';

// a candidate as the first import of an environment leaves it: every market written, none reviewed
async function unreviewedCandidate(): Promise<{ db: D1Database, versionId: string, snapshot: RegistrySnapshotV1 }> {
  await server.reset();
  const { APP_DB: db } = await server.getWorker<Env>().getEnv();
  await applyMigrations(db);

  const snapshot = loadRegistrySnapshotFixture();
  const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;
  const usdt     = mainnet.markets.find(market => market.deploymentKey === 'usdt')!;
  mainnet.markets.push({
    ...structuredClone(usdt),
    id:            '00000000-0000-4000-8000-0000000005ff',
    deploymentKey: 'undescribed',
    isDefault:     false,
    creationBlock: usdt.creationBlock + 1,
    contracts:     { ...usdt.contracts, comet: UNDESCRIBED },
  });
  const { versionId } = await seedCandidate(db, snapshot);
  await db.batch([
    db.prepare(
      `UPDATE markets SET status = 'disabled', is_default = 0, reviewed = 0, display_name = deployment_key,
              contract_name = NULL, rewards_enabled = 0, account_rewards_enabled = 0,
              transaction_history_enabled = 0
       WHERE registry_version_id = ?1`
    ).bind(versionId),
    db.prepare(`UPDATE registry_networks SET reviewed = 0 WHERE registry_version_id = ?1`).bind(versionId),
  ]);
  return { db, versionId, snapshot };
}

const auth = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };

function post(path: string, body?: unknown): Promise<Response> {
  return server.fetch(path, {
    method:  'POST',
    headers: { ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as Promise<Response>;
}

// the body as the runbook sends it: the bytes of a file
function put(versionId: string, text: string): Promise<Response> {
  return server.fetch(`/registry/v1/admin/versions/${versionId}/overlays`, {
    method:  'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    text,
  }) as unknown as Promise<Response>;
}

type Written = {
  changed:    boolean,
  documents:  Array<{ scopeType: string, scopeKey: string, changed: boolean, digest: string }>,
  unreviewed: { networks: number[], markets: string[] },
};

type Refused = { error: { message: string, details: { current: Record<string, string | null> } } };

t.test('a draft that lacks markets of the seed refuses it whole', async t => {
  const { db, versionId, snapshot } = await unreviewedCandidate();
  const before = await readUnreviewed(db, versionId);
  const seed   = readSeed();
  const held   = bodyFor(snapshot, seed);
  const missing = [
    ...Object.keys(seed.networks).filter(key => !(key in held.networks)).map(key => `chain ${key}`),
    ...Object.keys(seed.markets).filter(key => !(key in held.markets)),
  ];

  // the route answers 404 only for a body it takes, by size, keys, reason and count (admin-router.ts); the size is checked nowhere else
  const refused = await put(versionId, readSeedText());
  t.equal(refused.status, 404, 'the file as it is, which the route takes');
  t.equal((await refused.json() as Refused).error.message, `${missing.join(', ')} not imported into this registry version yet`,
    'naming every network and market of it the draft has not imported, the networks first');
  t.same(await readUnreviewed(db, versionId), before, 'and writing nothing');
});

t.test('the seed, cut to what the draft holds, reviews a first import once', async t => {
  const { db, versionId, snapshot } = await unreviewedCandidate();
  const body = bodyFor(snapshot);
  t.same(Object.keys(body.networks), [ '1', '8453', '534352' ], 'cut to the networks the draft holds');
  t.same(Object.keys(body.markets), [ '1/usdc', '1/usdt', '1/wbtc', '1/weth', '8453/aero', '534352/usdc' ], 'and to the markets the seed describes');
  t.same(Object.keys(body.expectedDigests ?? {}), [ ...Object.keys(body.networks), ...Object.keys(body.markets) ], 'with their expectations');

  const sent = await put(versionId, JSON.stringify(body));
  t.equal(sent.status, 200, 'the draft takes it');
  const written = await sent.json() as Written;
  t.ok(written.changed && written.documents.length === 9 && written.documents.every(document => document.changed), 'every document is written');
  t.same(written.unreviewed, { networks: [], markets: [ '1/undescribed' ] }, 'and only the market the seed does not describe stays unreviewed');

  const usdc = (await readSnapshot(db, versionId)).find(network => network.chainId === 1)!.markets.find(market => market.deploymentKey === 'usdc')!;
  t.same({ label: usdc.displayName, contract: usdc.contractName, status: usdc.status, isDefault: usdc.isDefault },
    { label: 'USDC', contract: 'cUSDCv3', status: 'enabled', isDefault: true }, 'as the seed decides');

  const again = await put(versionId, JSON.stringify(body));
  t.equal(again.status, 409, 'sent again, it is refused: every scope it names is reviewed now');
  t.same((await again.json() as Refused).error.details.current,
    Object.fromEntries(written.documents.map(document => [ `${document.scopeType} ${document.scopeKey}`, document.digest ])),
    'naming each, with what it holds');

  const validated = await post(`/registry/v1/admin/versions/${versionId}/validate`);
  t.equal(validated.status, 200, 'validation runs');
  const verdict = await validated.json() as { version: { status: string }, summary: { failed: number } };
  t.same({ status: verdict.version.status, failed: verdict.summary.failed }, { status: 'validated', failed: 0 }, 'the draft validates');
  // without its expectations, which an open draft would take as a change of nothing
  const { expectedDigests: _expected, ...unexpected } = body;
  const closed = await put(versionId, JSON.stringify(unexpected));
  t.equal(closed.status, 409, 'and takes no overlay from then on');
  t.match((await closed.json() as Refused).error.message, /validated registry version cannot be changed/, 'since it is no draft any more');

  const activated = await post(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'first registry version', expectedActiveVersionId: null });
  t.equal(activated.status, 200, 'it is switched on');
  const active = await (await server.fetch('/registry/v1/active')).json() as RegistrySnapshotV1;
  const served = active.networks.flatMap(network => network.markets.map(market => ({ key: marketKey(network.chainId, market.deploymentKey), market })));
  t.same(served.map(({ key }) => key).sort(), Object.keys(body.markets).sort(), 'serving the markets the seed describes, and not the other one');

  const comets = readSeedComets();
  for (const { key, market } of served) {
    const seeded = body.markets[key] as MarketOverlay;
    t.same(
      { label: market.displayName, slug: market.slug, contract: market.contractName, isDefault: market.isDefault, base: market.baseAsset.displayName, comet: market.contracts.comet },
      { label: seeded.displayName, slug: seeded.slug, contract: seeded.contractName, isDefault: seeded.isDefault, base: seeded.baseAsset.displayName, comet: comets[key] },
      `${key} as the seed and its companion say`,
    );
  }
});
