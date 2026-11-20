import t, { Test } from 'tap';

import { randomUUID } from 'node:crypto';

import C3Api, { Env } from '../../../entrypoint.js';
import { sha256 } from '../../../lib/hash.js';
import type { ActivationResultV1 } from '../../../lib/model/comet-registry.js';
import type { FieldChange, VersionChanges } from '../../../src/registry/changes.js';
import type { WebhookBody } from '../../../src/registry/notifications.js';
import type { RegistryStatus } from '../../../src/registry/status.js';

import { activeRegistryDatabase } from '../../util/registry-database.js';
import type { RegistryDatabase } from '../../util/registry-database.js';
import { approveSeeded, loadRegistrySnapshotFixture, seedCandidate, validateSeeded } from '../../util/registry-fixture.js';
import { makeTestEnv } from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * A move of the active version, or an approval, announced through the
 * worker's own entry point, as the runtime runs it: the command answers, and
 * the message is a task the invocation is kept alive for, which reads the
 * move or the approval back from its audit row and posts it. The webhook
 * here is the runtime's fetch standing in for its host, and the runtime's
 * invocation context is one that keeps the tasks it is handed, so a test
 * can wait for them.
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';
// bob's, the admin who approves what alice switches on
const APPROVER    = 'registry-approver-token-for-tests';
const WEBHOOK     = 'https://hooks.slack.test/services/T0NOTIFY/B0NOTIFY/notifications-secret';
const SECRET      = /T0NOTIFY|B0NOTIFY|notifications-secret|hooks\.slack\.test/i;

const snapshot = loadRegistrySnapshotFixture();

async function envWith(registry: RegistryDatabase, overrides: Partial<Env> = {}): Promise<Env> {
  return makeTestEnv({
    MEMORY_CACHE_SEED:                'registry-notifications',
    ENVIRONMENT:                      'stage',
    APP_DB:                           registry.db,
    COMET_REGISTRY_ADMIN_TOKENS:      JSON.stringify([
      { name: 'alice', sha256: await sha256(ADMIN_TOKEN), role: 'admin', notAfter: null },
      { name: 'bob',   sha256: await sha256(APPROVER),    role: 'admin', notAfter: null },
    ]),
    COMET_REGISTRY_WEBHOOK_URL:       WEBHOOK,
    REGISTRY_ADMIN_RATE_LIMITER:      { limit: async () => ({ success: true }) },
    REGISTRY_ADMIN_AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  });
}

// an invocation context that keeps what it is asked to see through
function invocation(): { execution: ExecutionContext, tasks: Array<Promise<unknown>> } {
  const tasks: Array<Promise<unknown>> = [];
  const execution = {
    waitUntil:              (task: Promise<unknown>) => { tasks.push(task); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { execution, tasks };
}

async function get(env: Env, path: string): Promise<Response> {
  return C3Api.fetch(new Request(`https://api.test.local${path}`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  }), env);
}

async function post(env: Env, path: string, body: unknown, execution?: ExecutionContext, token: string = ADMIN_TOKEN): Promise<Response> {
  return C3Api.fetch(new Request(`https://api.test.local${path}`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }), env, execution);
}

/*
 * Bob's approval of a version, recorded as the approve route records it but
 * without announcing it, for a test about the move that uses it.
 */
async function approved(registry: RegistryDatabase, versionId: string): Promise<{ id: string, actor: string, createdAt: string, expiresAt: string }> {
  const { id, actor, createdAt, expiresAt } = await approveSeeded(registry.db, versionId, 'bob');
  return { id, actor, createdAt, expiresAt };
}

type Posted = { url: string, body: WebhookBody };

/*
 * The runtime's fetch, standing in for the webhook's host: a request there is
 * kept and answered as `answer` says, and every other request goes out as it
 * would. `all` keeps every request the worker makes, wherever it goes.
 */
