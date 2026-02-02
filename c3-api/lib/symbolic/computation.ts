import type * as Base       from './computation/base.js';
import type * as Batch      from './computation/batch.js';
import type * as Immediate  from './computation/immediate.js';
import type * as Recurrence from './computation/recurrence.js';

/*
 * Compute.Returns dispatches the appropriate type-modifying type to
 * determine the return type(s) of a computation, depending on the kind of
 * computation in question.
 *
 * NOTE that the order of the conditions matters, since more-derived
 * computation spec types necessarily satisfy less-derived computation
 * spec types.
 *
 * NOTE this type should never return `never', since Immediate.Spec is the
 * base type that all other spec types derive.
 *
 */
export type Returns<Spec extends Base.Spec> = (
  Spec extends Recurrence.Spec
    ? Recurrence.Returns<Spec>
  : Spec extends Batch.Spec
    ? Batch.Returns<Spec>
  : Spec extends Immediate.Spec
    ? Immediate.Returns<Spec>
  : never
);

/*
 * NOTE(jordan): For backwards compatability, any computation with
 * the default version number of 0 will not suffix its name with a
 * version number so that existing cache entries are not needlessly
 * broken. We can and will migrate this over time, so that all
 * computations are given a version number and all cache keys encode that
 * version.
 */
export function versionedName(name: string, version: number): string {
  return version === 0 ? name : `${name}-v${version}`;
}

// re-export all submodules.
export type { Spec } from './computation/spec.js';

export * as Base       from './computation/base.js';
export * as Batch      from './computation/batch.js';
export * as Immediate  from './computation/immediate.js';
export * as Recurrence from './computation/recurrence.js';

/*
 * FIXME(jordan)?: namespace all existing uses of Compute.Spec or
 * Functor/Options/Implementation/etc. so that Immediate is not
 * necessarily the default?
 */
export {
  Functor,
  Options,
  Implementation,
} from './computation/immediate.js';
