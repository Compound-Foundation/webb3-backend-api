import * as Perspective from '../../perspective.js';

import { NumericRangeIndex } from './numeric-range.js';

function BlockNumberRangeIndex<T extends { blockNumber: number }>(options: {
  stride: number | ((context: T) => number),
  start?: number | ((context: T) => number),
  end?:   number | ((context: T) => number),
}) {
  return NumericRangeIndex.on<T>({
    ...options,
    numericPerspective: Perspective.on<{ blockNumber: number }>().select('blockNumber'),
  });
}

export { BlockNumberRangeIndex };
