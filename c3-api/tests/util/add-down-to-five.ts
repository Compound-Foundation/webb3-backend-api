import * as Index       from '../../lib/symbolic/index.js';
import * as Compute     from '../../lib/symbolic/computation.js';
import * as Perspective from '../../lib/perspective.js';

// Takes in a number cursor and adds itself down to 5, excluding 5.
type AddDownToFive = Compute.Recurrence.Spec<{
  name: 'addDownToFive';
  basis: {},
  cursor: {
    val: number
  },
  returns: number;
}>;

const { fromPrevious, implement } = Compute.Recurrence.Functor<AddDownToFive>({});

const addDownToFive = implement({
  version: 1,
  origin: () => 0,
  index: Index.NumericRange.on<AddDownToFive['expects']>({
    start: 5,
    stride: 1,
    numericPerspective: Perspective.on<AddDownToFive['expects']>().select('val'),
  }),
  compute: (curr) => {
    return fromPrevious((previous) => previous.value + curr.val);
  },
});

export { AddDownToFive, addDownToFive };
