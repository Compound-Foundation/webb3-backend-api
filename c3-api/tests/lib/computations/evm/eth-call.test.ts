import t from 'tap';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as evm   from '../../../../lib/computations/evm.js';
import * as comet from '../../../../lib/computations/comet.js';

import { getCoder } from '../../../../lib/computations/abi-function.js';

import * as jsonRpc from '../../../../lib/json-rpc.js';

import * as mock from '../../../util/mock/mock.js';
import { fixtureComet } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * What an eth_call the node answered with an error turns into. A revert is
 * the contract's answer, which ethCall hands to the function that made the
 * call; anything else is a failure of the node, which still fails.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network  = 'ethereum-mainnet' as const;
const nodeHost = 'node.test';
const nodeKey  = 'key';
const contract = fixtureComet(network, '0xc3d688b66703497daa19211eedff47f25384cdc3');
const block    = 21_000_000;
// getPrice(0xe3a409ed15cd53afdefdd191ad945cec528a2496), a retired wUSDM / USD feed
const data     = '0x41976e09000000000000000000000000e3a409ed15cd53afdefdd191ad945cec528a2496';

declare var fetch: mock.Fetch;
t.before(() => {
  global.fetch = mock.fetch({ passthrough: false });
});

function answerWith(error: jsonRpc.Error, callData = data) {
  const request: jsonRpc.Request = {
    jsonrpc: '2.0',
    id:      0,
    method:  'eth_call',
    params:  [ { to: contract.address, data: callData }, `0x${block.toString(16)}` ],
  };
  mock.rpc.expectPost(fetch, Eth.nodeEndpoint(nodeHost, nodeKey, network), [
    request,
    { jsonrpc: '2.0', id: 0, error },
  ]);
}

function evaluator() {
  const cache = new MemoryCache({}, [ BigNumber.JsonReviver, BigFixnum.JsonReviver ]);
  return Evaluator.instantiate<evm.EthCall | comet.NumAssets>({ ...evm, ...comet }, { cache, debug, flags });
}

function call() {
  const { pull1, evaluate } = evaluator();
  return evaluate(pull1({
    ethCall: { apiHost: '', nodeHost, nodeKey, network, contract, blockNumber: block, data },
  }));
}

t.test('a revert with data is answered, not thrown', async t => {
  answerWith({ code: 3, message: 'execution reverted', data: '0x' });
  t.strictSame(await call(), { reverted: { code: 3, message: 'execution reverted' } });
  fetch.satisfy(t);
});

t.test('a revert without data is answered too', async t => {
  answerWith({ code: -32000, message: 'execution reverted' });
  t.strictSame(await call(), { reverted: { code: -32000, message: 'execution reverted' } });
  fetch.satisfy(t);
});

t.test('a node that cannot serve the call still fails', async t => {
  answerWith({ code: -32000, message: 'header not found' });
  const failure = await call().then(() => null, (error: unknown) => error);
  t.match((failure as Error | null)?.message, /header not found/, 'a failure of the node says nothing about the contract');
  t.ok(jsonRpc.isNotServed(failure), 'so it is a call the node did not serve');
  fetch.satisfy(t);
});

t.test('a function that does not answer reverts still fails on one', async t => {
  const numAssets = getCoder('function numAssets() view returns (uint8)').encode([]);
  answerWith({ code: 3, message: 'execution reverted', data: '0x' }, numAssets);
  const { pull1, evaluate } = evaluator();
  const failure = await evaluate(pull1({ numAssets: { apiHost: '', nodeHost, nodeKey, network, contract, blockNumber: block } }))
    .then(() => null, (error: unknown) => error);
  t.match((failure as Error | null)?.message, /^ethCall: call error: .*execution reverted/,
    'as every function did before a revert could be answered');
  t.notOk(jsonRpc.isNotServed(failure), 'and the contract answered it, so the node served the call');
  fetch.satisfy(t);
});
