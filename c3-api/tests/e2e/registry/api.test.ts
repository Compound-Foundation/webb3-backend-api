import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import { overlayOfMarket } from '../../../src/registry/overlay.js';
import { recordValidationResults } from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, overlayOfNetwork, seedCandidate, validateSeeded } from '../../util/registry-fixture.js';

/*
 * The registry HTTP API, served by the real worker in workerd over local D1.
 *
 * These tests go through the worker the way a client does, so they cover what
 * unit tests of the handlers cannot: the entrypoint handing registry paths to
 * the registry router rather than to the legacy four-segment matcher, the
 * CORS headers the router sets and the security headers the entrypoint adds,
 * authentication, and the error envelope.
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';

/*
 * The worker stores only the hash of the admin token, so the harness is given
 * the hash as a secret and the tests present the token itself.
 */
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

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

/*
 * Seeds the fixture as a validated version. Activation goes through the API
 * itself wherever a test is about activation.
 */
async function seedValidated(db: D1Database, versionId?: string): Promise<string> {
  const { versionId: id } = await seedCandidate(db, snapshot, versionId === undefined ? {} : { versionId, attempt: 2 });
  await validateSeeded(db, id);
  return id;
}

type AdminRequest = { method: string, headers: Record<string, string>, body: string };

function admin(path: string, body: unknown = {}, token: string = ADMIN_TOKEN): [ string, AdminRequest ] {
  return [ path, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  } ];
}

t.test('the bootstrap read serves the active snapshot, or says there is none', async t => {
  const db = await freshDatabase();

  const missing = await server.fetch('/registry/v1/active');
  t.equal(missing.status, 503, 'without an active version the registry says so');
  const error = await missing.json() as { error: { code: string, requestId: string } };
  t.equal(error.error.code, 'REGISTRY_NOT_ACTIVE', 'with the versionless error code');
  t.match(error.error.requestId, /^[0-9a-f-]{36}$/, 'and a request id to correlate with the logs');
  t.equal(missing.headers.get('x-registry-version'), null, 'and no version headers: there is no version');

  const versionId = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'first activation' }));

  const response = await server.fetch('/registry/v1/active');
  t.equal(response.status, 200);
  t.equal(response.headers.get('x-registry-version'), versionId, 'the response names the version that answered');
  t.equal(response.headers.get('x-registry-checksum'), snapshot.registryVersion.checksum);
  t.equal(response.headers.get('access-control-allow-origin'), '*', 'public reads stay readable cross-origin');
  t.equal(response.headers.get('x-content-type-options'), 'nosniff', 'and keep the security headers');

  const body = await response.json() as typeof snapshot;
  t.equal(body.schemaVersion, 1);
  t.equal(body.registryVersion.id, versionId);
  t.same(body.networks, snapshot.networks, 'the payload is the snapshot that was stored');

  const slashed = await server.fetch('/registry/v1/active/');
  t.equal(slashed.status, 200, 'a trailing slash names the same resource');
  t.equal(slashed.headers.get('x-registry-version'), versionId);
});

t.test('a snapshot is cacheable by version and checksum', async t => {
  const db        = await freshDatabase();
  const versionId = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'activate' }));

  const first = await server.fetch('/registry/v1/active');
  const etag  = first.headers.get('etag');
  t.equal(etag, `"v1-r2-snapshot-${versionId}-${snapshot.registryVersion.checksum}"`,
    'the ETag identifies schema, revision, representation, version, and checksum');
  t.match(first.headers.get('cache-control'), /max-age=300/, 'with the configured cache lifetime');

  /*
   * These routes serve different bodies from one version, so an ETag that
   * named the version alone would let a conditional request for one be
   * answered 304 while the client holds another's body.
   */
  const otherRoutes = await Promise.all([
    server.fetch('/registry/v1/networks'),
    server.fetch('/registry/v1/networks/1/markets'),
  ]);
  const etags = otherRoutes.map(response => response.headers.get('etag'));
  t.equal(new Set([ etag, ...etags ]).size, 3, 'each representation has its own ETag');

  for (const [ index, path ] of [ '/registry/v1/networks', '/registry/v1/networks/1/markets' ].entries()) {
    const crossed = await server.fetch(path, { headers: { 'If-None-Match': etag! } });
    t.equal(crossed.status, 200, `${path} does not accept the snapshot ETag`);
    const own = await server.fetch(path, { headers: { 'If-None-Match': etags[index]! } });
    t.equal(own.status, 304, `${path} accepts its own`);
  }

  const repeat = await server.fetch('/registry/v1/active', { headers: { 'If-None-Match': etag! } });
  t.equal(repeat.status, 304, 'an unchanged version answers 304');
  t.equal(repeat.headers.get('x-registry-version'), versionId, 'and still names the version');

  // the same bytes by id are the same representation, decided from the version's row alone
  const pinned = await server.fetch(`/registry/v1/versions/${versionId}`, { headers: { 'If-None-Match': etag! } });
  t.equal(pinned.status, 304, 'the version read by id accepts the tag of the same bytes');
  t.equal(pinned.headers.get('etag'), etag);

  const stale = await server.fetch('/registry/v1/active', { headers: { 'If-None-Match': '"v1-other-version"' } });
  t.equal(stale.status, 200, 'a different ETag gets the body');
});

/*
 * If-None-Match is compared as RFC 9110 has it: weakly, so the tag a browser
 * sends back for a response Cloudflare compressed — the same tag, marked
 * weak — names the version as the tag itself does; `*` names any; and a list
 * names what any tag in it names. What is none of those names nothing.
 */
t.test('a conditional read is answered 304 by the weak tag, by a star, and by a list that holds the tag', async t => {
  const db        = await freshDatabase();
  const versionId = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'activate' }));

  const etag     = (await server.fetch('/registry/v1/active')).headers.get('etag')!;
  const answered = async (header: string) => (await server.fetch('/registry/v1/active', { headers: { 'If-None-Match': header } })).status;

  for (const [ header, what ] of [
    [ `W/${etag}`, 'the tag marked weak' ],
    [ '*', 'a star' ],
    [ `"v1-other-version", ${etag}`, 'a list that holds the tag' ],
    [ `W/"v1-other-version", W/${etag}`, 'and one that holds it marked weak' ],
  ] as const) {
    t.equal(await answered(header), 304, `${what} is answered 304`);
  }
  for (const [ header, what ] of [
    [ '"v1-other-version", W/"v1-yet-another-version"', 'a list without the tag' ],
    [ etag.slice(1, -1), 'the tag without its quotes' ],
    [ `w/${etag}`, 'a weak mark in the wrong case' ],
  ] as const) {
    t.equal(await answered(header), 200, `${what} gets the body`);
  }
});

/*
 * A chain id has one spelling in a path: decimal, without a leading zero, and
 * no larger than a number holds exactly. Anything else is refused rather than
 * read as the chain it resembles, which would give one resource many URLs,
 * each cached on its own — on the public routes and the administrative ones.
 */
t.test('a chain id in a path is read in its one spelling only', async t => {
  const db        = await freshDatabase();
  const versionId = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'activate' }));
  const { versionId: draft } = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });

  const comet = snapshot.networks.find(network => network.chainId === 1)!.markets[0]!.contracts.comet!;
  const auth  = { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } };
  const paths = (chainId: string): Array<[ string, { headers?: Record<string, string> } ]> => [
    [ `/registry/v1/networks/${chainId}/markets`, {} ],
    [ `/registry/v1/networks/${chainId}/markets/${comet}`, {} ],
    [ `/registry/v1/admin/versions/${draft}/markets/${chainId}/usdc/overlay`, auth ],
    [ `/registry/v1/admin/versions/${draft}/networks/${chainId}/overlay`, auth ],
  ];

  for (const [ path, init ] of paths('1')) {
    t.equal((await server.fetch(path, init)).status, 200, `${path} reads chain 1`);
  }
  for (const spelling of [ '01', '0x1', '1e0', '1.0', '+1', '0x0a', '9007199254740993' ]) {
    for (const [ path, init ] of paths(spelling)) {
      const refused = await server.fetch(path, init);
      t.equal(refused.status, 400, `${path} is refused`);
      t.equal((await refused.json() as { error: { message: string } }).error.message, `${spelling} is not a chain id`);
    }
  }
  t.equal((await server.fetch('/registry/v1/networks/9007199254740991/markets')).status, 404,
    'while the largest chain id a number holds exactly is one, of no network here');
});

