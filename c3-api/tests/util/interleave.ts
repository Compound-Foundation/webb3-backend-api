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

/*
 * A database that lets something happen just after a command read, before it
 * checks anything against what it read: `after` runs once, as soon as the
 * first read by a statement matching `pattern` has answered, and before that
 * answer reaches the command. It too runs against the database itself.
 */
function answered(db: D1Database, pattern: RegExp, after: () => Promise<void>): D1Database {
  let fired = false;
  // a wrapper, since the statements a test's bindings hand out keep no property set on them
  const reading = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'first') {
        return async (...args: unknown[]) => {
          const answer = await (target.first as (...args: unknown[]) => Promise<unknown>)(...args);
          if (!fired) {
            fired = true;
            await after();
          }
          return answer;
        };
      }
      if (property === 'bind') {
        return (...values: unknown[]) => reading(target.bind(...values));
      }
      const value = Reflect.get(target, property);
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          return !fired && pattern.test(sql) ? reading(statement) : statement;
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as D1Database;
}

export { answered, interleaved };
