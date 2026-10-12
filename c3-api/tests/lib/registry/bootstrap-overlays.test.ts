import t from 'tap';

import * as Eth from '../../../lib/eth-constants.js';

import type { Generated, Note } from '../../../src/registry/bootstrap.js';
import { bundleOf, marketOverlay, networkOverlay, reviewDocument } from '../../../src/registry/bootstrap.js';
import { parseMarketOverlay, parseNetworkOverlay } from '../../../src/registry/overlay.js';
import { staticComets } from '../../../src/registry/shadow.js';

/*
 * What the bootstrap script proposes for the first version of a registry.
 *
 * Every value it writes is a decision this API already acts on, taken from
 * the static constants and from the branches the registry replaced. These
 * tests pin the derivations, because a wrong one would be reviewed as if it
 * were how the API behaves today — and a review that confirms the wrong thing
 * is worse than no review.
 */
function comet(network: string, alias: string): any {
  return (Eth.wellKnownContractsByNetwork as any)[network]['Comet'][alias];
}

function overlayFor(network: any, deploymentKey: string, alias: string | null) {
  const notes: Note[] = [];
  const overlay = marketOverlay(network, deploymentKey, alias === null ? undefined : comet(network, alias), notes);
  return { overlay, notes };
}

t.test('a market is proposed as the constants describe it', async t => {
  const { overlay } = overlayFor('ethereum-mainnet', 'usdc', 'cUSDCv3');

  t.equal(overlay.displayName, 'USDC', 'the base symbol names the market');
  t.equal(overlay.contractName, 'cUSDCv3', 'and the constants name the contract');
  t.equal(overlay.status, 'enabled', 'every market described here is served today');
  t.equal(overlay.creationBlock, 15331586, 'the creation block comes from the constants');
  t.equal(overlay.isDefault, true, 'mainnet USDC is the market the application opens');
  t.equal(overlay.baseAsset.displayName, 'USD Coin');
  t.equal(overlay.baseAsset.isWrappedNative, false);
  t.equal(overlay.collateralValueQuote, 'usd', 'a market with no USD conversion quotes USD');
  t.same(overlay.capabilities, { rewards: true, accountRewards: true, transactionHistory: true });
  t.same(overlay.rewardPriceFeed, { address: '0xdbd020caef83efd542f4de03e3cf0c28a4428bd5', quote: 'usd' });
});

t.test('only the markets that had reachable history keep it', async t => {
  t.equal(overlayFor('ethereum-mainnet', 'usdt', 'cUSDTv3').overlay.capabilities.transactionHistory, true,
    'a market the hand-written stream list carried');
  t.equal(overlayFor('ethereum-mainnet', 'wbtc', 'cWBTCv3').overlay.capabilities.transactionHistory, false,
    'and one it did not, which had no reachable history at all');
  t.equal(overlayFor('base-mainnet', 'aero', 'cAEROv3').overlay.capabilities.transactionHistory, false);
});

/*
 * Rewards were skipped by network name before the registry, because no reward
 * feed answers there. The proposal states it per market, which is where the
 * decision belongs.
 */
t.test('a network without a reward feed proposes no rewards', async t => {
  const { overlay, notes } = overlayFor('scroll-mainnet', 'usdc', 'cUSDCv3');

  t.same(overlay.capabilities, { rewards: false, accountRewards: false, transactionHistory: false });
  t.equal(overlay.rewardPriceFeed, null, 'and no reward feed to value them with');
  t.same(notes, [], 'which leaves nothing to decide, whatever feed the constants name for it');
});

/*
 * A market is labelled as the frontend lists it, which is not what its token
 * or the constants call it: the frontend wraps the native token for the user,
 * tells bridged USDC apart, and follows Tether's renaming.
 */