t.test('the convenience reads serve the same objects as the snapshot', async t => {
  const db        = await freshDatabase();
  const versionId = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'activate' }));

  const networks = await (await server.fetch('/registry/v1/networks')).json() as {
    registryVersion: { id: string, checksum: string },
    networks: Array<{ chainId: number, markets?: unknown }>,
  };
  t.same(networks.registryVersion, { id: versionId, checksum: snapshot.registryVersion.checksum });
  t.same(networks.networks.map(network => network.chainId), snapshot.networks.map(network => network.chainId), 'in chain id order');
  t.equal(networks.networks[0]!.markets, undefined, 'the summary leaves markets to the market routes');

  const markets = await (await server.fetch('/registry/v1/networks/1/markets')).json() as {
    chainId: number, markets: Array<{ deploymentKey: string }>,
  };
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  t.equal(markets.chainId, 1);
  t.same(
    markets.markets.map(market => market.deploymentKey),
    mainnet.markets.map(market => market.deploymentKey),
    'markets keep the snapshot order',
  );

  const comet  = mainnet.markets[0]!.contracts.comet!;
  const market = await (await server.fetch(`/registry/v1/networks/1/markets/${comet}`)).json() as {
    market: { deploymentKey: string },
  };
  t.equal(market.market.deploymentKey, mainnet.markets[0]!.deploymentKey, 'a market is addressed by its Comet');

  const mixedCase = await server.fetch(`/registry/v1/networks/1/markets/${comet.toUpperCase().replace('0X', '0x')}`);
  t.equal(mixedCase.status, 200, 'and the address is matched case-insensitively');

  t.equal((await server.fetch('/registry/v1/networks/999/markets')).status, 404, 'an unknown chain is a 404');
  t.equal((await server.fetch('/registry/v1/networks/1/markets/0x1234')).status, 400, 'a malformed address is a 400');
  t.equal((await server.fetch(`/registry/v1/networks/1/markets/${'0x' + '9'.repeat(40)}`)).status, 404, 'an unknown market is a 404');
  t.equal((await server.fetch('/registry/v1/unknown')).status, 404, 'an unknown registry route is a 404');
  const wrongMethod = await server.fetch('/registry/v1/active', { method: 'POST' });
  t.equal(wrongMethod.status, 405, 'a public read refuses other methods');
  t.equal(wrongMethod.headers.get('allow'), 'GET, HEAD, OPTIONS', 'and says which ones it takes');
  t.equal(
    ((await wrongMethod.json()) as { error: { code: string } }).error.code,
    'METHOD_NOT_ALLOWED',
    'with a code that distinguishes it from a malformed request',
  );
});

/*
 * A disabled market is part of the stored version and visible to an operator,
 * but no public read may offer one: the market route refuses it and the
 * request catalog does not materialize it, so listing it would advertise
 * something unusable.
 */
t.test('a disabled market is not served by any public read', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await db.prepare(
    `UPDATE markets SET status = 'disabled'
     WHERE registry_version_id = ?1 AND deployment_key = 'weth'`
  ).bind(versionId).run();
  await validateSeeded(db, versionId);
  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'activate' }));

  const weth = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
  const active = await (await server.fetch('/registry/v1/active')).json() as typeof snapshot;
  const mainnet = active.networks.find(network => network.chainId === 1)!;
  t.notOk(mainnet.markets.some(market => market.deploymentKey === 'weth'), 'the snapshot read leaves it out');

  const markets = await (await server.fetch('/registry/v1/networks/1/markets')).json() as {
    markets: Array<{ deploymentKey: string }>,
  };
  t.notOk(markets.markets.some(market => market.deploymentKey === 'weth'), 'and so does the market list');
  t.equal((await server.fetch(`/registry/v1/networks/1/markets/${weth}`)).status, 404,
    'while the market route already refused it');
});

/*
 * A network whose every market is disabled serves nothing. A chain the source
 * has just added arrives that way — under its canonical name, with nothing
 * about it reviewed — and the version validates without a decision about it,
 * but no public read lists it: it would offer a network nobody decided to
 * offer, with no market to open.
 */
t.test('a network that serves no market is not listed by any public read', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await db.batch([
    db.prepare(
      `UPDATE markets SET status = 'disabled', is_default = 0, reviewed = 0, rewards_enabled = 0,
              account_rewards_enabled = 0, transaction_history_enabled = 0
       WHERE registry_version_id = ?1
         AND network_id = (SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 534352)`
    ).bind(versionId),
    db.prepare(`UPDATE registry_networks SET reviewed = 0, display_name = 'scroll-mainnet' WHERE registry_version_id = ?1 AND chain_id = 534352`)
      .bind(versionId),
  ]);

  const validated = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, {}));
  t.equal((await validated.json() as { version: { status: string } }).version.status, 'validated',
    'a network nobody reviewed that serves nothing does not hold the version back');
  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'activate' }));

  const listed = async (path: string) => ((await (await server.fetch(path)).json()) as { networks: Array<{ chainId: number }> })
    .networks.map(network => network.chainId);
  t.same(await listed('/registry/v1/networks'), [ 1, 8453 ], 'the network list leaves it out');
  t.same(await listed('/registry/v1/active'), [ 1, 8453 ], 'and so does the snapshot read');
  t.same(await listed(`/registry/v1/versions/${versionId}`), [ 1, 8453 ], 'and the version read by id');
  t.equal((await server.fetch('/registry/v1/networks/534352/markets')).status, 404, 'its market list is not found');

  /*
   * A release before this one listed the network for the same version and
   * checksum, under a tag without the revision. A client holding that copy
   * is sent the body again rather than told it is still current.
   */
  const checksum = (await server.fetch('/registry/v1/active')).headers.get('x-registry-checksum');
  for (const [ path, representation ] of [
    [ '/registry/v1/active', 'snapshot' ],
    [ '/registry/v1/networks', 'networks' ],
    [ `/registry/v1/versions/${versionId}`, 'snapshot' ],
  ] as const) {
    const earlier = await server.fetch(path, { headers: { 'If-None-Match': `"v1-${representation}-${versionId}-${checksum}"` } });
    t.equal(earlier.status, 200, `${path} does not confirm the copy an earlier release sent`);
    t.same(
      ((await earlier.json()) as { networks: Array<{ chainId: number }> }).networks.map(network => network.chainId),
      [ 1, 8453 ],
      'and sends the body without the network',
    );
  }
});

/*
 * A network that serves a market is offered under its name and presentation,
 * so someone has to have decided them. One nobody reviewed would be offered
 * under the provisional overlay: its canonical name, with nothing presented.
 */
t.test('a network nobody reviewed may not serve a market', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await db.prepare(`UPDATE registry_networks SET reviewed = 0 WHERE registry_version_id = ?1 AND chain_id = 534352`)
    .bind(versionId).run();

  const response = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, {}));
  const result = await response.json() as {
    version: { status: string },
    summary: { checks: Array<{ name: string, scope: string, passed: boolean }> },
  };
  t.equal(result.version.status, 'invalid', 'the version does not validate');
  t.same(
    result.summary.checks.filter(check => !check.passed).map(check => [ check.name, check.scope ]),
    [ [ 'served-network-reviewed', 'network:534352' ] ],
    'and the check that decided it names the network',
  );
});

