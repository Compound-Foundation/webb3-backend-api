import t from 'tap';

import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as KnownNetwork from '../../../../lib/well-known/networks/network.js';

import * as evm     from '../../../../lib/computations/evm.js';
import * as comet   from '../../../../lib/computations/comet.js';
import * as market  from '../../../../lib/computations/market.js';
import * as rewards from '../../../../lib/computations/rewards.js';

import '../../../../shim/node-self.js';

import { setupTestEnvVars } from '../../../util/setupTestEnvVars.js';
import { fixtureComet }     from '../../../util/registry-fixture.js';

const network: KnownNetwork.Name = 'ethereum-mainnet';
const contract = fixtureComet(network, '0xc3d688b66703497daa19211eedff47f25384cdc3');
// the feed the rewards summary route reads the reward token's price from: the one the version states
const rewardsTokenPriceFeed = contract.registry.market.rewardAsset!.priceFeed!;

let apiHost = '';
let nodeHost = '';
let nodeKey = '';
t.before(() => {
  ({ apiHost, nodeHost, nodeKey } = setupTestEnvVars());
});

t.test(`rewards-summary@block:16380543`, async t => {
  const evaluator = Evaluator.instantiate<rewards.RewardsSummary>(
    { ...evm, ...comet, ...market, ...rewards },
    {
      cache: new MemoryCache({}, [
        BigNumber.JsonReviver,
        BigFixnum.JsonReviver,
      ]),
    },
  );
  const rewardsSummary: rewards.RewardsSummary['expects'] = {
    apiHost,
    nodeHost,
    nodeKey,
    contract,
    network,
    rewardsTokenPriceFeed,
    block: {
      date:      '2023-01-11',
      number:    16_380_543,
      timestamp: 1_673_432_423,
    },
  };
  const result = await evaluator.evaluate(evaluator.pull1({ rewardsSummary }));
  t.strictSame(result, {
    status: 'success',
    supplyRewardsApr: '0.0',
    borrowRewardsApr: '0.02509046997784825315218',
    supplyRewardsRatePerSecond: '0.0',
    borrowRewardsRatePerSecond: '0.001868287037037',
  });
});