t.test('a market is labelled as the frontend lists it', async t => {
  for (const [ network, deploymentKey, alias, label, name ] of [
    [ 'ethereum-mainnet', 'weth',               'cWETHv3',   'ETH',    'Ether' ],
    [ 'ethereum-mainnet', 'institutional_usdc', 'ciUSDCv3',  'USDC',   'USDC Institutional' ],
    [ 'polygon-mainnet',  'usdc',               'cUSDCv3',   'USDC.e', 'USD Coin (Bridged)' ],
    [ 'polygon-mainnet',  'usdt',               'cUSDTv3',   'USDT0',  'Tether' ],
    [ 'arbitrum-mainnet', 'usdt',               'cUSDTv3',   'USD₮0',  'Tether' ],
    [ 'ronin-mainnet',    'weth',               'cWETHv3',   'WETH',   'Wrapped Ether' ],
    [ 'ronin-mainnet',    'wron',               'cWRONv3',   'RON',    'Ronin' ],
  ] as const) {
    const { overlay, notes } = overlayFor(network, deploymentKey, alias);
    t.same([ overlay.displayName, overlay.baseAsset.displayName ], [ label, name ], `${network}/${deploymentKey} is ${label}`);
    t.notOk(notes.some(note => note.open), 'which leaves nothing to decide');
  }

  /*
   * Two mainnet markets are labelled USDC. The frontend addresses the
   * institutional one by its slug and lists it in its own section, and the
   * other keeps its label as its key.
   */
  const institutional = overlayFor('ethereum-mainnet', 'institutional_usdc', 'ciUSDCv3').overlay;
  t.same([ institutional.slug, institutional.isInstitutional ], [ 'usdc-institutional', true ],
    'the institutional market is addressed by its slug, in its own section');
  const standard = overlayFor('ethereum-mainnet', 'usdc', 'cUSDCv3').overlay;
  t.same([ standard.slug, standard.isInstitutional ], [ null, false ], 'the standard one by its label');

  const unlisted = overlayFor('ethereum-mainnet', 'not-in-the-frontend', 'cUSDCv3');
  t.equal(unlisted.overlay.displayName, 'USDC', 'a deployment the frontend does not list keeps the constants\' symbol');
  t.ok(unlisted.notes.some(note => note.field === 'displayName, baseAsset.displayName' && note.open),
    'and its label is left for someone to decide');
});

/*
 * The constants declare COMP rewards for ciUSDCv3 only to keep one
 * CometRewards per network. The chain has none for it, so the import writes
 * no reward asset, and a proposed reward feed would be refused.
 */
t.test('a market with no rewards configured proposes none, on a network that has them', async t => {
  const { overlay, notes } = overlayFor('ethereum-mainnet', 'institutional_usdc', 'ciUSDCv3');

  t.same(overlay.capabilities, { rewards: false, accountRewards: false, transactionHistory: true },
    'rewards are off, while the history it had stays');
  t.equal(overlay.rewardPriceFeed, null, 'and there is no reward feed to propose');
  t.ok(notes.some(note => note.field.startsWith('capabilities.rewards') && !note.open && /zero address/.test(note.source)),
    'the review says what the chain answered');

  t.equal(overlayFor('ethereum-mainnet', 'usdc', 'cUSDCv3').overlay.capabilities.rewards, true,
    'the other markets of the network keep theirs');
});

/*
 * A market whose own feed does not quote USD was converted by hand in the
 * rewards APR computations. The proposal carries that conversion as the
 * market's quote unit and USD feed.
 */
t.test('a base-quoted market proposes the feed its APR was converted through', async t => {
  const weth = overlayFor('ethereum-mainnet', 'weth', 'cWETHv3');
  t.equal(weth.overlay.collateralValueQuote, 'base');
  t.equal(weth.overlay.baseAsset.usdPriceFeedAddress, '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
    'the USD feed the constants carry beside the base feed');
  t.equal(weth.overlay.baseAsset.isWrappedNative, true, 'and its base asset is the chain\'s wrapped native token');
  t.equal(weth.overlay.rewardPriceFeed?.quote, 'base', 'its reward feed, COMP / ETH, prices COMP in the base asset');
  t.equal(weth.overlay.contractName, 'cWETHv3', 'and the constants name the contract like every other market');
  t.notOk(weth.notes.some(note => note.open), 'so nothing about it is left to decide');

  const wbtc = overlayFor('ethereum-mainnet', 'wbtc', 'cWBTCv3');
  t.equal(wbtc.overlay.collateralValueQuote, 'base');
  t.equal(wbtc.overlay.baseAsset.usdPriceFeedAddress, '0xf4030086522a5beea4988f8ca5b36dbc97bee88c',
    'taken from the APR branch, because the constants carry no USD feed for it');
  t.ok(
    wbtc.notes.some(note => /rewards APR branches/.test(note.source)),
    'and the review says where that came from',
  );
});

/*
 * Whether a reward feed prices COMP in USD or in the base asset is not in its
 * decimals: Linea's COMP / ETH answers with eight, as every COMP / USD feed
 * does. Proposed as USD, Linea WETH served COMP priced in ETH as if in USD.
 */
