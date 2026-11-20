import type { VersionRefV1 } from '../../lib/model/comet-registry.js';

import { jsonResponse } from '../http/json.js';

import type { RecordedKind } from './decision-records.js';
import type { DecisionList } from './decision-store.js';
import { member } from './decision-store.js';
import type { AdminContext, RegistryContext } from './handlers.js';
import { registryHeaders } from './version-headers.js';

/*
 * The routes of the decisions of the store (decision-store.ts), each
 * answering for the kind it is given, with what the kind's own module
 * answers.
 *
 * A decision belongs to no registry version, but whether what it is about may
 * carry one is decided by the active version, so every answer names that
 * version, in headers and in the body, as the other registry routes do.
 *
 * A command takes effect as soon as it has committed: unlike a version's
 * activation, a decision needs nobody's approval, and nothing announces it
 * (notifications.ts). Its actor is the name of the token it was sent with
 * (AdminContext). A command of a kind an outage answers with records the
 * kind's decisions in force once it has committed (decision-records.ts); a
 * kind no outage answers with keeps no record (`record` null).
 */

type Answer = { registryVersion: VersionRefV1 };

type DecisionCommands<Subject extends object, Flag extends string, Listed> = {
  flag:   Flag,
  read:   (db: D1Database, subject: Subject) => Promise<Answer>,
  set:    (db: D1Database, change: Subject & Record<Flag, boolean> & { actor: string, reason: string }) => Promise<Answer>,
  export: (db: D1Database) => Promise<Answer>,
  review: (db: D1Database, list: DecisionList<Listed>) => Promise<Answer>,
  apply:  (db: D1Database, list: DecisionList<Listed>, actor: string) => Promise<Answer>,
  record: RecordedKind<Subject> | null,
};

function answered(answer: Answer): Response {
  return jsonResponse(answer, { headers: registryHeaders(answer.registryVersion) });
}

async function getDecision<Subject extends object, Flag extends string, Listed>(
  context: RegistryContext,
  kind: DecisionCommands<Subject, Flag, Listed>,
  subject: Subject,
): Promise<Response> {
  return answered(await kind.read(context.db, subject));
}

/*
 * Asking for the decision already in force answers `changed: false` and
 * writes nothing, so a retried or repeated request is safe; a change is
 * committed with its audit event before it is answered.
 */
async function patchDecision<Subject extends object, Flag extends string, Listed>(
  context: AdminContext,
  kind: DecisionCommands<Subject, Flag, Listed>,
  subject: Subject,
  decision: { flag: boolean, reason: string },
): Promise<Response> {
  const result = await kind.set(context.db, {
    ...subject,
    ...member(kind.flag, decision.flag),
    actor:  context.actor,
    reason: decision.reason,
  });
  if (kind.record !== null) {
    await context.record(kind.record);
  }
  return answered(result);
}

/*
 * A list of decisions for every subject at once: exported as a file, edited,
 * reviewed as the diff it would make, and applied in one transaction. The
 * export and the two commands speak the same body, so an exported file is
 * sent back as it is.
 */
async function getDecisionExport<Subject extends object, Flag extends string, Listed>(
  context: RegistryContext,
  kind: DecisionCommands<Subject, Flag, Listed>,
): Promise<Response> {
  return answered(await kind.export(context.db));
}

async function postDecisionReview<Subject extends object, Flag extends string, Listed>(
  context: RegistryContext,
  kind: DecisionCommands<Subject, Flag, Listed>,
  list: DecisionList<Listed>,
): Promise<Response> {
  return answered(await kind.review(context.db, list));
}

async function postDecisionApply<Subject extends object, Flag extends string, Listed>(
  context: AdminContext,
  kind: DecisionCommands<Subject, Flag, Listed>,
  list: DecisionList<Listed>,
): Promise<Response> {
  const applied = await kind.apply(context.db, list, context.actor);
  if (kind.record !== null) {
    await context.record(kind.record);
  }
  return answered(applied);
}

export type { DecisionCommands };
export {
  getDecision,
  getDecisionExport,
  patchDecision,
  postDecisionApply,
  postDecisionReview,
};
