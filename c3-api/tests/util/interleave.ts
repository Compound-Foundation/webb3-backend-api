/*
 * A database that lets something happen between what a command read and what
 * it writes, which is exactly where the races between administrative commands
 * and the importer live.
 *
 * `before` runs once, just before the first batch that follows the
 * preparation of a statement matching `pattern`: the batch the command builds
 * from what it has already read. It runs against the database itself, so what
 * it does is a write by somebody else, committed before the command's own.
 */
function interleaved(db: D1Database, pattern: RegExp, before: () => Promise<void>): D1Database {
  let armed = false;
  let fired = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'prepare') {
        return (sql: string) => {
          armed ||= !fired && pattern.test(sql);
          return target.prepare(sql);
        };
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (armed && !fired) {
            fired = true;
            await before();
          }
          return target.batch(statements);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as D1Database;
}

export { interleaved };