function webhook(t: Test, answer: () => Promise<Response> = async () => new Response('ok')): { posted: Posted[], all: string[] } {
  const posted: Posted[] = [];
  const all: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    all.push(request.url);
    if (new URL(request.url).hostname !== 'hooks.slack.test') {
      return original(request);
    }
    posted.push({ url: request.url, body: await request.json() as WebhookBody });
    return answer();
  }) as typeof globalThis.fetch;
  t.teardown(() => { globalThis.fetch = original; });
  return { posted, all };
}

function captureLogs(t: Test): string[] {
  const lines: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log, debug: console.debug };
  for (const level of [ 'error', 'warn', 'log', 'debug' ] as const) {
    console[level] = (...parameters: unknown[]) => { lines.push(`${level}: ${parameters.map(String).join(' ')}`); };
  }
  t.teardown(() => { Object.assign(console, saved); });
  return lines;
}

// a version of the next commit, which drops Scroll and renames Base and the Ethereum USDC market
async function seedNext(registry: RegistryDatabase): Promise<string> {
  const networks = structuredClone(snapshot.networks)
    .filter(network => network.chainId !== 534352)
    .map(network => network.chainId === 8453 ? { ...network, displayName: 'Base Mainnet' } : {
      ...network,
      markets: network.markets.map(market => market.deploymentKey === 'usdc' ? { ...market, displayName: 'USD Coin' } : market),
    });
  const { versionId } = await seedCandidate(registry.db, { ...snapshot, networks }, { versionId: randomUUID(), attempt: 2 });
  await validateSeeded(registry.db, versionId);
  return versionId;
}

// what GET …/changes answers, as a message summarizes it: which networks and markets, not how
function summaryOf(changes: VersionChanges): unknown {
  const scopes = (fields: FieldChange[]) => [ ...new Set(fields.map(field => field.scope)) ];
  return {
    networks: { added: changes.networks.added, removed: changes.networks.removed, changed: scopes(changes.networks.changed).map(Number) },
    markets:  {
      added:    changes.markets.added.map(market => market.scope),
      removed:  changes.markets.removed,
      changed:  scopes(changes.markets.changed),
      unserved: changes.markets.unserved.map(market => market.scope),
    },
  };
}

// what a promise settles to, or `still waiting` once `ms` have passed: a step that waits on the webhook fails rather than hangs
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<'still waiting'>(resolve => { timer = setTimeout(() => resolve('still waiting'), ms); });
  try {
    return await Promise.race([ promise, waited ]);
  } finally {
    clearTimeout(timer);
  }
}

