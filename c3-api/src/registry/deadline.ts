/*
 * Waiting for work no longer than a deadline, measured on the runtime's own
 * time, which is what cuts work off. The work is not cancelled: whoever
 * started it decides what becomes of it, and a wait that ended clears its
 * timer, so it keeps nothing scheduled.
 */
const TIMED_OUT = Symbol('timed out');

async function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), milliseconds); });
  try {
    return await Promise.race([ work, deadline ]);
  } finally {
    clearTimeout(timer);
  }
}

export { withDeadline };
