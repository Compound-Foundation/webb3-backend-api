import type { Env } from '../../entrypoint.js';

import type { ActivationAction, RegistryVersionRefV1 } from '../../lib/model/comet-registry.js';

import { readChanges } from './changes.js';
import type { FieldChange, VersionChanges } from './changes.js';
import { webhookUrlOf } from './config.js';

/*
 * Announcements of what goes live. Every move of the active version that
 * changed what the registry serves — an activation or a rollback — is posted
 * to a webhook once it has committed, so the people who answer for what is
 * served hear of it, whoever made it, without having to look. So is every
 * approval, which lets a version be switched on by somebody else: the
 * channel hears of a change while it can still be stopped.
 *
 * Nothing else is announced. Overlay writes, imports, validations and cancels
 * change no answer the API gives, and what the overlay writes changed reaches
 * the channel with the approval and the move that switches it on, in their
 * summaries; bringing an environment up writes a hundred documents, which
 * would drown it.
 *
 * The webhook is COMET_REGISTRY_WEBHOOK_URL, a Slack incoming webhook, whose
 * URL is its credential: whoever holds it can post to the channel. It is read
 * here and nowhere else (webhookUrlOf), and nothing this module logs can
 * carry it: no URL, no error a request raised, and nothing of an answer but
 * its status, since each of those can repeat the URL.
 *
 * It is best effort. A message is sent once, by a task the command's answer
 * never waits for, and nothing it meets fails the command. What it says is
 * read from the audit row of the move or the approval, which is the record
 * (GET …/versions/{id}); a message that could not be sent is logged, and
 * recorded for the status, which raises `notification-failing` until a later
 * one is sent.
 */

type RegistryEventKind = ActivationAction | 'approve';

// what a command hands over to be announced: the audit row of the move it made, or of the approval it gave
type RegistryEvent = { activationId: string } | { approvalId: string };

// an approval as a message names it: who gave it, and from when until when it lets its version be switched on
type ApprovalRefV1 = {
  id:        string,
  actor:     string,
  createdAt: string,
  expiresAt: string,
};

/*
 * What a message says: the move or the approval as its audit row recorded
 * it, the two versions it names — for an approval, the one it approves and
 * the one on when it was given — the approval a move used, and what changed
 * between the two versions, null when that could not be read.
 */
type NotificationFacts = {
  environment:     string,
  kind:            RegistryEventKind,
  activationId:    string | null,
  at:              string,
  actor:           string,
  reason:          string,
  version:         RegistryVersionRefV1,
  previousVersion: RegistryVersionRefV1 | null,
  approval:        ApprovalRefV1 | null,
  changes:         VersionChanges | null,
};

/*
 * What changed, as a message carries it: which networks and markets, by chain
 * id and by `chainId/deploymentKey`, and not how, which GET …/changes answers
 * field by field. A registry has tens of markets, so every list is whole.
 */
type ChangeSummaryV1 = {
  networks: { added: number[], removed: number[], changed: number[] },
  markets:  { added: string[], removed: string[], changed: string[], unserved: string[] },
};

// the half of a message a receiver acts on, every value as the audit recorded it (API.md)
type RegistryEventV1 = {
  kind:            RegistryEventKind,
  environment:     string,
  at:              string,
  actor:           string,
  reason:          string,
  version:         RegistryVersionRefV1,
  previousVersion: RegistryVersionRefV1 | null,
  activationId:    string | null,
  approval:        ApprovalRefV1 | null,
  changes:         ChangeSummaryV1 | null,
};

/*
 * What is posted. `text` is what Slack shows, and the two flags keep it from
 * turning a link a reason quotes into a preview of the page it names.
 */
type WebhookBody = {
  text:          string,
  unfurl_links:  false,
  unfurl_media:  false,
  registryEvent: RegistryEventV1,
};

/*
 * Slack reads `&`, `<` and `>` as its markup, and a line break as a new
 * line, so each value a message interpolates has the three escaped, and every
 * run of line breaks and other control characters in it made one space: a
 * reason can then neither mention everyone in the channel, as `<!channel>`
 * would, nor show a link under a name of its own choosing, nor write lines
 * that read as the worker's own. `registryEvent` carries the values as they
 * were recorded.
 */
