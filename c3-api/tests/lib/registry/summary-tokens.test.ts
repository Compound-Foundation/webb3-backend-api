import t from 'tap';

import type * as KnownNetwork from '../../../lib/well-known/networks/network.js';
import type { Address } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import type { Catalog } from '../../../src/registry/catalog.js';
import { DEPRECATED_RECORD, HIDDEN_RECORD } from '../../../src/registry/collateral-decisions.js';
import { decisionSetOf } from '../../../src/registry/decision-records.js';
import { chainTokens, withTokenFields } from '../../../src/registry/summary-tokens.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { NO_DECISIONS } from '../../util/summary-decisions.js';

/*
 * What /summary says of a collateral's token across its chain but its
 * strategic mark (collateralFields), without a node: the roles the token
 * plays in the markets the chain serves, and where the collateral decisions
 * of those markets deprecate and hide it. Mainnet's weETH is a collateral of
 * the USDC, WETH and USDT markets of the fixture; mETH and XAUt of the USDT
 * market alone, and pumpBTC of the WBTC market.
 */
const NOW      = new Date('2026-10-05T12:00:30.000Z');
const snapshot = loadRegistrySnapshotFixture();
const catalog  = catalogOf(snapshot, NOW);

// the Comets of mainnet's markets, lowercase, as a chain's facts name them
const USDC_COMET = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WETH_COMET = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
const USDT_COMET = '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840';

type Collateral = { chainId: number, cometAddress: Address, tokenAddress: Address };

const MAINNET = snapshot.networks.find(network => network.chainId === 1)!;
// a token of the fixture's chain `chainId` by its symbol, wherever its markets name it
const tokenOn = (chainId: number, symbol: string) => snapshot.networks.find(network => network.chainId === chainId)!.markets
  .flatMap(entry => [ entry.baseAsset.token, ...(entry.rewardAsset === null ? [] : [ entry.rewardAsset.token ]), ...entry.collateralAssets.map(asset => asset.token) ])
  .find(token => token.symbol === symbol)!.address;
const token = (symbol: string) => tokenOn(1, symbol);
// a decision of mainnet about a token as a collateral of a Comet
const decided = (...pairs: Array<[ Address, Address ]>): Collateral[] => pairs.map(([ cometAddress, tokenAddress ]) => ({ chainId: 1, cometAddress, tokenAddress }));

// a chain of `within` under the deprecated and the hidden decisions given, every other kind read and deciding nothing
const chainOf = (
  within: Catalog,
  network: KnownNetwork.Name,
  chainId: number,
  { deprecated = [], hidden = [] }: { deprecated?: Collateral[], hidden?: Collateral[] } = {},
) => chainTokens(within, network, chainId, {
  ...NO_DECISIONS,
  deprecated: { decisions: decisionSetOf(DEPRECATED_RECORD, deprecated), recorded: false },
  hidden:     { decisions: decisionSetOf(HIDDEN_RECORD, hidden), recorded: false },
});
const mainnet = (decisions: { deprecated?: Collateral[], hidden?: Collateral[] } = {}, within = catalog) => chainOf(within, 'ethereum-mainnet', 1, decisions);

// what the decisions say of a token across mainnet: whether it is deprecated in every enabled market, and where it is deprecated and hidden
const decisionsOf = (address: Address, decisions: { deprecated?: Collateral[], hidden?: Collateral[] }, within = catalog) => {
  const { isDeprecated, deprecatedIn, hiddenIn } = mainnet(decisions, within).factsOf(address);
  return { isDeprecated, deprecatedIn, hiddenIn };
};

// the fixture with the mainnet markets of the deployment keys given set to a status of the market, not a decision about a collateral
const withStatus = (statuses: Record<string, 'deprecated' | 'disabled'>) => catalogOf({
  ...snapshot,
  networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
    ...network,
    markets: network.markets.map(entry => entry.deploymentKey in statuses ? { ...entry, status: statuses[entry.deploymentKey]! } : entry),
  }),
}, NOW);

t.test('a token plays every role it has in the markets its chain serves', async t => {
  t.strictSame(mainnet().factsOf(token('COMP')).roles, [ 'reward', 'collateral' ], 'COMP is both a reward and a collateral on mainnet');
  t.strictSame(mainnet().factsOf(token('USDC')).roles, [ 'base', 'collateral' ], 'USDC both a base asset and a collateral');
  t.strictSame(mainnet().factsOf(token('XAUt')).roles, [ 'collateral' ], 'and XAUt a collateral alone');

  const scroll = chainOf(catalog, 'scroll-mainnet', 534352);
  t.strictSame(scroll.factsOf(tokenOn(534352, 'COMP')).roles, [ 'reward' ], 'on Scroll, COMP is a reward alone');
  t.strictSame(scroll.factsOf(tokenOn(534352, 'USDC')).roles, [ 'base' ], 'and USDC a base asset alone');
});

