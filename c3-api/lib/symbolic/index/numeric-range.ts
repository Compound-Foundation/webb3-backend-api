import * as Index from './base.js';

import * as Type        from '../../type-utilities.js';
import * as Fallible    from '../../fallible/fallible.js';
import * as Perspective from '../../perspective.js';

class NumericRangeIndex<T> implements Index.Iterable<T> {
  // hidden constructor; use NumericRangeIndex.on<T>({...})
  private static ConstructorGuard = Symbol('ConstructorGuard');
  private constructor(
    _: typeof NumericRangeIndex.ConstructorGuard,
    // NumericRangeIndex requires a numeric perspective of the cursor.
    public numericPerspective: Perspective.Of<number, T>,
    // The start, end, and stride are normalized to functions of cursor.
    public stride: ((context: T) => number),
    public start:  ((context: T) => number),
    public end:    ((context: T) => number|undefined),
  ) {}

  static on<T>({
    end,
    stride,
    numericPerspective,
    start = 0,
  }: {
    // NumericRangeIndex requires a numeric perspective of the cursor.
    numericPerspective: Perspective.Of<number, T>,
    // The start, end, and stride are may depend on the cursor, or not.
    stride: number | ((context: T) => number),
    start?: number | ((context: T) => number),
    end?:   number | ((context: T) => number),
  }): NumericRangeIndex<T> {
    return new NumericRangeIndex<T>(
      NumericRangeIndex.ConstructorGuard,
      numericPerspective,
      Type.fnWrap(stride),
      Type.fnWrap(start),
      Type.fnWrap(end),
    );
  }

  /*
   * `covers`: a reference cursor only if it is in the Index domain.
   */
  covers<Reference extends T>(cursor: Reference) {
    const end   = this.end(cursor);
    const start = this.start(cursor);
    const point = this.numericPerspective.reveal(cursor);
    return (point >= start) && ((end === undefined) || (point <= end));
  }

  /*
   * `includes`: a reference cursor only if it is both in the Index
   * domain, and among the points that are n >= 0 `stride` lengths away
   * from the `start` position.
   */
  includes<Reference extends T>(cursor: Reference) {
    return this.covers(cursor) && (() => {
      const point          = this.numericPerspective.reveal(cursor);
      const projectOutcome = this.project(cursor);
      return (true
        && Fallible.isSuccess(projectOutcome)
        && point === this.numericPerspective.reveal(projectOutcome)
      );
    })();
  }

  /*
   * `project`: a reference origin point in the domain of the Index onto
   * a proximate indexed point.
   *
   * Or: `project` from p where covers(p) to p' where includes(p').
   *
   * Returns an Outcome.Of.Failure if the reference origin point is not
   * in the Index domain.
   */
  project<Reference extends T>(origin: Reference) {
    if (!this.covers(origin)) {
      return Fallible.Outcome.Of.Failure({
        origin,
        reason: 'NumericRangeIndex: project: origin is out of bounds',
      });
    }
    const point     = this.numericPerspective.reveal(origin);
    const projected = point - ((point - this.start(origin)) % this.stride(origin));
    return this.numericPerspective.impose(origin, projected);
  }

  /*
   * `preceding`: navigate to the preceding indexed point from the
   * reference origin point in the Index domain. The reference origin
   * must be in the domain, but it may not be specifically indexed.
   *
   * Returns an Outcome.Of.Failure if the reference origin point or the
   * would-be preceding indexed point is not in the Index domain.
   */
  preceding<Reference extends T>(origin: Reference) {
    if (!this.covers(origin)) {
      return Fallible.Outcome.Of.Failure({
        origin,
        reason: 'NumericRangeIndex: preceding: origin is out of bounds',
      });
    }
    // if we're between indexed points, then our projection is preceding
    if (!this.includes(origin)) {
      return this.project(origin);
    }
    // otherwise step back by 1*stride
    const point  = this.numericPerspective.reveal(origin);
    const stride = this.stride(origin);
    const result = this.numericPerspective.impose(origin, point - stride);
    // if the preceding point would be out of bounds, fail as such
    if (!this.covers(result)) {
      return Fallible.Outcome.Of.Failure({
        origin,
        reason: 'NumericRangeIndex: preceding: would be out of bounds',
      });
    }
    return result;
  }

  /*
   * `succeeding`: navigate to the succeeding indexed point from the
   * reference origin point in the Index domain. The reference origin
   * must be in the domain, but it may not be specifically indexed.
   *
   * Returns an Outcome.Of.Failure if the reference origin point or the
   * would-be succeeding indexed point is not in the Index domain.
   */
  succeeding<Reference extends T>(origin: Reference) {
    if (!this.covers(origin)) {
      return Fallible.Outcome.Of.Failure({
        origin,
        reason: 'NumericRangeIndex: succeeding: origin is out of bounds',
      });
    }
    const stride = this.stride(origin);
    const projection = this.project(origin);
    // if projection fails for any reason, simply propagate
    if (Fallible.isFailure(projection)) {
      return projection;
    }
    const projectedPoint = this.numericPerspective.reveal(projection);
    const result = this.numericPerspective.impose(origin, projectedPoint + stride);
    // if the succeeding point would be out of bounds, fail as such
    if (!this.covers(result)) {
      return Fallible.Outcome.Of.Failure({
        origin,
        reason: 'NumericRangeIndex: succeeding: would be out of bounds',
      });
    }
    return result;
  }

