import type { TestHarness } from 'wrangler';

import type { Env } from '../../entrypoint.js';
import type { NetworkV1 } from '../../lib/model/comet-registry.js';
import { activateVersion, readActiveVersionId } from '../../src/registry/repository.js';

import { approveSeeded, loadRegistrySnapshotFixture, seedCandidate, validateSeeded } from './registry-fixture.js';
import type { RegistryHarness } from './registry-harness.js';
import { ADMIN_TOKEN, APPROVER_TOKEN } from './test-env.js';

/*
 * What the registry tests share around the administrative routes: a client
 * of them over a harness's worker, the fixture seeded as a validated version,
 * a fresh database with it active, and a count of a table's rows.
 */

/*
 * The name a harness lists ADMIN_TOKEN under (test-env.ts), which the worker
 * records as the actor of everything a request with it does: a test compares
 * who made a decision with this literal.
 */
const ADMIN_ACTOR = 'test-admin';

const AUTH = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };

const snapshot = loadRegistrySnapshotFixture();

// an answer with its body read as JSON, and null for one without a body, as a preflight's
type Answer<T> = { status: number, header: (name: string) => string | null, body: T };

/*
 * Requests carry the administrative token unless they are given headers of
 * their own: {} for an anonymous request. A body that is a string is sent as
 * it is, so that a test can send one that is not JSON.
 */
type AdminClient = {
  send:     <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Answer<T>>,
  read:     <T>(path: string, headers?: Record<string, string>) => Promise<Answer<T>>,
  post:     <T>(path: string, body: unknown, headers?: Record<string, string>) => Promise<Answer<T>>,
  patch:    <T>(path: string, body: unknown, headers?: Record<string, string>) => Promise<Answer<T>>,
  /*
   * Moves the active version through the API, as administrators do, and fails
   * the test where it cannot: test-approver approves an activation against
   * the version on, and test-admin makes it; a rollback is test-admin's alone.
   */
  switchTo: (versionId: string, action?: 'activate' | 'rollback') => Promise<void>,
};

function adminClient(server: TestHarness): AdminClient {
  const send = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH): Promise<Answer<T>> => {
    const response = await server.fetch(path, body === undefined ? { method, headers } : {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body:    typeof(body) === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, header: name => response.headers.get(name), body: (text === '' ? null : JSON.parse(text)) as T };
  };
  return {
    send,
    read:     (path, headers) => send('GET', path, undefined, headers),
    post:     (path, body, headers) => send('POST', path, body, headers),
    patch:    (path, body, headers) => send('PATCH', path, body, headers),
    switchTo: async (versionId, action = 'activate') => {
      if (action === 'activate') {
        const { APP_DB } = await server.getWorker<Env>().getEnv();
        const { status } = await send('POST', `/registry/v1/admin/versions/${versionId}/approve`, {
          reason:                  'approved for a test',
          expectedActiveVersionId: await readActiveVersionId(APP_DB),
        }, { 'Authorization': `Bearer ${APPROVER_TOKEN}` });
        if (status !== 200) {
          throw new Error(`the approval of ${versionId} answered ${status}`);
        }
      }
      const { status } = await send('POST', `/registry/v1/admin/versions/${versionId}/${action}`, { reason: `${action} for a test` });
      if (status !== 200) {
        throw new Error(`${action} of ${versionId} answered ${status}`);
      }
    },
  };
}

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

/*
 * A fresh database with the fixture validated and, with `activate`, active,
 * for a test about something other than activation: approved by
 * test-approver and switched on by test-seed. `through` stops the migrations
 * at that one.
 */
async function freshActive(
  harness: RegistryHarness,
  { activate, through }: { activate: boolean, through?: string },
): Promise<{ db: D1Database, versionId: string }> {
  const db        = await harness.freshDatabase({ through });
  const versionId = await seedValidated(db);
  if (activate) {
    await approveSeeded(db, versionId);
    await activateVersion(db, { versionId, action: 'activate', actor: 'test-seed', reason: 'seeded for a test' });
  }
  return { db, versionId };
}

// the rows of a table, or those of them that match a condition
async function count(db: D1Database, table: string, where: string = '1 = 1', ...bindings: unknown[]): Promise<number> {
  return await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...bindings).first<number>('n') ?? 0;
}

export type { AdminClient, Answer };
export { ADMIN_ACTOR, adminClient, count, freshActive, seedValidated };
