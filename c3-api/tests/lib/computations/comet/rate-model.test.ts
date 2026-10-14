import t from 'tap';

import { id } from '@ethersproject/hash';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Compute    from '../../../../lib/symbolic/computation.js';
import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as evm   from '../../../../lib/computations/evm.js';
import * as comet from '../../../../lib/computations/comet.js';

import type * as jsonRpc from '../../../../lib/json-rpc.js';

import * as mock from '../../../util/mock/mock.js';
import { fixtureComet } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * A Comet's interest rate model is eight getters, and each is read into its
 * own place of the curve it describes.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network  = 'ethereum-mainnet' as const;
const nodeHost = 'node.test';
const nodeKey  = 'key';
const contract = fixtureComet(network, '0xc3d688b66703497daa19211eedff47f25384cdc3');
const block    = 21_000_000;

// what each getter answers, each its own, so that one read into another's place shows
const ANSWERS = {
  supplyKink:                           '850000000000000000',
  supplyPerSecondInterestRateBase:      '1',
  supplyPerSecondInterestRateSlopeLow:  '1141552511',
  supplyPerSecondInterestRateSlopeHigh: '101344495180',
  borrowKink:                           '900000000000000000',
  borrowPerSecondInterestRateBase:      '475646879',
  borrowPerSecondInterestRateSlopeLow:  '880834601',
  borrowPerSecondInterestRateSlopeHigh: '114155251141',
};

const MODEL = {
  supply: {
    kink:      ANSWERS.supplyKink,
    base:      ANSWERS.supplyPerSecondInterestRateBase,
    slopeLow:  ANSWERS.supplyPerSecondInterestRateSlopeLow,
    slopeHigh: ANSWERS.supplyPerSecondInterestRateSlopeHigh,
  },
  borrow: {
    kink:      ANSWERS.borrowKink,
    base:      ANSWERS.borrowPerSecondInterestRateBase,
    slopeLow:  ANSWERS.borrowPerSecondInterestRateSlopeLow,
    slopeHigh: ANSWERS.borrowPerSecondInterestRateSlopeHigh,
  },
};

declare var fetch: mock.Fetch;
t.before(() => {
  global.fetch = mock.fetch({ passthrough: false });
});

function stub(answer: (context: any) => unknown) {
  return Compute.Functor<any>({}).implement({ version: 0, compute: context => answer(context) });
}

function modelOf(computations: Record<string, unknown>) {
  const cache = new MemoryCache({}, [ BigNumber.JsonReviver, BigFixnum.JsonReviver ]);
  const { pull1, evaluate } = Evaluator.instantiate<comet.RateModel>(computations as any, { cache, debug, flags });
  return evaluate(pull1({
    rateModel: { apiHost: '', nodeHost, nodeKey, network, contract, blockNumber: block },
  }));
}

// the model with each value written out; one that is not a BigNumber is left as it is, and matches nothing
function written(model: comet.RateModel['returns']) {
  const curve = (rates: comet.RateCurve) => Object.fromEntries(
    Object.entries(rates).map(([ name, rate ]) => [ name, BigNumber.isBigNumber(rate) ? rate.toString() : rate ]),
  );
  return { supply: curve(model.supply), borrow: curve(model.borrow) };
}

t.test('each getter is read into its own place of the model', async t => {
  const blocks: number[] = [];
  const model = await modelOf({
    rateModel: comet.rateModel,
    ...Object.fromEntries(Object.entries(ANSWERS).map(([ getter, answer ]) => [
      getter,
      stub(({ blockNumber }) => { blocks.push(blockNumber); return BigNumber.from(answer); }),
    ])),
  });

  t.strictSame(written(model), MODEL, 'the supply curve from the supply getters, the borrow curve from the borrow getters');
  t.strictSame(blocks, Array(8).fill(block), 'each read once, at the block of the model');
});

function answerWith(getter: string, answer: string) {
  const request: jsonRpc.Request = {
    jsonrpc: '2.0',
    id:      0,
    method:  'eth_call',
    // the selector of the getter of that name, which takes no arguments
    params:  [ { to: contract.address, data: id(`${getter}()`).slice(0, 10) }, `0x${block.toString(16)}` ],
  };
  mock.rpc.expectPost(fetch, Eth.nodeEndpoint(nodeHost, nodeKey, network), [
    request,
    { jsonrpc: '2.0', id: 0, result: `0x${BigInt(answer).toString(16).padStart(64, '0')}` },
  ]);
}

t.test('each read calls the Comet getter of its name', async t => {
  for (const [ getter, answer ] of Object.entries(ANSWERS)) {
    answerWith(getter, answer);
  }

  t.strictSame(written(await modelOf({ ...evm, ...comet })), MODEL, 'each from the call its own selector makes');
  fetch.satisfy(t);
});
