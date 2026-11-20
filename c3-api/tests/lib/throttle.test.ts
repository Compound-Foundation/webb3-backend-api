import t from 'tap';

import { throttle, throttleBy } from '../../lib/throttle.js';

/*
 * When a log line that would otherwise repeat on every request is written:
 * the first time for its key, and then once a window, counted from the last
 * time it was written. The computation cache and the registry cache write
 * such lines by this rule, so it is held here once.
 */
const MINUTE = 60_000;

t.test('the first call for a key is due, a call within the window is not, and one past it is', async t => {
  const due = throttle(MINUTE);
  t.equal(due('feed', 0), true, 'the first call is due');
  t.equal(due('feed', 1), false, 'one right after it is not');
  t.equal(due('feed', MINUTE - 1), false, 'nor one at the end of the window');
  t.equal(due('feed', MINUTE), true, 'one a whole window after it is');
  t.equal(due('feed', 2 * MINUTE - 1), false, 'and the next window is counted from that one');
  t.equal(due('feed', 5 * MINUTE), true, 'however long after it a call comes');
});

t.test('keys and scopes are independent', async t => {
  const due = throttle(MINUTE);
  t.equal(due('one', 0), true, 'one key is due');
  t.equal(due('two', 1), true, 'another key is due while the first is not');
  t.equal(due('one', 2), false, 'and the first is still not');
  t.equal(throttle(MINUTE)('one', 3), true, 'nor does another throttle know what this one said');

  const dueBy = throttleBy<object>(MINUTE);
  const [ first, second ] = [ {}, {} ];
  t.equal(dueBy(first, 'outage', 0), true, 'a key in one scope is due');
  t.equal(dueBy(second, 'outage', 1), true, 'the same key in another scope is due');
  t.equal(dueBy(first, 'fallback', 2), true, 'and so is another key in the same scope');
  t.equal(dueBy(first, 'outage', 3), false, 'while the first is not');
  t.equal(dueBy(first, 'outage', MINUTE), true, 'until its window has passed');
});

/*
 * The registry's caches give the time of their own clock, which a test
 * injects; everything else is timed by the clock.
 */
t.test('a call is timed by the clock, unless it is given a time', async t => {
  let now = 0;
  t.capture(Date, 'now', () => now);

  const due = throttle(MINUTE);
  t.equal(due('feed'), true, 'the first call is due');
  now = MINUTE - 1;
  t.equal(due('feed'), false, 'one within a window of it by the clock is not');
  now = MINUTE;
  t.equal(due('feed'), true, 'one a window after it by the clock is');
  t.equal(due('feed', 2 * MINUTE), true, 'one given a time a window after that is, though the clock has not moved');
  now = 10 * MINUTE;
  t.equal(due('feed', 3 * MINUTE - 1), false, 'and one given a time within that window is not, though the clock is far past it');

  const dueBy = throttleBy<object>(MINUTE);
  const scope = {};
  t.equal(dueBy(scope, 'outage', 0), true, 'a scoped call given a time is due');
  t.equal(dueBy(scope, 'outage', MINUTE - 1), false, 'one given a time within its window is not, though the clock is far past it');
  t.equal(dueBy(scope, 'outage'), true, 'and one without a time is timed by the clock');
});
