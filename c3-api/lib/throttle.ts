/*
 * Whether a log line that would otherwise repeat on every request is due: the
 * first time for its key, and then once a window, counted from the last time
 * it was due. What is remembered is the isolate's, so every isolate says it
 * for itself.
 *
 * The time is the clock's, unless the caller gives its own: the registry
 * reads an injected clock, and its windows must follow it.
 */
function dueIn(last: Map<string, number>, everyMs: number, key: string, at: number): boolean {
  const previous = last.get(key);
  if (previous !== undefined && at - previous < everyMs) {
    return false;
  }
  last.set(key, at);
  return true;
}

function throttle(everyMs: number): (key: string, at?: number) => boolean {
  const last = new Map<string, number>();
  return (key, at = Date.now()) => dueIn(last, everyMs, key, at);
}

/*
 * The same, by a scope as well as a key: a binding, such as a database or a
 * KV namespace, which is held weakly, so one nothing else holds is let go.
 */
function throttleBy<Scope extends object>(everyMs: number): (scope: Scope, key: string, at?: number) => boolean {
  const scopes = new WeakMap<Scope, Map<string, number>>();
  return (scope, key, at = Date.now()) => {
    let last = scopes.get(scope);
    if (last === undefined) {
      last = new Map();
      scopes.set(scope, last);
    }
    return dueIn(last, everyMs, key, at);
  };
}

export { throttle, throttleBy };