t.test('an activation answers without waiting for the webhook, and is then posted once', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  captureLogs(t);
  const next = await seedNext(registry);
  const env  = await envWith(registry);

  const changes = await (await get(env, `/registry/v1/admin/versions/${next}/changes`)).json() as VersionChanges & { comparedWith: string };
  t.equal(changes.comparedWith, registry.versionId, 'what switching it on changes, against the version on');

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const { posted } = webhook(t, async () => { await held; return new Response('ok'); });
  const { execution, tasks } = invocation();
  const approval = await approved(registry, next);

  const answer = await within(post(env, `/registry/v1/admin/versions/${next}/activate`, {
    reason: 'switch on the new commit', expectedActiveVersionId: registry.versionId,
  }, execution), 10_000);
  if (answer === 'still waiting') {
    t.fail('the activation waits for the webhook to answer');
    release();
    return;
  }
  t.equal(answer.status, 200, 'the activation answers while the webhook has not');
  const result = await answer.json() as ActivationResultV1;
  t.equal(tasks.length, 1, 'and leaves one task to the invocation');

  release();
  await Promise.all(tasks);
  t.equal(posted.length, 1, 'which posts one message');
  const { url, body } = posted[0]!;
  t.equal(url, WEBHOOK, 'to the webhook');

  type Detail = {
    version:     { id: string, sourceRepository: string, sourceCommitSha: string, snapshotChecksum: string },
    activations: Array<{ id: string, createdAt: string }>,
  };
  const [ target, replaced ] = await Promise.all([ next, registry.versionId ].map(async id => (
    await (await get(env, `/registry/v1/admin/versions/${id}`)).json() as Detail
  )));
  const refOf = ({ version }: Detail) => ({
    id:               version.id,
    sourceRepository: version.sourceRepository,
    sourceCommitSha:  version.sourceCommitSha,
    checksum:         version.snapshotChecksum,
  });
  t.same(body.registryEvent, {
    kind:            'activate',
    environment:     'stage',
    at:              target!.activations[0]!.createdAt,
    actor:           'alice',
    reason:          'switch on the new commit',
    version:         refOf(target!),
    previousVersion: refOf(replaced!),
    activationId:    result.activationId,
    approval,
    changes:         summaryOf(changes),
  }, 'naming the move as its audit row does, the approval it used, and what changed as GET …/changes does');
  t.equal(target!.activations[0]!.id, result.activationId, 'the audit row the answer names');
  t.equal(refOf(target!).checksum, result.registryVersion.checksum, 'of the version the answer switched on');
  t.match(body.text, `[stage] alice activated registry version ${next} (commit ${snapshot.registryVersion.sourceCommitSha.slice(0, 7)}), replacing ${registry.versionId}, approved by bob. Markets: 0 added, 1 removed, 1 changed, 1 no longer served; networks: 0 added, 1 removed, 1 changed. Reason: "switch on the new commit"`,
    'and in the words the channel reads');
});

t.test('a rollback is posted as one, naming the version it left', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  captureLogs(t);
  const next = await seedNext(registry);
  const env  = await envWith(registry);
  const { posted } = webhook(t);

  const first = invocation();
  await approved(registry, next);
  t.equal((await post(env, `/registry/v1/admin/versions/${next}/activate`, { reason: 'switch on the new commit' }, first.execution)).status, 200,
    'a version is switched on');
  await Promise.all(first.tasks);

  const back = invocation();
  const answer = await post(env, `/registry/v1/admin/versions/${registry.versionId}/rollback`, {
    reason: 'the new commit broke the frontend', expectedActiveVersionId: next,
  }, back.execution);
  t.equal(answer.status, 200, 'and rolled back from');
  await Promise.all(back.tasks);

  t.equal(posted.length, 2, 'each move is posted');
  t.match(posted[1]!.body.registryEvent, {
    kind:            'rollback',
    actor:           'alice',
    reason:          'the new commit broke the frontend',
    version:         { id: registry.versionId },
    previousVersion: { id: next },
    activationId:    (await answer.json() as ActivationResultV1).activationId,
    approval:        null,
    changes:         {
      networks: { added: [ 534352 ], removed: [], changed: [ 8453 ] },
      markets:  { added: [ '534352/usdc' ], removed: [], changed: [ '1/usdc' ], unserved: [] },
    },
  }, 'with what going back changes against the version it left');
  t.match(posted[1]!.body.text, `alice rolled the registry back to version ${registry.versionId}`, 'and says so in its text');
});

t.test('the first activation of an environment is posted with nothing before it', async t => {
  const registry = await activeRegistryDatabase({ activate: false });
  t.teardown(() => registry.dispose());
  captureLogs(t);
  const env = await envWith(registry);
  const { posted } = webhook(t);
  const { execution, tasks } = invocation();
  await approved(registry, registry.versionId);

  const answer = await post(env, `/registry/v1/admin/versions/${registry.versionId}/activate`, {
    reason: 'first registry version', expectedActiveVersionId: null,
  }, execution);
  t.equal(answer.status, 200, 'the first activation answers');
  await Promise.all(tasks);

  t.equal(posted.length, 1, 'and is posted');
  t.equal(posted[0]!.body.registryEvent.previousVersion, null, 'it replaced nothing');
  t.same(posted[0]!.body.registryEvent.changes?.markets.added, [ '1/usdc', '1/usdt', '1/wbtc', '1/weth', '8453/aero', '534352/usdc' ],
    'and added every market');
  t.match(posted[0]!.body.text, ', with no version on before, approved by bob. Markets: 6 added', 'which its text says');
});

