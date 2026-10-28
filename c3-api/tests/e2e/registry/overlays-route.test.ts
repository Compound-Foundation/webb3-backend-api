import t from 'tap';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import { overlayOfMarket } from '../../../src/registry/overlay.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, overlayOfNetwork, seedCandidate, validateSeeded } from '../../util/registry-fixture.js';

/*
 * `PUT /registry/v1/admin/versions/{id}/overlays`: a whole reviewed directory
 * in one request.
 *
 * What it adds over the one-document routes is that a directory is applied
 * all at once or not at all, so these tests are about that: what a request
 * writes when every document can be written, and that nothing is written when
 * one of them cannot. Each document is decided exactly as the one-document
 * routes decide it, which api.test.ts covers.
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';

const server = createTestHarness({
  workers: [ {
    configPath: './wrangler.toml',
    secrets:    { COMET_REGISTRY_ADMIN_TOKEN_HASH: await sha256Hex(ADMIN_TOKEN) },
  } ],
});

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();
const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;

async function freshCandidate(): Promise<{ db: D1Database, versionId: string }> {
  await server.reset();
  const { APP_DB: db } = await server.getWorker<Env>().getEnv();
  await applyMigrations(db);
  const { versionId } = await seedCandidate(db, snapshot);
  return { db, versionId };
}

function marketOverlay(key: string) {
  return overlayOfMarket(mainnet.markets.find(entry => entry.deploymentKey === key)!);
}

function put(versionId: string, body: unknown, token: string = ADMIN_TOKEN): Promise<Response> {
  return server.fetch(`/registry/v1/admin/versions/${versionId}/overlays`, {
    method:  'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }) as unknown as Promise<Response>;
}

type Applied = {
  versionId:        string,
  changed:          boolean,
  snapshotChecksum: string | null,
  documents:        Array<{ scopeType: string, scopeKey: string, changed: boolean, overlayEventId: string | null }>,
  unreviewed:       { networks: number[], markets: string[] },
};

async function events(db: D1Database, versionId: string) {
  const { results } = await db.prepare(
    `SELECT scope_type, scope_key, reason FROM registry_overlay_events WHERE registry_version_id = ?1 ORDER BY scope_key`
  ).bind(versionId).all<{ scope_type: string, scope_key: string, reason: string }>();
  return results ?? [];
}

async function mainnetState(db: D1Database, versionId: string) {
  return {
    network: await db.prepare(
      `SELECT display_name FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1`
    ).bind(versionId).first<string>('display_name'),
    markets: (await db.prepare(
      `SELECT deployment_key, status, is_default FROM markets
       WHERE registry_version_id = ?1 AND network_id = (
         SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1
       ) ORDER BY deployment_key`
    ).bind(versionId).all<{ deployment_key: string, status: string, is_default: number }>()).results,
  };
}

t.test('a directory is applied in one request, and applying it again changes nothing', async t => {
  const { db, versionId } = await freshCandidate();

  const body = {
    reason:   'review the directory',
    networks: { '1': { ...overlayOfNetwork(mainnet), displayName: 'Ethereum Mainnet' } },
    markets:  {
      '1/usdc': { ...marketOverlay('usdc'), status: 'deprecated', isDefault: false },
      '1/weth': marketOverlay('weth'),
    },
  };

  const response = await put(versionId, body);
  t.equal(response.status, 200);
  const applied = await response.json() as Applied;
  t.equal(applied.changed, true);
  t.equal(applied.snapshotChecksum, null, 'the checksum is cleared until validation recomputes it');
  t.same(
    applied.documents.map(({ scopeType, scopeKey, changed }) => [ scopeType, scopeKey, changed ]),
    [ [ 'network', '1', true ], [ 'market', '1/usdc', true ], [ 'market', '1/weth', false ] ],
    'each document says whether it changed anything, in the order it was sent',
  );
  t.equal(applied.documents[2]!.overlayEventId, null, 'an overlay identical to what is stored writes no event');

  const state = await mainnetState(db, versionId);
  t.equal(state.network, 'Ethereum Mainnet', 'the network is written');
  t.same(state.markets!.find(market => market.deployment_key === 'usdc'), { deployment_key: 'usdc', status: 'deprecated', is_default: 0 },
    'and so is the market');
  t.same(
    (await events(db, versionId)).map(event => [ event.scope_type, event.scope_key, event.reason ]),
    [ [ 'network', '1', 'review the directory' ], [ 'market', '1/usdc', 'review the directory' ] ],
    'one audit event per changed document, with the request\'s reason',
  );

  const again = await (await put(versionId, body)).json() as Applied;
  t.equal(again.changed, false, 'sending the same directory again changes nothing');
  t.equal((await events(db, versionId)).length, 2, 'and writes no further events');
});

/*
 * Network documents are keyed by chain id, and a parsed JSON object lists
 * the keys that are numbers in ascending order, whatever order the text
 * wrote them in; market keys keep the order they were written in. The body
 * is written by hand for that reason: an object literal would already have
 * put the chain ids in order before it was sent.
 */
