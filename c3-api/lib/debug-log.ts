import { inspect } from 'util';

const logLevels = [ 'error', 'warn', 'log', 'debug' ] as const;
type  LogLevel  = (typeof logLevels)[number];
type LogMethods = { [_ in LogLevel]: (...messages: any[]) => DebugLogger };

interface DebugLogger extends LogMethods {
  enabled(scopeLevel?: { scope?: string, level?: LogLevel }): boolean;
  logAtLevel: (typeof debugLog);
  // grouping primitives
  groupEnd(): this;
  group(label?: string): this;
  // environment
  configure(env: any): this,
  clearDanglingGroups(): void,
  env: {
    DEBUG?: string,
    DEBUG_DEPTH?: string,
    DEBUG_LEVEL?: string,
  },
  state: {
    level:  LogLevel,
    depth:  number|null,
    groups: number,
    levels: LogLevel[],
    scopes: string[],
  },
  // scope stack management
  scope: {
    stack: string[];
    // push a new scope onto the end of the stack
    (scope: string): DebugLogger;
  };
}

function MakeLogger(
  stack: string[],
  state: DebugLogger['state'] = {
    level: 'log',
    depth: 10,
    groups: 0,
    levels: logLevels.slice(0, -1),
    scopes: [],
  },
): DebugLogger {
  return {
    state,
    configure,
    clearDanglingGroups,
    env: {},
    scope: Scope(stack),
    logAtLevel: debugLog,
    debug(...logs: any[]) { this.logAtLevel('debug', logs); return this },
    log  (...logs: any[]) { this.logAtLevel('log',   logs); return this },
    warn (...logs: any[]) { this.logAtLevel('warn',  logs); return this },
    error(...logs: any[]) { this.logAtLevel('error', logs); return this },
    // grouping primitives
    group(label?: string) {
      if (this.enabled()) {
        this.state.groups++;
        console.group(label);
      }
      return this;
    },
    groupEnd() {
      if (this.enabled()) {
        this.state.groups--;
        console.groupEnd();
      }
      return this;
    },
    /*
     * A level is enabled if LEVELS includes level.
     *
     * A scope is enabled if:
     *    DEBUG=all,
     *      OR both: all Logger scopes are included in DEBUG SCOPES,
     *          AND the requested scope is included in DEBUG SCOPES.
     */
    enabled(
      this: DebugLogger,
      { scope = '*', level = this.state.level } = {},
    ) {
      const scopeEnabled = (false
        || this.state.scopes.includes('all')
        || (true
          && this.state.scopes.includes(scope)
          && stack.every(s => this.state.scopes.includes(s))
        )
      );
      return scopeEnabled && this.state.levels.includes(level);
    },
  };
}

function debugLog(this: DebugLogger, level: LogLevel, messages: any[]): DebugLogger {
  if (!this.enabled({ level })) return this;
  for (let message of messages) {
    if (typeof(message) === 'object') {
      message = inspect(message, { depth: this.state.depth });
    }
    console[level](`${message}`);
  }
  return this;
}

function Scope(stack: string[]): DebugLogger['scope'] {
  if (!stack.includes('*')) {
    stack.push('*');
  }
  return Object.assign(
    function(this: DebugLogger, scope: string) {
      const scopes = this.scope.stack.slice();
      scopes.push(scope);
      return MakeLogger(scopes, this.state);
    },
    { stack },
  );
}

function clearDanglingGroups(this: DebugLogger) {
  while (this.state.groups > 0) {
    console.groupEnd();
    this.state.groups--;
  }
}

function configure(this: DebugLogger, env: any) {
  // clear groups when the debug logger module gets configured
  this.clearDanglingGroups();
  // if the DEBUG variable exists at all, add the catch-all ('*') scope
  if (typeof(env.DEBUG) !== undefined) {
    this.state.scopes.push('*');
  }
  // add any scopes specified in DEBUG to scopes
  if (env.DEBUG) {
    this.env.DEBUG = env.DEBUG;
    this.state.scopes.push('*', ...env.DEBUG.split(','))
  }
  // if DEBUG_DEPTH, try to parse a custom log recursive struct print depth
  if (env.DEBUG_DEPTH) {
    const DEBUG_DEPTH = JSON.parse(env.DEBUG_DEPTH);
    if (!validDepth(DEBUG_DEPTH)) {
      throw new Error(`DEBUG_DEPTH is invalid: must be 'null' or integer`);
    }
    this.env.DEBUG_DEPTH = env.DEBUG_DEPTH;
    this.state.depth = DEBUG_DEPTH;
  }
  // if DEBUG_LEVEL, try to parse a custom set of enabled log levels
  if (env.DEBUG_LEVEL) {
    const DEBUG_LEVEL = env.DEBUG_LEVEL;
    if (!validLevel(DEBUG_LEVEL)) {
      throw new Error(
        `DEBUG_LEVEL is invalid: ${DEBUG_LEVEL}`
          + ` is not in valid levels: [${logLevels.join(',')}]`
      );
    }
    // set LEVEL to DEBUG_LEVEL
    this.env.DEBUG_LEVEL = DEBUG_LEVEL;
    this.state.level = DEBUG_LEVEL;
    // find the index of the configured level and take it & all levels above
    const levelIndex = logLevels.indexOf(this.state.level);
    this.state.levels = logLevels.slice(0, levelIndex + 1);
  }
  return this;
}

function validDepth(value: any): value is number|null {
  return value === null
      // MUST be a number and MUST be equal to itself truncating decimals
      || (typeof(value) === 'number' && (value | 0) === value);
}

function validLevel(value: any): value is LogLevel {
  return logLevels.includes(value);
}

export {
  configure,
  clearDanglingGroups,
  MakeLogger,
  DebugLogger as Logger,
};
