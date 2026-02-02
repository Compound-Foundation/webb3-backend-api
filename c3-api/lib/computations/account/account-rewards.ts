import * as Eth      from '../../eth-constants.js';
import * as Fallible from '../../fallible/fallible.js';
import { BigFixnum } from '../../bigfixnum.js';

import * as Key     from '../../symbolic/key.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import {
  Comet,
  StandaloneContract,
} from '../../well-known/contracts/types.js';

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
    contract: Eth.Contract<StandaloneContract<Comet>>;
    account: Eth.Address;
  };
  returns: market.MarketRewards['returns'] & {
    amountOwed: BigFixnum;
    walletBalance: BigFixnum;
    supplyBalance: BigFixnum;
    borrowBalance: BigFixnum;
  };
}>;

const { implement, pipe } = Compute.Functor<AccountRewards>({});
const accountRewards = implement({
  version: 2,
  index: Index.BlockIndexOnIntervalSeconds(60 * 5),
  key(name, { block, ...context }) {
    const { block: projected } = Fallible.must(this.index.project({ block, ...context }));
    return Key.toKey(name, { block: projected.number, ...context });
  },
  compute({ apiHost, nodeHost, nodeKey, contract, network, block, account }) {
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
          contract: contract.rewards.asset,
          blockNumber: block.number,
        },
        getRewardOwed: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          account,
          comet:        contract.address,
          contract:     contract.rewards.contract,
          blockNumber:  block.number,
          rewardsAsset: contract.rewards.asset,
        },
      },
      ({
        marketRewards,
        balanceOf,
        borrowBalanceOf,
        erc20Balance,
        getRewardOwed,
      }) => {
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