t.test('a retained version can be refetched by id', async t => {
  const db      = await freshDatabase();
  const first   = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${first}/activate`, { reason: 'activate' }));
  const second  = await seedValidated(db, randomUUID());
  await server.fetch(...admin(`/registry/v1/admin/versions/${second}/activate`, { reason: 'activate the second' }));

  const pinned = await server.fetch(`/registry/v1/versions/${first}`);
  t.equal(pinned.status, 200, 'the version a session pinned is still served');
  const body = await pinned.json() as typeof snapshot;
  t.equal(body.registryVersion.id, first, 'even though another version is active');

  t.equal((await server.fetch(`/registry/v1/versions/${randomUUID()}`)).status, 404, 'an unknown version is a 404');
});

t.test('administrative routes are authenticated and closed to browsers', async t => {
  const db        = await freshDatabase();
  const versionId = await seedValidated(db);

  const anonymous = await server.fetch(`/registry/v1/admin/versions/${versionId}`);
  t.equal(anonymous.status, 401, 'an unauthenticated read is refused');
  t.equal(anonymous.headers.get('www-authenticate'), 'Bearer', 'naming the scheme it takes');
  t.equal(anonymous.headers.get('access-control-allow-origin'), null, 'and carries no CORS header');
  t.equal(anonymous.headers.get('x-content-type-options'), 'nosniff', 'but keeps the security headers');

  const wrongToken = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'x' }, 'not-the-token'));
  t.equal(wrongToken.status, 401, 'a wrong token is refused');
  t.equal(wrongToken.headers.get('www-authenticate'), 'Bearer error="invalid_token"', 'saying that the token is the problem');

  // the administrative paths are published, so one that is none of them is unknown to anybody
  t.equal((await server.fetch('/registry/v1/admin/nonsense')).status, 404, 'an unknown administrative path is a 404');

  const wrongMethod = await server.fetch(`/registry/v1/admin/versions/${versionId}`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body:    '{}',
  });
  t.equal(wrongMethod.status, 405, 'an administrative path refuses another verb');
  t.equal(wrongMethod.headers.get('allow'), 'GET, OPTIONS', 'and says which one it takes');

  /*
   * Which administrative paths exist, and which verbs they take, is behind the
   * token as well: an anonymous caller is told the same thing everywhere.
   */
  const anonymousMethod = await server.fetch(`/registry/v1/admin/versions/${versionId}`, { method: 'POST', body: '{}' });
  t.equal(anonymousMethod.status, 401, 'without a token a wrong verb is refused as anything else is');
  t.equal(anonymousMethod.headers.get('allow'), null, 'and nothing says which verbs the path takes');

  const preflight = await server.fetch(`/registry/v1/admin/versions/${versionId}/activate`, { method: 'OPTIONS' });
  t.equal(preflight.status, 204);
  t.equal(preflight.headers.get('access-control-allow-origin'), null, 'an admin preflight advertises nothing');

  const publicPreflight = await server.fetch('/registry/v1/active', { method: 'OPTIONS' });
  t.equal(publicPreflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS', 'a public preflight does');

  const detail = await server.fetch(`/registry/v1/admin/versions/${versionId}`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  });
  t.equal(detail.status, 200, 'an authenticated read is served');
  const body = await detail.json() as { version: { id: string, status: string }, validation: { attempt: number } };
  t.equal(body.version.id, versionId);
  t.equal(body.version.status, 'validated');
  t.equal(body.validation.attempt, 1, 'with the validation attempt that decided it');
});

t.test('activation and rollback are idempotent and audited', async t => {
  const db     = await freshDatabase();
  const first  = await seedValidated(db);
  const second = await seedValidated(db, randomUUID());

  const activated = await server.fetch(...admin(`/registry/v1/admin/versions/${first}/activate`, { reason: 'first' }));
  t.equal(activated.status, 200);
  const result = await activated.json() as {
    action: string, changed: boolean, activationId: string | null,
    previousVersionId: string | null, targetVersionId: string,
  };
  t.equal(result.changed, true);
  t.equal(result.action, 'activate');
  t.equal(result.previousVersionId, null, 'the first activation has no predecessor');
  t.ok(result.activationId, 'and writes an audit row');

  const again = await server.fetch(...admin(`/registry/v1/admin/versions/${first}/activate`, { reason: 'again' }));
  const repeat = await again.json() as { changed: boolean, activationId: string | null };
  t.equal(repeat.changed, false, 'activating the active version changes nothing');
  t.equal(repeat.activationId, null, 'and writes no audit row');

  await server.fetch(...admin(`/registry/v1/admin/versions/${second}/activate`, { reason: 'second' }));
  const rolledBack = await server.fetch(...admin(`/registry/v1/admin/versions/${first}/rollback`, { reason: 'restore' }));
  const rollback = await rolledBack.json() as { action: string, previousVersionId: string | null, changed: boolean };
  t.equal(rollback.action, 'rollback');
  t.equal(rollback.previousVersionId, second, 'rollback records what it replaced');
  t.equal(rollback.changed, true);

  const active = await (await server.fetch('/registry/v1/active')).json() as typeof snapshot;
  t.equal(active.registryVersion.id, first, 'and the registry serves the restored version');

  const history = await db.prepare(
    `SELECT action FROM registry_activations ORDER BY rowid`
  ).all<{ action: string }>();
  t.same((history.results ?? []).map(row => row.action), [ 'activate', 'activate', 'rollback' ], 'every change is audited once');
});

/*
 * An activation or a rollback may name the version it is decided against. Of
 * two such moves made against the same version — a rollback and an
 * activation of something newer, by two people — the later one is refused
 * rather than silently undoing the other.
 */
t.test('a move decided against a version someone has since replaced is refused', async t => {
  const db    = await freshDatabase();
  const first = await seedValidated(db);
  const second = await seedValidated(db, randomUUID());
  const third  = await seedValidated(db, randomUUID());
  const move = async (action: string, versionId: string, expected: string | null) => server.fetch(...admin(
    `/registry/v1/admin/versions/${versionId}/${action}`,
    { reason: `${action} against ${expected}`, expectedActiveVersionId: expected },
  ));

  t.equal((await move('activate', first, null)).status, 200, 'the first activation expects nothing to be on');
  t.equal((await move('activate', second, first)).status, 200, 'and the next one the version it replaces');

  // two operators act on the second version being on: one switches the third on, the other rolls back
  t.equal((await move('activate', third, second)).status, 200);
  const rollback = await move('rollback', first, second);
  t.equal(rollback.status, 409, 'the rollback decided against the second version is refused');
  t.match((await rollback.json() as { error: { message: string } }).error.message, new RegExp(`active version is ${third}`),
    'and says what is on now');

  const active = await (await server.fetch('/registry/v1/active')).json() as typeof snapshot;
  t.equal(active.registryVersion.id, third, 'so the activation it raced is what the registry serves');
  t.same(
    ((await db.prepare(`SELECT action FROM registry_activations ORDER BY rowid`).all<{ action: string }>()).results ?? [])
      .map(row => row.action),
    [ 'activate', 'activate', 'activate' ],
    'and only the moves that happened are audited',
  );

  const repeated = await move('activate', third, second);
  t.equal(repeated.status, 200, 'a move whose target is already on is the idempotent no-op, whatever it expected');
  t.equal((await repeated.json() as { changed: boolean }).changed, false);

  const malformed = await server.fetch(...admin(`/registry/v1/admin/versions/${first}/rollback`, {
    reason: 'x', expectedActiveVersionId: 42,
  }));
  t.equal(malformed.status, 400, 'an expectation that names no version is refused, not ignored');
});

t.test('administrative commands validate their bodies', async t => {
  const db        = await freshDatabase();
  const versionId = await seedValidated(db);

  const noReason = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, {}));
  t.equal(noReason.status, 400, 'a change without a reason is refused');

  const extra = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'x', actor: 'someone' }));
  t.equal(extra.status, 400, 'an actor cannot be supplied by the caller');
  const body = await extra.json() as { error: { message: string } };
  t.match(body.error.message, /unexpected properties: actor/);

  const malformed = await server.fetch(`/registry/v1/admin/versions/${versionId}/activate`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body:    '{',
  });
  t.equal(malformed.status, 400, 'a malformed body is refused');

  const unknown = randomUUID();
  const activating = await server.fetch(...admin(`/registry/v1/admin/versions/${unknown}/activate`, { reason: 'x' }));
  t.equal(activating.status, 404, 'activating an unknown version is not found, as reading it is');
  const restoring = await server.fetch(...admin(`/registry/v1/admin/versions/${unknown}/rollback`, { reason: 'x' }));
  t.equal(restoring.status, 404, 'and so is restoring one');

  const { versionId: importing } = await seedCandidate(await freshDatabase(), snapshot);
  const conflict = await server.fetch(...admin(`/registry/v1/admin/versions/${importing}/activate`, { reason: 'x' }));
  t.equal(conflict.status, 409, 'while one that exists but is not validated is a conflict');

  /*
   * A held import leaves the commit unimported until somebody acts on the
   * candidate, so it is a decision like pinning a commit, and the audit has
   * to say whose decision it was. The body is refused before anything is
   * asked of the source.
   */
  const held = await server.fetch(...admin('/registry/v1/admin/sync', { holdForReview: true }));
  t.equal(held.status, 400, 'holding a candidate open for review needs a reason');
  t.match((await held.json() as { error: { message: string } }).error.message, /reason/);
  const notBoolean = await server.fetch(...admin('/registry/v1/admin/sync', { holdForReview: 'yes', reason: 'x' }));
  t.equal(notBoolean.status, 400, 'and it is a boolean');

  /*
   * A routine sync has no decision to keep a reason with, and one that
   * continues a run nowhere to keep it, so a reason without a decision is
   * refused rather than dropped from the audit.
   */
  const bare = await server.fetch(...admin('/registry/v1/admin/sync', { reason: 'x' }));
  t.equal(bare.status, 400, 'a reason without a decision is refused');
  t.match((await bare.json() as { error: { message: string } }).error.message, /reason/);
  const declined = await server.fetch(...admin('/registry/v1/admin/sync', { forceNewAttempt: false, reason: 'x' }));
  t.equal(declined.status, 400, 'and so is one beside a decision not taken');
  const long = await server.fetch(...admin('/registry/v1/admin/sync', { forceNewAttempt: true, reason: 'x'.repeat(1001) }));
  t.equal(long.status, 400, 'a reason is at most 1,000 characters here too');
});

function put(path: string, body: unknown): [ string, AdminRequest ] {
  return [ path, {
    method:  'PUT',
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  } ];
}

t.test('an overlay is replaced completely, and only while importing', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);

  const current = overlayOfNetwork(snapshot.networks.find(network => network.chainId === 1)!);

  // what the network's rows hold, but for the id an exception row is given each time it is written
  const rows = async () => ({
    network: await db.prepare(
      `SELECT display_name, metadata, reviewed FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1`
    ).bind(versionId).first(),
    exceptions: (await db.prepare(
      `SELECT exception.network_id, exception.price_feed_address, exception.kind, exception.fixed_price_value,
              exception.fixed_price_decimals, exception.replacement_price_feed_address,
              exception.replacement_price_feed_decimals, exception.provenance, exception.expires_at
       FROM network_price_exceptions AS exception
       JOIN registry_networks AS network ON network.id = exception.network_id
       WHERE exception.registry_version_id = ?1 AND network.chain_id = 1
       ORDER BY exception.price_feed_address`
    ).bind(versionId).all()).results,
  });
  const imported = await rows();

  const unchanged = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/networks/1/overlay`,
    { reason: 'no change', overlay: current },
  ));
  t.equal(unchanged.status, 200);
  const idempotent = await unchanged.json() as { changed: boolean, overlayEventId: string | null };
  t.equal(idempotent.changed, false, 'an identical replacement changes nothing');
  t.equal(idempotent.overlayEventId, null, 'and writes no audit event');

  const renamed = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/networks/1/overlay`,
    { reason: 'rename the network', overlay: { ...current, displayName: 'Ethereum Mainnet' } },
  ));
  const applied = await renamed.json() as { changed: boolean, overlayEventId: string, snapshotChecksum: string | null };
  t.equal(applied.changed, true, 'a reviewed change is applied');
  t.ok(applied.overlayEventId, 'with an audit event');
  t.equal(applied.snapshotChecksum, null, 'and the draft has no snapshot checksum until validation writes one');

  const stored = await db.prepare(
    `SELECT display_name FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1`
  ).bind(versionId).first<string>('display_name');
  t.equal(stored, 'Ethereum Mainnet', 'the stored network carries the reviewed name');

  const event = await db.prepare(
    `SELECT scope_type, scope_key, actor, reason, previous_digest, new_digest
     FROM registry_overlay_events WHERE registry_version_id = ?1`
  ).bind(versionId).first<{ scope_type: string, scope_key: string, actor: string, reason: string, previous_digest: string, new_digest: string }>();
  t.equal(event?.scope_type, 'network');
  t.equal(event?.scope_key, '1');
  t.equal(event?.reason, 'rename the network', 'the event records why');
  t.not(event?.previous_digest, event?.new_digest, 'and which overlay replaced which');

  const restored = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/networks/1/overlay`,
    { reason: 'name the network as it was', overlay: current },
  ));
  t.equal((await restored.json() as { changed: boolean }).changed, true);
  t.same(await rows(), imported, 'a network written back with the decisions it was imported with holds the rows the import wrote');

  const dropped = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/networks/1/overlay`,
    { reason: 'drop the exceptions', overlay: { ...current, priceExceptions: [] } },
  ));
  t.equal(dropped.status, 200);
  t.equal(
    await db.prepare(`SELECT COUNT(*) AS n FROM network_price_exceptions WHERE registry_version_id = ?1`)
      .bind(versionId).first<number>('n'),
    0,
    'a replacement states the whole overlay, so an omitted exception is removed',
  );

  const invalid = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/networks/1/overlay`,
    { reason: 'bad', overlay: { ...current, sortOrder: 2 } },
  ));
  t.equal(invalid.status, 400, 'an unknown overlay key is refused');

  /*
   * An import writes every network it reaches, reviewed or not, so a chain
   * missing here is one this candidate has not reached: the answer is to let
   * the import continue, and the route says so.
   */
  const unimportedChain = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/networks/999/overlay`,
    { reason: 'x', overlay: current },
  ));
  t.equal(unimportedChain.status, 404, 'a chain the version has not imported is a 404');
  t.match(
    ((await unimportedChain.json()) as { error: { message: string } }).error.message,
    /not been imported into this registry version yet/,
  );
});

/*
 * The overlay of a stored market reads back in the form its PUT takes, so a
 * market can be changed from what it carries, and a similar market is a
 * template for describing a new one.
 */
t.test('a market overlay reads back in the form it is written in', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  const auth = { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } };
  const path = `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`;

  const response = await server.fetch(path, auth);
  t.equal(response.status, 200);
  const read = await response.json() as { versionId: string, scope: string, reviewed: boolean, overlay: Record<string, unknown> };
  t.same({ versionId: read.versionId, scope: read.scope, reviewed: read.reviewed }, { versionId, scope: '1/usdc', reviewed: true });
  t.equal(read.overlay.contractName, 'cUSDCv3');

  const written = await server.fetch(...put(path, { reason: 'write back what was read', overlay: read.overlay }));
  t.equal(written.status, 200, 'the document it answers is one the PUT accepts');
  t.equal((await written.json() as { changed: boolean }).changed, false, 'and it changes nothing');

  await db.prepare(
    `UPDATE markets SET status = 'disabled', is_default = 0, reviewed = 0 WHERE registry_version_id = ?1 AND deployment_key = 'weth'`
  ).bind(versionId).run();
  const unreviewed = await (await server.fetch(`/registry/v1/admin/versions/${versionId}/markets/1/weth/overlay`, auth))
    .json() as { reviewed: boolean, overlay: { status: string } };
  t.same([ unreviewed.reviewed, unreviewed.overlay.status ], [ false, 'disabled' ],
    'a market nobody has reviewed answers with what its import wrote, and says so');

  t.equal((await server.fetch(`/registry/v1/admin/versions/${versionId}/markets/1/nope/overlay`, auth)).status, 404);
  t.equal((await server.fetch(path)).status, 401, 'and the route is authenticated');
  const wrongMethod = await server.fetch(path, { method: 'POST', headers: auth.headers });
  t.equal(wrongMethod.status, 405);
  t.equal(wrongMethod.headers.get('allow'), 'PUT, GET, OPTIONS', 'the path takes both verbs');
});

/*
 * The overlay a market carries can be read, changed and sent back saying
 * which overlay the change was decided against. A change someone else made
 * in between is not undone by it: the second write is refused.
 */
t.test('a market overlay read and sent back says what it was decided against', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  const auth = { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } };
  const path = `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`;

  const read = await (await server.fetch(path, auth)).json() as { digest: string, overlay: Record<string, unknown> };
  t.match(read.digest, /^[0-9a-f]{64}$/, 'a reviewed market answers the digest of its overlay');

  const renamed = await server.fetch(...put(path, {
    reason: 'rename it', overlay: { ...read.overlay, displayName: 'USD Coin market' }, expectedDigest: read.digest,
  }));
  t.equal(renamed.status, 200, 'a change decided against what is stored is written');
  const written = await renamed.json() as { changed: boolean, digest: string };
  t.equal(written.changed, true);
  t.equal((await (await server.fetch(path, auth)).json() as { digest: string }).digest, written.digest,
    'and the digest it answers is the one the market is read with next');

  const stale = await server.fetch(...put(path, {
    reason: 'rename it differently', overlay: { ...read.overlay, displayName: 'USDC market' }, expectedDigest: read.digest,
  }));
  t.equal(stale.status, 409, 'a change decided against the overlay it replaced is refused');
  t.equal(
    (await stale.json() as { error: { details: { current: Record<string, string> } } }).error.details.current['market 1/usdc'],
    written.digest,
    'naming the overlay the market holds now',
  );

  t.equal((await server.fetch(...put(path, { reason: 'x', overlay: read.overlay, expectedDigest: 'abc' }))).status, 400,
    'and a digest that is not one is refused rather than ignored');

  await db.prepare(
    `UPDATE markets SET status = 'disabled', is_default = 0, reviewed = 0 WHERE registry_version_id = ?1 AND deployment_key = 'weth'`
  ).bind(versionId).run();
  const unreviewed = await (await server.fetch(`/registry/v1/admin/versions/${versionId}/markets/1/weth/overlay`, auth))
    .json() as { digest: string | null };
  t.equal(unreviewed.digest, null, 'a market nobody has reviewed has no reviewed overlay to name');
});

/*
 * A network overlay is replaced whole, so a change to it starts from what the
 * draft holds: one built from what the version on serves would drop whatever
 * the draft has that it lacks. Read here, it is the document the PUT takes,
 * with the digest the PUT decides an expectation against.
 */
t.test('a network overlay reads back as the draft holds it, and says what a change is decided against', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  const auth = { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } };
  const path = `/registry/v1/admin/versions/${versionId}/networks/1/overlay`;
  type Read = {
    versionId: string, scope: string, reviewed: boolean, digest: string | null,
    overlay: { displayName: string, priceExceptions: Array<{ kind: string, priceFeedAddress: string, expiresAt: string | null }> },
  };
  const read = async (at: string = path) => await (await server.fetch(at, auth)).json() as Read;

  // the draft remaps a feed to one it knows on the chain, and holds an exception that has expired since it was written
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const remap   = {
    kind:                        'deprecated_price_remap',
    priceFeedAddress:            '0x00000000000000000000000000000000000000f2',
    replacementPriceFeedAddress: mainnet.markets[0]!.collateralAssets[0]!.priceFeed.address,
    provenance:                  'the feed was replaced',
    expiresAt:                   null,
  };
  const before = await read();
  t.equal((await server.fetch(...put(path, {
    reason: 'remap a feed', overlay: { ...before.overlay, priceExceptions: [ ...before.overlay.priceExceptions, remap ] },
  }))).status, 200);
  t.equal(await db.prepare(
    `SELECT replacement_price_feed_decimals FROM network_price_exceptions WHERE registry_version_id = ?1 AND kind = 'deprecated_price_remap'`
  ).bind(versionId).first<number>('replacement_price_feed_decimals'), mainnet.markets[0]!.collateralAssets[0]!.priceFeed.decimals,
    'the remap is stored with the decimals the version holds for that feed on the chain');
  const [ expired ] = mainnet.priceExceptions;
  await db.prepare(
    `UPDATE network_price_exceptions SET expires_at = '2020-01-01T00:00:00.000Z'
     WHERE registry_version_id = ?1 AND price_feed_address = ?2`
  ).bind(versionId, expired!.priceFeedAddress).run();

  const held = await read();
  t.same({ versionId: held.versionId, scope: held.scope, reviewed: held.reviewed }, { versionId, scope: '1', reviewed: true });
  t.match(held.digest, /^[0-9a-f]{64}$/, 'a reviewed network answers the digest of its overlay');
  t.same(held.overlay.priceExceptions.find(exception => exception.kind === 'deprecated_price_remap'), remap,
    'a remap names the feed it reads instead, as the PUT takes it');
  t.equal(held.overlay.priceExceptions.find(exception => exception.priceFeedAddress === expired!.priceFeedAddress)?.expiresAt,
    '2020-01-01T00:00:00.000Z', 'and an exception that has expired since is answered as it is held');

  const same = await server.fetch(...put(path, { reason: 'write back what was read', overlay: held.overlay, expectedDigest: held.digest }));
  t.equal(same.status, 200, 'the document it answers is one the PUT accepts, decided against what it answered');
  t.equal((await same.json() as { changed: boolean }).changed, false, 'and it changes nothing');

  const renamed = await server.fetch(...put(path, {
    reason: 'rename it', overlay: { ...held.overlay, displayName: 'Ethereum Mainnet' }, expectedDigest: held.digest,
  }));
  t.equal(renamed.status, 200, 'a change decided against what is stored is written');
  const written = await renamed.json() as { changed: boolean, digest: string };
  t.equal(written.changed, true);
  t.equal((await read()).digest, written.digest, 'and the digest it answers is the one the network is read with next');

  const stale = await server.fetch(...put(path, {
    reason: 'rename it differently', overlay: { ...held.overlay, displayName: 'Mainnet' }, expectedDigest: held.digest,
  }));
  t.equal(stale.status, 409, 'a change decided against the overlay it replaced is refused');
  t.equal(
    (await stale.json() as { error: { details: { current: Record<string, string> } } }).error.details.current['network 1'],
    written.digest,
    'naming the overlay the network holds now',
  );

  await db.prepare(`UPDATE registry_networks SET reviewed = 0, display_name = 'scroll-mainnet' WHERE registry_version_id = ?1 AND chain_id = 534352`)
    .bind(versionId).run();
  const unreviewed = await read(`/registry/v1/admin/versions/${versionId}/networks/534352/overlay`);
  t.same([ unreviewed.reviewed, unreviewed.digest, unreviewed.overlay.displayName ], [ false, null, 'scroll-mainnet' ],
    'a network nobody has reviewed answers with what its import wrote, and has no reviewed overlay to name');

  t.equal((await server.fetch(`/registry/v1/admin/versions/${versionId}/networks/999/overlay`, auth)).status, 404,
    'a chain the version has not imported is not found');
  t.equal((await server.fetch(`/registry/v1/admin/versions/${randomUUID()}/networks/1/overlay`, auth)).status, 404,
    'and neither is a version that does not exist');
  t.equal((await server.fetch(path)).status, 401, 'and the route is authenticated');
  const wrongMethod = await server.fetch(path, { method: 'POST', headers: auth.headers });
  t.equal(wrongMethod.status, 405);
  t.equal(wrongMethod.headers.get('allow'), 'PUT, GET, OPTIONS', 'the path takes both verbs');
});

/*
 * An expiry decides when a live feed is read again. It is an instant with its
 * offset, stored as the moment it names; one already past is refused when it
 * is written, because it would be stored, carried into every later version,
 * and never once price the feed it names.
 */
t.test('a price exception expires at an instant that is still to come', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  const overlay  = overlayOfNetwork(snapshot.networks.find(network => network.chainId === 1)!);
  const path     = `/registry/v1/admin/versions/${versionId}/networks/1/overlay`;
  const expiring = (expiresAt: string) => ({
    ...overlay,
    priceExceptions: overlay.priceExceptions.map(exception => ({ ...exception, expiresAt })),
  });

  const loose = await server.fetch(...put(path, { reason: 'x', overlay: expiring('Sep 21 2099') }));
  t.equal(loose.status, 400, 'a date Date.parse would guess at is refused');

  const past = await server.fetch(...put(path, { reason: 'x', overlay: expiring('2020-01-01T00:00:00Z') }));
  t.equal(past.status, 400, 'and so is one already past');
  t.match((await past.json() as { error: { message: string } }).error.message, /already expired/);

  const later = await server.fetch(...put(path, { reason: 'until governance replaces it', overlay: expiring('2099-01-01T02:00:00+02:00') }));
  t.equal(later.status, 200, 'one still to come is written');
  const stored = await db.prepare(
    `SELECT DISTINCT expires_at FROM network_price_exceptions WHERE registry_version_id = ?1`
  ).bind(versionId).all<{ expires_at: string }>();
  t.same((stored.results ?? []).map(row => row.expires_at), [ '2099-01-01T00:00:00.000Z' ], 'as the UTC instant it names');
});

/*
 * A network overlay is replaced whole, so every change to a network sends its
 * exceptions again, one that has expired since among them. One the network
 * holds exactly as it is was decided before and is kept; only an expiry the
 * document writes has to be still to come.
 */
t.test('an exception that has expired since it was written is kept as it is', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const [ expired ] = mainnet.priceExceptions;
  const expiryOf = () => db.prepare(
    `SELECT expires_at FROM network_price_exceptions WHERE registry_version_id = ?1 AND price_feed_address = ?2`
  ).bind(versionId, expired!.priceFeedAddress).first<string>('expires_at');
  await db.prepare(
    `UPDATE network_price_exceptions SET expires_at = '2020-01-01T00:00:00.000Z'
     WHERE registry_version_id = ?1 AND price_feed_address = ?2`
  ).bind(versionId, expired!.priceFeedAddress).run();

  const path    = `/registry/v1/admin/versions/${versionId}/networks/1/overlay`;
  const overlay = overlayOfNetwork(mainnet);
  const withExpiry = (expiresAt: string) => ({
    ...overlay,
    priceExceptions: [
      ...overlay.priceExceptions.map(exception => (
        exception.priceFeedAddress === expired!.priceFeedAddress ? { ...exception, expiresAt } : exception
      )),
      { kind: 'zero_price', priceFeedAddress: '0x00000000000000000000000000000000000000f1', provenance: 'reverts', expiresAt: null },
    ],
  });

  const added = await server.fetch(...put(path, { reason: 'price the feed that reverts', overlay: withExpiry('2020-01-01T00:00:00Z') }));
  t.equal(added.status, 200, 'a new exception is written, with the expired one sent again as it is');
  t.equal(await expiryOf(), '2020-01-01T00:00:00.000Z', 'which is kept');

  const moved = await server.fetch(...put(path, { reason: 'move the expiry', overlay: withExpiry('2021-01-01T00:00:00Z') }));
  t.equal(moved.status, 400, 'while an expiry the document changes has to be still to come');
  t.match((await moved.json() as { error: { message: string } }).error.message,
    `already expired: ${expired!.priceFeedAddress} at 2021-01-01T00:00:00.000Z`);
  t.equal(await expiryOf(), '2020-01-01T00:00:00.000Z', 'and nothing is written');
});

t.test('a market overlay carries the reviewed decisions', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);

  const overlay = overlayOfMarket(snapshot.networks.find(network => network.chainId === 1)!.markets
    .find(entry => entry.deploymentKey === 'usdc')!);

  const unchanged = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`,
    { reason: 'no change', overlay },
  ));
  t.equal((await unchanged.json() as { changed: boolean }).changed, false, 'the stored overlay round trips');

  const deprecated = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`,
    { reason: 'deprecate the market', overlay: { ...overlay, status: 'deprecated', isDefault: false } },
  ));
  t.equal(deprecated.status, 200);
  const stored = await db.prepare(
    `SELECT status, is_default, display_name FROM markets WHERE registry_version_id = ?1 AND deployment_key = 'usdc' AND network_id = (
       SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1
     )`
  ).bind(versionId).first<{ status: string, is_default: number }>();
  t.equal(stored?.status, 'deprecated', 'the market is stored as reviewed');
  t.equal(stored?.is_default, 0);

  const missingKey = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`,
    { reason: 'incomplete', overlay: { ...overlay, capabilities: { rewards: true } } },
  ));
  t.equal(missingKey.status, 400, 'a partial overlay is refused');

  const unimported = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/nope/overlay`,
    { reason: 'x', overlay },
  ));
  t.equal(unimported.status, 404, 'a market the version has not imported is a 404');

  /*
   * A market written without a review is disabled and marked so. The version
   * says which ones are left, which is what an operator works through before
   * a version of a new environment can be offered.
   */
  await db.prepare(
    `UPDATE markets SET status = 'disabled', is_default = 0, reviewed = 0
     WHERE registry_version_id = ?1 AND deployment_key = 'weth'`
  ).bind(versionId).run();
  const detail = await (await server.fetch(`/registry/v1/admin/versions/${versionId}`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  })).json() as { unreviewed: { networks: number[], markets: string[] } };
  t.same(detail.unreviewed, { networks: [], markets: [ '1/weth' ] }, 'the version lists what nobody has reviewed');

  const weth = snapshot.networks.find(network => network.chainId === 1)!.markets
    .find(entry => entry.deploymentKey === 'weth')!;
  const reviewedWeth = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/weth/overlay`,
    { reason: 'review the market the import could not decide about', overlay: { ...overlayOfMarket(weth), isDefault: false, status: 'enabled' } },
  ));
  t.equal(reviewedWeth.status, 200, 'reviewing it edits the rows the import wrote');
  const after = await (await server.fetch(`/registry/v1/admin/versions/${versionId}`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  })).json() as { unreviewed: { networks: number[], markets: string[] } };
  t.same(after.unreviewed.markets, [], 'and takes it off the list');

  /*
   * A feed the version already knows needs no chain read — but only on its
   * own network. The AERO feed below is stored for chain 8453; naming the
   * same address on chain 1 is a different contract, so its scale has to come
   * from chain 1, and with no node provider in this harness that read fails
   * rather than silently reusing the other chain's decimals.
   */
  const crossChain = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`,
    { reason: 'a feed address that exists on another chain', overlay: {
      ...overlay,
      status:    'enabled',
      isDefault: true,
      baseAsset: { ...overlay.baseAsset, usdPriceFeedAddress: '0xdb7edfa090061d9367cbeaf6be16ecbde596676c' },
    } },
  ));
  t.equal(crossChain.status, 503, 'the decimals are read from the market\'s own chain, not from another version row');

  // a terminal version is not writable
  await validateSeeded(db, versionId);
  const terminal = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`,
    { reason: 'too late', overlay },
  ));
  t.equal(terminal.status, 409, 'a validated version can no longer be changed');
});

