import * as Eth      from '../../eth-constants.js';
import * as Fallible from '../../fallible/fallible.js';
import { BigFixnum } from '../../bigfixnum.js';

import * as Key     from '../../symbolic/key.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { RegistryComet } from '../../model/comet-registry.js';

import * as market            from '../market.js';
import type * as comet        from '../comet.js';
import type * as account      from '../account.js';
import type * as cometRewards from '../comet-rewards.js';

type AccountRewards = Compute.Spec<{
  name: 'accountRewards';
  depends: [
    market.MarketRewards,
    comet.BalanceOf,
    comet.BorrowBalanceOf,
    account.Erc20Balance,
    cometRewards.GetRewardOwed
  ];
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    block: Eth.Block;
    network: KnownNetwork.Name;
    contract: RegistryComet;
    account: Eth.Address;
  };
  // a market whose rewards cannot be valued reports only what identifies it
  returns: Extract<market.MarketRewards['returns'], { status: 'error' }> | (
    & Extract<market.MarketRewards['returns'], { status: 'success' }>
    & {
      amountOwed: BigFixnum;
      walletBalance: BigFixnum;
      supplyBalance: BigFixnum;
      borrowBalance: BigFixnum;
    }
  );
}>;

const { implement, pipe } = Compute.Functor<AccountRewards>({});
const accountRewards = implement({
  // 3: a price that reverts is reported as the market's status
  version: 3,
  index: Index.BlockIndexOnIntervalSeconds(60 * 5),
  key(name, { block, ...context }) {
    const { block: projected } = Fallible.must(this.index.project({ block, ...context }));
    return Key.toKey(name, { block: projected.number, ...context });
  },
  compute({ apiHost, nodeHost, nodeKey, contract, network, block, account }) {
    // an account is owed rewards in the token a market pays, through the contract that pays it
    const rewards = contract.rewards;
    if (rewards?.asset === undefined) {
      throw new Error(`invariant violated: ${contract.address} pays no reward token`);
    }
    const rewardToken = rewards.asset;
    const marketRewards = Fallible.must(market.marketRewards.index.project({
      apiHost, nodeHost, nodeKey, contract, network, block
    }));
    return pipe([
      {
        marketRewards,
        balanceOf: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          contract,
          address: account,
          blockNumber: block.number,
        },
        borrowBalanceOf: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          contract,
          address: account,
          blockNumber: block.number,
        },
        erc20Balance: {
          apiHost,
          nodeHost,
          nodeKey,
          account,
          network,
          contract: rewardToken,
          blockNumber: block.number,
        },
        getRewardOwed: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          account,
          comet:        contract.address,
          contract:     rewards.contract,
          blockNumber:  block.number,
          rewardsAsset: rewardToken,
        },
      },
      ({
        marketRewards,
        balanceOf,
        borrowBalanceOf,
        erc20Balance,
        getRewardOwed,
      }): AccountRewards['returns'] => {
        if (marketRewards.status === 'error') {
          return marketRewards;
        }
        return {
          ...marketRewards,
          amountOwed: getRewardOwed,
          walletBalance: erc20Balance,
          supplyBalance: balanceOf,
          borrowBalance: borrowBalanceOf,
        };
      },
    ]);
  },
});

export { AccountRewards, accountRewards };
