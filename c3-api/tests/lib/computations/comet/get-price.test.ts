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

import type * as jsonRpc from '../../../../lib/json-rpc.js';

import * as mock from '../../../util/mock/mock.js';
import { fixtureComet } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * A price read answers a feed that reverts instead of failing, and still
 * fails when the node does not answer. It is made through ethCall, so the
 * cache seeds and index bias every other call uses apply to it too.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network   = 'ethereum-mainnet' as const;
const nodeHost  = 'node.test';
const nodeKey   = 'key';
const contract  = fixtureComet(network, '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840');
const block     = 21_000_000;
const priceFeed = { address: '0xe3a409ed15cd53afdefdd191ad945cec528a2496' as const, decimals: 8 };

type Feed = { address: `0x${string}`, decimals: number };

// getPrice(feed)
function dataOf(feed: Feed): string {
  return `0x41976e09${feed.address.slice(2).padStart(64, '0')}`;
}

declare var fetch: mock.Fetch;
t.before(() => {
  global.fetch = mock.fetch({ passthrough: false });
});

function answerWith(answer: { result: string } | { error: jsonRpc.Error }, feed: Feed = priceFeed) {
  const request: jsonRpc.Request = {
    jsonrpc: '2.0',
    id:      0,
    method:  'eth_call',
    params:  [ { to: contract.address, data: dataOf(feed) }, `0x${block.toString(16)}` ],
  };
  mock.rpc.expectPost(fetch, Eth.nodeEndpoint(nodeHost, nodeKey, network), [
    request,
    { jsonrpc: '2.0', id: 0, ...answer },
  ]);
}

function read(feed: Feed = priceFeed, options: { unreported?: true } = {}) {
  const cache = new MemoryCache({}, [ BigNumber.JsonReviver, BigFixnum.JsonReviver ]);
  const { pull1, evaluate } = Evaluator.instantiate<comet.GetPrice>({ ...evm, ...comet }, { cache, debug, flags });
  return evaluate(pull1({
    getPrice: { apiHost: '', nodeHost, nodeKey, network, contract, blockNumber: block, priceFeed: feed, ...options },
  }));
}

function captureWarnings(t: { teardown: (fn: () => void) => void }): string[] {
  const logged: string[] = [];
  const consoleWarn = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.join(' ')); };
  t.teardown(() => { console.warn = consoleWarn; });
  return logged;
}

t.test('a feed that answers is a price', async t => {
  answerWith({ result: `0x${(100_020_000).toString(16).padStart(64, '0')}` });
  const price = await read();

  t.equal(price.status, 'success');
  t.equal(price.status === 'success' && price.price.toString(), '1.0002');
  fetch.satisfy(t);
});

/*
 * A feed that reverts is an expected degradation — the summary reports the
 * price it could not read — so it is a warning, which still names the feed
 * an operator has to price. The line starts with what the runbook alerts on;
 * the rest of its wording is free to change.
 */
t.test('a feed that reverts is an answer, not a failure', async t => {
  const logged = captureWarnings(t);

  answerWith({ error: { code: 3, message: 'execution reverted', data: '0x' } });
  t.strictSame(await read(), { status: 'error', message: 'execution reverted' });
  t.equal(logged.length, 1, 'it is logged once');
  t.match(logged[0], /^price feed reverted: /, 'under the prefix the runbook alerts on');
  t.match(logged[0], priceFeed.address, 'naming the feed');
  fetch.satisfy(t);
});

/*
 * A retired feed is read by every market that prices with it, at every block
 * a summary reads; a line for each would bury the log. It is named once a
 * minute instead, for as long as it reverts.
 */
t.test('a feed that keeps reverting is named once a minute, not on every read', async t => {
  const logged = captureWarnings(t);
  const feed   = { address: '0x00000000000000000000000000000000000000f2' as const, decimals: 8 };

  answerWith({ error: { code: 3, message: 'execution reverted', data: '0x' } }, feed);
  answerWith({ error: { code: 3, message: 'execution reverted', data: '0x' } }, feed);
  t.equal((await read(feed)).status, 'error');
  t.equal((await read(feed)).status, 'error', 'every read answers the revert');
  t.equal(logged.filter(line => line.includes(feed.address)).length, 1, 'and the feed is named once');
  fetch.satisfy(t);
});

/*
 * A read whose caller answers the revert another way reports nothing itself:
 * a remap reads its replacement so, which at a block before it was deployed
 * is no contract yet. A Comet's read of such an address reverts with no data,
 * which the node answers -32000.
 */
t.test('a read whose caller answers its revert reports nothing', async t => {
  const logged = captureWarnings(t);
  const feed   = { address: '0x00000000000000000000000000000000000000f3' as const, decimals: 8 };

  answerWith({ error: { code: -32000, message: 'execution reverted' } }, feed);
  t.strictSame(await read(feed, { unreported: true }), { status: 'error', message: 'execution reverted' });
  t.strictSame(logged, [], 'and logs nothing');
  fetch.satisfy(t);
});

t.test('a node that cannot serve the read still fails', async t => {
  answerWith({ error: { code: -32000, message: 'header not found' } });
  await t.rejects(read(), /header not found/);
  fetch.satisfy(t);
});