  /*
   * `seek` to the indexed point at a relative offset away from the
   * reference origin point in the Index domain. The reference origin
   * must be in the domain, but it may not be specifically indexed.
   *
   * Returns an Outcome.Of.Failure if the reference origin point is not
   * in the Index domain, or if at any step during the `seek` the
   * would-be next cursor position is not in the Index domain.
   */
  // TODO(jordan): refactor into helper, Index.seek(index, origin, offset)...
  seek<Reference extends T>(origin: Reference, offset: number) {
    if (!this.covers(origin)) {
      return Fallible.Outcome.Of.Failure({
        origin,
        reason: 'NumericRangeIndex: seek: origin is out of bounds',
      });
    }
    if (offset === 0) {
      return this.project(origin);
    }
    // internal helper
    return step<Reference>(this, 'seek', {
      origin,
      steps:   Math.abs(offset),
      reverse: offset < 0,
    });
  }

  /*
   * `enumerate` {count} indexed points relative to the given reference
   * origin point. The sign of {count} indicates the direction of the
   * enumeration. The reference origin must be in the domain, but it may
   * not be specifically indexed.
   *
   * If the reference origin point is indexed (`if (includes(origin))`),
   * it will be included at the start of the enumeration. If it is not,
   * then the enumeration will start with the nearest indexed point in
   * the correct relative direction given the sign of {count}.
   *
   * See test cases for examples.
   *
   * Returns {count} indexed points.
   *
   * Returns an Outcome.Of.Failure if the reference origin point is not
   * in the Index domain, or if at any step during the `enumerate` the
   * would-be next cursor position is not in the Index domain.
   */
  // TODO(jordan): refactor into helper, Index.enumerate(index, origin, count)...
  enumerate<Reference extends T>(origin: Reference, count: number) {
    if (!this.covers(origin)) {
      return Fallible.Outcome.Of.Failure({
        origin,
        reason: 'NumericRangeIndex: enumerate: origin is out of bounds',
      });
    }
    const results: Reference[] = [];
    let steps = Math.abs(count);
    // endpoints inclusive
    if (this.includes(origin) && steps > 0) {
      results.push(origin);
      steps--;
    }
    // internal helper
    const outcome = step<Reference>(this, 'enumerate', {
      steps,
      origin,
      reverse: count < 0,
      latch(next) { results.push(next) },
    });
    if (Fallible.isFailure(outcome)) {
      return outcome;
    }
    return results;
  }

  /*
   * `countFromStartTo` counts the number of indexed points, starting from and
   * including {start}, until {limit} is reached or passed by the
   * next-indexed point.
   *
   * In other words, countFromStartTo({origin}) is the maximum value for {count}
   * in enumerate({origin}, -1 * {count}).
   */
  countFromStartTo<Reference extends T>(target: Reference) {
    if (!this.covers(target)) {
      return Fallible.Outcome.Of.Failure({
        limit: target,
        reason: 'NumericRangeIndex: countFromStartTo: limit is out of bounds',
      });
    }
    let steps  = 0;
    let cursor = this.numericPerspective.impose(target, this.start(target));
    const limit = this.numericPerspective.reveal(target);
    while (this.numericPerspective.reveal(cursor) <= limit) {
      cursor = Fallible.must(this.succeeding(cursor));
      steps++;
    }
    return steps;
  }
}

function step<T>(
  index:  Index.Iterable<T>,
  method: string,
  { origin, steps, reverse, latch = () => {} }: {
    origin:  T,
    steps:   number,
    reverse: boolean,
    latch?: (next: T) => void,
  }
) {
  // If steps is negative, that violates our preconditions irrecoverably.
  if (steps < 0) {
    throw new Error(`<internal> step(index): invalid: negative 'steps'`);
  }
  let cursor = { ...origin };
  while (steps > 0) {
    const next = index[reverse ? 'preceding' : 'succeeding'](cursor);
    if (Fallible.isFailure(next)) {
      return Fallible.Outcome.Of.Failure({
        origin,
        position: cursor,
        reason: `NumericRangeIndex: ${method}: next step would be out of bounds`,
      });
    } else {
      // NOTE(jordan): safe unwrap: next could be wrapped in a Success
      cursor = Fallible.unwrap(next);
      latch(cursor);
      steps--;
    }
  }
  return cursor;
}

export { NumericRangeIndex };
