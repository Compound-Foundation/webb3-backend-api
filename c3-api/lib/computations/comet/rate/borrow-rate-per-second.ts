import { BigNumber } from "@ethersproject/bignumber";

import { BigFixnum } from '../../../bigfixnum';

import * as Eth from "../../../eth-constants";
import * as Fallible from "../../../fallible/fallible";
import * as Index from "../../../symbolic";
import * as Compute from '../../../symbolic/computation.js';
import * as Key from "../../../symbolic/key";
import * as KnownNetwork from "../../../well-known/networks/network";

import { Comet, StandaloneContract } from "../../../well-known/contracts/types";

import type { Utilization } from '../utilization';

import type { BorrowKink } from './borrow-kink';
import type { BorrowPerSecondInterestRateBase } from './borrow-per-second-interest-rate-base';
import type { BorrowPerSecondInterestRateSlopeLow } from './borrow-per-second-interest-rate-slope-low';
import type { BorrowPerSecondInterestRateSlopeHigh } from './borrow-per-second-interest-rate-slope-high';

type BorrowRatePerSecond = Compute.Spec<{
  name: 'borrowRatePerSecond';
  depends: [
    Utilization,
    BorrowKink,
    BorrowPerSecondInterestRateBase,
    BorrowPerSecondInterestRateSlopeLow,
    BorrowPerSecondInterestRateSlopeHigh,
  ];
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    block: Eth.Block;
    network: KnownNetwork.Name;
    contract: Eth.Contract<StandaloneContract<Comet>>;
  },
  returns: BigFixnum;
}>;

const { implement, pipe } = Compute.Functor<BorrowRatePerSecond>({});

const borrowRatePerSecond = implement({
  version: 1,
  index: Index.BlockIndexOnIntervalSeconds(60 * 5),
  key(name, { block, ...context }) {
    const { block: projected } = Fallible.must(this.index.project({ block, ...context }));
    return Key.toKey(name, { block: projected.number, ...context });
  },
  compute({block, ...context}) {
    const abiFunctionCtx = {
      ...context,
      blockNumber: block.number,
    } as const;

    return pipe([
      {
        utilization: abiFunctionCtx,
        borrowKink: abiFunctionCtx,
        borrowPerSecondInterestRateBase: abiFunctionCtx,
        borrowPerSecondInterestRateSlopeLow: abiFunctionCtx,
        borrowPerSecondInterestRateSlopeHigh: abiFunctionCtx,
      },
      ({
         utilization,
         borrowKink: kink,
         borrowPerSecondInterestRateBase: base,
         borrowPerSecondInterestRateSlopeLow: low,
         borrowPerSecondInterestRateSlopeHigh: high,
       }) => {
        return BigFixnum.from({
          decimals: 18,
          value: ((): BigNumber => {
            const factorScale = 10n ** 18n;

            if (utilization.lte(kink)) {
              return base.add(low.mul(utilization).div(factorScale));
            }

            return base.add(low.mul(kink).div(factorScale)).add(high.mul(utilization.sub(kink)).div(factorScale));
          })(),
        })
      }
    ])
  }
});

export { BorrowRatePerSecond, borrowRatePerSecond };
