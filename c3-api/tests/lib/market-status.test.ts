import t, { Test } from 'tap';

import * as Flags from '../../lib/flags.js';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import * as rewards from '../../lib/computations/rewards.js';

import * as marketHandlers from '../../src/market.js';
import { rewardsSummary as accountRewardsSummary } from '../../src/account-handlers/rewards.js';
import {
  AllContracts,
  AllNetworks,
  type AccountRouteData,
  type Context,
  type MarketContext,
  type MarketRouteData,
} from '../../src/router.js';

import { consoleLines } from '../util/console.js';
import { evaluatorOver, stub } from '../util/evaluator.js';
import { fixtureCatalog, loadRegistrySnapshotFixture } from '../util/registry-fixture.js';
import { REGISTRY_KEYS } from '../util/summary-registry-fields.js';
import { summaryDecisionsOf } from '../util/summary-decisions.js';

import '../../shim/node-self.js';

/*
 * The routes answer every market with the status its computation reports —
 * a Comet reading a price feed Chainlink retired is `error` and only what
 * identifies it — and a node that fails still fails the request.
 */
const flags = Flags.parseWithDefaults(process.env);

const catalog = fixtureCatalog();

const MAINNET = 'ethereum-mainnet' as const;
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WBTC    = '0xe85dc543813b8c2cfeaac371517b925a166a9293';
const AERO    = '0x784efeb622244d2348d4f2522f8860b96fbece89';
const WETH    = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
const ACCOUNT = '0x1111111111111111111111111111111111111111';

const LATEST = { number: 50_000_000, timestamp: 1_790_000_000 };

function comet(network: KnownNetwork.Name, address: string) {
  return catalog.marketsOn(network).find(entry => entry.comet.address.toLowerCase() === address)!.comet;
}

/*
 * The evaluator the router hands a handler, over computations that answer
 * from `answer` instead of a node: the real one, so what a route answers is
 * what the evaluator makes of what each computation answered, or threw. A
 * lookup of a computation not named here fails, as one a handler's scope
 * lacks would.
 */
type Answer = (name: string, context: any) => unknown;

const COMPUTATIONS = [
  'ethGetBlock', 'marketMinutelySummary', 'historicalMarketDaySummaries', 'marketRewards',
  'getRewardConfigsSleuth', 'accountRewards', 'rewardsSummary',
] as const;

function evaluatorOf(answer: Answer, overrides: Flags.SomeFlags = {}) {
  const computations = Object.fromEntries(COMPUTATIONS.map(name => [ name, stub(context => answer(name, context)) ]));
  // on what the handler asks for, and otherwise on what the environment sets
  const evaluator = Object.assign(
    evaluatorOver(computations, {
      algorithm: overrides.evaluatorAlgorithm ?? flags.evaluatorAlgorithm,
      batching:  overrides.batchingEnabled ?? flags.batchingEnabled,
    }),
    { evaluations: 0 },
  );
  // a handler takes evaluate off the evaluator, so the count is put where it reads it
  const evaluate = evaluator.evaluate;
  evaluator.evaluate = (redex => { evaluator.evaluations++; return evaluate(redex); }) as typeof evaluate;
  return evaluator;
}

/*
 * The answers of a network where the price feeds of `reverting` Comets
 * revert, as their computations report it.
 */
function answers(reverting: string[]) {
  return (name: string, context: any) => {
    if (name === 'ethGetBlock') {
      return LATEST;
    }
    // each rewards contract pays the token the version describes for its market
    if (name === 'getRewardConfigsSleuth') {
      return context.cometMarkets.map((market: any) => ({ rewardConfig: { rewardToken: market.rewards.asset.address } }));
    }
    const comet = { address: context.contract.address };
    if (reverting.includes(comet.address.toLowerCase())) {
      const error = { chainId: 1, comet, status: 'error', message: 'execution reverted' };
      return name === 'historicalMarketDaySummaries' ? [ { ...error, timestamp: LATEST.timestamp } ] : error;
    }
    switch (name) {
      case 'marketMinutelySummary':
        return { chainId: 1, comet, status: comet.address.toLowerCase() === WETH ? 'partially' : 'success' };
      case 'historicalMarketDaySummaries':
        return [ { chainId: 1, comet, status: 'success', timestamp: LATEST.timestamp } ];
      case 'accountRewards':
        return { status: 'success', chainId: 1, comet, amountOwed: 1, walletBalance: 0, supplyBalance: 0, borrowBalance: 0 };
      default:
        return { status: 'success', chainId: 1, comet };
    }
  };
}