t.test('the answer lists the networks by chain id, then the markets in the order they were sent', async t => {
  const { versionId } = await freshCandidate();
  const base   = snapshot.networks.find(network => network.chainId === 8453)!;
  const scroll = snapshot.networks.find(network => network.chainId === 534352)!;

  const body = `{"reason": "review the directory", `
    + `"markets": {"1/weth": ${JSON.stringify(marketOverlay('weth'))}, "1/usdc": ${JSON.stringify(marketOverlay('usdc'))}}, `
    + `"networks": {"534352": ${JSON.stringify(overlayOfNetwork(scroll))}, "1": ${JSON.stringify(overlayOfNetwork(mainnet))}, `
    + `"8453": ${JSON.stringify(overlayOfNetwork(base))}}}`;
  const response = await server.fetch(`/registry/v1/admin/versions/${versionId}/overlays`, {
    method:  'PUT',
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body,
  });
  t.equal(response.status, 200);
  const applied = await response.json() as Applied;
  t.same(
    applied.documents.map(({ scopeType, scopeKey }) => [ scopeType, scopeKey ]),
    [ [ 'network', '1' ], [ 'network', '8453' ], [ 'network', '534352' ], [ 'market', '1/weth' ], [ 'market', '1/usdc' ] ],
  );
});

/*
 * The schema allows one default market per version after every statement,
 * not only at the end of a batch. A directory that moves the default names
 * the new default wherever it likes, so every changed market first gives the
 * default up.
 */
t.test('a directory that moves the default is written in an order the schema accepts', async t => {
  const { db, versionId } = await freshCandidate();

  const response = await put(versionId, {
    reason:  'move the default',
    markets: {
      '1/weth': { ...marketOverlay('weth'), isDefault: true },
      '1/usdc': { ...marketOverlay('usdc'), isDefault: false },
    },
  });
  t.equal(response.status, 200, 'the new default is named before the old one, and still lands');
  const defaults = (await mainnetState(db, versionId)).markets!.filter(market => market.is_default === 1);
  t.same(defaults.map(market => market.deployment_key), [ 'weth' ]);
});