t.test('a move that changed nothing, or was refused, is not announced', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  captureLogs(t);
  const next = await seedNext(registry);
  const env  = await envWith(registry);
  const { posted } = webhook(t);

  for (const [ what, path, body, status ] of [
    [ 'an activation of the version on', `/registry/v1/admin/versions/${registry.versionId}/activate`, { reason: 'again' }, 200 ],
    [ 'a rollback to the version on', `/registry/v1/admin/versions/${registry.versionId}/rollback`, { reason: 'again' }, 200 ],
    [ 'a move decided against another version', `/registry/v1/admin/versions/${next}/activate`, { reason: 'late', expectedActiveVersionId: next }, 409 ],
    [ 'an activation nobody approved', `/registry/v1/admin/versions/${next}/activate`, { reason: 'alone' }, 409 ],
    [ 'a rollback to a version never on', `/registry/v1/admin/versions/${next}/rollback`, { reason: 'forward' }, 409 ],
    [ 'a version that does not exist', `/registry/v1/admin/versions/${randomUUID()}/activate`, { reason: 'unknown' }, 404 ],
    [ 'a body the route refuses', `/registry/v1/admin/versions/${next}/activate`, {}, 400 ],
  ] as const) {
    const { execution, tasks } = invocation();
    const answer = await post(env, path, body, execution);
    t.equal(answer.status, status, `${what} answers ${status}`);
    t.equal(tasks.length, 0, 'and leaves nothing to announce');
  }
  t.same(posted, [], 'nothing is posted');
});

t.test('with no webhook set, a move is answered and nothing leaves the worker', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  captureLogs(t);
  const next = await seedNext(registry);
  const env  = await envWith(registry);
  delete env.COMET_REGISTRY_WEBHOOK_URL;
  const { all } = webhook(t);
  const { execution, tasks } = invocation();
  await approved(registry, next);

  t.equal((await post(env, `/registry/v1/admin/versions/${next}/activate`, { reason: 'quietly' }, execution)).status, 200,
    'the move is answered');
  await Promise.all(tasks);
  t.same(all, [], 'and no request is made');
});

/*
 * A webhook that refuses or fails is the log's to say, and the status's: the
 * command it follows has answered. Neither may name the webhook, whose URL is
 * a credential, in the spelling it was configured in or the one the runtime
 * parses it to — with every scope and level of the log switched on.
 */