/*
 * Everything else about a version is read by its id, so an operator who has
 * run a few imports needs something that says which ids exist.
 */
t.test('the versions there are can be listed, newest first', async t => {
  const db = await freshDatabase();

  const empty = await (await server.fetch('/registry/v1/admin/versions', { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } })).json() as {
    activeVersionId: string | null, versions: unknown[],
  };
  t.same(empty, { activeVersionId: null, next: null, versions: [] }, 'an environment with no versions lists none');

  const active = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${active}/activate`, { reason: 'bringing it up' }));

  const candidate = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });

  const listed = await (await server.fetch('/registry/v1/admin/versions', { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } })).json() as {
    activeVersionId: string,
    versions: Array<{
      id: string, status: string, attempt: number, isActive: boolean, snapshotChecksum: string | null,
      createdAt: string, validatedAt: string | null,
    }>,
  };
  t.equal(listed.activeVersionId, active, 'the listing names the version that is on');
  t.same(listed.versions.map(version => version.id).sort(), [ active, candidate.versionId ].sort(),
    'and every version there is');
  t.same(
    listed.versions.find(version => version.id === active),
    {
      id:               active,
      status:           'validated',
      attempt:          1,
      isActive:         true,
      sourceRepository: snapshot.registryVersion.sourceRepository.toLowerCase(),
      sourceCommitSha:  snapshot.registryVersion.sourceCommitSha,
      snapshotChecksum: snapshot.registryVersion.checksum,
      createdAt:        listed.versions.find(version => version.id === active)!.createdAt,
      validatedAt:      listed.versions.find(version => version.id === active)!.validatedAt,
      createdBy:        'test-seed',
    } as never,
    'with what each version was built from and what became of it',
  );

  const importing = await (await server.fetch('/registry/v1/admin/versions?status=importing', {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  })).json() as { versions: Array<{ id: string }> };
  t.same(importing.versions.map(version => version.id), [ candidate.versionId ], 'the listing filters by status');

  const one = await (await server.fetch('/registry/v1/admin/versions?limit=1', {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  })).json() as { versions: Array<{ id: string }>, next: string | null };
  t.equal(one.versions.length, 1, 'and is bounded');
  t.equal(one.next, one.versions[0]!.id, 'naming where the next page starts');

  /*
   * A listing longer than a page is read page by page: each page names the
   * version the next one starts after, and the last names none.
   */
  const rest = await (await server.fetch(`/registry/v1/admin/versions?limit=1&before=${one.next}`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  })).json() as { versions: Array<{ id: string }>, next: string | null };
  t.same([ ...one.versions, ...rest.versions ].map(version => version.id), listed.versions.map(version => version.id),
    'the pages are the listing, in its order');
  t.equal(rest.next, null, 'and the last page names no next one');
  t.equal(
    (await server.fetch(`/registry/v1/admin/versions?before=${randomUUID()}`, { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } })).status,
    404,
    'a page cannot start after a version that does not exist',
  );

  for (const query of [ '?status=nonsense', '?limit=0', '?limit=1000', '?limit=half' ]) {
    t.equal(
      (await server.fetch(`/registry/v1/admin/versions${query}`, { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } })).status,
      400,
      `${query} is refused`,
    );
  }
  t.equal((await server.fetch('/registry/v1/admin/versions')).status, 401, 'the listing is behind the token');
});

t.test('a sync run reports its checkpoints without its lease owner', async t => {
  const db    = await freshDatabase();
  const runId = randomUUID();
  const now   = new Date().toISOString();

  await db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, trigger_kind, requested_by, status,
       lease_owner, lease_expires_at, expected_count, started_at
     ) VALUES (?1, ?2, 'main', 'scheduled', 'registry-cron', 'running', 'secret-owner-token', ?3, 1, ?3)`
  ).bind(runId, 'a'.repeat(40), now).run();
  await db.prepare(
    `INSERT INTO sync_run_items (
       id, sync_run_id, root_path, source_blob_sha,
       upstream_network_key, deployment_key, status, attempts, claim_owner, last_error, created_at, updated_at
     ) VALUES (?1, ?2, 'deployments/mainnet/usdc/roots.json', ?3, 'mainnet', 'usdc', 'failed', 1, 'secret-owner-token', 'CHAIN_REQUEST_FAILED: a node provider request failed', ?4, ?4)`
  ).bind(randomUUID(), runId, 'b'.repeat(40), now).run();

  const response = await server.fetch(`/registry/v1/admin/sync-runs/${runId}`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  });
  t.equal(response.status, 200);
  const body = await response.json() as { syncRun: Record<string, unknown>, items: Array<Record<string, unknown>> };
  t.equal(body.syncRun.status, 'running');
  t.equal(body.syncRun.expectedCount, 1);
  t.equal(body.items.length, 1);
  t.equal(body.items[0]!.status, 'failed');
  t.equal(body.items[0]!.lastError, 'CHAIN_REQUEST_FAILED: a node provider request failed', 'a checkpoint reports its diagnostic');

  const serialized = JSON.stringify(body);
  t.notMatch(serialized, /secret-owner-token/, 'but the lease and claim owners never leave the worker');
  t.ok(body.syncRun.leaseExpiresAt, 'while the expiry, which says when the run is resumable, does');

  t.equal(
    (await server.fetch(`/registry/v1/admin/sync-runs/${randomUUID()}`, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
    })).status,
    404,
  );
});

