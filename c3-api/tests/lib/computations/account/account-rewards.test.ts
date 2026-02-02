import t from 'tap';

import * as Eth   from '../../../../lib/eth-constants.js';
import * as Debug from '../../../../lib/debug-log.js';
import * as Flags from '../../../../lib/flags.js';

import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as evm          from '../../../../lib/computations/evm.js';
import * as comet        from '../../../../lib/computations/comet.js';
import * as account      from '../../../../lib/computations/account.js';
import * as rewards      from '../../../../lib/computations/rewards.js';
import * as market       from '../../../../lib/computations/market.js';
import * as cometRewards from '../../../../lib/computations/comet-rewards.js';

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

t.test(
  `account-rewards@block:17835961 verify amountOwed and borrowBalance`,
  async () => {
    const evaluator = Evaluator.instantiate<account.AccountRewards>(
      {
        ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
        ...comet,
        ...market,
        ...rewards,
        ...account,
        ...cometRewards,
      },
      {
        debug,
        flags,
        cache: new MemoryCache({}, [
          BigFixnum.JsonReviver,
          BigNumber.JsonReviver,
        ]),
      }
    );

    const accountRewards: account.AccountRewards['expects'] = {
      apiHost,
      nodeHost,
      nodeKey,
      contract:
        Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Comet']['cUSDCv3'],
      network: 'ethereum-mainnet',
      block: { number: 17835961 },
      account: '0xc01e119d19d10ab6b60b95b28c201b09cf95360b',
    };

    const result = await evaluator.evaluate(
      evaluator.pull1({ accountRewards })
    );
    t.strictSame(result, {
      chainId: 1,
      comet: { address: '0xc3d688b66703497daa19211eedff47f25384cdc3' },
      cometRewards: { address: '0x1b0e765f6224c21223aea2af16c1c46e38885a40' },
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
        price: '60.03203654',
        symbol: 'COMP',
      },
      earnRewardsApr: '0.00561516260550728952261',
      borrowRewardsApr: '0.02149863381959849594351',
      // 99.740644
      amountOwed: BigFixnum.from({
        value: BigNumber.from('0x05682df344f8b24000'),
        decimals: 18,
      }),
      // 0.0
      walletBalance: BigFixnum.from({
        value: BigNumber.from('0x00'),
        decimals: 18,
      }),
      // 0.0
      supplyBalance: BigFixnum.from({
        value: BigNumber.from('0x00'),
        decimals: 6,
      }),
      // 405412.066458
      borrowBalance: BigFixnum.from({
        value: BigNumber.from('0x5e6471349a'),
        decimals: 6,
      }),
    });
  }
);

t.test(`account-rewards@block:17835961 verify supplyBalance`, async () => {
  const evaluator = Evaluator.instantiate<account.AccountRewards>(
    {
      ...evm.applyIndexBias(flags.ethComputationIndexBias, evm),
      ...comet,
      ...market,
      ...rewards,
      ...account,
      ...cometRewards,
    },
    {
      debug,
      flags,
      cache: new MemoryCache({}, [
        BigFixnum.JsonReviver,
        BigNumber.JsonReviver,
      ]),
    }
  );

  const accountRewards: account.AccountRewards['expects'] = {
    apiHost,
    nodeHost,
    nodeKey,
    contract:
      Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Comet']['cUSDCv3'],
    network: 'ethereum-mainnet',
    block: { number: 17835961 },
    account: '0x65aba0bcaa72daf4ab9512a9c73f4fa813f02f82',
  };

  const result = await evaluator.evaluate(evaluator.pull1({ accountRewards }));
  t.strictSame(result, {
    chainId: 1,
    comet: { address: '0xc3d688b66703497daa19211eedff47f25384cdc3' },
    cometRewards: { address: '0x1b0e765f6224c21223aea2af16c1c46e38885a40' },
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
      price: '60.03203654',
      symbol: 'COMP',
    },
    earnRewardsApr: '0.00561516260550728952261',
    borrowRewardsApr: '0.02149863381959849594351',
    // 4.425546
    amountOwed: BigFixnum.from({
      value: BigNumber.from('0x3d6ab2a3b326a000'),
      decimals: 18,
    }),
    // 0.0
    walletBalance: BigFixnum.from({
      value: BigNumber.from('0x00'),
      decimals: 18,
    }),
    // 1013886.495526
    supplyBalance: BigFixnum.from({
      value: BigNumber.from('0xec10582b26'),
      decimals: 6,
    }),
    //0.0
    borrowBalance: BigFixnum.from({
      value: BigNumber.from('0x00'),
      decimals: 6,
    }),
  });
});

t.test(`account-rewards@block:17835961 verify usdc walletBalance`, async () => {
  const evaluator = Evaluator.instantiate<account.AccountRewards>(
    { ...evm, ...comet, ...rewards, ...market, ...account, ...cometRewards },
    {
      debug,
      flags,
      cache: new MemoryCache({}, [
        BigFixnum.JsonReviver,
        BigNumber.JsonReviver,
      ]),
    }
  );

  const accountRewards: account.AccountRewards['expects'] = {
    apiHost,
    nodeHost,
    nodeKey,
    contract:
      Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Comet']['cUSDCv3'],
    network: 'ethereum-mainnet',
    block: { number: 17835961 },
    account: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // vitalik.eth
  };

  const result = await evaluator.evaluate(evaluator.pull1({ accountRewards }));
  t.strictSame(result, {
    chainId: 1,
    comet: { address: '0xc3d688b66703497daa19211eedff47f25384cdc3' },
    cometRewards: { address: '0x1b0e765f6224c21223aea2af16c1c46e38885a40' },
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
      price: '60.03203654',
      symbol: 'COMP',
    },
    earnRewardsApr: '0.00561516260550728952261',
    borrowRewardsApr: '0.02149863381959849594351',
    // 0.0
    amountOwed: BigFixnum.from({
      value: BigNumber.from('0x00'),
      decimals: 18,
    }),
    // 396767.093705
    walletBalance: BigFixnum.from({
      value: BigNumber.from('0x05b49a0c186b25'),
      decimals: 18,
    }),
    // 0.0
    supplyBalance: BigFixnum.from({
      value: BigNumber.from('0x00'),
      decimals: 6,
    }),
    // 0.0
    borrowBalance: BigFixnum.from({
      value: BigNumber.from('0x00'),
      decimals: 6,
    }),
  });
});
