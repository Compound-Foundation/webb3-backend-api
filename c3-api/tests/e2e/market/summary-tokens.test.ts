import t, { Test } from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';

import * as market from '../../../lib/computations/market.js';
import { checksumAddress } from '../../../lib/model/comet-registry.js';
import type { ActiveMarketV1, Address, BlockRefV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import {
  DEPRECATED_COLLATERAL_KIND,
  HIDDEN_COLLATERAL_KIND,
  setCollateral,
} from '../../../src/registry/collateral-decision-repository.js';
import { DEPRECATED_KEY, HIDDEN_KEY } from '../../../src/registry/collateral-decisions.js';
import { setTokenPolicy } from '../../../src/registry/token-policy-repository.js';

import { consoleLines } from '../../util/console.js';
import { NodeScript, fakeNode, headerReads } from '../../util/fake-node.js';
import { MemoryKv } from '../../util/kv.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { COLLATERAL_KEYS, visibilityOnSummary } from '../../util/summary-token-fields.js';
import { failingStatements, makeTestEnv } from '../../util/test-env.js';

import { DEPRECATED_COLLATERALS, HIDDEN_COLLATERALS, TOKEN_POLICIES, statementsOf } from '../registry/decision-scenarios.js';

import '../../../shim/node-self.js';

/*
 * What /summary says of the token of each collateral, through the whole
 * worker: the legacy router, the decisions in D1 and the records the worker
 * keeps of the deprecated and the hidden ones, the cache of the summaries,
 * and a node behind the node proxy's service binding. What a collateral says
 * of its token across the chain is held to the decisions the test made, and
 * its value to what the node says its market holds of it, at its market's
 * block.
 */
const fixture = loadRegistrySnapshotFixture();
const LATEST  = { number: 23_500_000, timestamp: 1_791_204_930 };

const MAINNET  = fixture.networks.find(network => network.chainId === 1)!;
const marketOf = (key: string) => MAINNET.markets.find(entry => entry.deploymentKey === key)!;
const tokenOf  = (key: string, symbol: string) => marketOf(key).collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address;
const cometOf  = (key: string) => marketOf(key).contracts.comet!;

const EVERY_NETWORK = '/market/all-networks/all-contracts/summary';
const OF_MAINNET    = '/market/ethereum-mainnet/all-contracts/summary';

let seed = 0;

// `migrated` stops the database's migrations at `through`, as a release deployed before its own finds it
async function workerOf(t: Test, script: NodeScript = {}, snapshot: RegistrySnapshotV1 = fixture, migrated: { through?: string } = {}) {
  const registry = await activeRegistryDatabase({ snapshot, ...migrated });
  t.teardown(() => registry.dispose());
  const node = fakeNode(snapshot, LATEST, script);
  const env  = makeTestEnv({
    APP_DB:                           registry.db,
    MEMORY_CACHE_SEED:                `summary-tokens-${seed++}`,
    NODE_PROXY_HOST:                  'node.test',
    NODE_PROXY_KEY:                   'node-key',
    URL_SERVICE_BINDING_OVERRIDES:    [ { host: 'node.test', binding: 'node_provider_proxy' } ],
    node_provider_proxy:              { fetch: node.fetch as typeof fetch },
    // Node takes every computation to be indexed unless told otherwise, which would cache the latest block
    FLAGS_ETH_COMPUTATION_INDEX_BIAS: 'default',
  });
  /*
   * Without an execution context unless a test passes one: the request then
   * answers once what it handed to waitUntil is done, so what it wrote to KV
   * is there for the next one.
   */
  const get = (path: string, overrides: Partial<Env> = {}, context?: ExecutionContext) => (
    C3Api.fetch(new Request(`https://api.test.local${path}`), { ...env, ...overrides }, context)
  );
  return { registry, node, env, get };
}

type Collateral = { address: string, symbol: string, status: string, [field: string]: unknown };
type Entry      = { chain_id: number, comet: { address: string }, deployment_key: string, collateral_value_block?: BlockRefV1, collaterals?: Collateral[] };

async function summaryOf(response: Response): Promise<Entry[]> {
  if (response.status !== 200) {
    throw new Error(`the summary answered ${response.status}: ${await response.text()}`);
  }
  return await response.json() as Entry[];
}

// every collateral of every market of a summary, with its market
const collateralsOf = (entries: Entry[]) => entries.flatMap(entry => (entry.collaterals ?? []).map(collateral => ({ entry, collateral })));
const entryOf       = (entries: Entry[], key: string) => entries.find(entry => entry.chain_id === 1 && entry.deployment_key === key)!;
const collateralOf  = (entry: Entry, symbol: string) => entry.collaterals!.find(collateral => collateral.symbol === symbol)!;
const nameOf        = ({ entry, collateral }: { entry: Entry, collateral: Collateral }) => `${entry.chain_id} ${entry.deployment_key} ${collateral.symbol}`;

const without = (object: object, ...fields: string[]) => Object.fromEntries(Object.entries(object).filter(([ field ]) => !fields.includes(field)));
const picked  = (object: object, ...fields: string[]) => Object.fromEntries(Object.entries(object).filter(([ field ]) => fields.includes(field)));

const decide = (db: D1Database, key: string, symbol: string) => setTokenPolicy(db, {
  chainId:      1,
  tokenAddress: tokenOf(key, symbol),
  isStrategic:  true,
  actor:        'test',
  reason:       'decided for a summary test',
});

const markDeprecated = (db: D1Database, key: string, symbol: string) => setCollateral(db, DEPRECATED_COLLATERAL_KIND, {
  chainId:      1,
  cometAddress: cometOf(key),
  tokenAddress: tokenOf(key, symbol),
  isDeprecated: true,
  actor:        'test',
  reason:       'decided for a summary test',
});

const hide = (db: D1Database, key: string, symbol: string) => setCollateral(db, HIDDEN_COLLATERAL_KIND, {
  chainId:      1,
  cometAddress: cometOf(key),
  tokenAddress: tokenOf(key, symbol),
  isHidden:     true,
  actor:        'test',
  reason:       'decided for a summary test',
});

const FIXED = '0x351a133fd850ea81ed8a782016e308acbaddec91' as Address;

// the fixture with pumpBTC priced through the feed the network's fixed price is stated for, which expires at `expiresAt`, or never
function fixedPumpBtc(expiresAt: string | null): RegistrySnapshotV1 {
  return {
    ...fixture,
    networks: fixture.networks.map(network => network !== MAINNET ? network : {
      ...network,
      priceExceptions: network.priceExceptions.map(exception => exception.priceFeedAddress === FIXED ? { ...exception, expiresAt } : exception),
      markets: network.markets.map(entry => entry.deploymentKey !== 'wbtc' ? entry : {
        ...entry,
        collateralAssets: entry.collateralAssets.map(asset => asset.token.symbol !== 'pumpBTC' ? asset : {
          ...asset,
          priceFeed: { ...asset.priceFeed, address: FIXED },
        }),
      }),
    }),
  };
}

/*
 * The block each market is read at in the minute of LATEST, by chain and
 * deployment key: the latest block less what its creation block leaves over
 * of a minute's blocks on its chain, as the minutely index projects it — five
 * blocks on mainnet, and thirty on Base and on Scroll — with the timestamp the
 * node gives it, a second older for each block below the latest.
 */
const MARKET_BLOCK_REFS: Record<string, BlockRefV1> = {
  '1 usdc':      { number: 23_499_996, timestamp: 1_791_204_926 },
  '1 weth':      { number: 23_500_000, timestamp: 1_791_204_930 },
  '1 usdt':      { number: 23_499_997, timestamp: 1_791_204_927 },
  '1 wbtc':      { number: 23_499_997, timestamp: 1_791_204_927 },
  '8453 aero':   { number: 23_499_995, timestamp: 1_791_204_925 },
  '534352 usdc': { number: 23_499_984, timestamp: 1_791_204_914 },
};
const MARKET_BLOCKS = Object.fromEntries(Object.entries(MARKET_BLOCK_REFS).map(([ market, { number } ]) => [ market, number ]));

t.test('every form of the summary answers each collateral with the fields of its token, after what was read of it', async t => {
  const { node, get } = await workerOf(t);

  const every = await summaryOf(await get(EVERY_NETWORK));
  for (const read of collateralsOf(every)) {
    t.strictSame(Object.keys(read.collateral), COLLATERAL_KEYS, `${nameOf(read)}: what was read of it, then its token's fields`);
  }
  t.strictSame(headerReads(node).sort(), [ ...new Set(Object.values(MARKET_BLOCKS)) ].sort(),
    'the header of each market\'s block is read once, in a minute nobody had read, the markets read at the same block sharing one');

  const mainnet = await summaryOf(await get(OF_MAINNET));
  t.equal(JSON.stringify(mainnet), JSON.stringify(every.filter(entry => entry.chain_id === 1)), 'the summary of a network answers its collaterals alike');
  const alone = await summaryOf(await get(`/market/ethereum-mainnet/${cometOf('usdt')}/summary`));
  t.equal(JSON.stringify(alone), JSON.stringify([ entryOf(every, 'usdt') ]), 'and so does the summary of one market');
  t.equal(headerReads(node).length, new Set(Object.values(MARKET_BLOCKS)).size, 'both from the summaries of the minute, reading no header again');
});

// the Comets of mainnet the test decides about, checksummed, as the summary names a Comet
const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';

// the tokens of mainnet that play another role there than a collateral's: COMP, the reward of its markets, and their base assets
const ROLES: Record<string, string[]> = {
  COMP: [ 'reward', 'collateral' ],
  USDC: [ 'base', 'collateral' ],
  WETH: [ 'base', 'collateral' ],
  USDT: [ 'base', 'collateral' ],
  WBTC: [ 'base', 'collateral' ],
};

// what the collateral decisions say of each collateral the test decides about; any other is deprecated and hidden nowhere
const DECIDED: Record<string, { is_deprecated: boolean, is_network_deprecated: boolean, deprecated_in: string[], is_hidden: boolean, hidden_in: string[] }> = {
  '1 usdc weETH': { is_deprecated: false, is_network_deprecated: false, deprecated_in: [ USDT_COMET ], is_hidden: true,  hidden_in: [ USDC_COMET ] },
  '1 weth weETH': { is_deprecated: false, is_network_deprecated: false, deprecated_in: [ USDT_COMET ], is_hidden: false, hidden_in: [ USDC_COMET ] },
  '1 usdt weETH': { is_deprecated: true,  is_network_deprecated: false, deprecated_in: [ USDT_COMET ], is_hidden: false, hidden_in: [ USDC_COMET ] },
  '1 usdt mETH':  { is_deprecated: true,  is_network_deprecated: true,  deprecated_in: [ USDT_COMET ], is_hidden: false, hidden_in: [] },
};

// the tokens the test marks strategic on mainnet
const STRATEGIC = [ 'XAUt', 'cbBTC' ];

// whether discovery shows each collateral the test decides about, and why; any other, worth a dollar, is short of the threshold
const SAID: Record<string, { is_visible: boolean, visibility_reason: string }> = {
  '1 usdc cbBTC': { is_visible: true,  visibility_reason: 'strategic' },
  '1 weth cbBTC': { is_visible: true,  visibility_reason: 'strategic' },
  '1 usdt cbBTC': { is_visible: true,  visibility_reason: 'strategic' },
  '1 usdt XAUt':  { is_visible: true,  visibility_reason: 'strategic' },
  '1 usdc weETH': { is_visible: false, visibility_reason: 'hidden' },
  '1 usdt weETH': { is_visible: false, visibility_reason: 'deprecated' },
  '1 usdt mETH':  { is_visible: false, visibility_reason: 'deprecated' },
};

/*
 * Each collateral is held to what the test decided and what the node holds,
 * every field of it stated apart from the code: one token of a dollar in
 * every market, which pumpBTC, priced through a price exception of the
 * registry whose expiry is stated with an offset, is worth at the price the
 * registry states. XAUt and cbBTC are strategic on mainnet, weETH and mETH
 * are deprecated in USDT's market, and weETH is hidden in USDC's, so every
 * field is held to something. Three collaterals are stated in full, and every
 * other by the tables above; each market answers the block it was read at
 * once, as MARKET_BLOCK_REFS has it.
 */
t.test('what a collateral says of its token is what holds of it on its chain, and its value its own in its market', async t => {
  const { registry, get } = await workerOf(t, {}, fixedPumpBtc('2999-01-01T00:00:00+01:00'));
  await decide(registry.db, 'usdt', 'XAUt');
  await decide(registry.db, 'usdc', 'cbBTC');
  await markDeprecated(registry.db, 'usdt', 'weETH');
  await markDeprecated(registry.db, 'usdt', 'mETH');
  await hide(registry.db, 'usdc', 'weETH');

  const { provenance, price } = MAINNET.priceExceptions.find(exception => exception.priceFeedAddress === FIXED)! as { provenance: string, price: { value: string } };
  t.equal(price.value, '102447384', 'the price the registry states for pumpBTC\'s feed, at eight decimals');
  const stated = { kind: 'fixed_price', price_feed_address: '0x351a133Fd850ea81ed8a782016e308aCBADDec91', provenance, expires_at: '2998-12-31T23:00:00.000Z' };

  const every = await summaryOf(await get(EVERY_NETWORK));
  t.strictSame(collateralOf(entryOf(every, 'usdc'), 'weETH'), {
    address: '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', symbol: 'weETH', status: 'success', name: 'Wrapped eETH', decimals: 18,
    is_deprecated: false, is_network_deprecated: false, deprecated_in: [ USDT_COMET ], is_hidden: true, hidden_in: [ USDC_COMET ],
    is_strategic: false, network_roles: [ 'collateral' ],
    collateral_value_usd: '1.0', collateral_value_status: 'fresh', collateral_value_exception: null,
    is_visible: false, visibility_reason: 'hidden',
  }, 'weETH in USDC\'s market: hidden there, deprecated in USDT\'s alone, and one token at a dollar');
  t.strictSame(collateralOf(entryOf(every, 'usdt'), 'mETH'), {
    address: '0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa', symbol: 'mETH', status: 'success', name: 'mETH', decimals: 18,
    is_deprecated: true, is_network_deprecated: true, deprecated_in: [ USDT_COMET ], is_hidden: false, hidden_in: [],
    is_strategic: false, network_roles: [ 'collateral' ],
    collateral_value_usd: '1.0', collateral_value_status: 'fresh', collateral_value_exception: null,
    is_visible: false, visibility_reason: 'deprecated',
  }, 'mETH in USDT\'s market, the one that takes it: deprecated there, and so across the chain');
  t.strictSame(collateralOf(entryOf(every, 'wbtc'), 'pumpBTC'), {
    address: '0xF469fBD2abcd6B9de8E169d128226C0Fc90a012e', symbol: 'pumpBTC', status: 'success', name: 'pumpBTC', decimals: 8,
    is_deprecated: false, is_network_deprecated: false, deprecated_in: [], is_hidden: false, hidden_in: [],
    is_strategic: false, network_roles: [ 'collateral' ],
    collateral_value_usd: '1.02447384', collateral_value_status: 'exception', collateral_value_exception: stated,
    is_visible: false, visibility_reason: 'below_threshold',
  }, 'pumpBTC in WBTC\'s market: one token at the price the registry states, naming the exception, its expiry an instant');

  for (const entry of every) {
    const market = `${entry.chain_id} ${entry.deployment_key}`;
    t.strictSame(entry.collateral_value_block, MARKET_BLOCK_REFS[market],
      `${market}: the block it was read at, which its collaterals' values were read at`);
  }
  for (const read of collateralsOf(every)) {
    const market = `${read.entry.chain_id} ${read.entry.deployment_key}`;
    const priced = market === '1 wbtc' && read.collateral.symbol === 'pumpBTC';
    const { token } = fixture.networks.find(network => network.chainId === read.entry.chain_id)!.markets
      .find(entry => entry.deploymentKey === read.entry.deployment_key)!.collateralAssets.find(asset => asset.token.symbol === read.collateral.symbol)!;
    t.strictSame(without(read.collateral, 'address', 'symbol', 'status', 'message'), {
      name:                       token.name,
      decimals:                   token.decimals,
      ...(DECIDED[`${market} ${read.collateral.symbol}`] ?? { is_deprecated: false, is_network_deprecated: false, deprecated_in: [], is_hidden: false, hidden_in: [] }),
      is_strategic:               read.entry.chain_id === 1 && STRATEGIC.includes(read.collateral.symbol),
      network_roles:              (read.entry.chain_id === 1 ? ROLES[read.collateral.symbol] : undefined) ?? [ 'collateral' ],
      collateral_value_usd:       priced ? '1.02447384' : '1.0',
      collateral_value_status:    priced ? 'exception' : 'fresh',
      collateral_value_exception: priced ? stated : null,
      ...(SAID[`${market} ${read.collateral.symbol}`] ?? { is_visible: false, visibility_reason: 'below_threshold' }),
    }, `${nameOf(read)}: every field of its token, its value in its market, and whether discovery shows it there`);
  }
});

// that an exception never expires is known, so its expiry is null rather than left out as an unknown value is
t.test('an exception that does not expire is answered with a null expiry, not without one', async t => {
  const { get } = await workerOf(t, {}, fixedPumpBtc(null));

  const every = await summaryOf(await get(EVERY_NETWORK));
  const { provenance } = MAINNET.priceExceptions.find(exception => exception.priceFeedAddress === FIXED)!;
  t.strictSame(collateralOf(entryOf(every, 'wbtc'), 'pumpBTC').collateral_value_exception,
    { kind: 'fixed_price', price_feed_address: checksumAddress(FIXED), provenance, expires_at: null },
    'pumpBTC: the exception that priced it, with a null expiry');
});

/*
 * Why an exception was added and until when it applies change no value, so
 * two versions that differ only in them share the summaries of a minute
 * (catalog.ts, marketDigest). Each answers with its own description of the
 * exception, whichever read the minute.
 */
t.test('an exception is described as the version that answers describes it, whichever read the minute', async t => {
  const edited = (provenance: string, expiresAt: string, id: string): RegistrySnapshotV1 => {
    const version = fixedPumpBtc(expiresAt);
    return {
      ...version,
      registryVersion: { ...version.registryVersion, id },
      networks: version.networks.map(network => network.chainId !== 1 ? network : {
        ...network,
        priceExceptions: network.priceExceptions.map(exception => exception.priceFeedAddress === FIXED ? { ...exception, provenance } : exception),
      }),
    };
  };
  const first  = edited('as the first version describes it', '2999-01-01T00:00:00.000Z', fixture.registryVersion.id);
  const second = await activeRegistryDatabase({ snapshot: edited('as the second version describes it', '2999-06-01T00:00:00+02:00', '00000000-0000-4000-8000-0000000000b2') });
  t.teardown(() => second.dispose());
  const { node, get } = await workerOf(t, {}, first);
  const described = (entries: Entry[]) => {
    const { provenance, expires_at } = collateralOf(entryOf(entries, 'wbtc'), 'pumpBTC').collateral_value_exception as { provenance: string, expires_at: string };
    return { provenance, expires_at };
  };

  t.same(described(await summaryOf(await get(OF_MAINNET))), { provenance: 'as the first version describes it', expires_at: '2999-01-01T00:00:00.000Z' });
  const read = node.requests.length;
  const answered = await get(OF_MAINNET, { APP_DB: second.db });
  t.equal(answered.headers.get('x-registry-version'), second.versionId, 'the second version answers');
  const summary = await summaryOf(answered);
  t.equal(node.requests.length - read, 1, 'from the summaries the first one read, asking the node for the latest block alone');
  t.same(described(summary), { provenance: 'as the second version describes it', expires_at: '2999-05-31T22:00:00.000Z' },
    'with its own description of the exception, its expiry an instant');
});

/*
 * weETH is a collateral of the USDC, WETH and USDT markets of mainnet, and
 * mETH of the USDT market alone. Deprecated in USDT's, each is deprecated
 * there and nowhere else, as /registry/v1 marks the collaterals of a market,
 * and is not shown there: whether discovery shows a token is the market's own.
 * Across the chain, mETH is deprecated in every enabled market that takes it,
 * while weETH is still offered by two, which decide it by their own values.
 */
t.test('is_deprecated is the decision of the market\'s own Comet, and is_network_deprecated what holds across the chain', async t => {
  const { registry, get } = await workerOf(t);
  await markDeprecated(registry.db, 'usdt', 'weETH');
  await markDeprecated(registry.db, 'usdt', 'mETH');

  const mainnet = await summaryOf(await get(OF_MAINNET));
  const usdt    = checksumAddress(cometOf('usdt'));
  const stateOf = (key: string, symbol: string) => {
    const { is_deprecated, is_network_deprecated, deprecated_in, is_visible, visibility_reason } = collateralOf(entryOf(mainnet, key), symbol);
    return { is_deprecated, is_network_deprecated, deprecated_in, is_visible, visibility_reason };
  };
  t.strictSame(stateOf('usdt', 'weETH'),
    { is_deprecated: true, is_network_deprecated: false, deprecated_in: [ usdt ], is_visible: false, visibility_reason: 'deprecated' },
    'weETH in USDT\'s market: deprecated there, and so not shown there, though not deprecated across the chain');
  for (const key of [ 'usdc', 'weth' ]) {
    t.strictSame(stateOf(key, 'weETH'),
      { is_deprecated: false, is_network_deprecated: false, deprecated_in: [ usdt ], is_visible: false, visibility_reason: 'below_threshold' },
      `weETH in ${key.toUpperCase()}'s market: current there, and the same across the chain`);
  }
  t.strictSame(stateOf('usdt', 'mETH'),
    { is_deprecated: true, is_network_deprecated: true, deprecated_in: [ usdt ], is_visible: false, visibility_reason: 'deprecated' },
    'mETH, which USDT\'s market alone takes: deprecated there and across the chain, and not shown');

  for (const key of [ 'usdc', 'weth', 'usdt', 'wbtc' ]) {
    const { market } = await (await get(`/registry/v1/networks/1/markets/${cometOf(key)}`)).json() as { market: ActiveMarketV1 };
    t.strictSame(entryOf(mainnet, key).collaterals!.map(collateral => [ collateral.symbol, collateral.is_deprecated ]),
      market.collateralAssets.map(asset => [ asset.token.symbol, asset.isDeprecated ]),
      `${key.toUpperCase()}: every collateral as the market read of the registry marks it`);
  }
});

/*
 * A collateral is hidden as it is deprecated, by one Comet, and whether
 * discovery shows the token is the market's own on the summary: weETH,
 * strategic here, is hidden in USDC's market only, so it is not shown there
 * while WETH's and USDT's markets show it. mETH, hidden in USDT's, the one
 * market that takes it, is not shown there.
 */
t.test('is_hidden is the decision of the market\'s own Comet, and is_visible what discovery shows in that market', async t => {
  const { registry, get } = await workerOf(t);
  await decide(registry.db, 'usdt', 'weETH');
  await hide(registry.db, 'usdc', 'weETH');
  await hide(registry.db, 'usdt', 'mETH');

  const mainnet = await summaryOf(await get(OF_MAINNET));
  const [ usdc, usdt ] = [ checksumAddress(cometOf('usdc')), checksumAddress(cometOf('usdt')) ];
  const stateOf = (key: string, symbol: string) => picked(collateralOf(entryOf(mainnet, key), symbol), 'is_hidden', 'hidden_in', 'is_visible', 'visibility_reason');
  t.strictSame(stateOf('usdc', 'weETH'), { is_hidden: true, hidden_in: [ usdc ], is_visible: false, visibility_reason: 'hidden' },
    'weETH in USDC\'s market: hidden there, and not shown in it');
  for (const key of [ 'weth', 'usdt' ]) {
    t.strictSame(stateOf(key, 'weETH'), { is_hidden: false, hidden_in: [ usdc ], is_visible: true, visibility_reason: 'strategic' },
      `weETH in ${key.toUpperCase()}'s market: not hidden there, and shown for being strategic`);
  }
  t.strictSame(stateOf('usdt', 'mETH'), { is_hidden: true, hidden_in: [ usdt ], is_visible: false, visibility_reason: 'hidden' },
    'mETH, which USDT\'s market alone takes: hidden there, and not shown');

  for (const key of [ 'usdc', 'weth', 'usdt', 'wbtc' ]) {
    const { market } = await (await get(`/registry/v1/networks/1/markets/${cometOf(key)}`)).json() as { market: ActiveMarketV1 };
    t.strictSame(entryOf(mainnet, key).collaterals!.map(collateral => [ collateral.symbol, collateral.is_hidden ]),
      market.collateralAssets.map(asset => [ asset.token.symbol, asset.isHidden ]),
      `${key.toUpperCase()}: every collateral as the market read of the registry marks it`);
  }

  // the Comet named checksummed, as a client may name it
  for (const key of [ 'usdc', 'weth' ]) {
    const alone = await summaryOf(await get(`/market/ethereum-mainnet/${checksumAddress(cometOf(key))}/summary`));
    t.equal(JSON.stringify(alone), JSON.stringify([ entryOf(mainnet, key) ]),
      `the summary of ${key.toUpperCase()}'s market alone answers it as the summary of the network does, by its own Comet's decisions`);
  }
});

/*
 * A market whose status is deprecated answers its collaterals by the same
 * rule as any other: its own Comet's decisions, and its own value. Here
 * USDT's market is deprecated. weETH, strategic, is hidden in the USDC and
 * WETH markets, the enabled ones that take it, and not there, so the rest of
 * the rule shows it there. mETH, strategic as well, is taken by USDT's market
 * alone, which hides it and does not show it. XAUt, which nobody decided
 * about and which USDT's market alone takes, is held there at 300,000 tokens
 * of a dollar, and shown for it, and sFRAX, held there at one, is not.
 */
t.test('a market whose status is deprecated answers by its own Comet\'s decisions and its own value', async t => {
  const snapshot: RegistrySnapshotV1 = {
    ...fixture,
    networks: fixture.networks.map(network => network !== MAINNET ? network : {
      ...network,
      markets: network.markets.map(entry => entry.deploymentKey === 'usdt' ? { ...entry, status: 'deprecated' as const } : entry),
    }),
  };
  const xaut = marketOf('usdt').collateralAssets.find(asset => asset.token.symbol === 'XAUt')!.token;
  const { registry, get } = await workerOf(t, {
    answer: ({ comet, name, argument }) => comet === cometOf('usdt') && name === 'totalsCollateral' && argument === xaut.address
      ? [ (300_000n * 10n ** BigInt(xaut.decimals)).toString() ]
      : undefined,
  }, snapshot);
  await decide(registry.db, 'usdt', 'weETH');
  await decide(registry.db, 'usdt', 'mETH');
  await hide(registry.db, 'usdc', 'weETH');
  await hide(registry.db, 'weth', 'weETH');
  await hide(registry.db, 'usdt', 'mETH');

  const mainnet  = await summaryOf(await get(OF_MAINNET));
  const stateOf  = (key: string, symbol: string) => picked(collateralOf(entryOf(mainnet, key), symbol), 'is_hidden', 'hidden_in', 'is_visible', 'visibility_reason');
  const hiddenIn = [ cometOf('usdc'), cometOf('weth') ].sort().map(address => checksumAddress(address));
  for (const key of [ 'usdc', 'weth' ]) {
    t.strictSame(stateOf(key, 'weETH'), { is_hidden: true, hidden_in: hiddenIn, is_visible: false, visibility_reason: 'hidden' },
      `weETH in ${key.toUpperCase()}'s market: hidden there, and not shown in it`);
  }
  t.strictSame(stateOf('usdt', 'weETH'), { is_hidden: false, hidden_in: hiddenIn, is_visible: true, visibility_reason: 'strategic' },
    'weETH in USDT\'s market: not hidden there, and shown for being strategic, whatever the enabled markets decided');
  t.strictSame(stateOf('usdt', 'mETH'), { is_hidden: true, hidden_in: [ checksumAddress(cometOf('usdt')) ], is_visible: false, visibility_reason: 'hidden' },
    'mETH in USDT\'s market: hidden there, and not shown in it');
  t.strictSame([ 'XAUt', 'sFRAX' ].map(symbol => picked(collateralOf(entryOf(mainnet, 'usdt'), symbol), 'collateral_value_usd', 'is_visible', 'visibility_reason')), [
    { collateral_value_usd: '300000.0', is_visible: true,  visibility_reason: 'collateral_threshold' },
    { collateral_value_usd: '1.0',      is_visible: false, visibility_reason: 'below_threshold' },
  ], 'and XAUt and sFRAX, which nobody decided about, by what it holds of each');
});

// matches no statement, so that a database fails only while it is down
const NO_STATEMENT = /^$/;

// what each kind of decision decides, and the two fields every kind takes part in: whether the token is shown, and why
const decidedBy = {
  deprecated: [ 'is_deprecated', 'is_network_deprecated', 'deprecated_in' ],
  hidden:     [ 'is_hidden', 'hidden_in' ],
  strategic:  [ 'is_strategic' ],
  shown:      [ 'is_visible' ],
  why:        [ 'visibility_reason' ],
};

// a kind of decision the summary may not have read
type Unread = 'deprecated' | 'hidden' | 'strategic';

/*
 * A collateral a summary answered with every decision read, as a summary
 * answers it while the kinds named cannot be read: without what they decide,
 * and saying whether its token is shown, and why, only where the decisions
 * read settle it whichever way the others went (visibilityOnSummary), each as
 * when every decision was read.
 */
function unreadOf(collateral: Collateral, unread: readonly Unread[]): Collateral {
  const settled = visibilityOnSummary({
    isHidden:     unread.includes('hidden')     ? null : collateral.is_hidden as boolean,
    isDeprecated: unread.includes('deprecated') ? null : collateral.is_deprecated as boolean,
    isStrategic:  unread.includes('strategic')  ? null : collateral.is_strategic as boolean,
  }, (collateral.collateral_value_usd as string | undefined) ?? null);
  const unsettled = [ ...decidedBy.shown, ...decidedBy.why ].filter(field => !(field in settled));
  return without(collateral, ...unread.flatMap(kind => decidedBy[kind]), ...unsettled) as Collateral;
}

// a summary answered with every decision read, as unreadOf answers each collateral
const unreadSummary = (entries: Entry[], unread: readonly Unread[]): Entry[] => entries.map(entry => ({
  ...entry,
  collaterals: entry.collaterals!.map(collateral => unreadOf(collateral, unread)),
}));

// every collateral of a summary answered with every decision read, by name, as unreadOf answers it
const unreadCollaterals = (entries: Entry[], unread: readonly Unread[]) => new Map(collateralsOf(unreadSummary(entries, unread)).map(read => (
  [ nameOf(read), read.collateral ]
)));

// the fields of a collateral in the order the summary writes them, the message of one that is `error` after its status
const keysOf = (collateral: Collateral) => COLLATERAL_KEYS
  .flatMap((key): string[] => key === 'status' && 'message' in collateral ? [ key, 'message' ] : [ key ])
  .filter(key => key in collateral);

// whether a collateral says its token is shown, and why
const saidOf = (collateral: Collateral) => picked(collateral, ...decidedBy.shown, ...decidedBy.why);

/*
 * The deprecated and the hidden decisions are read as the active reads read
 * them: from D1, or, while D1 cannot be reached, from the record the worker
 * keeps of each kind, and an answer marked with those says that it could not
 * be confirmed. The strategic ones have no record, and what they decide is
 * left out. Every value here is worth less than the threshold, so a
 * collateral its Comet neither hides nor deprecates is told nothing of
 * whether it is shown, as a strategic mark would show it, while one its Comet
 * hides or has deprecated is not shown there whatever they say. Either way
 * the summary is answered: a summary is every market's.
 */
t.test('while D1 cannot be reached, the deprecated and the hidden decisions come from their records and are said to be unconfirmed', async t => {
  const { registry, env, get } = await workerOf(t);
  const logs = consoleLines(t, [ 'error', 'warn' ], { prefixed: true });
  await decide(registry.db, 'usdt', 'XAUt');
  await markDeprecated(registry.db, 'usdt', 'mETH');
  await hide(registry.db, 'usdc', 'weETH');
  let down = false;
  const db = failingStatements(registry.db, NO_STATEMENT, { down: () => down });

  const confirmed = await get(OF_MAINNET, { APP_DB: db });
  t.same([ confirmed.headers.get('x-registry-stale'), confirmed.headers.get('cache-control') ], [ null, null ],
    'an answer D1 confirmed says nothing of the kind');
  const recorded = async (key: string) => (await env.kv_registry.get(key, 'json') as { collaterals: unknown[] }).collaterals;
  t.same([ await recorded(DEPRECATED_KEY), await recorded(HIDDEN_KEY) ], [
    [ { chainId: 1, cometAddress: cometOf('usdt'), tokenAddress: tokenOf('usdt', 'mETH') } ],
    [ { chainId: 1, cometAddress: cometOf('usdc'), tokenAddress: tokenOf('usdc', 'weETH') } ],
  ], 'and records the decisions it read, each kind apart');
  const before = await summaryOf(confirmed);

  for (const [ kind, failing ] of [ [ 'deprecated', statementsOf(DEPRECATED_COLLATERALS) ], [ 'hidden', statementsOf(HIDDEN_COLLATERALS) ] ] as const) {
    const partly = await get(OF_MAINNET, { APP_DB: failingStatements(registry.db, failing) });
    t.same([ partly.headers.get('x-registry-stale'), partly.headers.get('cache-control') ], [ '0', 'no-store' ],
      `${kind} decisions D1 did not give, the version it did: the decisions last recorded, said to be no older than now, and not to be kept`);
    t.equal(JSON.stringify(await summaryOf(partly)), JSON.stringify(before), 'which mark the collaterals as D1 did');
  }

  down = true;
  const response = await get(OF_MAINNET, { APP_DB: db });
  t.equal(response.status, 200, 'with D1 down, the summary is answered from the version it last named');
  t.match(response.headers.get('x-registry-stale'), /^[0-9]+$/, 'saying how old that version is');
  t.equal(response.headers.get('cache-control'), 'no-store', 'and that nothing may keep it');
  const during = await summaryOf(response);
  t.strictSame(picked(collateralOf(entryOf(during, 'usdt'), 'mETH'), 'is_deprecated', 'is_network_deprecated'),
    { is_deprecated: true, is_network_deprecated: true }, 'its collaterals marked by the decisions last recorded');
  t.strictSame(picked(collateralOf(entryOf(during, 'usdc'), 'weETH'), 'is_hidden', 'is_visible', 'visibility_reason'),
    { is_hidden: true, is_visible: false, visibility_reason: 'hidden' }, 'of either kind, and a collateral its Comet hides is not shown there');
  t.strictSame(picked(collateralOf(entryOf(during, 'usdt'), 'mETH'), 'is_hidden', 'is_visible', 'visibility_reason'),
    { is_hidden: false, is_visible: false, visibility_reason: 'deprecated' }, 'nor one its Comet has deprecated and does not hide');
  const strategic = [ ...decidedBy.strategic, ...decidedBy.shown, ...decidedBy.why ];
  const expected  = unreadCollaterals(before, [ 'strategic' ]);
  for (const read of collateralsOf(during)) {
    const fields = expected.get(nameOf(read))!;
    t.strictSame(Object.keys(read.collateral), keysOf(fields),
      `${nameOf(read)}: without what the strategic decisions decide${'visibility_reason' in fields ? ', but for whether it is shown, which its Comet\'s decision decides' : ''}`);
  }
  t.strictSame(during.map(entry => ({ ...entry, collaterals: entry.collaterals!.map(collateral => without(collateral, ...strategic)) })),
    before.map(entry => ({ ...entry, collaterals: entry.collaterals!.map(collateral => without(collateral, ...strategic)) })),
    'and everything else as when D1 answered');
  for (const kind of [ 'deprecated', 'hidden' ]) {
    t.ok(logs.some(line => line === `warn: ${kind} collateral decisions unreadable; answering with the ones last recorded`),
      `the log says where the ${kind} decisions came from`);
  }
  t.ok(logs.some(line => line === 'error: the summary could not read the token policies'), 'and which decisions could not be read');
});

/*
 * A failed read is logged once a minute for each database binding, as the
 * cache logs an outage it answers through, and its fields are left out of
 * every answer all the same. Whether discovery shows a token, and why, which
 * every kind takes part in, are each said only where the decisions read
 * settle them whichever way the others went. Every value here is worth less
 * than the threshold, so a collateral the strategic decisions do not mark is
 * not shown whatever its Comet decided, and is told nothing of it while they
 * cannot be read, as a mark would show it. mETH, which USDT's Comet has
 * deprecated, is not shown there whatever its hiding or its strategic mark,
 * and is told why while the strategic decisions alone cannot be read. XAUt,
 * strategic, is shown unless its Comet hides it or has it deprecated, and so
 * is told nothing of it while either cannot be read.
 */
t.test('decisions that cannot be read leave out what they decide, and are logged under the request', async t => {
  const { registry, get } = await workerOf(t);
  const errors = consoleLines(t, [ 'error' ]);
  await decide(registry.db, 'usdt', 'XAUt');
  await markDeprecated(registry.db, 'usdt', 'mETH');
  const before = await summaryOf(await get(OF_MAINNET));

  const cases = [
    [ 'the deprecated decisions, with none recorded', statementsOf(DEPRECATED_COLLATERALS), 'deprecated', 'deprecated collateral decisions' ],
    [ 'the hidden decisions, with none recorded',     statementsOf(HIDDEN_COLLATERALS), 'hidden', 'hidden collateral decisions' ],
    [ 'the strategic decisions',                      statementsOf(TOKEN_POLICIES), 'strategic', 'token policies' ],
  ] as const;
  for (const [ what, failing, kind, logged ] of cases) {
    errors.length = 0;
    const db       = failingStatements(registry.db, failing);
    const response = await get(OF_MAINNET, { APP_DB: db, kv_registry: MemoryKv({}) });
    t.same([ response.status, response.headers.get('x-registry-stale'), response.headers.get('cache-control') ], [ 200, null, null ],
      `${what}: the summary is answered, and says nothing is unconfirmed`);
    const answered = await summaryOf(response);
    const expected = unreadCollaterals(before, [ kind ]);
    for (const read of collateralsOf(answered)) {
      const fields = expected.get(nameOf(read))!;
      t.strictSame([ Object.keys(read.collateral), saidOf(read.collateral) ], [ keysOf(fields), saidOf(fields) ],
        `${what}: ${nameOf(read)} without what they decide${'visibility_reason' in fields ? ', but for whether it is shown, which its Comet\'s deprecating decides' : ''}`);
    }
    const decided = [ ...decidedBy[kind], ...decidedBy.shown, ...decidedBy.why ];
    t.strictSame(answered.map(entry => ({ ...entry, collaterals: entry.collaterals!.map(collateral => without(collateral, ...decided)) })),
      before.map(entry => ({ ...entry, collaterals: entry.collaterals!.map(collateral => without(collateral, ...decided)) })),
      `${what}: and everything else as when they were read`);
    const at = errors.indexOf(`the summary could not read the ${logged}`);
    t.ok(at >= 0, `${what}: the log says so`);
    t.match(errors[at + 1], /requestId: '[0-9a-f-]{36}'[\s\S]*Network connection lost/, `${what}: with its cause, under the request's id`);

    errors.length = 0;
    const again = await summaryOf(await get(OF_MAINNET, { APP_DB: db, kv_registry: MemoryKv({}) }));
    t.equal(JSON.stringify(again), JSON.stringify(answered), `${what}: a request right after leaves them out as well`);
    t.notOk(errors.includes(`the summary could not read the ${logged}`), `${what}: and is not logged again for that database within a minute`);
  }
});

/*
 * A release deployed before migration 0008 finds no table of hidden
 * decisions to read, where the other routes that read them answer 503: the
 * summary is answered without what they decide, as when D1 cannot give them,
 * and the log says why. Whether a token is shown is said where the other
 * decisions settle it: every collateral here is neither strategic nor worth
 * the threshold, so none is shown, whatever its hiding.
 */
t.test('a database without the hidden collateral migration leaves out what the hidden decisions decide', async t => {
  const { get } = await workerOf(t, {}, fixture, { through: '0007' });
  const errors = consoleLines(t, [ 'error' ]);

  const response = await get(OF_MAINNET, { kv_registry: MemoryKv({}) });
  t.same([ response.status, response.headers.get('x-registry-stale'), response.headers.get('cache-control') ], [ 200, null, null ],
    'the summary is answered, and says nothing is unconfirmed');
  const unread = [ ...decidedBy.hidden, ...decidedBy.why ];
  for (const read of collateralsOf(await summaryOf(response))) {
    t.strictSame([ Object.keys(read.collateral), saidOf(read.collateral) ], [ COLLATERAL_KEYS.filter(key => !unread.includes(key)), { is_visible: false } ],
      `${nameOf(read)}: without what they decide`);
  }
  const logged = 'the summary could not read the hidden collateral decisions';
  t.equal(errors.filter(line => line === logged).length, 1, 'the log says so once');
  t.match(errors[errors.indexOf(logged) + 1], /no such table: hidden_collaterals/, 'with the table D1 does not have');
});

/*
 * Whether discovery shows a token takes every kind of decision, but a Comet's
 * hiding it decides that alone, since the rule asks it first. So a collateral
 * its Comet hides is said not to be shown there, and why, even when the other
 * decisions could not be read: a client told nothing would show it. Without
 * the deprecated decisions, every other collateral but weETH, strategic here,
 * is said not to be shown either, though not why: worth less than the
 * threshold, it is not shown whether or not its Comet has deprecated it.
 * Without the strategic ones, every other collateral is told nothing of it,
 * as a strategic mark would show it.
 */
t.test('a collateral its Comet hides is not shown there, though the other decisions could not be read', async t => {
  const { registry, get } = await workerOf(t);
  consoleLines(t, [ 'error' ]);
  await decide(registry.db, 'usdc', 'weETH');
  await hide(registry.db, 'usdc', 'weETH');
  const before = await summaryOf(await get(OF_MAINNET));

  const cases = [
    [ 'the deprecated decisions, with none recorded', statementsOf(DEPRECATED_COLLATERALS), 'deprecated' ],
    [ 'the strategic decisions',                      statementsOf(TOKEN_POLICIES), 'strategic' ],
  ] as const;
  for (const [ what, failing, kind ] of cases) {
    const answered = await summaryOf(await get(OF_MAINNET, { APP_DB: failingStatements(registry.db, failing), kv_registry: MemoryKv({}) }));
    t.strictSame(picked(collateralOf(entryOf(answered, 'usdc'), 'weETH'), 'is_hidden', 'is_visible', 'visibility_reason'),
      { is_hidden: true, is_visible: false, visibility_reason: 'hidden' }, `${what}: weETH in USDC's market, which hides it, is not shown there`);
    const expected = unreadCollaterals(before, [ kind ]);
    for (const read of collateralsOf(answered)) {
      const fields = expected.get(nameOf(read))!;
      const said   = 'visibility_reason' in fields ? 'says whether it is shown'
        : 'is_visible' in fields ? `is said ${fields.is_visible ? 'to be' : 'not to be'} shown, though not why`
        : 'is told nothing of whether it is shown';
      t.strictSame([ Object.keys(read.collateral), saidOf(read.collateral) ], [ keysOf(fields), saidOf(fields) ], `${what}: ${nameOf(read)} ${said}`);
    }
    t.strictSame(picked(collateralOf(entryOf(answered, 'weth'), 'weETH'), 'is_hidden', 'hidden_in'),
      { is_hidden: false, hidden_in: [ checksumAddress(cometOf('usdc')) ] }, `${what}: while WETH's market says only where it is hidden`);
  }
});

/*
 * The strategic decisions have no record, so while they cannot be read, as
 * in any outage of D1, the summary cannot tell whether a token is strategic.
 * A collateral its Comet neither hides nor deprecates is shown, strategic or
 * not, where its value reaches the threshold or cannot be read, so the
 * summary says it is shown, though not why: here rETH, which WETH's market
 * alone takes, held there at 300,000 tokens of a dollar each, and osETH,
 * whose price reverts there. cbETH, worth less, is told nothing of it, as a
 * strategic mark would show it.
 */
t.test('while the strategic decisions cannot be read, a collateral its value shows is said to be shown, though not why', async t => {
  const assetOf = (symbol: string) => marketOf('weth').collateralAssets.find(asset => asset.token.symbol === symbol)!;
  const [ rEth, osEth ] = [ assetOf('rETH'), assetOf('osETH') ];
  const { registry, get } = await workerOf(t, {
    answer: ({ name, argument }) => (
        name === 'totalsCollateral' && argument === rEth.token.address ? [ (300_000n * 10n ** BigInt(rEth.token.decimals)).toString() ]
      : name === 'getPrice' && argument === osEth.priceFeed.address    ? 'revert'
      : undefined
    ),
  });
  consoleLines(t, [ 'error', 'warn' ]);
  let down = false;
  const db     = failingStatements(registry.db, NO_STATEMENT, { down: () => down });
  const before = await summaryOf(await get(OF_MAINNET, { APP_DB: db }));

  const policies = await summaryOf(await get(OF_MAINNET, { APP_DB: failingStatements(registry.db, statementsOf(TOKEN_POLICIES)) }));
  down = true;
  const outage   = await summaryOf(await get(OF_MAINNET, { APP_DB: db }));
  for (const [ what, answered ] of [ [ 'the token policies alone', policies ], [ 'D1 down', outage ] ] as const) {
    const weth = entryOf(answered, 'weth');
    t.strictSame([ 'rETH', 'osETH', 'cbETH' ].map(symbol => picked(collateralOf(weth, symbol), 'collateral_value_status', 'is_strategic', ...decidedBy.shown, ...decidedBy.why)), [
      { collateral_value_status: 'fresh',       is_visible: true },
      { collateral_value_status: 'unavailable', is_visible: true },
      { collateral_value_status: 'fresh' },
    ], `${what}: in WETH's market, rETH, worth the threshold, and osETH, of a value nobody could read, are said to be shown, though not why, and cbETH, worth less, is told nothing`);
    const expected = unreadCollaterals(before, [ 'strategic' ]);
    for (const symbol of [ 'rETH', 'osETH' ]) {
      const fields = expected.get(nameOf({ entry: weth, collateral: collateralOf(weth, symbol) }))!;
      t.strictSame(Object.keys(collateralOf(weth, symbol)), keysOf(fields), `${what}: ${symbol} without what the strategic decisions decide, but for whether it is shown`);
    }
    t.strictSame(answered, unreadSummary(before, [ 'strategic' ]), `${what}: and everything else as when every decision was read`);
  }
});

/*
 * Nothing but the summaries of the markets is cached: the minutely summary
 * under its version, at the block of each market's minute, and in the
 * registry's namespace nothing the active reads do not keep. A minute nobody
 * has read costs a network four requests, the headers of its markets' blocks
 * read in the first round of its reads, and the next request of the minute
 * reads the latest blocks alone.
 */
t.test('the summary caches the minutely summaries of its markets alone, under their version', async t => {
  const { node, env, get } = await workerOf(t);
  await summaryOf(await get(EVERY_NETWORK));
  const networks = [ ...new Set(fixture.networks.map(network => network.key)) ];
  for (const network of networks) {
    t.equal(node.requests.filter(request => request.network === network).length, 4, `${network}: the latest block, then three rounds of reads`);
  }

  const keysOf  = async (kv: KVNamespace) => (await kv.list()).keys.map(entry => entry.name);
  const written = await keysOf(env.kv_mainnet);
  const markets = fixture.networks.flatMap(network => network.markets.map(entry => (
    `marketMinutelySummary-v${market.marketMinutelySummary.version}:(block:${MARKET_BLOCKS[`${network.chainId} ${entry.deploymentKey}`]};contract:${entry.contracts.comet}@`
  )));
  t.equal(written.length, markets.length, 'one record of each market');
  t.ok(markets.every(prefix => written.filter(key => key.startsWith(prefix)).length === 1),
    'the minutely summary of each, at the block of its minute, under its version');
  t.ok((await keysOf(env.kv_registry)).every(key => [ 'active:v1', DEPRECATED_KEY, HIDDEN_KEY ].includes(key) || key.startsWith('snapshot:')),
    'and in the registry\'s namespace nothing the active reads do not keep');

  node.requests.length = 0;
  await summaryOf(await get(EVERY_NETWORK));
  t.equal(node.requests.length, networks.length, 'the next request of the minute reads the latest block of each network alone');
  t.strictSame(await keysOf(env.kv_mainnet), written, 'writing nothing more');
});
