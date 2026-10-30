import t from 'tap';
import { Interface } from '@ethersproject/abi';
import { parseFixed } from '@ethersproject/bignumber';

import * as Eth from '../../../../lib/eth-constants.js';
import * as Flags from '../../../../lib/flags.js';
import * as Fallible from '../../../../lib/fallible/fallible.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';
import * as Evaluator from '../../../../lib/symbolic/evaluator.js';
import { versionedName } from '../../../../lib/symbolic/computation.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';
import * as evm from '../../../../lib/computations/evm.js';
import * as comet from '../../../../lib/computations/comet.js';
import * as mock from '../../../util/mock/mock.js';

import '../../../../shim/node-self.js';

const rateContext: comet.SupplyRatePerSecond['expects'] = {
  apiHost: 'https://api.example.test',
  nodeHost: 'node.example.test',
  nodeKey: 'test',
  network: 'ethereum-mainnet',
  contract: Eth.wellKnownContractsByNetwork['ethereum-mainnet'].Comet.cUSDCv3,
  block: { number: 16_380_543, timestamp: 1_673_432_423 },
};

const fixed18 = (value: string) => parseFixed(value, 18);

const fetch = mock.fetch({ passthrough: false });
t.before(() => {
  const originalFetch = global.fetch;
  global.fetch = fetch;
  t.teardown(() => { global.fetch = originalFetch; });
});

// Zero supply and zero borrow are represented by getUtilization() returning zero.
const cases = [
  {
    action: 'supply',
    description: 'zero utilization (zero supply or zero borrow)',
    utilization: fixed18('0'),
    curve: {
      kink: fixed18('0.8'),
      base: fixed18('0.0000000003'),
      low: fixed18('0.0000000008'),
      high: fixed18('0.0000001'),
    },
    expected: fixed18('0.0000000003'),
  },
  {
    action: 'supply',
    description: '50% utilization',
    utilization: fixed18('0.5'),
    curve: {
      kink: fixed18('0.8'),
      base: fixed18('0.00000000045'),
      low: fixed18('0.00000000065'),
      high: fixed18('0.00000008'),
    },
    expected: fixed18('0.000000000775'),
  },
  {
    action: 'supply',
    description: 'utilization one percentage point below kink',
    utilization: fixed18('0.79'),
    curve: {
      kink: fixed18('0.8'),
      base: fixed18('0.0000000002'),
      low: fixed18('0.00000000095'),
      high: fixed18('0.00000012'),
    },
    expected: fixed18('0.0000000009505'),
  },
  {
    action: 'supply',
    description: 'utilization at kink',
    utilization: fixed18('0.8'),
    curve: {
      kink: fixed18('0.8'),
      base: fixed18('0.00000000065'),
      low: fixed18('0.0000000007'),
      high: fixed18('0.00000009'),
    },
    expected: fixed18('0.00000000121'),
  },
  {
    action: 'supply',
    description: 'utilization one percentage point above kink',
    utilization: fixed18('0.81'),
    curve: {
      kink: fixed18('0.8'),
      base: fixed18('0.00000000035'),
      low: fixed18('0.00000000085'),
      high: fixed18('0.00000011'),
    },
    expected: fixed18('0.00000000213'),
  },
  {
    action: 'supply',
    description: 'utilization ten percentage points above kink',
    utilization: fixed18('0.9'),
    curve: {
      kink: fixed18('0.8'),
      base: fixed18('0.00000000055'),
      low: fixed18('0.0000000006'),
      high: fixed18('0.00000007'),
    },
    expected: fixed18('0.00000000803'),
  },
  {
    action: 'supply',
    description: '100% utilization',
    utilization: fixed18('1'),
    curve: {
      kink: fixed18('0.8'),
      base: fixed18('0.00000000025'),
      low: fixed18('0.00000000105'),
      high: fixed18('0.00000014'),
    },
    expected: fixed18('0.00000002909'),
  },
  {
    action: 'supply',
    description: '120% utilization is not capped',
    utilization: fixed18('1.2'),
    curve: {
      kink: fixed18('0.8'),
      base: fixed18('0.00000000075'),
      low: fixed18('0.00000000075'),
      high: fixed18('0.00000013'),
    },
    expected: fixed18('0.00000005335'),
  },
  {
    action: 'borrow',
    description: 'zero utilization (zero supply or zero borrow)',
    utilization: fixed18('0'),
    curve: {
      kink: fixed18('0.7'),
      base: fixed18('0.0000000005'),
      low: fixed18('0.0000000009'),
      high: fixed18('0.00000015'),
    },
    expected: fixed18('0.0000000005'),
  },
  {
    action: 'borrow',
    description: '50% utilization',
    utilization: fixed18('0.5'),
    curve: {
      kink: fixed18('0.7'),
      base: fixed18('0.0000000004'),
      low: fixed18('0.0000000011'),
      high: fixed18('0.00000016'),
    },
    expected: fixed18('0.00000000095'),
  },
  {
    action: 'borrow',
    description: 'utilization one percentage point below kink',
    utilization: fixed18('0.69'),
    curve: {
      kink: fixed18('0.7'),
      base: fixed18('0.0000000006'),
      low: fixed18('0.00000000068'),
      high: fixed18('0.000000085'),
    },
    expected: fixed18('0.0000000010692'),
  },
  {
    action: 'borrow',
    description: 'utilization at kink',
    utilization: fixed18('0.7'),
    curve: {
      kink: fixed18('0.7'),
      base: fixed18('0.00000000028'),
      low: fixed18('0.00000000098'),
      high: fixed18('0.000000095'),
    },
    expected: fixed18('0.000000000966'),
  },
  {
    action: 'borrow',
    description: 'utilization one percentage point above kink',
    utilization: fixed18('0.71'),
    curve: {
      kink: fixed18('0.7'),
      base: fixed18('0.00000000048'),
      low: fixed18('0.00000000078'),
      high: fixed18('0.000000105'),
    },
    expected: fixed18('0.000000002076'),
  },
  {
    action: 'borrow',
    description: 'utilization ten percentage points above kink',
    utilization: fixed18('0.8'),
    curve: {
      kink: fixed18('0.7'),
      base: fixed18('0.00000000038'),
      low: fixed18('0.00000000088'),
      high: fixed18('0.000000115'),
    },
    expected: fixed18('0.000000012496'),
  },
  {
    action: 'borrow',
    description: '100% utilization',
    utilization: fixed18('1'),
    curve: {
      kink: fixed18('0.7'),
      base: fixed18('0.00000000058'),
      low: fixed18('0.00000000118'),
      high: fixed18('0.000000125'),
    },
    expected: fixed18('0.000000038906'),
  },
  {
    action: 'borrow',
    description: '120% utilization is not capped',
    utilization: fixed18('1.2'),
    curve: {
      kink: fixed18('0.7'),
      base: fixed18('0.00000000068'),
      low: fixed18('0.00000000108'),
      high: fixed18('0.000000135'),
    },
    expected: fixed18('0.000000068936'),
  },
] as const;