function escaped(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// each scope a field changed in, once, in the order the comparison lists them
function scopesOf(changes: FieldChange[]): string[] {
  return [ ...new Set(changes.map(change => change.scope)) ];
}

function summaryOf(changes: VersionChanges): ChangeSummaryV1 {
  return {
    networks: {
      added:   changes.networks.added,
      removed: changes.networks.removed,
      changed: scopesOf(changes.networks.changed).map(Number),
    },
    markets: {
      added:    changes.markets.added.map(market => market.scope),
      removed:  changes.markets.removed,
      changed:  scopesOf(changes.markets.changed),
      unserved: changes.markets.unserved.map(market => market.scope),
    },
  };
}

function summaryText(summary: ChangeSummaryV1 | null): string {
  if (summary === null) {
    return `What changed could not be read.`;
  }
  const { networks, markets } = summary;
  return `Markets: ${markets.added.length} added, ${markets.removed.length} removed, `
    + `${markets.changed.length} changed, ${markets.unserved.length} no longer served; `
    + `networks: ${networks.added.length} added, ${networks.removed.length} removed, ${networks.changed.length} changed.`;
}

// a version as a person looks it up: by its id, and the commit it was imported from
function versionText(version: RegistryVersionRefV1): string {
  return `${escaped(version.id)} (commit ${escaped(version.sourceCommitSha.slice(0, 7))})`;
}

// what a message says happened, before what that changes and why
function deedOf(facts: NotificationFacts, previous: string | null): string {
  const approver = facts.approval === null ? '' : `, approved by ${escaped(facts.approval.actor)}`;
  switch (facts.kind) {
    case 'approve':
      return `approved registry version ${versionText(facts.version)} until ${escaped(facts.approval?.expiresAt ?? '')}, `
        + (previous === null ? 'with no version on' : `against ${previous}`);
    case 'rollback':
      return `rolled the registry back to version ${versionText(facts.version)}${previous === null ? ', with no version on before' : ` from ${previous}`}`;
    case 'activate':
      return `activated registry version ${versionText(facts.version)}, ${previous === null ? 'with no version on before' : `replacing ${previous}`}${approver}`;
  }
}

function notificationOf(facts: NotificationFacts): WebhookBody {
  const changes  = facts.changes === null ? null : summaryOf(facts.changes);
  const previous = facts.previousVersion === null ? null : escaped(facts.previousVersion.id);
  return {
    // the reason last, so whatever it says follows every fact the worker states, and stands in for none
    text:          `[${escaped(facts.environment)}] ${escaped(facts.actor)} ${deedOf(facts, previous)}. ${summaryText(changes)} Reason: "${escaped(facts.reason)}"`,
    unfurl_links:  false,
    unfurl_media:  false,
    registryEvent: {
      kind:            facts.kind,
      environment:     facts.environment,
      at:              facts.at,
      actor:           facts.actor,
      reason:          facts.reason,
      version:         facts.version,
      previousVersion: facts.previousVersion,
      activationId:    facts.activationId,
      approval:        facts.approval,
      changes,
    },
  };
}

type EventRow = {
  kind:          RegistryEventKind,
  actor:         string,
  reason:        string,
  created_at:    string,
  activation_id: string | null,
  target_id:  string, target_repository: string, target_commit: string, target_checksum: string,
  // null, all four, when nothing was on before the move, or when the approval was given
  previous_id: string | null, previous_repository: string | null, previous_commit: string | null, previous_checksum: string | null,
  // null, all four, for a rollback, and for a move made before approvals existed
  approval_id: string | null, approval_actor: string | null, approval_created_at: string | null, approval_expires_at: string | null,
};

const EVENT_COLUMNS = `target.id AS target_id, target.source_repository AS target_repository,
                  target.source_commit_sha AS target_commit, target.snapshot_checksum AS target_checksum,
                  previous.id AS previous_id, previous.source_repository AS previous_repository,
                  previous.source_commit_sha AS previous_commit, previous.snapshot_checksum AS previous_checksum,
                  approval.id AS approval_id, approval.actor AS approval_actor,
                  approval.created_at AS approval_created_at, approval.expires_at AS approval_expires_at`;

/*
 * The move or the approval as its audit row recorded it, with the two
 * versions it names and the approval, in one statement; null for an id no
 * row has. Only a validated version is ever approved or switched on, and a
 * validated version never changes, so both checksums are there and are still
 * the ones of the change the row records.
 */
async function readEvent(db: D1Database, event: RegistryEvent): Promise<EventRow | null> {
  const statement = 'activationId' in event
    ? db.prepare(
        `SELECT activation.action AS kind, activation.actor, activation.reason, activation.created_at,
                activation.id AS activation_id, ${EVENT_COLUMNS}
         FROM registry_activations AS activation
         JOIN registry_versions AS target ON target.id = activation.registry_version_id
         LEFT JOIN registry_versions AS previous ON previous.id = activation.previous_version_id
         LEFT JOIN registry_approvals AS approval ON approval.id = activation.approval_id
         WHERE activation.id = ?1`
      ).bind(event.activationId)
    : db.prepare(
        `SELECT 'approve' AS kind, approval.actor, approval.reason, approval.created_at,
                NULL AS activation_id, ${EVENT_COLUMNS}
         FROM registry_approvals AS approval
         JOIN registry_versions AS target ON target.id = approval.registry_version_id
         LEFT JOIN registry_versions AS previous ON previous.id = approval.active_version_id
         WHERE approval.id = ?1`
      ).bind(event.approvalId);
  const row = await statement.first<EventRow>();
  return row ?? null;
}

function previousOf(row: EventRow): RegistryVersionRefV1 | null {
  return row.previous_id === null ? null : {
    id:               row.previous_id,
    sourceRepository: row.previous_repository!,
    sourceCommitSha:  row.previous_commit!,
    checksum:         row.previous_checksum!,
  };
}

function approvalOf(row: EventRow): ApprovalRefV1 | null {
  return row.approval_id === null ? null : {
    id:        row.approval_id,
    actor:     row.approval_actor!,
    createdAt: row.approval_created_at!,
    expiresAt: row.approval_expires_at!,
  };
}

/*
 * How long the webhook may take to answer a message. Slack answers within a
 * second; a webhook that has not answered in five is not going to, and the
 * message is given up rather than sent again: a webhook takes no idempotency
 * key, so a message sent again after a timeout can arrive twice.
 */
const NOTIFICATION_TIMEOUT_MS = 5_000;

type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

/*
 * What became of a message: sent, with the status the webhook answered, or
 * given up, with why — the status the webhook refused it with, or null when
 * it did not answer, and the name of the error a request that failed raised.
 */
type Delivery =
  | { sent: true,  status: number }
  | { sent: false, status: number | null, reason: string, errorName?: string };

async function deliver(url: string, body: WebhookBody, send: WebhookFetch, timeout: number): Promise<Delivery> {
  // one deadline for the whole request, which ends the wait for an answer that never starts
  const deadline = AbortSignal.timeout(timeout);
  let response: Response;
  try {
    response = await send(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  deadline,
    });
  } catch (error) {
    /*
     * The error is named, and neither it nor its message is kept: what the
     * runtime says of a request it could not make names the URL it was asked
     * for, in a spelling of its own.
     */
    return deadline.aborted
      ? { sent: false, status: null, reason: `did not answer within ${timeout / 1000} seconds` }
      : { sent: false, status: null, reason: `the request failed`, errorName: error instanceof Error ? error.name : typeof(error) };
  }
  // the answer is read for its status alone: an error page can quote the path it was asked for
  await response.body?.cancel().catch(() => undefined);
  return response.ok
    ? { sent: true, status: response.status }
    : { sent: false, status: response.status, reason: `the webhook answered ${response.status}` };
}