t.test('a reward feed is quoted in the unit it answers in, whatever its decimals', async t => {
  const lineaWeth = overlayFor('linea-mainnet', 'weth', 'cWETHv3');
  t.same(lineaWeth.overlay.rewardPriceFeed, { address: '0x6af327313876ef9a5d342105747ebf3aa2543547', quote: 'base' },
    'COMP / ETH with eight decimals is quoted in the base asset');
  const lineaUsdc = overlayFor('linea-mainnet', 'usdc', 'cUSDCv3');
  t.same(lineaUsdc.overlay.rewardPriceFeed, { address: '0xc0068a2f7e4847df9c3a34b27ccc07b7e15e0458', quote: 'usd' },
    'and COMP / USD, with the same eight, in USD');
});

/*
 * The constants and the APR branches offer AERO and USDe a USD feed, but the
 * feeds of both markets already answer in USD. Taking the offer would state a
 * base quote the chain contradicts, and validation refuses a USD-quoted market
 * that carries a USD feed.
 */
t.test('a market whose own feeds answer in USD takes no USD feed', async t => {
  for (const [ network, deploymentKey, alias, offered ] of [
    [ 'base-mainnet',   'aero', 'cAEROv3', '0x4ec5970fc728c5f65ba413992cd5ff6fd70fcff0' ],
    [ 'mantle-mainnet', 'usde', 'cUSDev3', '0xc49e06b50fca57751155da78803dca691afcdb22' ],
  ] as const) {
    const { overlay, notes } = overlayFor(network, deploymentKey, alias);
    t.equal(overlay.collateralValueQuote, 'usd', `${alias} is quoted in USD`);
    t.equal(overlay.baseAsset.usdPriceFeedAddress, null, 'and carries no USD feed');
    t.ok(
      notes.some(note => note.field === 'baseAsset.usdPriceFeedAddress' && !note.open && note.source.includes(offered)),
      'the review names the feed it was offered and says why it was declined',
    );
  }
});

/*
 * The quote is the unit the chain answers in, so the set of base-quoted
 * markets is a fact about the deployments, pinned here as it was read from
 * each Comet's base token feed.
 */
t.test('only the markets whose feeds answer in their base asset are quoted in it', async t => {
  const quotedInBase: string[] = [];
  for (const network of Object.keys(Eth.wellKnownContractsByNetwork).filter(name => name.endsWith('-mainnet'))) {
    const comets = new Map<string, any>();
    for (const candidate of Object.values((Eth.wellKnownContractsByNetwork as any)[network]['Comet'] ?? {}) as any[]) {
      comets.set(candidate.address.toLowerCase(), candidate);
    }
    for (const candidate of comets.values()) {
      if (marketOverlay(network as never, 'key', candidate, []).collateralValueQuote === 'base') {
        quotedInBase.push(`${network}/${candidate.displayName}`);
      }
    }
  }

  t.same(quotedInBase.sort(), [
    'arbitrum-mainnet/cWETHv3',
    'base-mainnet/cWETHv3',
    'ethereum-mainnet/cWBTCv3',
    'ethereum-mainnet/cWETHv3',
    'ethereum-mainnet/cwstETHv3',
    'linea-mainnet/cWETHv3',
    'optimism-mainnet/cWETHv3',
    'ronin-mainnet/cWETHv3',
    'unichain-mainnet/cWETHv3',
  ], 'the constant-priced WETH and wstETH markets and WBTC, priced in BTC');
});

/*
 * A market the constants do not describe has nothing to propose from, so
 * every field is a placeholder. Saying so is the point: the operator has to
 * decide, and a placeholder that looked plausible would be reviewed as if it
 * were the current behaviour.
 */
t.test('a market no source describes is proposed as placeholders, loudly', async t => {
  const { overlay, notes } = overlayFor('ethereum-mainnet', 'brand-new', null);

  t.equal(overlay.contractName, null);
  t.equal(overlay.creationBlock, 0, 'there is no creation block to take');
  t.equal(overlay.displayName, 'BRAND-NEW', 'the deployment key stands in for a name');
  t.equal(overlay.rewardPriceFeed, null);
  t.ok(
    notes.some(note => note.field === 'the whole market' && note.open),
    'the review says every field of it is undecided',
  );
});

