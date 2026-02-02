import * as Index       from '../../lib/symbolic/index.js';
import * as Compute     from '../../lib/symbolic/computation.js';
import * as Perspective from '../../lib/perspective.js';

// Takes in a number cursor and adds itself down to an arbitrary start number,
// set by the context
type AddDownToNum = Compute.Recurrence.Spec<{
  name: 'addDownToNum';
  basis: { start: number };
  cursor: { val: number };
  returns: number;
}>;

const { fromPrevious, implement } = Compute.Recurrence.Functor<AddDownToNum>({});

const addDownToNum = implement({
  version: 1,
  origin: () => 0,
  index: Index.NumericRange.on<AddDownToNum['expects']>({
    start: ({ start }) => start,
    stride: 1,
    numericPerspective: Perspective.on<AddDownToNum['expects']>().select('val'),
  }),
  compute: (current) => {
    return fromPrevious((previous) => previous.value + current.val);
  },
});

export { AddDownToNum, addDownToNum };
