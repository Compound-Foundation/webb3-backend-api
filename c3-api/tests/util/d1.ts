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
 */
async function applyMigrations(
  db: D1Database,
  directory: string = MIGRATIONS_DIR,
  { through }: { through?: string } = {},
): Promise<string[]> {
  const files = readdirSync(directory)
    .filter(name => name.endsWith('.sql'))
    .filter(name => through === undefined || name.slice(0, 4) <= through)
    .sort();
  for (const file of files) {
    await applyMigration(db, file, directory);
  }
  return files;
}

/*
 * Applies one migration file as one batch, for a test that upgrades a
 * database an earlier migration left behind.
 */
async function applyMigration(db: D1Database, file: string, directory: string = MIGRATIONS_DIR): Promise<void> {
  const statements = unstable_splitSqlQuery(readFileSync(join(directory, file), 'utf8'));
  await db.batch(statements.map(statement => db.prepare(statement)));
}

/*
 * Prepares an INSERT of one row. Table and column names come from test code,
 * values are always bound.
 */
function insertStatement(db: D1Database, table: string, row: Row): D1PreparedStatement {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `?${index + 1}`);
  return db
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`)
    .bind(...Object.values(row));
}

async function insertRow(db: D1Database, table: string, row: Row): Promise<D1Result> {
  return insertStatement(db, table, row).run();
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
  Row,
  SqlValue,
  applyMigration,
  applyMigrations,
  changedRows,
  foreignKeyViolations,
  insertRow,
  insertStatement,
};
