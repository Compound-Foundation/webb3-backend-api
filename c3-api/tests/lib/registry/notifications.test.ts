import t, { Test } from 'tap';

import { randomUUID } from 'node:crypto';

import type { Env } from '../../../entrypoint.js';
import * as Debug from '../../../lib/debug-log.js';
import type { ApprovalV1, NetworkV1, RegistryVersionRefV1 } from '../../../lib/model/comet-registry.js';
import { compareVersions } from '../../../src/registry/changes.js';
import { FAILURE_KEY, NOTIFICATION_TIMEOUT_MS, notificationOf, notifyRegistryEvent, readNotificationFailure } from '../../../src/registry/notifications.js';
import type { NotificationFacts, WebhookBody } from '../../../src/registry/notifications.js';
import { activateVersion, readVersion } from '../../../src/registry/repository.js';

import { refusingKv } from '../../util/kv.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import type { RegistryDatabase } from '../../util/registry-database.js';
import { approveSeeded, loadRegistrySnapshotFixture, seedCandidate, validateSeeded } from '../../util/registry-fixture.js';
import { makeTestEnv } from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * What a move of the active version, or an approval, is announced as, and
 * what becomes of the message. The text is what a person in the channel
 * reads, so each kind of message is held to its words; the event beside it
 * is what a receiver acts on. The webhook's URL is a credential, so no line
 * logged about a message may carry it, however the runtime spells it.
 */
const snapshot = loadRegistrySnapshotFixture();

const ON: RegistryVersionRefV1 = {
  id:               'd9698ddd-ab86-46bc-a412-c71df7d20414',
  sourceRepository: 'compound-foundation/comet',
  sourceCommitSha:  '5d2e1f04c7b9a3e8f6d2c1b0a9e8d7c6b5a4f3e2',
  checksum:         '1bd74ebe00d845e0fa5e648b22a2c39e60d9a62bf6c58190320fa01cd9a26a4a',
};

const NEXT: RegistryVersionRefV1 = {
  id:               'c0d77dad-5b0e-4f8a-9d55-0c1b2a3e4f60',
  sourceRepository: 'compound-foundation/comet',
  sourceCommitSha:  'a34d9b571c833b5d77f052ab8e2dbdbe10df726d',
  checksum:         '748b4d56e58efd6f44f94587c0d0ea9e63355b06faebb386a42f5eee7b3c2ba9',
};

// the fixture without Scroll, with Base and the Ethereum USDC market renamed: what the next commit changes
function nextNetworks(): NetworkV1[] {
  return structuredClone(snapshot.networks)
    .filter(network => network.chainId !== 534352)
    .map(network => network.chainId === 8453 ? { ...network, displayName: 'Base Mainnet' } : {
      ...network,
      markets: network.markets.map(market => market.deploymentKey === 'usdc' ? { ...market, displayName: 'USD Coin' } : market),
    });
}

// what switching from the fixture to the next commit changes, as a message names it
const FORWARD = {
  networks: { added: [], removed: [ 534352 ], changed: [ 8453 ] },
  markets:  { added: [], removed: [ '534352/usdc' ], changed: [ '1/usdc' ], unserved: [ '534352/usdc' ] },
};

// bob's approval of the next commit's version, against the version on, which alice's activation uses
const APPROVAL = {
  id:        '5b1f0c2e-7a64-4d0f-9a3e-2c8d1e6f4b70',
  actor:     'bob',
  createdAt: '2026-11-04T11:00:00.000Z',
  expiresAt: '2026-11-05T11:00:00.000Z',
};

function facts(overrides: Partial<NotificationFacts> = {}): NotificationFacts {
  return {
    environment:     'production',
    kind:            'activate',
    activationId:    '3e96812b-6a0b-4c55-a1c2-7f1f3e2d9c10',
    at:              '2026-11-04T12:00:00.000Z',
    actor:           'alice',
    reason:          'switch on the new commit',
    version:         NEXT,
    previousVersion: ON,
    approval:        APPROVAL,
    changes:         compareVersions(snapshot.networks, nextNetworks(), new Set()),
    ...overrides,
  };
}