t.test('a disabled market plays no role, and a deprecated one still does', async t => {
  const changed = mainnet({}, withStatus({ wbtc: 'disabled', usdt: 'deprecated' }));
  t.strictSame(changed.factsOf(token('pumpBTC')), { roles: [], isDeprecated: false, deprecatedIn: [], hiddenIn: [] },
    'pumpBTC, which only the disabled WBTC market takes, plays no role on the chain');
  t.strictSame(changed.factsOf(token('XAUt')).roles, [ 'collateral' ], 'XAUt, which only the deprecated USDT market takes, is still a collateral');
});

/*
 * Nothing about a token across its chain is a value: what the chain holds of
 * a token decides nothing. Its strategic mark, though the chain's as well, is
 * no fact of the chain either: it is one lookup, made where each collateral is
 * described (collateralFields), which asks the rule with it and leaves it out
 * where the marks could not be read.
 */
t.test('a token says its roles and where it is deprecated and hidden across its chain, and nothing else', async t => {
  const facts = mainnet({ deprecated: decided([ USDT_COMET, token('weETH') ]), hidden: decided([ USDC_COMET, token('weETH') ]) }).factsOf(token('weETH'));
  t.strictSame(facts, { roles: [ 'collateral' ], isDeprecated: false, deprecatedIn: [ USDT_COMET ], hiddenIn: [ USDC_COMET ] },
    'weETH: a collateral, deprecated in USDT\'s market and hidden in USDC\'s');
});

/*
 * Deprecated collateral (migrations 0006 and 0007): a decision is about one
 * collateral of one Comet, and a token of a chain says where it is one, and
 * whether it is one in every enabled market that takes it.
 */
t.test('a token is deprecated across its chain only where every enabled market that takes it marks it so', async t => {
  const [ WEETH, METH, XAUT ] = [ token('weETH'), token('mETH'), token('XAUt') ];

  t.strictSame(decisionsOf(WEETH, { deprecated: decided([ USDC_COMET, WEETH ], [ USDT_COMET, WEETH ]) }),
    { isDeprecated: false, deprecatedIn: [ USDT_COMET, USDC_COMET ], hiddenIn: [] },
    'deprecated in two of the three enabled markets that take it is not deprecated, and names the two, sorted');
  t.strictSame(decisionsOf(WEETH, { deprecated: decided([ USDC_COMET, WEETH ], [ USDT_COMET, WEETH ], [ WETH_COMET, WEETH ]) }),
    { isDeprecated: true, deprecatedIn: [ USDT_COMET, WETH_COMET, USDC_COMET ], hiddenIn: [] }, 'deprecated in all three is');
  t.strictSame(decisionsOf(METH, { deprecated: decided([ USDT_COMET, METH ]) }), { isDeprecated: true, deprecatedIn: [ USDT_COMET ], hiddenIn: [] },
    'as is a token deprecated in the one market that takes it');

  t.strictSame(decisionsOf(METH, { deprecated: decided([ USDC_COMET, METH ]) }), { isDeprecated: false, deprecatedIn: [], hiddenIn: [] },
    'a decision about a Comet that does not take the token as collateral marks nothing');
  t.strictSame(decisionsOf(METH, { deprecated: [ { chainId: 8453, cometAddress: USDT_COMET, tokenAddress: METH } ] }), { isDeprecated: false, deprecatedIn: [], hiddenIn: [] },
    'and a decision belongs to its chain: one about the same Comet and token on another chain marks nothing');
  t.strictSame(decisionsOf(token('WETH'), {}), { isDeprecated: false, deprecatedIn: [], hiddenIn: [] }, 'nobody deciding is nothing deprecated');

  const changed = withStatus({ weth: 'deprecated', usdt: 'deprecated' });
  t.strictSame(decisionsOf(WEETH, { deprecated: decided([ USDC_COMET, WEETH ], [ USDT_COMET, WEETH ]) }, changed),
    { isDeprecated: true, deprecatedIn: [ USDT_COMET, USDC_COMET ], hiddenIn: [] },
    'a market whose status is deprecated does not keep a token current where it does not mark it');
  t.strictSame(decisionsOf(XAUT, { deprecated: decided([ USDT_COMET, XAUT ]) }, changed), { isDeprecated: false, deprecatedIn: [ USDT_COMET ], hiddenIn: [] },
    'and a token only such a market takes is named there, but no enabled market makes it deprecated');

  const usdt     = MAINNET.markets.find(entry => entry.deploymentKey === 'usdt')!;
  const everyone = mainnet({ deprecated: decided(...usdt.collateralAssets.map((asset): [ Address, Address ] => [ USDT_COMET, asset.token.address ])) });
  t.strictSame(usdt.collateralAssets.filter(asset => everyone.factsOf(asset.token.address).isDeprecated).map(asset => asset.token.symbol).sort(),
    [ 'XAUt', 'mETH', 'sFRAX', 'wUSDM' ], 'with every collateral of the USDT market deprecated, the tokens no other market takes are deprecated across the chain');
  t.strictSame(everyone.factsOf(token('COMP')), { roles: [ 'reward', 'collateral' ], isDeprecated: false, deprecatedIn: [ USDT_COMET ], hiddenIn: [] },
    'and COMP, the reward of every market, is named where it is a deprecated collateral');
});

