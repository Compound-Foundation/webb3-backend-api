import * as Index       from '../../lib/symbolic/index.js';
import * as Compute     from '../../lib/symbolic/computation.js';
import * as Perspective from '../../lib/perspective.js';

type GetNum = Compute.Spec<{
  name: 'getNum';
  expects: {
    val:    number;
    end:    number;
    start:  number;
    stride: number;
  };
  returns: number;
}>;

const { implement } = Compute.Functor<GetNum>({});

const getNum = implement({
  version: 1,
  index: Index.NumericRange.on<GetNum['expects']>({
    end:    ({ end    }) => end,
    start:  ({ start  }) => start,
    stride: ({ stride }) => stride,
    numericPerspective: Perspective.on<GetNum['expects']>().select('val'),
  }),
  compute: ({ val }) => val,
});

type GetNumDefaultCache = Compute.Spec<{
  name: 'getNumDefaultCache';
  expects: { val: number };
  returns: number;
}>;

const { implement: implementOther } = Compute.Functor<GetNumDefaultCache>({});

const getNumDefaultCache = implementOther({
  version: 1,
  compute: ({ val }) => val,
});

export { GetNum, getNum, GetNumDefaultCache, getNumDefaultCache };