t.test('an activation says who switched which version on, in place of which, who approved it, and what that changed', async t => {
  const body = notificationOf(facts());

  t.equal(
    body.text,
    `[production] alice activated registry version ${NEXT.id} (commit a34d9b5), replacing ${ON.id}, approved by bob. `
      + `Markets: 0 added, 1 removed, 1 changed, 1 no longer served; networks: 0 added, 1 removed, 1 changed. `
      + `Reason: "switch on the new commit"`,
    'in the words the channel reads',
  );
  t.same(body.registryEvent, {
    kind:            'activate',
    environment:     'production',
    at:              '2026-11-04T12:00:00.000Z',
    actor:           'alice',
    reason:          'switch on the new commit',
    version:         NEXT,
    previousVersion: ON,
    activationId:    '3e96812b-6a0b-4c55-a1c2-7f1f3e2d9c10',
    approval:        APPROVAL,
    changes:         FORWARD,
  }, 'and in the event a receiver acts on, which names each network and market, and the approval it used');
  t.same([ body.unfurl_links, body.unfurl_media ], [ false, false ], 'and no link in it is expanded into a preview');

  t.match(notificationOf(facts({ approval: null })).text, `replacing ${ON.id}. Markets: `,
    'a move recorded with no approval names none');
});

/*
 * An approval is announced as it is given, so the channel hears of a change
 * while it can still be stopped: who approved which version, against which,
 * until when, and what switching it on would change.
 */
t.test('an approval says who approved which version, against which, until when, and what it would change', async t => {
  const body = notificationOf(facts({
    kind:         'approve',
    activationId: null,
    at:           APPROVAL.createdAt,
    actor:        'bob',
    reason:       'read the changes',
  }));

  t.equal(
    body.text,
    `[production] bob approved registry version ${NEXT.id} (commit a34d9b5) until ${APPROVAL.expiresAt}, against ${ON.id}. `
      + `Markets: 0 added, 1 removed, 1 changed, 1 no longer served; networks: 0 added, 1 removed, 1 changed. `
      + `Reason: "read the changes"`,
  );
  t.same(body.registryEvent, {
    kind:            'approve',
    environment:     'production',
    at:              APPROVAL.createdAt,
    actor:           'bob',
    reason:          'read the changes',
    version:         NEXT,
    previousVersion: ON,
    activationId:    null,
    approval:        APPROVAL,
    changes:         FORWARD,
  }, 'with the approval itself, and no move');

  t.match(
    notificationOf(facts({ kind: 'approve', activationId: null, actor: 'bob', previousVersion: null })).text,
    `until ${APPROVAL.expiresAt}, with no version on. `,
    'and one given while nothing is on says so',
  );
});

t.test('the first activation of an environment replaces nothing, and adds everything', async t => {
  const body = notificationOf(facts({
    previousVersion: null,
    reason:          'first registry version',
    changes:         compareVersions(null, snapshot.networks, new Set()),
  }));

  t.equal(
    body.text,
    `[production] alice activated registry version ${NEXT.id} (commit a34d9b5), with no version on before, approved by bob. `
      + `Markets: 6 added, 0 removed, 0 changed, 0 no longer served; networks: 3 added, 0 removed, 0 changed. `
      + `Reason: "first registry version"`,
  );
  t.equal(body.registryEvent.previousVersion, null);
  t.same(body.registryEvent.changes, {
    networks: { added: [ 1, 8453, 534352 ], removed: [], changed: [] },
    markets:  {
      added:    [ '1/usdc', '1/usdt', '1/wbtc', '1/weth', '8453/aero', '534352/usdc' ],
      removed:  [],
      changed:  [],
      unserved: [],
    },
  }, 'every network and market, as GET …/changes lists them');
});