t.test('a webhook that refuses or fails leaves the move answered, the log without its URL, and the status raised', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const lines = captureLogs(t);
  const next  = await seedNext(registry);
  const env   = await envWith(registry, {
    COMET_REGISTRY_WEBHOOK_URL: 'https://HOOKS.Slack.TEST:443/services/T0NOTIFY/B0NOTIFY/notifications-secret',
    DEBUG:                      'fetch,all',
    DEBUG_LEVEL:                'debug',
  });

  let answers: () => Promise<Response> = async () => new Response(`<p>no_service: ${WEBHOOK}</p>`, { status: 404 });
  const { posted } = webhook(t, () => answers());

  const refused = invocation();
  await approved(registry, next);
  const activated = await post(env, `/registry/v1/admin/versions/${next}/activate`, { reason: 'switch on the new commit' }, refused.execution);
  t.equal(activated.status, 200, 'a move the webhook refuses is answered as made');
  const { activationId } = await activated.json() as ActivationResultV1;
  await Promise.all(refused.tasks);
  t.equal(posted.length, 1, 'once');
  t.ok(lines.includes('error: registry notification failed'), 'and the log says it was not announced');

  const status = await (await get(env, '/registry/v1/admin/status')).json() as RegistryStatus;
  t.ok(status.alerts.includes('notification-failing'), 'the status raises it');
  t.match(status.notifications, {
    webhook: 'on',
    failure: { activationId, approvalId: null, kind: 'activate', versionId: next, status: 404, reason: 'the webhook answered 404' },
  }, 'naming the move, and what the webhook answered');

  answers = async () => { throw new TypeError(`fetch failed: ${WEBHOOK}`); };
  const failed = invocation();
  t.equal((await post(env, `/registry/v1/admin/versions/${registry.versionId}/rollback`, { reason: 'go back' }, failed.execution)).status, 200,
    'a move whose request fails is answered as made too');
  await Promise.all(failed.tasks);
  t.match((await (await get(env, '/registry/v1/admin/status')).json() as RegistryStatus).notifications.failure,
    { kind: 'rollback', status: null, reason: 'the request failed' }, 'and the status names the move given up last');

  answers = async () => new Response('ok');
  const sent = invocation();
  await approved(registry, next);
  t.equal((await post(env, `/registry/v1/admin/versions/${next}/activate`, { reason: 'once more' }, sent.execution)).status, 200,
    'once the webhook takes messages again');
  await Promise.all(sent.tasks);
  const healthy = await (await get(env, '/registry/v1/admin/status')).json() as RegistryStatus;
  t.notOk(healthy.alerts.includes('notification-failing'), 'the next move announced clears the alert');
  t.equal(healthy.notifications.failure, null, 'and the record');

  t.notOk(lines.some(line => SECRET.test(line)), 'and no line logged names the webhook, in either spelling, nor its path');
});

/*
 * An approval is announced as it is given, so the channel hears of a change
 * while it can still be stopped, and the move that uses it says whose it was.
 */
t.test('an approval is announced as it is given, and the activation names it', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  captureLogs(t);
  const next = await seedNext(registry);
  const env  = await envWith(registry);
  const { posted } = webhook(t);

  const given = invocation();
  const answer = await post(env, `/registry/v1/admin/versions/${next}/approve`, {
    reason: 'read the changes', expectedActiveVersionId: registry.versionId,
  }, given.execution, APPROVER);
  t.equal(answer.status, 200, 'bob approves the next version');
  const { approval } = await answer.json() as { approval: { id: string, createdAt: string, expiresAt: string } };
  t.equal(given.tasks.length, 1, 'which leaves one task to the invocation');
  await Promise.all(given.tasks);

  t.equal(posted.length, 1, 'that posts one message');
  t.match(posted[0]!.body.registryEvent, {
    kind:            'approve',
    environment:     'stage',
    at:              approval.createdAt,
    actor:           'bob',
    reason:          'read the changes',
    version:         { id: next },
    previousVersion: { id: registry.versionId },
    activationId:    null,
    approval:        { id: approval.id, actor: 'bob', createdAt: approval.createdAt, expiresAt: approval.expiresAt },
    changes:         { networks: { removed: [ 534352 ] }, markets: { unserved: [ '534352/usdc' ] } },
  }, 'naming the version it approves, the one it was given against, and what switching it on would change');
  t.match(posted[0]!.body.text, `[stage] bob approved registry version ${next} (commit ${snapshot.registryVersion.sourceCommitSha.slice(0, 7)}) until ${approval.expiresAt}, against ${registry.versionId}. Markets: 0 added, 1 removed, 1 changed, 1 no longer served; networks: 0 added, 1 removed, 1 changed. Reason: "read the changes"`,
    'in the words the channel reads');

  const switched = invocation();
  t.equal((await post(env, `/registry/v1/admin/versions/${next}/activate`, { reason: 'switch on the new commit' }, switched.execution)).status, 200,
    'alice switches it on');
  await Promise.all(switched.tasks);
  t.equal(posted.length, 2, 'which is posted too');
  t.match(posted[1]!.body.registryEvent, { kind: 'activate', actor: 'alice', approval: { id: approval.id, actor: 'bob' } },
    'naming the approval it used');

  const refused = invocation();
  t.equal((await post(env, `/registry/v1/admin/versions/${next}/approve`, {
    reason: 'again', expectedActiveVersionId: next,
  }, refused.execution, APPROVER)).status, 409, 'an approval refused — of the version on —');
  t.equal(refused.tasks.length, 0, 'is not announced');
});