// the same holds for a slug, which also names one market of a network at a time
t.test('a directory that moves a slug is written in an order the schema accepts', async t => {
  const { db, versionId } = await freshCandidate();
  const slugs = async () => (await db.prepare(
    `SELECT deployment_key, slug FROM markets WHERE registry_version_id = ?1 AND slug IS NOT NULL ORDER BY deployment_key`
  ).bind(versionId).all<{ deployment_key: string, slug: string }>()).results;

  t.equal((await put(versionId, {
    reason:  'give the slug to one market',
    markets: { '1/usdc': { ...marketOverlay('usdc'), slug: 'usdc-main' } },
  })).status, 200);
  t.same(await slugs(), [ { deployment_key: 'usdc', slug: 'usdc-main' } ]);

  const moved = await put(versionId, {
    reason:  'move it to another',
    markets: {
      '1/usdt': { ...marketOverlay('usdt'), slug: 'usdc-main' },
      '1/usdc': { ...marketOverlay('usdc'), slug: null },
    },
  });
  t.equal(moved.status, 200, 'the market taking the slug is sent first, and still lands');
  t.same(await slugs(), [ { deployment_key: 'usdt', slug: 'usdc-main' } ]);

  /*
   * No order of writes satisfies the schema after every statement for these
   * two, which is why every changed market first gives up its slug and the
   * default.
   */
  t.equal((await put(versionId, {
    reason:  'give usdc a slug back',
    markets: { '1/usdc': { ...marketOverlay('usdc'), slug: 'usdc-other' } },
  })).status, 200);
  const swapped = await put(versionId, {
    reason:  'swap two slugs',
    markets: {
      '1/usdt': { ...marketOverlay('usdt'), slug: 'usdc-other' },
      '1/usdc': { ...marketOverlay('usdc'), slug: 'usdc-main' },
    },
  });
  t.equal(swapped.status, 200, 'two markets swap their slugs in one request');
  t.same(await slugs(), [ { deployment_key: 'usdc', slug: 'usdc-main' }, { deployment_key: 'usdt', slug: 'usdc-other' } ]);

  const moved2 = await put(versionId, {
    reason:  'move the default to a market without a slug, and give the old default one',
    markets: {
      '1/weth': { ...marketOverlay('weth'), isDefault: true, slug: null },
      '1/usdc': { ...marketOverlay('usdc'), isDefault: false, slug: 'usdc-main' },
    },
  });
  t.equal(moved2.status, 200, 'the default moves while slugs change, in either order');

  const taken = await put(versionId, {
    reason:  'a slug already taken',
    markets: { '1/weth': { ...marketOverlay('weth'), slug: 'usdc-main' } },
  });
  t.equal(taken.status, 409, 'a slug another market keeps is refused');
  t.match((await taken.json() as { error: { message: string } }).error.message, /already has that slug/);
});

t.test('nothing is written unless everything can be', async t => {
  const { db, versionId } = await freshCandidate();
  const before = await mainnetState(db, versionId);

  const renamed = { '1': { ...overlayOfNetwork(mainnet), displayName: 'Ethereum Mainnet' } };

  const invalid = await put(versionId, {
    reason:   'one document is wrong',
    networks: renamed,
    markets:  { '1/usdc': { ...marketOverlay('usdc'), sortOrder: 2 } },
  });
  t.equal(invalid.status, 400, 'a document the parser refuses refuses the request');
  t.match((await invalid.json() as { error: { message: string } }).error.message, /markets\.1\/usdc/,
    'and says which document it was');

  const unimported = await put(versionId, {
    reason:   'one market is not imported',
    networks: renamed,
    markets:  { '1/usdc': marketOverlay('usdc'), '1/nope': marketOverlay('usdc'), '999/usdc': marketOverlay('usdc') },
  });
  t.equal(unimported.status, 404, 'a market the version has not imported refuses the request');
  t.match((await unimported.json() as { error: { message: string } }).error.message, /1\/nope, 999\/usdc/,
    'naming every one of them at once');

  t.same(await mainnetState(db, versionId), before, 'the valid documents beside them were not written');
  t.same(await events(db, versionId), [], 'and no event was recorded');
});

t.test('the route takes a directory and nothing else', async t => {
  const { versionId } = await freshCandidate();
  const usdc = marketOverlay('usdc');

  const refusals: Array<[ string, unknown ]> = [
    [ 'an empty directory',                   { reason: 'x' } ],
    [ 'a directory without a reason',         { markets: { '1/usdc': usdc } } ],
    [ 'an unknown property',                  { reason: 'x', markets: { '1/usdc': usdc }, force: true } ],
    [ 'markets that are not an object',       { reason: 'x', markets: [ usdc ] } ],
    [ 'a network key that is not a chain id', { reason: 'x', networks: { ethereum: overlayOfNetwork(mainnet) } } ],
    [ 'a market key without a deployment',    { reason: 'x', markets: { '1': usdc } } ],
  ];
  for (const [ what, body ] of refusals) {
    t.equal((await put(versionId, body)).status, 400, `${what} is refused`);
  }

  /*
   * A key spells its chain id as a path does, so no two keys of a document
   * name the same scope: a chain id written another way is refused as no
   * chain id at all.
   */
  for (const [ what, body, key ] of [
    [ 'a network key',  { reason: 'x', networks: { '0x1': overlayOfNetwork(mainnet) } }, '0x1' ],
    [ 'a market key',   { reason: 'x', markets: { '1/usdc': usdc, '01/usdc': usdc } }, '01' ],
  ] as const) {
    const refused = await put(versionId, body);
    t.equal(refused.status, 400, `${what} with a chain id written otherwise than in decimal is refused`);
    t.equal((await refused.json() as { error: { message: string } }).error.message, `${key} is not a chain id`);
  }

  t.equal((await put(versionId, { reason: 'x', markets: { '1/usdc': usdc } }, 'not-the-token')).status, 401,
    'and it is authenticated like every administrative route');
});