// the message given up last, until a later one is sent, for the status to raise
const FAILURE_KEY = 'notification-failure:v1';

type NotificationFailure = {
  at:           string,
  // the move by its audit row, or the approval; the other is null
  activationId: string | null,
  approvalId:   string | null,
  // what it was, and the version it named; null when it could not be read
  kind:         RegistryEventKind | null,
  versionId:    string | null,
  // what the webhook answered, or null when it did not answer or was never asked
  status:       number | null,
  reason:       string,
};

/*
 * The message given up last, or null for none — or for an entry of some other
 * shape, which is no record this release can read. An id that is missing or
 * not a string reads as null, so the status has both, as API.md says,
 * whatever the entry holds.
 */
async function readNotificationFailure(kv: KVNamespace): Promise<NotificationFailure | null> {
  const failure = await kv.get(FAILURE_KEY, 'json') as Partial<NotificationFailure> | null;
  if (failure === null || typeof(failure) !== 'object') {
    return null;
  }
  const activationId = typeof(failure.activationId) === 'string' ? failure.activationId : null;
  const approvalId   = typeof(failure.approvalId) === 'string' ? failure.approvalId : null;
  const readable = typeof(failure.at) === 'string'
    && typeof(failure.reason) === 'string'
    && (activationId !== null || approvalId !== null);
  return readable ? { ...failure, activationId, approvalId } as NotificationFailure : null;
}

type NotifyOptions = {
  // the root logger, which stage and production write: a message given up there is somebody's to act on
  debug: {
    log:   (...parameters: unknown[]) => unknown,
    warn:  (...parameters: unknown[]) => unknown,
    error: (...parameters: unknown[]) => unknown,
  },
  // the request whose command made the move or gave the approval, which every line logged about its message names
  requestId?: string,
  /*
   * The runtime's own fetch unless a test brings one. Never the counting
   * fetch of the legacy routes, which logs the URL of every request it makes
   * where DEBUG names `fetch`, as the local environment does.
   */
  fetch?:     WebhookFetch,
  // how long the webhook may take; NOTIFICATION_TIMEOUT_MS unless a test needs less
  timeoutMs?: number,
  now?:       () => Date,
};

