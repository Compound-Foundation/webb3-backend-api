import type { ValidationSummaryV1 } from '../../lib/model/comet-registry.js';

import type { ValidationResultRow } from './rows.js';
import { Condition, conditioned } from './sql-condition.js';

/*
 * Validation attempts as the database keeps them: the results of each
 * attempt, the revision of the candidate it was taken at, and the statement
 * that ends a candidate on one. The checks themselves are validation.ts.
 */
type ResultInput = Pick<ValidationResultRow, 'check_name' | 'scope' | 'passed'> & { details?: unknown };

/*
 * One validation attempt as one statement. Its results travel as a single
 * JSON document, so an attempt is recorded whole or not at all however many
 * checks it ran: results are append-only, and part of an attempt would be
 * read as all of it. With a condition, it is recorded only while that holds.
 *
 * A repeated attempt number for the same check is a programming error rather
 * than an update, and fails on the unique constraint.
 */
function validationResultsStatement(
  db: D1Database,
  versionId: string,
  attempt: number,
  results: ResultInput[],
  createdAt: string,
  condition?: Condition,
): D1PreparedStatement {
  const rows = results.map(result => ({
    check_name: result.check_name,
    scope:      result.scope,
    passed:     result.passed,
    details:    JSON.stringify(result.details ?? {}),
  }));
  return conditioned(
    db,
    `INSERT INTO validation_results (
       registry_version_id, validation_attempt, check_name, scope, passed, details, created_at
     )
     SELECT ?1, ?2, json_extract(row.value, '$.check_name'), json_extract(row.value, '$.scope'),
            json_extract(row.value, '$.passed'), json_extract(row.value, '$.details'), ?3
     FROM json_each(?4) AS row
     WHERE row.type = 'object'`,
    [ versionId, attempt, createdAt, JSON.stringify(rows) ],
    condition,
  );
}

/*
 * The latest complete validation attempt of a version, which is the one that
 * decided its status.
 */
async function latestValidationAttempt(db: D1Database, versionId: string): Promise<number> {
  const attempt = await db.prepare(
    `SELECT max(validation_attempt) AS attempt FROM validation_results WHERE registry_version_id = ?1`
  ).bind(versionId).first<number | null>('attempt');
  return attempt ?? 0;
}

// the checks the latest validation attempt of a version failed
async function failedChecks(db: D1Database, versionId: string): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT DISTINCT check_name FROM validation_results
     WHERE registry_version_id = ?1 AND passed = 0
       AND validation_attempt = (SELECT MAX(validation_attempt) FROM validation_results WHERE registry_version_id = ?1)
     ORDER BY check_name`
  ).bind(versionId).all<{ check_name: string }>();
  return (results ?? []).map(row => row.check_name);
}

async function readValidationSummary(db: D1Database, versionId: string): Promise<ValidationSummaryV1> {
  const attempt = await latestValidationAttempt(db, versionId);
  if (attempt === 0) {
    return { attempt: 0, passed: 0, failed: 0, checks: [] };
  }
  const { results } = await db.prepare(
    `SELECT check_name, scope, passed, details FROM validation_results
     WHERE registry_version_id = ?1 AND validation_attempt = ?2
     ORDER BY passed, check_name, scope`
  ).bind(versionId, attempt).all<{ check_name: string, scope: string, passed: number, details: string }>();

  const checks = (results ?? []).map(row => ({
    name:   row.check_name,
    scope:  row.scope,
    passed: row.passed === 1,
    ...(row.passed === 1 ? {} : { details: JSON.parse(row.details) as unknown }),
  }));
  return {
    attempt,
    passed: checks.filter(check => check.passed).length,
    failed: checks.filter(check => !check.passed).length,
    checks,
  };
}

/*
 * Where a candidate stands: its revision, and its latest validation attempt.
 *
 * The revision is how many overlay events it has recorded. Every overlay
 * write records one in the transaction that changes the rows, and events are
 * never removed, so the count only moves forward, and anything read at one
 * revision still describes the candidate while the count is the same.
 */
async function readRevision(db: D1Database, versionId: string): Promise<{ revision: number, attempt: number }> {
  const row = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM registry_overlay_events WHERE registry_version_id = ?1) AS revision,
            (SELECT COALESCE(MAX(validation_attempt), 0) FROM validation_results WHERE registry_version_id = ?1) AS attempt`
  ).bind(versionId).first<{ revision: number, attempt: number } | null>();
  return { revision: row?.revision ?? 0, attempt: row?.attempt ?? 0 };
}

// a candidate as it was read: still importing, and at the revision it was read at
function unchanged(versionId: string, revision: number): Condition {
  return {
    sql: first => `EXISTS (SELECT 1 FROM registry_versions WHERE id = ?${first} AND status = 'importing')
       AND (SELECT COUNT(*) FROM registry_overlay_events WHERE registry_version_id = ?${first}) = ?${first + 1}`,
    values: [ versionId, revision ],
  };
}

/*
 * A validation attempt of a candidate has been recorded. A write that belongs
 * with the attempt — closing the run that imported the candidate — follows it
 * in the same transaction on this condition, so it applies only if the
 * attempt did.
 */
function recorded(versionId: string, attempt: number): Condition {
  return {
    sql: first => `EXISTS (
      SELECT 1 FROM validation_results WHERE registry_version_id = ?${first} AND validation_attempt = ?${first + 1}
    )`,
    values: [ versionId, attempt ],
  };
}

/*
 * A candidate's terminal status as one statement, for a caller that commits
 * it in one transaction with the validation attempt that decides it. The
 * transition triggers verify the stored validation results, so a status the
 * results do not support fails here rather than producing a version that
 * claims to be validated.
 */
function endCandidateStatement(
  db: D1Database,
  versionId: string,
  ending: { status: 'validated', checksum: string } | { status: 'invalid' },
  at: string,
  condition?: Condition,
): D1PreparedStatement {
  return conditioned(
    db,
    `UPDATE registry_versions
     SET status            = ?1,
         snapshot_checksum = CASE WHEN ?1 = 'validated' THEN ?2 ELSE snapshot_checksum END,
         validated_at      = CASE WHEN ?1 = 'validated' THEN ?3 ELSE validated_at END
     WHERE id = ?4 AND status = 'importing'`,
    [ ending.status, ending.status === 'validated' ? ending.checksum : null, at, versionId ],
    condition,
  );
}

export type { ResultInput };
export {
  endCandidateStatement,
  failedChecks,
  readRevision,
  readValidationSummary,
  recorded,
  unchanged,
  validationResultsStatement,
};
