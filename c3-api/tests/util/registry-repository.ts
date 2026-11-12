import { RegistryError } from '../../src/registry/errors.js';
import { readOverlays } from '../../src/registry/overlay-store.js';
import type { ClonedOverlays } from '../../src/registry/overlay-store.js';
import { candidateRow, readActiveVersionId } from '../../src/registry/repository.js';
import type { CandidateInput } from '../../src/registry/repository.js';
import type { RegistryVersionRow } from '../../src/registry/rows.js';
import { changedRows, insertStatement } from '../../src/registry/sql-condition.js';
import { endCandidateStatement, validationResultsStatement } from '../../src/registry/validation-store.js';
import type { ResultInput } from '../../src/registry/validation-store.js';

/*
 * The steps of a candidate's lifecycle, one call each. Production never takes
 * one alone: it commits each in a batch with the writes that belong with it,
 * on a condition they share (bindCandidate, verdictStatements). A test takes
 * them one at a time, to seed a candidate or to walk one through its
 * lifecycle.
 */
async function createCandidate(db: D1Database, input: CandidateInput): Promise<RegistryVersionRow> {
  const version = candidateRow(input);
  await insertStatement(db, 'registry_versions', version).run();
  return version;
}

async function recordValidationResults(
  db: D1Database,
  versionId: string,
  attempt: number,
  results: ResultInput[],
): Promise<void> {
  await validationResultsStatement(db, versionId, attempt, results, new Date().toISOString()).run();
}

async function markValidated(db: D1Database, versionId: string, checksum: string): Promise<void> {
  const ending = { status: 'validated', checksum } as const;
  const result = await endCandidateStatement(db, versionId, ending, new Date().toISOString()).run();
  assertChanged(result, versionId, `the candidate is no longer importing`);
}

async function markInvalid(db: D1Database, versionId: string): Promise<void> {
  const result = await endCandidateStatement(db, versionId, { status: 'invalid' }, new Date().toISOString()).run();
  assertChanged(result, versionId, `the candidate is no longer importing`);
}

function assertChanged(result: D1Result, versionId: string, message: string): void {
  const changes = changedRows(result);
  if (changes !== 1) {
    throw new RegistryError('CANDIDATE_STATE_CONFLICT', message, versionId);
  }
}

/*
 * The overlay of the currently active version, or empty maps when no version
 * has been activated yet, which is the first import. An import reads it
 * merged with what its earlier attempts reviewed (readImportOverlays); a test
 * reads it alone.
 */
async function readActiveOverlays(db: D1Database): Promise<ClonedOverlays> {
  const versionId = await readActiveVersionId(db);
  return versionId === null ? { networks: new Map(), markets: new Map(), comets: new Map() } : readOverlays(db, versionId);
}

export {
  createCandidate,
  markInvalid,
  markValidated,
  readActiveOverlays,
  recordValidationResults,
};
