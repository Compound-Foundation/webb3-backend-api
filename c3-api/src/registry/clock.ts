/*
 * The registry's injectable clock, so a lease, a retry, the age of a cached
 * answer or the expiry of an exception can be tested without waiting for
 * real time to pass.
 */
type Clock = () => Date;

type ClockOption = { now?: Clock | undefined };

function nowOf(clock: Clock | undefined): Date {
  return clock?.() ?? new Date();
}

export type { Clock, ClockOption };
export { nowOf };