/*
 * A run no invocation can finish is ended by an operator, with why. Only a
 * run nobody holds is: one under a live lease is left to the invocation that
 * holds it, which may be importing into it, and one that has ended is
 * history.
 */
t.test('a sync run nobody holds can be cancelled, with a reason', async t => {
  const db              = await freshDatabase();
  const { ENVIRONMENT } = await server.getWorker<Env>().getEnv();
  const runId           = randomUUID();
  const now             = new Date().toISOString();
  const past            = new Date(Date.now() - 60_000).toISOString();

  // a run whose invocation was stopped in the middle of usdc's last attempt, and whose lease has run out; weth was never reached
  await db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, trigger_kind, requested_by, status,
       lease_owner, lease_expires_at, expected_count, started_at
     ) VALUES (?1, ?2, 'main', 'scheduled', 'registry-cron', 'running', 'stopped-invocation', ?3, 2, ?4)`
  ).bind(runId, 'a'.repeat(40), past, now).run();
  for (const [ key, status, attempts, owner ] of [
    [ 'usdc', 'processing', 5, 'stopped-invocation' ],
    [ 'weth', 'pending',    0, null ],
  ] as const) {
    await db.prepare(
      `INSERT INTO sync_run_items (
         id, sync_run_id, root_path, source_blob_sha, upstream_network_key, deployment_key,
         status, attempts, claim_owner, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, 'mainnet', ?5, ?6, ?7, ?8, ?9, ?9)`
    ).bind(randomUUID(), runId, `deployments/mainnet/${key}/roots.json`, 'b'.repeat(40), key, status, attempts, owner, now).run();
  }
  const cancel = (id: string, body: unknown) => server.fetch(...admin(`/registry/v1/admin/sync-runs/${id}/cancel`, body));
  const messageOf = async (response: { json(): Promise<unknown> }) => (await response.json() as { error: { message: string } }).error.message;

  const bare = await cancel(runId, {});
  t.equal(bare.status, 400, 'a cancel needs a reason');
  t.match(await messageOf(bare), /reason/);
  t.equal((await cancel(runId, { reason: 'x', force: true })).status, 400, 'and takes nothing else');
  t.equal((await cancel(randomUUID(), { reason: 'x' })).status, 404, 'a run that does not exist is not found');

  await db.prepare(`UPDATE sync_runs SET lease_expires_at = ?1 WHERE id = ?2`)
    .bind(new Date(Date.now() + 900_000).toISOString(), runId).run();
  const held = await cancel(runId, { reason: 'x' });
  t.equal(held.status, 409, 'a run an invocation holds is left to it');
  t.match(await messageOf(held), /holds the sync run until/, 'until its lease runs out');
  t.equal(
    await db.prepare(`SELECT status FROM sync_run_items WHERE sync_run_id = ?1 AND deployment_key = 'usdc'`)
      .bind(runId).first<string>('status'),
    'processing',
    'and nothing of it changes',
  );
  await db.prepare(`UPDATE sync_runs SET lease_expires_at = ?1 WHERE id = ?2`).bind(past, runId).run();

  const cancelled = await cancel(runId, { reason: 'a stored overlay no longer parses' });
  t.equal(cancelled.status, 200, 'one whose lease has run out is cancelled');
  const { syncRun, items } = await cancelled.json() as {
    syncRun: Record<string, unknown>,
    items:   Array<{ deploymentKey: string, status: string, lastError: string | null }>,
  };
  t.same(
    [ syncRun.status, syncRun.outcome, syncRun.lastError, syncRun.leaseExpiresAt ],
    [ 'failed', null, `cancelled by registry-admin:${ENVIRONMENT}: a stored overlay no longer parses`, null ],
    'answered with the run, failed, saying who cancelled it and why',
  );
  t.ok(syncRun.completedAt, 'and when');
  t.equal(syncRun.failedCount, 1, 'a root that had spent its last attempt counts among the roots the run gave up');
  t.same(items.map(item => [ item.deploymentKey, item.status, item.lastError ]), [
    [ 'usdc', 'failed', 'the invocation importing this root did not finish' ],
    [ 'weth', 'pending', null ],
  ], 'the root left in progress fails as an invocation taking the run over would fail it');
  t.notMatch(JSON.stringify({ syncRun, items }), /stopped-invocation/, 'and neither the lease nor the claim owner leaves the worker');

  const ended = await cancel(runId, { reason: 'x' });
  t.equal(ended.status, 409, 'a run that has ended is not cancelled again');
  t.match(await messageOf(ended), /already ended/);
});

/*
 * Validation decides over the stored rows. An earlier attempt is history: a
 * check it failed is decided again, and nothing it recorded is carried into
 * the next one — what the chain says about a market is not a check, because a
 * market the chain cannot confirm fails its import before it is written.
 */
t.test('validating a candidate again decides it over its rows alone', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await recordValidationResults(db, versionId, 1, [
    { check_name: 'single-default-market',     scope: 'global',        passed: 0, details: { defaults: [] } },
    { check_name: 'market-contracts-deployed', scope: 'market:1/usdc', passed: 1 },
  ]);

  const response = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, {}));
  t.equal(response.status, 200, 'the rows hold one default market, so the candidate validates');
  const result = await response.json() as {
    version: { status: string },
    summary: { attempt: number, checks: Array<{ name: string, scope: string, passed: boolean }> },
  };
  t.equal(result.version.status, 'validated');
  t.equal(result.summary.attempt, 2, 'in an attempt of its own');
  t.notOk(
    result.summary.checks.some(check => check.name === 'market-contracts-deployed'),
    'which carries nothing over from the attempt before it',
  );
});

t.test('validation can be re-run through the API', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);

  const withReason = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, { reason: 'review' }));
  t.equal(withReason.status, 400, 'validation takes no reason: it decides nothing, and would only discard one');

  const validated = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, {}));
  t.equal(validated.status, 200, 'a complete candidate validates');
  const result = await validated.json() as {
    version: { status: string, checksum: string }, changed: boolean, summary: { failed: number, passed: number },
  };
  t.equal(result.version.status, 'validated');
  t.equal(result.version.checksum, snapshot.registryVersion.checksum, 'and reports the snapshot checksum');
  t.equal(result.changed, true);
  t.equal(result.summary.failed, 0);
  t.ok(result.summary.passed > 0, 'with the checks that decided it');

  const again = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, {}));
  const repeat = await again.json() as { changed: boolean, version: { status: string } };
  t.equal(again.status, 200);
  t.equal(repeat.changed, false, 'revalidating a validated version changes nothing');
  t.equal(repeat.version.status, 'validated');
});

/*
 * A validation that ran answers what it decided, invalid as well as valid:
 * an invalid version is the outcome of the command, not a failure of it, and
 * validating it again gives the same answer rather than an error.
 */
t.test('a candidate that fails its checks is answered as invalid, not as an error', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await db.prepare(`UPDATE markets SET is_default = 0 WHERE registry_version_id = ?1`).bind(versionId).run();

  const first = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, {}));
  t.equal(first.status, 200, 'the validation ran, so it answers 200');
  const decided = await first.json() as {
    version: { status: string }, changed: boolean, summary: { failed: number, checks: Array<{ name: string, passed: boolean }> },
  };
  t.equal(decided.version.status, 'invalid', 'with the version it decided invalid');
  t.equal(decided.changed, true);
  t.ok(decided.summary.checks.some(check => check.name === 'single-default-market' && !check.passed),
    'and the check that decided it');

  const again = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, {}));
  t.equal(again.status, 200, 'validating it again is the same answer');
  const repeat = await again.json() as { version: { status: string }, changed: boolean, summary: { failed: number } };
  t.same([ repeat.version.status, repeat.changed ], [ 'invalid', false ], 'which changes nothing');
  t.equal(repeat.summary.failed, decided.summary.failed, 'and reports the checks it was decided by');
});

/*
 * An administrative sync answers 202 while the import has work left for a
 * later request, and 200 when this request is the whole answer. A request
 * sent while another invocation imports is refused before the source is
 * asked anything: the one running slot would refuse it anyway.
 */
t.test('an administrative sync says whether it is the whole answer', async t => {
  const db = await freshDatabase();
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1`).bind(new Date().toISOString()).run();

  const idle = await server.fetch(...admin('/registry/v1/admin/sync', {}));
  t.equal(idle.status, 200, 'a request with nothing to do is answered, not accepted for later');
  t.equal((await idle.json() as { status: string }).status, 'idle');

  // another invocation, importing right now under a live lease
  await db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, trigger_kind, requested_by, status,
       lease_owner, lease_expires_at, expected_count, started_at
     ) VALUES (?1, ?2, 'main', 'scheduled', 'registry-cron', 'running', ?3, ?4, 1, ?5)`
  ).bind(randomUUID(), 'a'.repeat(40), randomUUID(), new Date(Date.now() + 900_000).toISOString(), new Date().toISOString()).run();

  const busy = await server.fetch(...admin('/registry/v1/admin/sync', {}));
  t.equal(busy.status, 409, 'a request while another invocation imports is refused');
  const { error } = await busy.json() as { error: { code: string, details: { code: string } } };
  t.same([ error.code, error.details.code ], [ 'CONFLICT', 'SYNC_ALREADY_RUNNING' ],
    'as a conflict, whose details name the registry\'s own reason');
});

/*
 * Before a newer version is switched on, the question is what switching
 * changes. The candidate is readable while it still imports, because that is
 * when a market the source added is described, from the facts its import read.
 */
t.test('what a candidate changes against the active version is served while it imports', async t => {
  const db = await freshDatabase();
  const auth = { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } };

  const activeId = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${activeId}/activate`, { reason: 'activate' }));

  const next    = structuredClone(snapshot);
  const mainnet = next.networks.find(network => network.chainId === 1)!;
  mainnet.markets = mainnet.markets.filter(market => market.deploymentKey !== 'wbtc');
  const weth = mainnet.markets.find(market => market.deploymentKey === 'weth')!;
  weth.creationBlock = weth.creationBlock + 1;
  // two markets the source added: one already described, one nobody has looked at
  const usdt  = mainnet.markets.find(market => market.deploymentKey === 'usdt')!;
  const added = (deploymentKey: string, comet: string, offset: number) => ({
    ...structuredClone(usdt),
    deploymentKey,
    displayName:   deploymentKey.toUpperCase(),
    isDefault:     false,
    creationBlock: usdt.creationBlock + offset,
    contracts:     { ...usdt.contracts, comet: comet as `0x${string}` },
  });
  mainnet.markets.push(
    added('described', '0x6666666666666666666666666666666666666666', 1),
    added('undescribed', '0x7777777777777777777777777777777777777777', 2),
  );
  const { versionId } = await seedCandidate(db, next, { versionId: randomUUID(), attempt: 2 });
  await db.prepare(
    `UPDATE markets SET status = 'disabled', reviewed = 0 WHERE registry_version_id = ?1 AND deployment_key IN ('usdt', 'undescribed')`
  ).bind(versionId).run();

  const response = await server.fetch(`/registry/v1/admin/versions/${versionId}/changes`, auth);
  t.equal(response.status, 200);
  const changes = await response.json() as {
    status: string, comparedWith: string,
    markets: {
      added:    Array<{ scope: string, reviewed: boolean }>,
      removed:  string[],
      changed:  Array<{ scope: string, field: string, before: unknown, after: unknown }>,
      unserved: Array<{ scope: string, comet: string, now: { scope: string, status: string } | null }>,
    },
  };
  t.equal(changes.status, 'importing', 'a candidate that still imports is comparable');
  t.equal(changes.comparedWith, activeId, 'against the version that is on');
  t.same(
    changes.markets.added.map(({ scope, reviewed }) => ({ scope, reviewed })),
    [ { scope: '1/described', reviewed: true }, { scope: '1/undescribed', reviewed: false } ],
    'the markets it adds, each named as the version names it, and whether someone has described it',
  );
  t.same(changes.markets.removed, [ '1/wbtc' ], 'the market it drops');
  t.same(
    changes.markets.changed.filter(change => change.scope === '1/weth'),
    [ { scope: '1/weth', field: 'creationBlock', before: weth.creationBlock - 1, after: weth.creationBlock } ],
    'and what it changes on a market that stays',
  );
  t.ok(changes.markets.changed.some(change => change.scope === '1/usdt' && change.field === 'status'),
    'including a market written unreviewed, which the version no longer offers');
  t.same(
    changes.markets.unserved.map(({ scope, now }) => ({ scope, now })),
    [ { scope: '1/usdt', now: { scope: '1/usdt', status: 'disabled' } }, { scope: '1/wbtc', now: null } ],
    'so the markets users of the version on would lose are named, with where the candidate holds each',
  );

  t.equal((await server.fetch(`/registry/v1/admin/versions/${randomUUID()}/changes`, auth)).status, 404,
    'a version that does not exist has nothing to compare');
  t.equal((await server.fetch(`/registry/v1/admin/versions/${versionId}/changes`)).status, 401,
    'and the route is authenticated');
});

