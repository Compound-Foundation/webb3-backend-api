import type { RegistryTables } from './rows.js';

/*
 * Conditional writes: the condition a statement applies under, the
 * statements that carry one, and how many rows a statement changed. The
 * registry stores and the sync fence (sync.ts) build their writes from them.
 */
type SqlValue = string | number | null;

/*
 * What must still hold when a write applies: an expression for a WHERE
 * clause, and the values it binds. Its parameters are numbered from `first`,
 * so it can follow whatever the statement it is added to binds itself.
 *
 * D1 rolls a batch back when a statement fails, not when one changes nothing,
 * so a write that must not apply once something has moved names that in every
 * statement it is made of.
 */
type Condition = {
  sql:    (first: number) => string,
  values: SqlValue[],
};

function both(left: Condition, right: Condition): Condition {
  return {
    sql:    first => `(${left.sql(first)}) AND (${right.sql(first + left.values.length)})`,
    values: [ ...left.values, ...right.values ],
  };
}

/*
 * A statement that applies only while a condition holds. `sql` ends in its own
 * WHERE clause, a conjunction the condition is added to; its parameters are
 * numbered from one, and the condition's follow them. Without a condition it
 * is the statement as written.
 */
function conditioned(db: D1Database, sql: string, values: SqlValue[], condition?: Condition): D1PreparedStatement {
  return condition === undefined
    ? db.prepare(sql).bind(...values)
    : db.prepare(`${sql} AND (${condition.sql(values.length + 1)})`).bind(...values, ...condition.values);
}

/*
 * An INSERT of one row, checked against the row type of its table: a column
 * the type names cannot be left out and fall back to its default, which for
 * `reviewed` would record a decision nobody made. With a condition the row is
 * selected rather than stated, so it is inserted only while the condition
 * holds.
 */
function insertStatement<Table extends keyof RegistryTables>(
  db: D1Database,
  table: Table,
  row: RegistryTables[Table],
  condition?: Condition,
): D1PreparedStatement {
  const columns      = Object.keys(row);
  const values       = Object.values(row) as SqlValue[];
  const placeholders = columns.map((_, index) => `?${index + 1}`).join(', ');
  return condition === undefined
    ? db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).bind(...values)
    : db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${placeholders} WHERE ${condition.sql(values.length + 1)}`)
        .bind(...values, ...condition.values);
}

/*
 * Rows a statement changed. D1 reports it in `meta.changes`, which the
 * workers-types version this worker resolves does not declare.
 */
function changedRows(result: D1Result): number {
  return (result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

export type { Condition, SqlValue };
export { both, changedRows, conditioned, insertStatement };
