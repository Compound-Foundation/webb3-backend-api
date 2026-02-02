import * as evm          from '../../lib/computations/evm.js';
import * as account      from '../../lib/computations/account.js';
import * as cometRewards from '../../lib/computations/comet-rewards.js';

import type { Context as RouterContext } from '../router.js';

interface Context
  extends RouterContext
{}

type Dependencies = (
  | evm.Evm
  | account.AccountRewards
  | cometRewards.GetRewardConfig
  | cometRewards.GetRewardConfigsSleuth
);

export type {
  Context,
  Dependencies,
};

export { rewardsSummary } from './rewards.js';