t.test('the shadow comparison is served for the active version, and for a candidate by id', async t => {
  const db = await freshDatabase();

  const withoutActive = await server.fetch('/registry/v1/admin/shadow', {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  });
  t.equal(withoutActive.status, 503, 'with no active version there is nothing to compare');

  const versionId = await seedValidated(db);
  const candidate = await server.fetch(`/registry/v1/admin/versions/${versionId}/shadow`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  });
  t.equal(candidate.status, 200, 'a validated candidate is comparable before it is activated');
  const before = await candidate.json() as {
    agrees: boolean,
    shadow: { versionId: string, registryMarkets: number, onlyInRegistry: string[], differences: unknown[] },
  };
  t.equal(before.shadow.versionId, versionId, 'the report names the version it compared');
  t.equal(before.shadow.registryMarkets, 6);
  t.same(before.shadow.onlyInRegistry, [], 'the constants describe every market of the fixture');
  t.equal(before.agrees, false, 'which the fixture does not fully agree with');
  t.ok(before.shadow.differences.length > 0, 'and the report says where');

  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'activate' }));
  const active = await server.fetch('/registry/v1/admin/shadow', {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  });
  t.equal(active.status, 200);
  t.equal(active.headers.get('x-registry-version'), versionId, 'the active comparison names the version too');
  t.equal(active.headers.get('access-control-allow-origin'), null, 'and stays out of reach of a browser');

  t.equal(
    (await server.fetch(`/registry/v1/admin/versions/${randomUUID()}/shadow`, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
    })).status,
    404,
    'a version that was never validated has no snapshot to compare',
  );
  t.equal((await server.fetch('/registry/v1/admin/shadow')).status, 401, 'and the route is authenticated');
});