/*
 * Moving the default or a slug between two markets is read from both and sent
 * back as one directory. Each document can say which overlay it was decided
 * against, as a one-document route's can, so a change made to either market
 * in between is not undone by the move.
 */
t.test('a directory says what each of its documents was decided against', async t => {
  const { db, versionId } = await freshCandidate();
  const auth = { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } };
  type Read = { digest: string, overlay: Record<string, unknown> };
  const read = async (scope: string) => await (await server.fetch(`/registry/v1/admin/versions/${versionId}/${scope}/overlay`, auth))
    .json() as Read;
  const defaults = async () => (await mainnetState(db, versionId)).markets!
    .filter(market => market.is_default === 1).map(market => market.deployment_key);

  const [ usdc, weth ] = [ await read('markets/1/usdc'), await read('markets/1/weth') ];
  const move = (from: Read, to: Read, expectedDigests: Record<string, string | null>) => put(versionId, {
    reason:   'move the default',
    markets:  { '1/usdc': { ...from.overlay, isDefault: false }, '1/weth': { ...to.overlay, isDefault: true } },
    expectedDigests,
  });

  // somebody renames usdc after both were read
  t.equal((await put(versionId, { reason: 'rename usdc', markets: { '1/usdc': { ...usdc.overlay, displayName: 'USD Coin' } } })).status, 200);

  const stale = await move(usdc, weth, { '1/usdc': usdc.digest, '1/weth': weth.digest });
  t.equal(stale.status, 409, 'a directory decided against an overlay replaced since is refused');
  const renamed = await read('markets/1/usdc');
  t.same((await stale.json() as { error: { details: { current: Record<string, string> } } }).error.details.current,
    { 'market 1/usdc': renamed.digest }, 'naming the market that changed, and what it holds now');
  t.same(await defaults(), [ 'usdc' ], 'and nothing is written');

  const network = await read('networks/1');
  const moved   = await put(versionId, {
    reason:   'move the default, and rename the network',
    networks: { '1': { ...network.overlay, displayName: 'Ethereum Mainnet' } },
    markets:  { '1/usdc': { ...renamed.overlay, isDefault: false }, '1/weth': { ...weth.overlay, isDefault: true } },
    expectedDigests: { '1': network.digest, '1/usdc': renamed.digest, '1/weth': weth.digest },
  });
  t.equal(moved.status, 200, 'read again, the move is written');
  t.same(await defaults(), [ 'weth' ]);
  t.equal((await mainnetState(db, versionId)).network, 'Ethereum Mainnet', 'and so is the network, decided against its own read');

  t.equal((await move(renamed, weth, { '1/weth': null })).status, 409,
    'a document that expects a market nobody has reviewed is refused when somebody has');

  for (const [ what, expectedDigests ] of [
    [ 'an expectation of a document the request does not carry', { '1/usdt': null } ],
    [ 'an expectation that is not a digest',                      { '1/usdc': 'abc' } ],
    [ 'expectations that are not keyed by document',              [ null ] ],
  ] as const) {
    t.equal((await put(versionId, { reason: 'x', markets: { '1/usdc': renamed.overlay }, expectedDigests })).status, 400,
      `${what} is refused rather than ignored`);
  }
});

t.test('only an importing candidate can be reviewed', async t => {
  const { db, versionId } = await freshCandidate();
  await validateSeeded(db, versionId);

  const response = await put(versionId, { reason: 'too late', markets: { '1/usdc': marketOverlay('usdc') } });
  t.equal(response.status, 409, 'a validated version can no longer be changed');
});
