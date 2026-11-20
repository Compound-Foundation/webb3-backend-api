import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The statement splitter `wrangler d1 migrations apply` uses, which Wrangler
 * exports under this name only: there is no stable one to use instead. It is
 * what lets a test apply a migration exactly as a deploy does, triggers and
 * all. The release package.json requires at least has it, and one that
 * renamed it would fail the build here, at the import.
 */
import { unstable_splitSqlQuery } from 'wrangler';

/*
 * The shared APP_DB migration stream, relative to the c3-api directory tests
 * run from.
 */
const MIGRATIONS_DIR = './migrations';

type SqlValue = string | number | null;
type Row = Record<string, SqlValue>;

/*
 * Applies every migration file in name order, as `wrangler d1 migrations
 * apply` does, splitting each file with Wrangler's own trigger-aware splitter.
 * A file runs as one batch, so a failing statement leaves no partial file.
 *
 * `through` stops after the migration with that number, which is how a test
 * reaches a database a release has been deployed to before its migrations.
 * `besides` names migrations after it to apply all the same (RELEASED_BEFORE).
 */
async function applyMigrations(
  db: D1Database,
  directory: string = MIGRATIONS_DIR,
  { through, besides = [] }: { through?: string, besides?: string[] } = {},
): Promise<string[]> {
  const files = readdirSync(directory)
    .filter(name => name.endsWith('.sql'))
    .filter(name => through === undefined || name.slice(0, 4) <= through || besides.includes(name.slice(0, 4)))
    .sort();
  for (const file of files) {
    await applyMigration(db, file, directory);
  }
  return files;
}

/*
 * Migrations a release before the token migrations brought, under numbers
 * after theirs: 0011, the approvals every activation records. A database a
 * test stops short of the token migrations has them all the same
 * (registry-harness.ts, registry-database.ts).
 */
const RELEASED_BEFORE = [ '0011' ];

/*
 * Applies one migration file as one batch, for a test that upgrades a
 * database an earlier migration left behind.
 */
async function applyMigration(db: D1Database, file: string, directory: string = MIGRATIONS_DIR): Promise<void> {
  await applySql(db, readFileSync(join(directory, file), 'utf8'));
}

// statements written as a migration is, applied as one is: split by Wrangler's splitter and sent as one batch
async function applySql(db: D1Database, sql: string): Promise<void> {
  const statements = unstable_splitSqlQuery(sql);
  await db.batch(statements.map(statement => db.prepare(statement)));
}

type Verb = 'INSERT' | 'INSERT OR REPLACE';

/*
 * Prepares an INSERT of one row, or with `verb` the INSERT OR REPLACE a test
 * of a guard against replacing rows sends. Table and column names come from
 * test code, values are always bound.
 */
function insertStatement(db: D1Database, table: string, row: Row, verb: Verb = 'INSERT'): D1PreparedStatement {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `?${index + 1}`);
  return db
    .prepare(`${verb} INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`)
    .bind(...Object.values(row));
}

async function insertRow(db: D1Database, table: string, row: Row, verb: Verb = 'INSERT'): Promise<D1Result> {
  return insertStatement(db, table, row, verb).run();
}

/*
 * Rows written by a statement. D1 reports them in `meta.changes`, which
 * workers-types 3.x does not declare.
 */
function changedRows(result: D1Result): number {
  return (result as unknown as { meta: { changes: number } }).meta.changes;
}

async function foreignKeyViolations(db: D1Database): Promise<unknown[]> {
  const { results } = await db.prepare('PRAGMA foreign_key_check').all();
  return results ?? [];
}

export {
  RELEASED_BEFORE,
  Row,
  SqlValue,
  applyMigration,
  applyMigrations,
  applySql,
  changedRows,
  foreignKeyViolations,
  insertRow,
  insertStatement,
};
