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
import type { RegistryComet } from '../../../../lib/model/comet-registry.js';

import * as mock from '../../../util/mock/mock.js';
import { fixtureCatalog } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * A Comet's reserves are read through its token's balanceOf, so a revert is
 * the state of the token: it is answered instead of failing the summary, and
 * named in the log once a minute. A node that does not answer still fails.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network  = 'ethereum-mainnet' as const;
const nodeHost = 'node.test';
const nodeKey  = 'key';
const block    = 21_000_000;

// the Comets of the fixture's network: each test reports reverts of its own, which the log names once a minute
const cometOf = (key: string) => fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === key)!.comet;
const usdc = cometOf('usdc');
const usdt = cometOf('usdt');
const weth = cometOf('weth');
const wbtc = cometOf('wbtc');

const COMP = '0xc00e94Cb662C3520282E6f5717214004A7f26888' as const;
const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' as const;
const LINK = '0x514910771AF9Ca656af840dff83E8264EcF986CA' as const;
const UNI  = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' as const;

// getReserves()
const GET_RESERVES = '0x0902f1ac';

// getCollateralReserves(asset)
function collateralReservesCall(asset: string): string {
  return `0x9ff567f8${asset.slice(2).toLowerCase().padStart(64, '0')}`;
}

const reverted       = { error: { code: 3, message: 'execution reverted', data: '0x' } };
const revertedBare   = { error: { code: -32000, message: 'execution reverted' } };
const headerNotFound = { error: { code: -32000, message: 'header not found' } };

declare var fetch: mock.Fetch;
t.before(() => {
  global.fetch = mock.fetch({ passthrough: false });
});

function answerWith(contract: RegistryComet, data: string, answer: { result: string } | { error: jsonRpc.Error }) {
  const request: jsonRpc.Request = {
    jsonrpc: '2.0',
    id:      0,
    method:  'eth_call',
    params:  [ { to: contract.address, data }, `0x${block.toString(16)}` ],
  };
  mock.rpc.expectPost(fetch, Eth.nodeEndpoint(nodeHost, nodeKey, network), [
    request,
    { jsonrpc: '2.0', id: 0, ...answer },
  ]);
}

function evaluator() {
  const cache = new MemoryCache({}, [ BigNumber.JsonReviver, BigFixnum.JsonReviver ]);
  return Evaluator.instantiate<comet.Reserves | comet.CollateralReserves>({ ...evm, ...comet }, { cache, debug, flags });
}

function reservesOf(contract: RegistryComet) {
  const { pull1, evaluate } = evaluator();
  return evaluate(pull1({
    reserves: { apiHost: '', nodeHost, nodeKey, network, contract, blockNumber: block },
  }));
}

function collateralReservesOf(contract: RegistryComet, asset: Eth.Address) {
  const { pull1, evaluate } = evaluator();
  return evaluate(pull1({
    collateralReserves: { apiHost: '', nodeHost, nodeKey, network, contract, blockNumber: block, asset },
  }));
}

function captureWarnings(t: { teardown: (fn: () => void) => void }): string[] {
  const logged: string[] = [];
  const consoleWarn = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.join(' ')); };
  t.teardown(() => { console.warn = consoleWarn; });
  return logged;
}

t.test('the base asset\'s reserves are signed', async t => {
  // -5 as an int256
  answerWith(usdc, GET_RESERVES, { result: `0x${'f'.repeat(63)}b` });
  const reserves = await reservesOf(usdc);

  t.ok(BigNumber.isBigNumber(reserves), 'as the Comet answers them');
  t.equal(reserves?.toString(), '-5', 'a market can owe its suppliers more than it holds and has lent');
  fetch.satisfy(t);
});

t.test('a collateral\'s reserves are read for its asset', async t => {
  answerWith(usdc, collateralReservesCall(WBTC), { result: `0x${(1_234_567).toString(16).padStart(64, '0')}` });
  const reserves = await collateralReservesOf(usdc, WBTC);

  t.ok(BigNumber.isBigNumber(reserves), 'as the Comet answers them');
  t.equal(reserves?.toString(), '1234567', 'in the asset\'s own units');
  fetch.satisfy(t);
});

/*
 * A token that reverts is an expected degradation — the summary leaves out
 * the one field it could not read — so it is a warning, which names the
 * Comet, the call and the token, under a prefix of its own.
 */
t.test('a reserve that reverts is an answer, not a failure', async t => {
  const logged = captureWarnings(t);

  answerWith(usdt, GET_RESERVES, reverted);
  answerWith(usdt, collateralReservesCall(COMP), reverted);
  t.equal(await reservesOf(usdt), null, 'the base asset\'s reserves are answered as unread');
  t.equal(await collateralReservesOf(usdt, COMP), null, 'and so are a collateral\'s');
  t.strictSame(logged, [
    `reserves reverted: getReserves() of ${usdt.address} on ${network} at block ${block}: execution reverted`,
    `reserves reverted: getCollateralReserves(${COMP}) of ${usdt.address} on ${network} at block ${block}: execution reverted`,
  ], 'each is logged once, naming the Comet and the token');
  fetch.satisfy(t);
});

/*
 * A call that reverts without data is answered -32000 by the node, with the
 * same message.
 */
t.test('a reserve that reverts without data is answered the same', async t => {
  const logged = captureWarnings(t);

  answerWith(weth, GET_RESERVES, revertedBare);
  answerWith(weth, collateralReservesCall(COMP), revertedBare);
  t.equal(await reservesOf(weth), null, 'the base asset\'s reserves are answered as unread');
  t.equal(await collateralReservesOf(weth, COMP), null, 'and so are a collateral\'s');
  t.equal(logged.length, 2, 'each is logged');
  t.ok(logged.every(line => line.startsWith('reserves reverted: ') && line.includes(weth.address)), 'naming the Comet');
  fetch.satisfy(t);
});

/*
 * A token that reverts does so for every summary that reads it, at every
 * block; a line for each would bury the log. Each read is named once a
 * minute instead, by Comet and call, for as long as it reverts.
 */
t.test('a reserve that keeps reverting is named once a minute, not on every read', async t => {
  const logged = captureWarnings(t);

  answerWith(wbtc, collateralReservesCall(LINK), reverted);
  answerWith(wbtc, collateralReservesCall(LINK), reverted);
  answerWith(wbtc, collateralReservesCall(UNI), reverted);
  answerWith(usdc, collateralReservesCall(LINK), reverted);
  t.equal(await collateralReservesOf(wbtc, LINK), null, 'a read answers the revert');
  t.equal(await collateralReservesOf(wbtc, LINK), null, 'and so does every read after it');
  t.equal(await collateralReservesOf(wbtc, UNI), null, 'as does a read of another token');
  t.equal(await collateralReservesOf(usdc, LINK), null, 'or of the same token by another Comet');
  t.equal(logged.filter(line => line.includes(`(${LINK}) of ${wbtc.address}`)).length, 1, 'and the token is named once');
  t.equal(logged.filter(line => line.includes(`(${UNI}) of ${wbtc.address}`)).length, 1, 'as is another token of the Comet');
  t.equal(logged.filter(line => line.includes(`(${LINK}) of ${usdc.address}`)).length, 1, 'and the same token of another Comet');
  fetch.satisfy(t);
});

t.test('a node that cannot serve the read still fails', async t => {
  answerWith(usdc, GET_RESERVES, headerNotFound);
  answerWith(usdc, collateralReservesCall(COMP), headerNotFound);
  await t.rejects(reservesOf(usdc), /header not found/);
  await t.rejects(collateralReservesOf(usdc, COMP), /header not found/);
  fetch.satisfy(t);
});