/*
 * Hidden collateral (migration 0008): a decision is about one collateral of
 * one Comet, as a deprecated one is, and a token of a chain says where it is
 * hidden. It has no flag of its own across the chain: whether discovery shows
 * the token is each market's to say, by its own decisions.
 */
t.test('a token of a chain names the Comets that hide it, and is not hidden across the chain', async t => {
  const [ WEETH, METH ] = [ token('weETH'), token('mETH') ];

  t.strictSame(decisionsOf(WEETH, { hidden: decided([ USDC_COMET, WEETH ], [ USDT_COMET, WEETH ], [ WETH_COMET, WEETH ]) }),
    { isDeprecated: false, deprecatedIn: [], hiddenIn: [ USDT_COMET, WETH_COMET, USDC_COMET ] }, 'hidden in all three markets that take it, it is named in each');
  t.strictSame(decisionsOf(WEETH, {
    hidden:     decided([ USDC_COMET, WEETH ]),
    deprecated: decided([ USDC_COMET, WEETH ], [ USDT_COMET, WEETH ], [ WETH_COMET, WEETH ]),
  }), { isDeprecated: true, deprecatedIn: [ USDT_COMET, WETH_COMET, USDC_COMET ], hiddenIn: [ USDC_COMET ] }, 'and hiding it does not stop it being deprecated');
  t.strictSame(decisionsOf(METH, { hidden: decided([ USDC_COMET, METH ]) }), { isDeprecated: false, deprecatedIn: [], hiddenIn: [] },
    'a decision about a Comet that does not take the token as collateral hides nothing');
  t.strictSame(decisionsOf(METH, { hidden: [ { chainId: 8453, cometAddress: USDT_COMET, tokenAddress: METH } ] }), { isDeprecated: false, deprecatedIn: [], hiddenIn: [] },
    'and a decision belongs to its chain: one about the same Comet and token on another chain hides nothing');
  t.strictSame(decisionsOf(WEETH, { hidden: decided([ USDT_COMET, WEETH ]) }, withStatus({ usdt: 'deprecated' })),
    { isDeprecated: false, deprecatedIn: [], hiddenIn: [ USDT_COMET ] }, 'a market whose status is deprecated is named where it hides the token');
  t.strictSame(mainnet({ hidden: decided([ USDT_COMET, METH ]) }).factsOf(METH), { roles: [ 'collateral' ], isDeprecated: false, deprecatedIn: [], hiddenIn: [ USDT_COMET ] },
    'which no flag across the chain says');
});

/*
 * The block a market was read at and the value of each collateral as it was
 * read are the computation's: /summary answers them in fields of its own, so
 * a market or a collateral of its answer that still carries them is a type
 * error the build expects.
 */
t.test('a market of the summary carries neither the block it was read at nor the values as they were read', async () => {
  (...[ read, contract, chain ]: Parameters<typeof withTokenFields>) => {
    const answered = withTokenFields(read, contract, chain);
    return [
      // @ts-expect-error the block the market was read at
      answered.marketBlock,
      // @ts-expect-error a collateral's value as it was read
      answered.collaterals?.[0]?.valueUsd,
    ];
  };
});