/*
 * An approval whose message the webhook refuses is raised as a move's is, by
 * the approval: the channel has not heard of a change it could still stop.
 */
t.test('an approval the webhook refuses is raised by the approval until a later message is sent', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const lines = captureLogs(t);
  const next  = await seedNext(registry);
  const env   = await envWith(registry);

  let answers: () => Promise<Response> = async () => new Response(`<p>no_service: ${WEBHOOK}</p>`, { status: 404 });
  const { posted } = webhook(t, () => answers());

  const refused = invocation();
  const answer  = await post(env, `/registry/v1/admin/versions/${next}/approve`, {
    reason: 'read the changes', expectedActiveVersionId: registry.versionId,
  }, refused.execution, APPROVER);
  t.equal(answer.status, 200, 'an approval the webhook refuses is answered as given');
  const { approval } = await answer.json() as { approval: { id: string } };
  await Promise.all(refused.tasks);
  t.equal(posted.length, 1, 'once');

  const status = await (await get(env, '/registry/v1/admin/status')).json() as RegistryStatus;
  t.ok(status.alerts.includes('notification-failing'), 'the status raises it');
  t.match(status.notifications, {
    webhook: 'on',
    failure: { activationId: null, approvalId: approval.id, kind: 'approve', versionId: next, status: 404, reason: 'the webhook answered 404' },
  }, 'naming the approval, the version it approves, and what the webhook answered');

  answers = async () => new Response('ok');
  const sent = invocation();
  t.equal((await post(env, `/registry/v1/admin/versions/${next}/approve`, {
    reason: 'read them again', expectedActiveVersionId: registry.versionId,
  }, sent.execution, APPROVER)).status, 200, 'once the webhook takes messages again');
  await Promise.all(sent.tasks);
  const healthy = await (await get(env, '/registry/v1/admin/status')).json() as RegistryStatus;
  t.notOk(healthy.alerts.includes('notification-failing'), 'the next approval announced clears the alert');
  t.equal(healthy.notifications.failure, null, 'and the record');

  t.notOk(lines.some(line => SECRET.test(line)), 'and no line logged names the webhook');
});

t.test('an approval refused is not announced', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  captureLogs(t);
  const next = await seedNext(registry);
  // a version imported and never validated
  const { versionId: draft } = await seedCandidate(registry.db, snapshot, { versionId: randomUUID(), attempt: 3 });
  const env  = await envWith(registry);
  const { all } = webhook(t);

  const on = registry.versionId;
  for (const [ what, versionId, body, status ] of [
    [ 'one without a reason', next, { expectedActiveVersionId: on }, 400 ],
    [ 'one without expectedActiveVersionId', next, { reason: 'read' }, 400 ],
    [ 'one with another property', next, { reason: 'read', expectedActiveVersionId: on, ttlSeconds: 60 }, 400 ],
    [ 'one of a version that does not exist', randomUUID(), { reason: 'read', expectedActiveVersionId: on }, 404 ],
    [ 'one of a version not validated', draft, { reason: 'read', expectedActiveVersionId: on }, 409 ],
    [ 'one of the version on', on, { reason: 'again', expectedActiveVersionId: on }, 409 ],
    [ 'one decided against another version', next, { reason: 'late', expectedActiveVersionId: next }, 409 ],
  ] as const) {
    const { execution, tasks } = invocation();
    const answer = await post(env, `/registry/v1/admin/versions/${versionId}/approve`, body, execution, APPROVER);
    t.equal(answer.status, status, `${what} answers ${status}`);
    t.equal(tasks.length, 0, 'and leaves nothing to announce');
  }
  t.same(all, [], 'and no request leaves the worker');
});
