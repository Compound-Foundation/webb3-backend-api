/*
 * What a module writes its lines through: the logger of the request or of the
 * Cron (lib/debug-log.ts), or a test's own. A module names the levels it
 * writes at and takes them required, so no caller can leave out the line that
 * says what went wrong.
 */
type Log = {
  error: (...parameters: unknown[]) => unknown,
  warn:  (...parameters: unknown[]) => unknown,
  log:   (...parameters: unknown[]) => unknown,
};

export type { Log };