t.test('a network proposes the exceptions that were compiled into the price computation', async t => {
  const mainnet = networkOverlay('ethereum-mainnet');

  t.equal(mainnet.displayName, 'Ethereum');
  t.same(mainnet.priceExceptions.map((exception: any) => [ exception.kind, exception.priceFeedAddress ]), [
    [ 'fixed_price', '0x351a133fd850ea81ed8a782016e308acbaddec91' ],
    [ 'zero_price',  '0xe3a409ed15cd53afdefdd191ad945cec528a2496' ],
  ], 'the pumpBTC and wUSDM feeds asset-price.ts refused to read');
  t.ok(mainnet.priceExceptions.every((exception: any) => exception.provenance.length > 20),
    'each says why it exists, which is what an operator reviews');

  t.same(
    networkOverlay('optimism-mainnet').priceExceptions.map(exception => exception.priceFeedAddress),
    [ '0x66228d797eb83ecf3465297751f6b1d4d42b7627', '0x7e86318cc4bc539043f204b39ce0ebed9f0050dc' ],
  );
  t.same(networkOverlay('base-mainnet').priceExceptions, [], 'a network that had none proposes none');
});

const NATIVE = '0x0000000000000000000000000000000000000000';

/*
 * Presentation exists only in the frontend, so the proposal carries it as
 * copied from there. What these tests pin is the shape the registry reads it
 * in, and the two addresses written as the frontend behaves rather than as
 * it stores them.
 */
t.test('a network proposes how the frontend presents its assets', async t => {
  const mainnet = networkOverlay('ethereum-mainnet');

  t.same(mainnet.assetDisplayOverrides[0], {
    tokenAddress:   '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    displayAddress: NATIVE,
    symbol:         'ETH',
    name:           'Ether',
  }, 'WETH is shown as the chain\'s own token');
  t.same(
    mainnet.assetDisplayOverrides.find(override => override.symbol === 'wstETH'),
    {
      tokenAddress:   '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
      displayAddress: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
      symbol:         'wstETH',
      name:           'Lido Wrapped Staked ETH',
    },
    'and a token only renamed keeps its own address',
  );
  t.same(mainnet.unwrappedCollateralAssets, [ {
    wrappedTokenAddress: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
    tokenAddress:        '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
    symbol:              'stETH',
    name:                'Lido Staked ETH',
  } ], 'stETH may be supplied for the bulker to wrap into wstETH');
});

t.test('the frontend\'s behaviour decides a display address, not what it stores', async t => {
  const notes: Note[] = [];

  const [ wron ] = networkOverlay('ronin-mainnet', notes).assetDisplayOverrides;
  t.equal(wron!.displayAddress, NATIVE, 'WRON is shown and supplied as RON, the native token');

  const weth = networkOverlay('mantle-mainnet', notes).assetDisplayOverrides.find(override => override.symbol === 'ETH');
  t.equal(weth!.displayAddress, weth!.tokenAddress, 'Mantle\'s WETH is only renamed: Mantle\'s own token is MNT');

  t.same(notes.map(note => [ note.scope, note.open ]), [
    [ 'chain ronin-mainnet',  false ],
    [ 'chain mantle-mainnet', false ],
  ], 'and the review says why each departs from the frontend\'s file');
});

t.test('every network proposal is one the admin route accepts', async t => {
  for (const network of [
    'ethereum-mainnet', 'optimism-mainnet', 'polygon-mainnet', 'arbitrum-mainnet', 'base-mainnet',
    'scroll-mainnet', 'mantle-mainnet', 'linea-mainnet', 'unichain-mainnet', 'ronin-mainnet',
  ] as const) {
    const overlay = networkOverlay(network);
    t.ok(overlay.assetDisplayOverrides.length > 0, `${network} has display overrides`);
    t.doesNotThrow(() => parseNetworkOverlay(overlay), 'which parse: addresses are well formed and none repeats');
  }
});

/*
 * A proposal has the overlay's types, so the compiler holds its keys, but not
 * the values the route refuses, and one document refused refuses the whole
 * directory. A deployment the frontend does not list is named by the
 * constants alone, which is where a Comet described without a name for its
 * base asset would surface.
 */
t.test('every market proposal is one the admin route accepts', async t => {
  for (const network of Object.keys(Eth.wellKnownContractsByNetwork).filter(name => name.endsWith('-mainnet'))) {
    const comets = staticComets(network as never);
    t.ok(comets.size > 0, `${network} has Comets`);
    for (const candidate of comets.values()) {
      t.doesNotThrow(
        () => parseMarketOverlay(marketOverlay(network as never, 'not-in-the-frontend', candidate, [])),
        `${network} ${candidate.displayName} parses, named by the constants alone`,
      );
    }
  }
});