for (const { action, description, utilization, curve, expected } of cases) {
  t.test(`${action}RatePerSecond: ${description}`, async t => {
    const computation = action === 'supply'
      ? comet.supplyRatePerSecond
      : comet.borrowRatePerSecond;
    
    const context = Fallible.must(computation.index.project(rateContext));

    const getters = [
      ['getUtilization', utilization],
      [`${action}Kink`, curve.kink],
      [`${action}PerSecondInterestRateBase`, curve.base],
      [`${action}PerSecondInterestRateSlopeLow`, curve.low],
      [`${action}PerSecondInterestRateSlopeHigh`, curve.high],
    ] as const;

    for (const [name, value] of getters) {
      const abi = new Interface([`function ${name}() returns (uint256)`]);
      mock.rpc.expectPost(fetch,
        Eth.nodeEndpoint(context.nodeHost, context.nodeKey, context.network),
        [
          {
            jsonrpc: '2.0', id: 0, method: 'eth_call',
            params: [
              { to: context.contract.address, data: abi.encodeFunctionData(name) },
              `0x${context.block.number.toString(16)}`,
            ],
          },
          { jsonrpc: '2.0', id: 0, result: abi.encodeFunctionResult(name, [value]) },
        ]
      );
    }

    const cache = new MemoryCache({}, [BigNumber.JsonReviver, BigFixnum.JsonReviver]);
    
    const { pull1, evaluate } = Evaluator.instantiate<
      comet.SupplyRatePerSecond | comet.BorrowRatePerSecond
    >({ ...evm, ...comet }, { cache, flags: Flags.defaults({}) });
    
    const lookup = action === 'supply'
      ? { supplyRatePerSecond: context }
      : { borrowRatePerSecond: context };

    const result = await evaluate(pull1(lookup));
    
    t.type(result, BigFixnum);
    
    t.equal(result.value.toString(), expected.toString(), 'exact rate matches expected');
    
    fetch.satisfy(t);

    const key = await computation.key(
      versionedName(`${action}RatePerSecond`, computation.version),
      context,
    );

    t.ok(Object.hasOwn(cache.store, key), 'rate is cached');

    fetch.satisfy(t);
  });
}
