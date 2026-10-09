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

import type { SupplyKink } from './supply-kink';
import type { SupplyPerSecondInterestRateBase } from './supply-per-second-interest-rate-base';
import type { SupplyPerSecondInterestRateSlopeLow } from './supply-per-second-interest-rate-slope-low';
import type { SupplyPerSecondInterestRateSlopeHigh } from './supply-per-second-interest-rate-slope-high';

type SupplyRatePerSecond = Compute.Spec<{
  name: 'supplyRatePerSecond';
  depends: [
    Utilization,
    SupplyKink,
    SupplyPerSecondInterestRateBase,
    SupplyPerSecondInterestRateSlopeLow,
    SupplyPerSecondInterestRateSlopeHigh,
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

const { implement, pipe } = Compute.Functor<SupplyRatePerSecond>({});

const supplyRatePerSecond = implement({
  version: 1,
  index: Index.BlockIndexOnIntervalSeconds(60 * 5),
  key(name, { block, ...context }) {
    const { block: projected } = Fallible.must(this.index.project({ block, ...context }));
    return Key.toKey(name, { block: projected.number, ...context });
  },
  compute({ block, ...context }) {
    const abiFunctionCtx = {
      ...context,
      blockNumber: block.number,
    } as const;

    return pipe([
      {
        utilization: abiFunctionCtx,
        supplyKink: abiFunctionCtx,
        supplyPerSecondInterestRateBase: abiFunctionCtx,
        supplyPerSecondInterestRateSlopeLow: abiFunctionCtx,
        supplyPerSecondInterestRateSlopeHigh: abiFunctionCtx,
      },
      ({
         utilization,
         supplyKink: kink,
         supplyPerSecondInterestRateBase: base,
         supplyPerSecondInterestRateSlopeLow: low,
         supplyPerSecondInterestRateSlopeHigh: high,
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

export { SupplyRatePerSecond, supplyRatePerSecond };
