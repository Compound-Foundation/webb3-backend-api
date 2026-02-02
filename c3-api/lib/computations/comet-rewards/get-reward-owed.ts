import * as Eth      from '../../eth-constants.js';
import { BigNumber } from '../../bignumber.js';
import { BigFixnum } from '../../bigfixnum.js';

import type {
  ERC20,
  StandaloneContract,
} from '../../well-known/contracts/types.js';

import * as abiFunction from '../abi-function.js';

type GetRewardOwed = abiFunction.Spec<{
  name: 'getRewardOwed';
  expects: {
    comet: Eth.Address;
    account: Eth.Address;
    rewardsAsset: Eth.Contract<StandaloneContract<ERC20>>;
  };
  returns: BigFixnum;
}>;

const { implement } = abiFunction.Functor<GetRewardOwed>({});
const getRewardOwed = implement({
  version: 1,
  signature: `function getRewardOwed(address,address) returns (address,uint256)`,
  parameters: ({ comet, account }) => [comet, account],
  parser: ([_, u256], { rewardsAsset }) => BigFixnum.from({
    value: BigNumber.from(u256),
    decimals: rewardsAsset.decimals,
  }),
});

export { GetRewardOwed, getRewardOwed };
