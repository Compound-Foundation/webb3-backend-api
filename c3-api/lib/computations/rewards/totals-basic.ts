import { BigNumber } from '@ethersproject/bignumber';

import * as abiFunction from '../abi-function.js';

const TotalsBasicStructAbi = `tuple(
  uint64 baseSupplyIndex,
  uint64 baseBorrowIndex,
  uint64 trackingSupplyIndex,
  uint64 trackingBorrowIndex,
  uint104 totalSupplyBase,
  uint104 totalBorrowBase,
  uint40 lastAccrualTime,
  uint8 pauseFlags
)`;

type TotalsBasic = abiFunction.Spec<{
  name: 'totalsBasic',
  returns: {
    pauseFlags : BigNumber,
    baseSupplyIndex : BigNumber,
    baseBorrowIndex : BigNumber,
    totalSupplyBase : BigNumber,
    totalBorrowBase : BigNumber,
    lastAccrualTime : BigNumber,
    trackingSupplyIndex : BigNumber,
    trackingBorrowIndex : BigNumber,
  },
}>;

const { implement } = abiFunction.Functor<TotalsBasic>({});
const totalsBasic = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function totalsBasic() view returns (${TotalsBasicStructAbi} memory)`,
  parser: ([{
    pauseFlags,
    baseSupplyIndex,
    baseBorrowIndex,
    totalSupplyBase,
    totalBorrowBase,
    lastAccrualTime,
    trackingSupplyIndex,
    trackingBorrowIndex,
  }]) => ({
    pauseFlags:          BigNumber.from(pauseFlags),
    baseSupplyIndex:     BigNumber.from(baseSupplyIndex),
    baseBorrowIndex:     BigNumber.from(baseBorrowIndex),
    totalSupplyBase:     BigNumber.from(totalSupplyBase),
    totalBorrowBase:     BigNumber.from(totalBorrowBase),
    lastAccrualTime:     BigNumber.from(lastAccrualTime),
    trackingSupplyIndex: BigNumber.from(trackingSupplyIndex),
    trackingBorrowIndex: BigNumber.from(trackingBorrowIndex),
  }),
});

export { TotalsBasic, totalsBasic };