t.test('a rollback says which version it went back to, and which it left', async t => {
  const body = notificationOf(facts({
    kind:            'rollback',
    actor:           'bob',
    reason:          'the new commit broke the frontend',
    version:         ON,
    previousVersion: NEXT,
    approval:        null,
    changes:         compareVersions(nextNetworks(), snapshot.networks, new Set()),
  }));

  t.equal(
    body.text,
    `[production] bob rolled the registry back to version ${ON.id} (commit 5d2e1f0) from ${NEXT.id}. `
      + `Markets: 1 added, 0 removed, 1 changed, 0 no longer served; networks: 1 added, 0 removed, 1 changed. `
      + `Reason: "the new commit broke the frontend"`,
  );
  t.equal(body.registryEvent.kind, 'rollback');
  t.same(body.registryEvent.previousVersion, NEXT, 'the version it left is the one it replaced');
  t.equal(body.registryEvent.approval, null, 'and one person made it, with no approval');

  t.match(
    notificationOf(facts({ kind: 'rollback', previousVersion: null, approval: null })).text,
    `rolled the registry back to version ${NEXT.id} (commit a34d9b5), with no version on before. `,
    'and one made while nothing was on says so',
  );
});

/*
 * Slack reads `<…>` as a mention or a link and `&` as the start of either, so
 * a reason, the one value of the text a person writes freely, reaches the
 * channel as text. Every other value is escaped as well: no token's name can
 * hold markup today, and the text does not rest on that.
 */
t.test('what a person wrote reaches the channel as text, and the event as written', async t => {
  const reason = '<!channel> read this & <https://example.test/notes|the release notes>';
  const body   = notificationOf(facts({ reason }));

  t.match(body.text, `"&lt;!channel&gt; read this &amp; &lt;https://example.test/notes|the release notes&gt;"`, 'the reason is escaped');
  t.notOk(/[<>]/.test(body.text), 'so nothing in it is markup');
  t.equal(body.registryEvent.reason, reason, 'while the event carries the reason as it was recorded');

  const named = notificationOf(facts({ actor: 'ops <@U0123>' }));
  t.match(named.text, `[production] ops &lt;@U0123&gt; activated registry version`, 'and so is an actor, a name no token can have');
  t.equal(named.registryEvent.actor, 'ops <@U0123>');

  const approved = notificationOf(facts({ approval: { ...APPROVAL, actor: 'ops <@U0123>' } }));
  t.match(approved.text, `, approved by ops &lt;@U0123&gt;. Markets: `, 'and the admin who approved the move');
  t.equal(approved.registryEvent.approval?.actor, 'ops <@U0123>');
});

/*
 * A reason may run over lines, and Slack would show each as a line of the
 * message. Each becomes one space, and the reason comes last, so nothing it
 * says can stand before the counts the worker states, or read as them: the
 * announcement of an approval is what the channel stops a change by.
 */
t.test('a reason over several lines reaches the channel on one line, after the counts', async t => {
  const reason = 'routine". Markets: 0 added, 0 removed, 0 changed, 0 no longer served; networks: 0 added, 0 removed, 0 changed.'
    + '\n'.repeat(40) + 'see\r\nthe\u2028ticket\u0085for\tit';
  const body = notificationOf(facts({ kind: 'approve', activationId: null, actor: 'mallory', reason }));

  t.notOk(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(body.text), 'the text has no line break, nor any other control character');
  t.ok(body.text.startsWith(`[production] mallory approved registry version ${NEXT.id} (commit a34d9b5) until ${APPROVAL.expiresAt}, against ${ON.id}. `
    + `Markets: 0 added, 1 removed, 1 changed, 1 no longer served; networks: 0 added, 1 removed, 1 changed. Reason: "routine". `),
    'the counts the worker states come first');
  t.ok(body.text.endsWith(`networks: 0 added, 0 removed, 0 changed. see the ticket for it"`), 'and the reason after them, each run of breaks a space');
  t.equal(body.registryEvent.reason, reason, 'while the event carries the reason as it was recorded');
});

t.test('a move whose changes could not be read is announced without them', async t => {
  const body = notificationOf(facts({ changes: null }));

  t.ok(body.text.endsWith(`. What changed could not be read. Reason: "switch on the new commit"`), 'saying so');
  t.equal(body.registryEvent.changes, null);
});

// every line the logger writes, at any level
function capture(t: Test): string[] {
  const lines: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log, debug: console.debug };
  for (const level of [ 'error', 'warn', 'log', 'debug' ] as const) {
    console[level] = (...parameters: unknown[]) => { lines.push(`${level}: ${parameters.map(String).join(' ')}`); };
  }
  t.teardown(() => { Object.assign(console, saved); });
  return lines;
}