/*
 * The review document (`GET /versions/{id}/proposal/review`) is what an
 * operator reads instead of 39 documents, so every decision has to be in it,
 * and what is open has to be told apart from what merely needs saying.
 */
function generatedFor(markets: Array<[ string, string, string | null ]>): Generated {
  const notes: Note[] = [];
  return {
    commit: 'a'.repeat(40),
    reason: 'bootstrap',
    notes,
    networks: [ { chainId: 1, network: 'ethereum-mainnet', overlay: networkOverlay('ethereum-mainnet', notes) } ],
    markets: markets.map(([ network, deploymentKey, alias ]) => ({
      chainId: 1,
      network: network as never,
      deploymentKey,
      overlay: marketOverlay(network as never, deploymentKey, alias === null ? undefined : comet(network, alias), notes),
    })),
  };
}

/*
 * The bundle is the body of the route that applies it, so what the review
 * document describes is exactly what one request writes.
 */
t.test('the bundle is the request body, keyed by what each overlay reviews', async t => {
  const generated = generatedFor([ [ 'ethereum-mainnet', 'usdc', 'cUSDCv3' ] ]);
  const bundle    = bundleOf(generated);

  t.same(Object.keys(bundle), [ 'reason', 'networks', 'markets' ]);
  t.equal(bundle.reason, 'bootstrap', 'one reason for every audit event of the request');
  t.same(Object.keys(bundle.networks), [ '1' ], 'networks by chain id');
  t.same(Object.keys(bundle.markets), [ '1/usdc' ], 'markets by chain id and deployment key');
  t.equal(bundle.markets['1/usdc'], generated.markets[0]!.overlay, 'carrying the proposed overlay unchanged');
});

t.test('the review document puts every decision in a table', async t => {
  const document = reviewDocument(generatedFor([
    [ 'ethereum-mainnet', 'usdc', 'cUSDCv3' ],
    [ 'ethereum-mainnet', 'weth', 'cWETHv3' ],
  ]), 'compound-foundation/comet', '0123456789abcdef');

  t.match(document, '| ethereum-mainnet | usdc | USDC | — | no | USD Coin | `cUSDCv3` | enabled | yes | 15331586 | yes | yes | yes |',
    'names, status, the default, the creation block and every capability of a market');
  t.match(document,
    '| ethereum-mainnet | weth | ETH | yes | base | `0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419` ' +
    '| `0x1b39ee86ec5979ba5c322b826b3ecb8c79991699` | base |',
    'and how it is priced');
  t.match(document, /0x351a133fd850ea81ed8a782016e308acbaddec91` fixed at 1\.02447384: PumpBTC/,
    'a fixed price reads as the feed would report it');
  t.match(document, /## Needs a decision\n\nNothing\./, 'with nothing open, the review says so');
  t.match(document, /Reward quote: `usd`, except where the reward feed answers in the base asset/,
    'the reward quote is explained by the rule the proposal follows');
  t.match(document, /cWETHv3 on ethereum-mainnet, cWETHv3 on linea-mainnet \(COMP \/ ETH\)/);
  t.notMatch(document, /eighteen/, 'never by decimals, which cannot tell');
  t.match(document, '| ethereum-mainnet | `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` | ETH | Ether | the chain\'s own token |',
    'the presentation of each asset');
  t.match(document, /`0xae7ab96520de3a18e5e111b5eaab095312d7fe84` stETH \(Lido Staked ETH\) as `0x7f39/,
    'and the collateral that may be supplied unwrapped');
  t.match(document, /Presentation: copied from woof-software\/webb3-frontend@98c38cd/,
    'with the commit it was copied from');
  t.match(document, /Labels .*\n.*woof-software\/webb3-frontend@98c38cd.* src\/helpers\/markets\.ts/,
    'and so do the labels');
});

t.test('what is open is listed apart from what is merely derived', async t => {
  const document = reviewDocument(generatedFor([
    [ 'ethereum-mainnet', 'brand-new', null ],
    [ 'ethereum-mainnet', 'wbtc', 'cWBTCv3' ],
  ]), 'compound-foundation/comet', '0123456789abcdef');

  const [ open, rest ] = document.split('## Markets');
  t.match(open, /brand-new on ethereum-mainnet.*the whole market/, 'the undescribed market is a decision');
  t.notMatch(open, /wbtc/, 'a derived feed is not');
  t.match(rest, /wbtc on ethereum-mainnet.*WBTC-USD/, 'it is explained under where the values came from');
});