/*
 * Announces one move or approval, and never throws: it has committed and its
 * command does not wait for this, so whatever happens here is the log's and
 * the status's to say. With no webhook set, or one set to no URL, nothing is
 * read or sent; the status names the second as `configuration-invalid`.
 */
async function notifyRegistryEvent(env: Env, event: RegistryEvent, options: NotifyOptions): Promise<void> {
  const url = webhookUrlOf(env);
  if (url === undefined || url === null) {
    return;
  }
  const { debug } = options;
  // the event by the id of its audit row, which every line logged about it names, and its record with the other id null
  const [ named, what, ids ] = 'activationId' in event
    ? [ { activationId: event.activationId }, 'move', { activationId: event.activationId, approvalId: null } ]
    : [ { approvalId: event.approvalId }, 'approval', { activationId: null, approvalId: event.approvalId } ];
  const asked = options.requestId === undefined ? {} : { requestId: options.requestId };
  const at    = () => (options.now?.() ?? new Date()).toISOString();

  // a message given up is recorded for the status; KV that does not take the record leaves the log line alone to say so
  const giveUp = async (failure: Pick<NotificationFailure, 'kind' | 'versionId' | 'status' | 'reason'>): Promise<void> => {
    try {
      await env.kv_registry.put(FAILURE_KEY, JSON.stringify({ at: at(), ...ids, ...failure }));
    } catch (error) {
      debug.warn(`registry notification failure not recorded`, { ...named, error, ...asked });
    }
  };

  try {
    let row: EventRow | null;
    try {
      row = await readEvent(env.APP_DB, event);
    } catch (error) {
      // what D1 says of a statement carries no URL, so it is logged whole
      debug.error(`registry notification failed`, { ...named, reason: `the ${what} could not be read`, error, ...asked });
      await giveUp({ kind: null, versionId: null, status: null, reason: `the ${what} could not be read` });
      return;
    }
    if (row === null) {
      debug.error(`registry notification failed`, { ...named, reason: `no ${what} has that id`, ...asked });
      await giveUp({ kind: null, versionId: null, status: null, reason: `no ${what} has that id` });
      return;
    }
    const about = { kind: row.kind, versionId: row.target_id, ...named };

    let changes: VersionChanges | null;
    try {
      changes = await readChanges(env.APP_DB, row.target_id, row.previous_id);
    } catch (error) {
      // who switched or approved what matters more than what it changes, so it is announced without them
      debug.warn(`registry notification without changes`, { ...about, error, ...asked });
      changes = null;
    }

    const body = notificationOf({
      environment:     env.ENVIRONMENT,
      kind:            row.kind,
      activationId:    row.activation_id,
      at:              row.created_at,
      actor:           row.actor,
      reason:          row.reason,
      version:         {
        id:               row.target_id,
        sourceRepository: row.target_repository,
        sourceCommitSha:  row.target_commit,
        checksum:         row.target_checksum,
      },
      previousVersion: previousOf(row),
      approval:        approvalOf(row),
      changes,
    });
    /*
     * The runtime's fetch, looked up when it is needed, so a test that stands
     * in for it is the one asked. It is given a Request, as the import's own
     * fetch is (scheduled.ts): a build that also sees Node's types resolves a
     * call with a URL to Node's fetch, whose answer the Workers types of 3.x
     * do not take as theirs.
     */
    const send = options.fetch ?? ((target, init) => fetch(new Request(target, init)) as Promise<Response>);
    const delivery = await deliver(url, body, send, options.timeoutMs ?? NOTIFICATION_TIMEOUT_MS);

    if (delivery.sent) {
      debug.log({ registryNotification: { ...about, status: delivery.status }, ...asked });
      // the webhook takes messages again, so a message given up before is no longer news
      try {
        await env.kv_registry.delete(FAILURE_KEY);
      } catch (error) {
        debug.warn(`registry notification failure not cleared`, { ...about, error, ...asked });
      }
      return;
    }
    const { sent: _sent, ...why } = delivery;
    debug.error(`registry notification failed`, { ...about, ...why, ...asked });
    await giveUp({ kind: row.kind, versionId: row.target_id, status: delivery.status, reason: delivery.reason });
  } catch (error) {
    /*
     * A fault of the notifier's own. Everything that holds the URL answers its
     * failures as a delivery rather than raising them, so what reaches here is
     * logged whole.
     */
    debug.error(`registry notification failed unexpectedly`, { ...named, error, ...asked });
    await giveUp({ kind: null, versionId: null, status: null, reason: 'an unexpected error' });
  }
}

export type { NotificationFacts, NotificationFailure, RegistryEvent, RegistryEventKind, RegistryEventV1, WebhookBody };
export { FAILURE_KEY, NOTIFICATION_TIMEOUT_MS, notificationOf, notifyRegistryEvent, readNotificationFailure };