// the root logger, as the worker configures it from the environment
function logger(env: Env): Debug.Logger {
  return Debug.MakeLogger([]).configure(env);
}

t.test('with no webhook, or one that is no https URL, nothing is read or sent', async t => {
  const lines = capture(t);
  const asked: string[] = [];
  for (const value of [ undefined, '', '  ', 'http://hooks.example.test/services/T0/B0/x', 'hooks.example.test/services/T0', 'not a url' ]) {
    // the database is one a Node test cannot reach: any read of it throws, and the notifier would log that
    const env = makeTestEnv(value === undefined ? {} : { COMET_REGISTRY_WEBHOOK_URL: value });
    await notifyRegistryEvent(env, { activationId: randomUUID() }, {
      debug: logger(env),
      fetch: async url => { asked.push(url); return new Response('ok'); },
    });
  }
  t.same(asked, [], 'nothing is sent');
  t.same(lines, [], 'and nothing is read or logged');
});

/*
 * A webhook as somebody might paste it: its host in capitals and the default
 * port named. The runtime reports a request by the URL it parsed, which is
 * spelled otherwise, so neither spelling, nor the path that is the secret,
 * may reach a line — with every scope and level of the log switched on,
 * `fetch` among them, as the local environment has it.
 */
const WEBHOOK = 'https://HOOKS.Example.TEST:443/services/T0SECRET/B0SECRET/notifications-secret';
const PARSED  = 'https://hooks.example.test/services/T0SECRET/B0SECRET/notifications-secret';
const SECRET  = /T0SECRET|B0SECRET|notifications-secret|hooks\.example\.test/i;

function envOf(registry: RegistryDatabase, overrides: Partial<Env> = {}): Env {
  return makeTestEnv({
    ENVIRONMENT:                'production',
    DEBUG:                      'fetch,all',
    DEBUG_LEVEL:                'debug',
    APP_DB:                     registry.db,
    COMET_REGISTRY_WEBHOOK_URL: WEBHOOK,
    ...overrides,
  });
}

// a database with a version on, and a move to the next commit's version, whose audit row a message is read from
async function moved(t: Test): Promise<{ registry: RegistryDatabase, next: string, activationId: string, approval: ApprovalV1 }> {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const { versionId: next } = await seedCandidate(registry.db, { ...snapshot, networks: nextNetworks() }, {
    versionId: randomUUID(),
    attempt:   2,
  });
  await validateSeeded(registry.db, next);
  const approval = await approveSeeded(registry.db, next, 'bob');
  const { activationId } = await activateVersion(registry.db, {
    versionId: next, action: 'activate', actor: 'alice', reason: 'switch on the new commit',
  });
  return { registry, next, activationId: activationId!, approval };
}

t.test('a move is posted once, as JSON, and a message given up before is forgotten', async t => {
  const { registry, next, activationId, approval } = await moved(t);
  const lines = capture(t);
  const env   = envOf(registry);
  await env.kv_registry.put(FAILURE_KEY, JSON.stringify({
    at: '2026-11-01T00:00:00.000Z', activationId: randomUUID(), kind: 'activate', versionId: randomUUID(),
    status: 410, reason: 'the webhook answered 410',
  }));

  const posted: Array<{ url: string, init: RequestInit }> = [];
  await notifyRegistryEvent(env, { activationId }, {
    debug:     logger(env),
    requestId: 'request-1',
    fetch:     async (url, init) => { posted.push({ url, init }); return new Response('ok'); },
  });

  t.equal(posted.length, 1, 'one request');
  t.equal(posted[0]!.url, PARSED, 'to the webhook');
  t.equal(posted[0]!.init.method, 'POST', 'as a POST');
  t.same(posted[0]!.init.headers, { 'Content-Type': 'application/json' }, 'of JSON');
  const body = JSON.parse(String(posted[0]!.init.body)) as WebhookBody;
  t.match(body.registryEvent, {
    kind:            'activate',
    environment:     'production',
    actor:           'alice',
    reason:          'switch on the new commit',
    activationId,
  }, 'read from the audit row of the move');
  t.same(body.registryEvent.approval, {
    id: approval.id, actor: 'bob', createdAt: approval.createdAt, expiresAt: approval.expiresAt,
  }, 'with the approval it used');
  const [ version, previous ] = await Promise.all([ readVersion(registry.db, next), readVersion(registry.db, registry.versionId) ]);
  t.same([ body.registryEvent.version, body.registryEvent.previousVersion ], [ version, previous ].map(row => ({
    id:               row!.id,
    sourceRepository: row!.source_repository,
    sourceCommitSha:  row!.source_commit_sha,
    checksum:         row!.snapshot_checksum,
  })), 'and the two versions it names');
  t.same(body.registryEvent.changes, FORWARD, 'with what it changed, read from both versions');

  t.equal(await readNotificationFailure(env.kv_registry), null, 'a message given up before is no longer news');
  t.ok(lines.some(line => line.includes('registryNotification') && line.includes('status: 200') && line.includes('request-1')),
    'the log says it was sent, for the request that made the move');
  t.notOk(lines.some(line => SECRET.test(line)), 'and never where to');
});

