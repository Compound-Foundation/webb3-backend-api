import type { Log } from '../../src/log.js';

/*
 * A log that writes nothing, for a test its lines are not about. A test that
 * is about them hands its own, and reads what it was given.
 */
const quietLog: Log = {
  error: () => {},
  warn:  () => {},
  log:   () => {},
};

export { quietLog };
