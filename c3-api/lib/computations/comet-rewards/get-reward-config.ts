import * as Eth   from '../../eth-constants.js';
import * as Index from '../../symbolic/index.js';

import * as abiFunction from '../abi-function.js';

import { Comet, StandaloneContract } from '../../well-known/contracts/types.js';

type GetRewardConfig = abiFunction.Spec<{
  name: 'getRewardConfig';
  expects: {
    market: Eth.Contract<StandaloneContract<Comet>>;
  };
  returns: {
    rewardToken: Eth.Address; // TODO(jordan): ERC20 type
    rescaleFactor: number;
    shouldUpscale: boolean;
  };
}>;

const { implement } = abiFunction.Functor<GetRewardConfig>({});
const getRewardConfig = implement({
  version: 2,
  index: Index.adapt(Index.HourlyBlockIndex, {
    // blockNumber -> block.number
    reveal: ctx => ({ ...ctx, block: { number: ctx.blockNumber } }),
    // block.number -> blockNumber
    impose: (ctx, mod) => ({ ...ctx, blockNumber: mod.block.number }),
  }),
  signature: `function rewardConfig(address) returns (address,uint64,bool)`,
  parameters: ({ market }) => [market.address],
  parser: ([rewardToken, rescaleFactor, shouldUpscale]) => ({
    rewardToken,
    rescaleFactor,
    shouldUpscale,
  }),
});

export { GetRewardConfig, getRewardConfig };