function routeData(network: MarketRouteData['network'], contract: MarketRouteData['contract']): MarketRouteData {
  return { apiHost: '', nodeHost: '', nodeKey: '', network, contract, catalog, queryParams: new URLSearchParams() };
}

// as the router hands a market handler the evaluator it made, with the route's flags
function uninstantiated(answer: Answer) {
  const evaluator = evaluatorOf(answer, Flags.ROUTE_EVALUATOR_FLAGS);
  const context = {
    // a local run, whose history samples one day
    flags: { ...flags, environment: 'local' },
    evaluator,
    decisions: summaryDecisionsOf(),
    evaluations: () => evaluator.evaluations,
  };
  return context as unknown as MarketContext & { evaluations(): number };
}

// as the router hands a handler an evaluator it made: with the request's flags, and those it sets for the route
function instantiated(answer: Answer, overrides: Flags.SomeFlags): Context {
  return { flags: { ...flags, environment: 'local' }, evaluator: evaluatorOf(answer, overrides) } as unknown as Context;
}

type Entry = { chain_id: number, comet: { address: string }, status: string, message?: string };

function statuses(body: unknown): Record<string, string> {
  return Object.fromEntries((body as Entry[]).map(entry => [ entry.comet.address.toLowerCase(), entry.status ]));
}

function errorOf(address: string) {
  return {
    chain_id: 1,
    comet:    { address: comet(MAINNET, address).address },
    status:   'error',
    message:  'execution reverted',
  };
}

function wbtcSummaryError() {
  return {
    chain_id: 1,
    comet: {
      address: '0xe85Dc543813B8c2CFEaAc371517b925a166a9293',
      rewards: '0x1B0e765F6224C21223AeA2af16c1C46E38885a40',
      bulker:  '0xa397a8C2086C554B531c02E29f3291c9704B00c7',
    },
    deployment_key:    'wbtc',
    display_name:      'WBTC',
    base_asset_name:   'Wrapped BTC',
    is_wrapped_native: false,
    is_default:        false,
    is_institutional:  false,
    status:            'error',
    message:           'execution reverted',
  };
}

t.test('the summary of every market passes on the status of each', async t => {
  const response = await marketHandlers.latestSummary(
    routeData(AllNetworks, AllContracts),
    uninstantiated(answers([ WBTC ])),
  );

  t.equal(response.status, 200);
  const body = await response.json() as Entry[];
  t.equal(body.length, catalog.markets().length, 'no market is left out');
  t.strictSame(body.find(entry => entry.comet.address.toLowerCase() === WBTC), wbtcSummaryError());
  t.equal(statuses(body)[WETH], 'partially');
  t.equal(statuses(body)[USDC], 'success');
});

t.test('the summary of one market is its status', async t => {
  const response = await marketHandlers.latestSummary(
    routeData(MAINNET, comet(MAINNET, WBTC)),
    uninstantiated(answers([ WBTC ])),
  );
  t.equal(response.status, 200);
  t.strictSame(await response.json(), [ wbtcSummaryError() ], 'answered as a list of one, as every form of the summary is');
});

/*
 * The summary of a network or of every network is a list however many
 * markets it holds: the active version decides how many there are, so one
 * that leaves a single market changes its length, and nothing else.
 */
t.test('the summary answers a list in every form, of one market or of none', async t => {
  const summaryOf = async (data: MarketRouteData) => (await marketHandlers.latestSummary(data, uninstantiated(answers([])))).json();
  const cometsOf  = (body: unknown) => Array.isArray(body) ? body.map((entry: Entry) => entry.comet.address.toLowerCase()) : body;

  t.strictSame(cometsOf(await summaryOf(routeData('base-mainnet', AllContracts))), [ AERO ], 'Base, where the version serves one market: a list of it');
  t.strictSame(await summaryOf(routeData('arbitrum-mainnet', AllContracts)), [], 'Arbitrum, where it serves none: an empty list');

  // a version that serves mainnet's USDC market alone
  const fixture = loadRegistrySnapshotFixture();
  const alone   = fixtureCatalog({
    ...fixture,
    networks: fixture.networks.map(network => ({
      ...network,
      markets: network.markets.map(market => market.contracts.comet === USDC ? market : { ...market, status: 'disabled' as const }),
    })),
  });
  for (const network of [ MAINNET, AllNetworks ] as const) {
    t.strictSame(cometsOf(await summaryOf({ ...routeData(network, AllContracts), catalog: alone })), [ USDC ],
      `${network}, under a version that serves one market: a list of it`);
  }
});

