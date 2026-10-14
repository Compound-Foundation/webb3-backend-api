import { BigNumber }    from '@ethersproject/bignumber';

import * as Compute     from '../../symbolic/computation.js';
import * as abiFunction from '../abi-function.js';

/*
 * The interest rate model of a Comet: for supply and for borrow, the
 * utilization at which the rate's slope changes, the rate per second at no
 * utilization, and its slopes below and above that point, each at 1e18 as
 * the Comet stores them. They are immutables of the Comet's implementation,
 * so only an upgrade changes them, and they read nothing outside it: unlike
 * a price or a reserve, a revert of one means the address is not a Comet,
 * and fails the read as any other call does.
 */
type Getter<Name extends string> = abiFunction.Spec<{
  name: Name,
  returns: BigNumber,
}>;

type SupplyKink                           = Getter<'supplyKink'>;
type SupplyPerSecondInterestRateBase      = Getter<'supplyPerSecondInterestRateBase'>;
type SupplyPerSecondInterestRateSlopeLow  = Getter<'supplyPerSecondInterestRateSlopeLow'>;
type SupplyPerSecondInterestRateSlopeHigh = Getter<'supplyPerSecondInterestRateSlopeHigh'>;
type BorrowKink                           = Getter<'borrowKink'>;
type BorrowPerSecondInterestRateBase      = Getter<'borrowPerSecondInterestRateBase'>;
type BorrowPerSecondInterestRateSlopeLow  = Getter<'borrowPerSecondInterestRateSlopeLow'>;
type BorrowPerSecondInterestRateSlopeHigh = Getter<'borrowPerSecondInterestRateSlopeHigh'>;

const parser = ([ u256 ]: abiFunction.AbiResult) => BigNumber.from(u256);

const supplyKink = abiFunction.Functor<SupplyKink>({}).implement({
  version: 1,
  signature: `function supplyKink() view returns (uint256)`,
  parser,
});

const supplyPerSecondInterestRateBase = abiFunction.Functor<SupplyPerSecondInterestRateBase>({}).implement({
  version: 1,
  signature: `function supplyPerSecondInterestRateBase() view returns (uint256)`,
  parser,
});

const supplyPerSecondInterestRateSlopeLow = abiFunction.Functor<SupplyPerSecondInterestRateSlopeLow>({}).implement({
  version: 1,
  signature: `function supplyPerSecondInterestRateSlopeLow() view returns (uint256)`,
  parser,
});

const supplyPerSecondInterestRateSlopeHigh = abiFunction.Functor<SupplyPerSecondInterestRateSlopeHigh>({}).implement({
  version: 1,
  signature: `function supplyPerSecondInterestRateSlopeHigh() view returns (uint256)`,
  parser,
});

const borrowKink = abiFunction.Functor<BorrowKink>({}).implement({
  version: 1,
  signature: `function borrowKink() view returns (uint256)`,
  parser,
});

const borrowPerSecondInterestRateBase = abiFunction.Functor<BorrowPerSecondInterestRateBase>({}).implement({
  version: 1,
  signature: `function borrowPerSecondInterestRateBase() view returns (uint256)`,
  parser,
});

const borrowPerSecondInterestRateSlopeLow = abiFunction.Functor<BorrowPerSecondInterestRateSlopeLow>({}).implement({
  version: 1,
  signature: `function borrowPerSecondInterestRateSlopeLow() view returns (uint256)`,
  parser,
});

const borrowPerSecondInterestRateSlopeHigh = abiFunction.Functor<BorrowPerSecondInterestRateSlopeHigh>({}).implement({
  version: 1,
  signature: `function borrowPerSecondInterestRateSlopeHigh() view returns (uint256)`,
  parser,
});

type RateCurve = {
  kink:      BigNumber,
  base:      BigNumber,
  slopeLow:  BigNumber,
  slopeHigh: BigNumber,
};

type RateModel = Compute.Spec<{
  name: 'rateModel',
  depends: [
    SupplyKink,
    SupplyPerSecondInterestRateBase,
    SupplyPerSecondInterestRateSlopeLow,
    SupplyPerSecondInterestRateSlopeHigh,
    BorrowKink,
    BorrowPerSecondInterestRateBase,
    BorrowPerSecondInterestRateSlopeLow,
    BorrowPerSecondInterestRateSlopeHigh,
  ],
  expects: SupplyKink['expects'],
  returns: { supply: RateCurve, borrow: RateCurve },
}>;

const { implement, pipe } = Compute.Functor<RateModel>({});
const rateModel = implement({
  version: 1,
  compute({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) {
    const read = { apiHost, nodeHost, nodeKey, blockNumber, contract, network };
    return pipe([
      {
        supplyKink:                           read,
        supplyPerSecondInterestRateBase:      read,
        supplyPerSecondInterestRateSlopeLow:  read,
        supplyPerSecondInterestRateSlopeHigh: read,
        borrowKink:                           read,
        borrowPerSecondInterestRateBase:      read,
        borrowPerSecondInterestRateSlopeLow:  read,
        borrowPerSecondInterestRateSlopeHigh: read,
      },
      parameters => ({
        supply: {
          kink:      parameters.supplyKink,
          base:      parameters.supplyPerSecondInterestRateBase,
          slopeLow:  parameters.supplyPerSecondInterestRateSlopeLow,
          slopeHigh: parameters.supplyPerSecondInterestRateSlopeHigh,
        },
        borrow: {
          kink:      parameters.borrowKink,
          base:      parameters.borrowPerSecondInterestRateBase,
          slopeLow:  parameters.borrowPerSecondInterestRateSlopeLow,
          slopeHigh: parameters.borrowPerSecondInterestRateSlopeHigh,
        },
      }),
    ]);
  },
});

export type { RateCurve };

export {
  BorrowKink,
  BorrowPerSecondInterestRateBase,
  BorrowPerSecondInterestRateSlopeHigh,
  BorrowPerSecondInterestRateSlopeLow,
  RateModel,
  SupplyKink,
  SupplyPerSecondInterestRateBase,
  SupplyPerSecondInterestRateSlopeHigh,
  SupplyPerSecondInterestRateSlopeLow,
  borrowKink,
  borrowPerSecondInterestRateBase,
  borrowPerSecondInterestRateSlopeHigh,
  borrowPerSecondInterestRateSlopeLow,
  rateModel,
  supplyKink,
  supplyPerSecondInterestRateBase,
  supplyPerSecondInterestRateSlopeHigh,
  supplyPerSecondInterestRateSlopeLow,
};