t.test('an approval is posted from its own audit row, against the version on when it was given', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const { versionId: next } = await seedCandidate(registry.db, { ...snapshot, networks: nextNetworks() }, { versionId: randomUUID(), attempt: 2 });
  await validateSeeded(registry.db, next);
  const approval = await approveSeeded(registry.db, next, 'bob');
  const lines = capture(t);
  const env   = envOf(registry);

  const posted: WebhookBody[] = [];
  await notifyRegistryEvent(env, { approvalId: approval.id }, {
    debug: logger(env),
    fetch: async (_url, init) => { posted.push(JSON.parse(String(init.body))); return new Response('ok'); },
  });
  t.equal(posted.length, 1, 'one message');
  t.match(posted[0]!.registryEvent, {
    kind:            'approve',
    actor:           'bob',
    reason:          'test',
    at:              approval.createdAt,
    version:         { id: next },
    previousVersion: { id: registry.versionId },
    activationId:    null,
    approval:        { id: approval.id, actor: 'bob', createdAt: approval.createdAt, expiresAt: approval.expiresAt },
    changes:         FORWARD,
  }, 'naming the approval, the version it approves and the one on, and what switching it on would change');
  t.match(posted[0]!.text, `bob approved registry version ${next}`, 'in its text too');
  t.ok(lines.some(line => line.includes('registryNotification') && line.includes(`approvalId: '${approval.id}'`)),
    'and the log says it was sent, by the approval');

  const unknown = randomUUID();
  await notifyRegistryEvent(env, { approvalId: unknown }, {
    debug: logger(env),
    fetch: async () => { throw new Error('nothing is sent for an approval no row records'); },
  });
  t.match(await readNotificationFailure(env.kv_registry), {
    activationId: null, approvalId: unknown, kind: null, versionId: null, status: null, reason: 'no approval has that id',
  }, 'one that cannot be read is recorded by its id');
  t.notOk(lines.some(line => SECRET.test(line)), 'and no line names the webhook');
});

t.test('a webhook that refuses, fails or does not answer is logged and recorded, never by its URL', async t => {
  const { registry, next, activationId } = await moved(t);
  const lines = capture(t);

  const cases: Array<{ name: string, fetch: (url: string, init: RequestInit) => Promise<Response>, given: Record<string, unknown> }> = [
    {
      name:  'refuses',
      // an error page that quotes the path it was asked for, which is never read
      fetch: async () => new Response(`<h1>no_service: ${PARSED}</h1>`, { status: 404 }),
      given: { status: 404, reason: 'the webhook answered 404' },
    },
    {
      name:  'fails',
      // what the runtime says of a request it could not make names the URL, spelled its own way
      fetch: async () => { throw new TypeError(`fetch failed: ${PARSED}`); },
      given: { status: null, reason: 'the request failed' },
    },
    {
      name:  'does not answer',
      fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      }),
      given: { status: null, reason: 'did not answer within 0.02 seconds' },
    },
  ];
  for (const { name, fetch, given } of cases) {
    const env  = envOf(registry);
    const from = lines.length;
    await t.resolves(notifyRegistryEvent(env, { activationId }, { debug: logger(env), fetch, timeoutMs: 20 }), `a webhook that ${name} fails nothing`);
    const logged = lines.slice(from);
    t.ok(logged.includes('error: registry notification failed'), 'it is logged as an error');
    t.ok(logged.some(line => line.includes(`reason: '${given.reason}'`)), `saying why: ${given.reason}`);
    t.match(await readNotificationFailure(env.kv_registry), { activationId, kind: 'activate', versionId: next, ...given },
      'and recorded for the status, naming the move');
  }
  t.equal(NOTIFICATION_TIMEOUT_MS, 5_000, 'a webhook no test hurries has 5 seconds to answer');
  t.ok(lines.some(line => line.includes(`errorName: 'TypeError'`)), 'a request that failed names its error');
  t.notOk(lines.some(line => SECRET.test(line)), 'and no line names the webhook, in either spelling, nor its path');
});