t.test('history passes on the status of each day', async t => {
  const response = await marketHandlers.historicalSummary(
    routeData(MAINNET, AllContracts),
    uninstantiated(answers([ WBTC ])),
  );
  t.equal(response.status, 200);
  const body = await response.json() as Array<Entry & { timestamp: number }>;
  t.match(body.find(entry => entry.comet.address.toLowerCase() === WBTC), { ...errorOf(WBTC), timestamp: LATEST.timestamp });
  t.equal(statuses(body)[USDC], 'success');
});

t.test('the rewards of every market pass on the status of each', async t => {
  const context  = uninstantiated(answers([ WBTC ]));
  const response = await marketHandlers.rewardsDappData(routeData(MAINNET, AllContracts), context);

  t.equal(response.status, 200);
  const body = await response.json() as Entry[];
  t.strictSame(body.find(entry => entry.comet.address.toLowerCase() === WBTC), errorOf(WBTC));
  t.equal(statuses(body)[USDC], 'success');
  t.equal(context.evaluations(), 1, 'the markets of a network still share one evaluation');
});

/*
 * The rewards summary of a market values its rewards at the feed the version
 * states for the token it pays, as the rewards of every market do, and is
 * kept under that feed as the version states it: its address as the registry
 * stores it, and its scale.
 */
t.test('the rewards summary reads the reward feed its version states', async t => {
  const usdc  = comet(MAINNET, USDC);
  const feed  = usdc.registry.market.rewardAsset!.priceFeed!;
  const asked: any[] = [];
  const answer: Answer = (name, context) => {
    if (name === 'rewardsSummary') {
      asked.push(context);
    }
    return answers([])(name, context);
  };
  const response = await marketHandlers.latestRewardsSummary(routeData(MAINNET, usdc), uninstantiated(answer));

  t.equal(response.status, 200);
  t.equal(asked.length, 1, 'one summary is asked for');
  t.equal(asked[0].rewardsTokenPriceFeed, feed, 'of the feed the version states');
  t.equal(
    await rewards.rewardsSummary.key('rewardsSummary-v5', asked[0]),
    `rewardsSummary-v5:(block:${asked[0].block.number};contract:${usdc.key()};network:${MAINNET};`
      + `rewardsTokenPriceFeed:(address:${feed.address};decimals:${feed.decimals}))`,
    'and kept under that feed',
  );
});

t.test('the rewards of an account format only the markets that were valued', async t => {
  const response = await accountRewardsSummary(
    { apiHost: '', nodeHost: '', nodeKey: '', account: ACCOUNT, catalog },
    instantiated(answers([ WBTC ]), Flags.ROUTE_EVALUATOR_FLAGS),
  );

  t.equal(response.status, 200);
  const body = await response.json() as Array<Entry & { amount_owed?: string }>;
  t.strictSame(body.find(entry => entry.comet.address.toLowerCase() === WBTC), errorOf(WBTC));
  t.match(body.find(entry => entry.comet.address.toLowerCase() === AERO), { status: 'success', amount_owed: '1' });
  t.equal(body.length, 5, 'every market with claimable rewards is answered');
});

t.test('a node that fails still fails the list', async t => {
  await t.rejects(
    marketHandlers.latestSummary(routeData(MAINNET, AllContracts), uninstantiated(() => { throw new Error('bad vibes'); })),
    /bad vibes/,
  );
});

/*
 * The read that fails can be one market's, after the block every market
 * shares was read: every route that lists markets fails then too, rather
 * than answer the list without that market.
 */
