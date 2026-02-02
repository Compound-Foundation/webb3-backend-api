import { BigNumber } from '@ethersproject/bignumber';

import * as abiFunction from '../abi-function.js';

type TrackingIndexScale = abiFunction.Spec<{
  name: 'trackingIndexScale',
  returns: BigNumber,
}>;

const { implement } = abiFunction.Functor<TrackingIndexScale>({});
const trackingIndexScale = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function trackingIndexScale() view returns (uint256)`,
  parser: ([ u256 ]) => BigNumber.from(u256),
});

export { TrackingIndexScale, trackingIndexScale };