t.test('a move that cannot be read is not announced, and the status hears of it', async t => {
  const { registry } = await moved(t);
  const lines = capture(t);
  const env   = envOf(registry);
  const asked: string[] = [];
  const unknown = randomUUID();

  await notifyRegistryEvent(env, { activationId: unknown }, {
    debug: logger(env),
    fetch: async url => { asked.push(url); return new Response('ok'); },
  });
  t.same(asked, [], 'nothing is sent for a move no audit row records');
  t.ok(lines.includes('error: registry notification failed'), 'which is logged');
  t.match(await readNotificationFailure(env.kv_registry), { activationId: unknown, kind: null, versionId: null, status: null },
    'and recorded');
});

t.test('a move whose changes cannot be read is announced without them', async t => {
  const { registry, activationId } = await moved(t);
  const lines = capture(t);
  // the move is one statement; reading both versions is the batches that fail
  const db = new Proxy(registry.db, {
    get(target, property, receiver) {
      if (property === 'batch') {
        return async () => { throw new Error('D1_ERROR: Network connection lost.'); };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as D1Database;
  const env = envOf(registry, { APP_DB: db });

  const posted: WebhookBody[] = [];
  await notifyRegistryEvent(env, { activationId }, {
    debug: logger(env),
    fetch: async (_url, init) => { posted.push(JSON.parse(String(init.body))); return new Response('ok'); },
  });
  t.equal(posted.length, 1, 'the move is announced');
  t.equal(posted[0]!.registryEvent.changes, null, 'without what it changed');
  t.match(posted[0]!.text, '. What changed could not be read. Reason: ', 'which the text says');
  t.ok(lines.includes('warn: registry notification without changes'), 'and the log warns of');
});

t.test('a namespace that does not take the record fails nothing', async t => {
  const { registry, activationId } = await moved(t);
  const lines = capture(t);
  const env   = envOf(registry, { kv_registry: refusingKv() });

  await t.resolves(notifyRegistryEvent(env, { activationId }, {
    debug: logger(env),
    fetch: async () => new Response('', { status: 500 }),
  }), 'the notifier resolves');
  t.ok(lines.includes('error: registry notification failed'), 'the message given up is logged');
  t.ok(lines.includes('warn: registry notification failure not recorded'), 'and the record it could not keep is a warning');

  await t.resolves(notifyRegistryEvent(env, { activationId }, {
    debug: logger(env),
    fetch: async () => new Response('ok'),
  }), 'and so it does once the webhook takes it');
  t.ok(lines.includes('warn: registry notification failure not cleared'), 'with the record it could not clear a warning');
});

t.test('a record of some other shape is no record', async t => {
  const env = makeTestEnv({});
  await env.kv_registry.put(FAILURE_KEY, JSON.stringify({ at: 7 }));
  t.equal(await readNotificationFailure(env.kv_registry), null);
  await env.kv_registry.put(FAILURE_KEY, JSON.stringify('given up'));
  t.equal(await readNotificationFailure(env.kv_registry), null);
  await env.kv_registry.put(FAILURE_KEY, JSON.stringify({ at: '2026-11-01T00:00:00.000Z', reason: 'the webhook answered 410' }));
  t.equal(await readNotificationFailure(env.kv_registry), null, 'nor is one that names neither a move nor an approval');
});