t.test('a node that fails one market still fails the list', async t => {
  const failing: Answer = (name, context) => {
    if (context.contract?.address.toLowerCase() === USDC) {
      throw new Error('the node did not serve usdc');
    }
    return answers([])(name, context);
  };
  const account: AccountRouteData = { apiHost: '', nodeHost: '', nodeKey: '', account: ACCOUNT, catalog };

  for (const [ what, answered ] of [
    [ 'the summary of a network',     () => marketHandlers.latestSummary(routeData(MAINNET, AllContracts), uninstantiated(failing)) ],
    [ 'the summary of every network', () => marketHandlers.latestSummary(routeData(AllNetworks, AllContracts), uninstantiated(failing)) ],
    [ 'the rewards of a network',     () => marketHandlers.rewardsDappData(routeData(MAINNET, AllContracts), uninstantiated(failing)) ],
    [ 'the history of a network',     () => marketHandlers.historicalSummary(routeData(MAINNET, AllContracts), uninstantiated(failing)) ],
    [ 'the rewards of an account',    () => accountRewardsSummary(account, instantiated(failing, Flags.ROUTE_EVALUATOR_FLAGS)) ],
  ] as const) {
    await t.rejects(answered(), /the node did not serve usdc/, what);
  }
});

const USDT = '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840';

function createdAt(block: number, comets: string[]) {
  const fixture = loadRegistrySnapshotFixture();
  return fixtureCatalog({
    ...fixture,
    networks: fixture.networks.map(network => ({
      ...network,
      markets: network.markets.map(market => (
        comets.includes(market.contracts.comet!) ? { ...market, creationBlock: block } : market
      )),
    })),
  });
}

// the warning a market the chain has not reached is logged with, kept out of the test's output
function quiet(t: Test): void {
  consoleLines(t, [ 'warn' ]);
}

/*
 * A market whose creation block is past the latest block has no point in the
 * index of an account's rewards: it is answered as an error naming the block,
 * and the other markets of its rewards contract are read. Base's AERO market
 * is alone under its rewards contract here, and the index the contract's
 * reward configurations are read on starts at its earliest market, so those
 * are not read at all.
 */
t.test('the rewards of an account answer a market the chain has not reached as an error', async t => {
  quiet(t);
  const created = LATEST.number + 1;
  const read: string[] = [];
  const answer: Answer = (name, context) => {
    if (name === 'getRewardConfigsSleuth') {
      read.push(context.network);
    }
    return answers([])(name, context);
  };

  const response = await accountRewardsSummary(
    { apiHost: '', nodeHost: '', nodeKey: '', account: ACCOUNT, catalog: createdAt(created, [ USDT, AERO ]) },
    instantiated(answer, Flags.ROUTE_EVALUATOR_FLAGS),
  );

  t.equal(response.status, 200);
  const body    = await response.json() as Array<Entry & { amount_owed?: string }>;
  const message = `creationBlock ${created} is past the latest block, ${LATEST.number}`;
  const entryOf = (address: string) => body.find(entry => entry.comet.address.toLowerCase() === address);
  t.strictSame(entryOf(USDT), { chain_id: 1, comet: { address: comet(MAINNET, USDT).address }, status: 'error', message },
    'a market beside others under its rewards contract is an error naming its block');
  t.strictSame(entryOf(AERO), { chain_id: 8453, comet: { address: comet('base-mainnet', AERO).address }, status: 'error', message },
    'and so is one alone under its own');
  t.match(entryOf(USDC), { status: 'success', amount_owed: '1' }, 'while the others are read');
  t.equal(body.length, 5, 'every market with claimable rewards is answered');
  t.same(read, [ MAINNET ], 'and reward configurations are read only where the chain has reached a market');
});

/*
 * What the rewards contract pays is read for all its markets at once, and
 * decides nothing for one the chain has not reached: that one is an error
 * though the contract pays it nothing, as it is where no market of the
 * contract is reached and nothing is read. One the chain has reached that the
 * contract pays nothing is left out, as it always was.
 */
