import * as Flags from '../flags.js';

import * as Compute from './computation.js';

import { RecursiveEvaluator  } from './evaluator/recursive.js';
import { WorkingsetEvaluator } from './evaluator/workingset.js';

import type * as Evaluator from './evaluator/base.js';

function instantiate<
  ScopeRoots extends Compute.Spec,
  Scope      extends Compute.Spec = (ScopeRoots | ScopeRoots['depends']),
>(
  computations: Evaluator.Computations<Scope>,
  context:      Evaluator.Context,
): Evaluator.Implementation<Scope> {
  const flags = Flags.defaults(context.flags ?? {});
  switch (flags.evaluatorAlgorithm) {
    case 'recursive':  return RecursiveEvaluator(computations, context);
    case 'workingset': return WorkingsetEvaluator(computations, context);
    default: {
      throw new Error(
        `unknown evaluator algorithm requested:`
        + ` ${flags.evaluatorAlgorithm}`
      );
    }
  }
}

export { instantiate };
export { RecursiveEvaluator  as Recursive  } from './evaluator/recursive.js';
export { WorkingsetEvaluator as Workingset } from './evaluator/workingset.js';

export type {
  // instance types
  Context,
  Parameters,
  Computations,
  Implementation,
  // result types
  CertainResult,
  EventualResult,
} from './evaluator/base.js';
