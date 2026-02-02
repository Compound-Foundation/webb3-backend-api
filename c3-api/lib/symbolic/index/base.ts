import * as Fallible    from '../../fallible/fallible.js';
import * as Perspective from '../../perspective.js';

interface Index<Constraint> {
  // "covers" a reference point if it falls within the index's domain
  covers(point: Constraint): boolean;
  // "includes" a reference point only if it is covered and indexed
  includes(point: Constraint): boolean;
  // "project"s from a covered reference point to a proximate indexed point
  project<Reference extends Constraint>(point: Reference): Fallible.Outcome.OrJust<Reference>;
}

interface IterableIndex<Constraint> extends Index<Constraint> {
  // "preceding" navigates to the nearest preceding indexed point from a reference point
  preceding<Reference extends Constraint>(point: Reference): Fallible.Outcome.OrJust<Reference>;
  // "succeeding" navigates to the nearest succeeding indexed point from a reference point
  succeeding<Reference extends Constraint>(point: Reference): Fallible.Outcome.OrJust<Reference>;
}

function MakeIndex<Constraint>(index: Index<Constraint>) {
  return index;
}

const Nothing = MakeIndex<any>({
  covers:   ()    => true,
  includes: ()    => false,
  project:  point => point,
});

const Everything = MakeIndex<any>({
  covers:   ()    => true,
  includes: ()    => true,
  project:  point => point,
});

function adapt<Target, Constraint>(
  index: Index<Target>,
  perspective: Perspective.Of<Target, Constraint>,
): Index<Constraint> {
  return {
    covers(reference) {
      return index.covers(perspective.reveal(reference));
    },
    includes(reference) {
      return index.includes(perspective.reveal(reference));
    },
    project(reference) {
      const outcome = index.project(perspective.reveal(reference));
      if (Fallible.isFailure(outcome)) {
        return outcome;
      }
      return perspective.impose(reference, Fallible.unwrap(outcome));
    },
  };
}

export type {
  Index         as Base,
  IterableIndex as Iterable,
};

export {
  adapt,
  Nothing,
  Everything,
  MakeIndex as Make,
};