t.test('the rewards of an account answer a market the chain has not reached as an error whatever its contract pays', async t => {
  quiet(t);
  const created = LATEST.number + 1;
  const nothing = { rewardConfig: { rewardToken: '0x0000000000000000000000000000000000000000' } };
  const answer: Answer = (name, context) => {
    const answered = answers([])(name, context);
    return name !== 'getRewardConfigsSleuth' ? answered : (answered as unknown[]).map((config, index) => (
      [ USDT, WBTC ].includes(context.cometMarkets[index].address.toLowerCase()) ? nothing : config
    ));
  };

  const response = await accountRewardsSummary(
    { apiHost: '', nodeHost: '', nodeKey: '', account: ACCOUNT, catalog: createdAt(created, [ USDT ]) },
    instantiated(answer, Flags.ROUTE_EVALUATOR_FLAGS),
  );

  t.equal(response.status, 200);
  const body    = await response.json() as Entry[];
  const entryOf = (address: string) => body.find(entry => entry.comet.address.toLowerCase() === address);
  t.strictSame(entryOf(USDT), {
    chain_id: 1,
    comet:    { address: comet(MAINNET, USDT).address },
    status:   'error',
    message:  `creationBlock ${created} is past the latest block, ${LATEST.number}`,
  }, 'a market the chain has not reached is an error though its rewards contract pays it nothing');
  t.equal(entryOf(WBTC), undefined, 'while one it has reached is left out');
});

/*
 * Only the summary answers what the registry version says of a market in
 * its Comet and beside it: the rewards contract and the bulker beside its
 * Comet, then its keys and labels, of every market, an error too. The
 * history, the rewards of every market, the rewards summary of one and the
 * rewards of an account answer as they did: the Comet alone, and none of
 * those fields.
 */
t.test('only the summary answers what the version says of a market in its Comet and beside it', async t => {
  const answer  = answers([ WBTC ]);
  const account: AccountRouteData = { apiHost: '', nodeHost: '', nodeKey: '', account: ACCOUNT, catalog };
  // what an answer says of a market that its version says: the keys of its Comet, and the fields of the version it has
  const described = (entry: Record<string, any>) => [
    Object.keys(entry.comet ?? {}),
    Object.keys(entry).filter(key => (REGISTRY_KEYS as readonly string[]).includes(key)),
  ];
  const ALONE = [ [ 'address' ], [] ];

  const summary = await (await marketHandlers.latestSummary(routeData(AllNetworks, AllContracts), uninstantiated(answer))).json() as Entry[];
  const SUMMARY = [
    [ 'address', 'rewards', 'bulker' ],
    [ 'deployment_key', 'display_name', 'base_asset_name', 'is_wrapped_native', 'is_default', 'is_institutional' ],
  ];
  t.ok(summary.length > 0, 'the summary answers markets');
  t.strictSame(summary.map(described), summary.map(() => SUMMARY), 'the summary: the Comet, its rewards contract and its bulker, and the keys and labels of the version, of every market');
  t.equal(statuses(summary)[WBTC], 'error', 'WBTC\'s among them, which is an error');

  const days = await (await marketHandlers.historicalSummary(routeData(AllNetworks, AllContracts), uninstantiated(answer))).json() as Entry[];
  t.ok(days.length > 0, 'the history answers days');
  t.strictSame(days.map(described), days.map(() => ALONE), 'the history: the Comet alone, on every day');
  const markets = await (await marketHandlers.rewardsDappData(routeData(AllNetworks, AllContracts), uninstantiated(answer))).json() as Entry[];
  t.ok(markets.length > 0, 'the rewards of every market are answered');
  t.strictSame(markets.map(described), markets.map(() => ALONE), 'the rewards of every market: the Comet alone');
  const one = await (await marketHandlers.latestRewardsSummary(routeData(MAINNET, comet(MAINNET, USDC)), uninstantiated(answer))).json() as Entry;
  t.strictSame(described(one)[1], [], 'the rewards summary of one market: none of the fields of the version');
  const owed = await (await accountRewardsSummary(account, instantiated(answer, Flags.ROUTE_EVALUATOR_FLAGS))).json() as Entry[];
  t.ok(owed.length > 0, 'the rewards of an account are answered');
  t.strictSame(owed.map(described), owed.map(() => ALONE), 'and the rewards of an account: the Comet alone');
});

/*
 * A creation block is past the latest block only until the chain reaches it:
 * the market is read from then on, as every other is.
 */
t.test('a market is read once the chain reaches its creation block', async t => {
  const reached = { ...routeData(MAINNET, AllContracts), catalog: createdAt(LATEST.number, [ USDT ]) };

  const summary = await marketHandlers.latestSummary(reached, uninstantiated(answers([])));
  t.equal(statuses(await summary.json())[USDT], 'success', 'the summary reads it');

  const history = await marketHandlers.historicalSummary(reached, uninstantiated(answers([])));
  t.equal(statuses(await history.json())[USDT], 'success', 'and so does the history');
});
