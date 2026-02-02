import t from 'tap';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';

import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as evm    from '../../../../lib/computations/evm.js';
import * as comet  from '../../../../lib/computations/comet.js';
import * as market from '../../../../lib/computations/market.js';
import * as rewards from '../../../../lib/computations/rewards.js';

import '../../../../shim/node-self.js';

import { setupTestEnvVars } from '../../../util/setupTestEnvVars.js';

/*
 * Global env.
 */

const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const testDebug = debug.scope('test');
testDebug.log({ flags });

let apiHost = '';
let nodeHost = '';
let nodeKey = '';
t.before(() => {
  ({ apiHost, nodeHost, nodeKey } = setupTestEnvVars());
});

t.test(`market-rewards@block:17813902`, async t => {
  const evaluator = Evaluator.instantiate<market.MarketRewards>(
    {
      ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
      ...comet,
      ...market,
      ...rewards,
    },
    {
      debug,
      flags,
      cache: new MemoryCache({}, [
        BigFixnum.JsonReviver,
        BigNumber.JsonReviver,
      ]),
    },
  );
  const marketRewards: market.MarketRewards['expects'] = {
    apiHost,
    nodeHost,
    nodeKey,
    contract: Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Comet']['cUSDCv3'],
    network: 'ethereum-mainnet',
    block: { number: 17_813_902 },
  }

  const result = await evaluator.evaluate(evaluator.pull1({ marketRewards }));
  t.strictSame(result, {
    chainId: 1,
    comet: {
      address: '0xc3d688b66703497daa19211eedff47f25384cdc3',
    },
    cometRewards: {
      address: '0x1b0e765f6224c21223aea2af16c1c46e38885a40',
    },
    baseAsset: {
      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      decimals: 6,
      description: 'USD Coin',
      symbol: 'USDC',
      minBorrow: '100.0',
      priceFeed: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    },
    rewardAsset: {
      address: '0xc00e94cb662c3520282e6f5717214004a7f26888',
      decimals: 18,
      description: 'Compound Governance Token',
      price: '66.5776997',
      symbol: 'COMP',
    },
    earnRewardsApr: '0.005937882111773537413',
    borrowRewardsApr: '0.024521223921916513635',
  });
});
