import * as Eth          from '../../lib/eth-constants.js';
import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import type {
  Address,
  AssetDisplayOverrideV1,
  NetworkV1,
} from '../../lib/model/comet-registry.js';
import { marketKey } from '../../lib/model/comet-registry.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { sha256Hex } from '../../lib/hash.js';

import type { MarketOverlay, NetworkOverlay, OverlayPriceException } from './overlay.js';
import { staticComets } from './shadow.js';
import type { CometContract } from './shadow.js';


/*
 * The reviewed overlay of a registry that has never been activated.
 *
 * A version normally inherits its decisions — names, capabilities, quote
 * units, feeds, price exceptions, presentation — from the one that is already
 * active. The first version of an environment has nothing to inherit, so every
 * market and network has to be reviewed once — and the decisions are not
 * invented: the API already serves these markets today, and what it serves is
 * written in the static constants and in the branches the registry replaced.
 *
 * This proposes those decisions for the markets a candidate imported, so the
 * review is reading a document rather than typing 39 of them. It decides
 * nothing on its own: everything it derives is listed in the review with where
 * it came from, and a market the constants do not describe is not proposed at
 * all. The proposal is served by the admin routes of the Worker being
 * deployed, so it is built from the very release that will serve the markets,
 * and applied by its digest, so what is applied is exactly what was read.
 */
type NetworkName = KnownNetwork.Name;

/*
 * Why one value is what it is, where the general rules the review document
 * states do not already say so. An open note is one no source could answer:
 * somebody has to decide it before the version can be validated.
 */
type Note = {
  scope:   string,
  field:   string,
  value:   string,
  source:  string,
  open:    boolean,
};

/*
 * The documents the admin routes accept, in the shape this script proposes
 * them. The routes read a document as unknown, so a shape of its own here
 * would let a decision added to the overlay be left out of the proposal
 * until applying it is refused; these are the overlay's types instead. A
 * proposed market is one served today, and a base asset no source names is
 * proposed without a name, which the review lists as open.
 */
type MarketProposal = Omit<MarketOverlay, 'status' | 'baseAsset'> & {
  status:    'enabled',
  baseAsset: Omit<MarketOverlay['baseAsset'], 'displayName'> & { displayName: string | null },
};

type Presentation = Pick<NetworkOverlay, 'assetDisplayOverrides' | 'unwrappedCollateralAssets'>;

type NetworkProposal = NetworkOverlay;

/*
 * The markets whose transaction history this API served before the registry,
 * written out by hand in transaction-history-items-handler.ts. A market that
 * was not in that list had no reachable history, so this is the capability
 * as it stands today, not a new decision.
 */
const HISTORY_MARKETS: Partial<Record<NetworkName, string[]>> = {
  'ethereum-mainnet': [ 'cUSDCv3', 'cWETHv3', 'cUSDTv3', 'ciUSDCv3' ],
  'polygon-mainnet':  [ 'cUSDCv3' ],
  'arbitrum-mainnet': [ 'cUSDCv3', 'cUSDC.ev3' ],
  'base-mainnet':     [ 'cUSDCv3', 'cUSDbCv3', 'cWETHv3' ],
  'optimism-mainnet': [ 'cUSDCv3', 'cUSDTv3', 'cWETHv3' ],
};

/*
 * The networks market rewards and account rewards skipped by name, because
 * no reward price feed answers on them.
 */
const WITHOUT_REWARDS: NetworkName[] = [ 'scroll-mainnet', 'ronin-mainnet' ];

/*
 * Markets that have no rewards on a network that does: the rewards contract
 * answers the zero address for their reward token and both tracking speeds
 * are zero, so the import writes no reward asset for them. The constants
 * declare COMP rewards for ciUSDCv3 anyway, only to keep one CometRewards per
 * network; proposing a reward feed from that would be refused, because there
 * is no reward asset to carry it.
 */
const MARKETS_WITHOUT_REWARDS: Partial<Record<NetworkName, string[]>> = {
  'ethereum-mainnet': [ 'ciUSDCv3' ],
};

/*
 * The markets whose reward feed prices COMP in their base asset rather than
 * in USD. Decimals cannot tell: mainnet's COMP / ETH answers with eighteen,
 * but Linea's with eight, as every COMP / USD feed does. Read from each
 * feed's description() on chain: "COMP / ETH" and "COMP / ETH price feed".
 */
const REWARDS_QUOTED_IN_BASE: Partial<Record<NetworkName, string[]>> = {
  'ethereum-mainnet': [ 'cWETHv3' ],
  'linea-mainnet':    [ 'cWETHv3' ],
};

/*
 * The USD feed each base-quoted market was converted through, by the branches
 * the rewards APR computations carried. A market the constants already give a
 * `usdPriceFeed` is taken from there instead.
 */
const USD_CONVERSIONS: Partial<Record<NetworkName, Record<string, string>>> = {
  'ethereum-mainnet': { 'cwstETHv3': 'wstETH-USD', 'cWBTCv3': 'WBTC-USD' },
  'base-mainnet':     { 'cWETHv3':   'WETH-USD' },
  'arbitrum-mainnet': { 'cWETHv3':   'WETH-USD' },
  'optimism-mainnet': { 'cWETHv3':   'WETH-USD' },
  'unichain-mainnet': { 'cWETHv3':   'WETH-USD' },
  'mantle-mainnet':   { 'cUSDev3':   'cUSDev3-USD' },
};

/*
 * The markets whose own feeds answer in the base asset rather than in USD,
 * which is what a `base` collateral value quote states. Read from the base
 * token feed of each Comet: every WETH market and mainnet wstETH answer
 * "Constant price feed", mainnet WBTC answers "WBTC / BTC", and every other
 * base feed answers in USD.
 *
 * It is a table rather than a rule on the constants because they are wrong
 * in both directions: they put mainnet WBTC on the BTC/USD feed, and they
 * and the APR branches give AERO and USDe a USD feed although both markets'
 * own feeds already answer "AERO / USD" and "USDe / USD".
 */
const QUOTED_IN_BASE: Partial<Record<NetworkName, string[]>> = {
  'ethereum-mainnet': [ 'cWETHv3', 'cwstETHv3', 'cWBTCv3' ],
  'arbitrum-mainnet': [ 'cWETHv3' ],
  'base-mainnet':     [ 'cWETHv3' ],
  'linea-mainnet':    [ 'cWETHv3' ],
  'optimism-mainnet': [ 'cWETHv3' ],
  'ronin-mainnet':    [ 'cWETHv3' ],
  'unichain-mainnet': [ 'cWETHv3' ],
};

/*
 * The feeds asset-price.ts refused to read, with the reason each one was
 * added. They become the price exceptions of their network.
 */
const PRICE_EXCEPTIONS: Partial<Record<NetworkName, OverlayPriceException[]>> = {
  'ethereum-mainnet': [
    {
      kind:             'fixed_price',
      priceFeedAddress: '0x351a133fd850ea81ed8a782016e308acbaddec91',
      price:            { value: '102447384', decimals: 8 },
      provenance:       'PumpBTC / BTC exchange-rate feed (cWBTCv3 collateral) reverts since 2026-09-03; last answer of the retired aggregator 0x918c6cde1cdd940934820b8fa3a2c8b26a60736c (c3-api b7bb889)',
      expiresAt:        null,
    },
    {
      kind:             'zero_price',
      priceFeedAddress: '0xe3a409ed15cd53afdefdd191ad945cec528a2496',
      provenance:       'Deprecated wUSDM / USD feed (cUSDTv3 collateral) reverts; priced at zero by c3-api before the registry',
      expiresAt:        null,
    },
  ],
  'arbitrum-mainnet': [
    {
      kind:             'zero_price',
      priceFeedAddress: '0x13cdfb7db5e2f58e122b2e789b59de13645349c4',
      provenance:       'Deprecated feed priced at zero by c3-api asset-price.ts before the registry',
      expiresAt:        null,
    },
  ],
  'optimism-mainnet': [
    {
      kind:             'zero_price',
      priceFeedAddress: '0x66228d797eb83ecf3465297751f6b1d4d42b7627',
      provenance:       'Deprecated feed priced at zero by c3-api asset-price.ts before the registry',
      expiresAt:        null,
    },
    {
      kind:             'zero_price',
      priceFeedAddress: '0x7e86318cc4bc539043f204b39ce0ebed9f0050dc',
      provenance:       'Deprecated feed priced at zero by c3-api asset-price.ts before the registry; the branch that carried it applied to every network, which the registry makes explicit per network',
      expiresAt:        null,
    },
  ],
};

// the frontend commit the labels and the presentation below were copied from
const FRONTEND = 'woof-software/webb3-frontend@98c38cd16937206f3fbad59205343e4c9cf9d165';

/*
 * What the frontend calls each market: the label it lists the market under and
 * the name of its base asset. They are the frontend's decisions, not the
 * tokens' — it shows WETH markets as ETH because it wraps the native token
 * for the user, tells bridged USDC apart as USDC.e, and follows Tether's
 * renaming to USDT0 and USD₮0 — and the registry is where they move to, so a
 * label here is the one the frontend already shows. Copied from its
 * src/helpers/markets.ts, keyed by deployment.
 *
 * Two markets of one network may share a label only if a slug tells them
 * apart: the frontend addresses the institutional USDC market as
 * `usdc-institutional`, and lists it in its own institutional section.
 */
type MarketLabel = { symbol: string, name: string, slug?: string, institutional?: true };

const MARKET_LABELS: Partial<Record<NetworkName, Record<string, MarketLabel>>> = {
  'ethereum-mainnet': {
    'usdc':               { symbol: 'USDC',   name: 'USD Coin' },
    'weth':               { symbol: 'ETH',    name: 'Ether' },
    'usdt':               { symbol: 'USDT',   name: 'Tether' },
    'wsteth':             { symbol: 'wstETH', name: 'Lido Wrapped Staked ETH' },
    'usds':               { symbol: 'USDS',   name: 'USDS' },
    'wbtc':               { symbol: 'WBTC',   name: 'Wrapped BTC' },
    'institutional_usdc': { symbol: 'USDC',   name: 'USDC Institutional', slug: 'usdc-institutional', institutional: true },
  },
  'polygon-mainnet': {
    'usdc': { symbol: 'USDC.e', name: 'USD Coin (Bridged)' },
    'usdt': { symbol: 'USDT0',  name: 'Tether' },
  },
  'arbitrum-mainnet': {
    'usdc':   { symbol: 'USDC',   name: 'USD Coin' },
    'usdc.e': { symbol: 'USDC.e', name: 'USD Coin (Bridged)' },
    'weth':   { symbol: 'ETH',    name: 'Ether' },
    'usdt':   { symbol: 'USD₮0',  name: 'Tether' },
  },
  'optimism-mainnet': {
    'usdc': { symbol: 'USDC', name: 'USD Coin' },
    'usdt': { symbol: 'USDT', name: 'Tether' },
    'weth': { symbol: 'ETH',  name: 'Ether' },
  },
  'base-mainnet': {
    'usdc':  { symbol: 'USDC',  name: 'USD Coin' },
    'usdbc': { symbol: 'USDbC', name: 'USD Coin (Bridged)' },
    'usds':  { symbol: 'USDS',  name: 'USDS' },
    'weth':  { symbol: 'ETH',   name: 'Ether' },
    'aero':  { symbol: 'AERO',  name: 'Aero' },
  },
  'scroll-mainnet': {
    'usdc': { symbol: 'USDC', name: 'USD Coin' },
  },
  'mantle-mainnet': {
    'usde': { symbol: 'USDe', name: 'Ethena USDe' },
  },
  'linea-mainnet': {
    'usdc': { symbol: 'USDC', name: 'USD Coin' },
    'weth': { symbol: 'ETH',  name: 'Ether' },
  },
  'unichain-mainnet': {
    'usdc': { symbol: 'USDC', name: 'USD Coin' },
    'weth': { symbol: 'ETH',  name: 'Ether' },
  },
  'ronin-mainnet': {
    'weth': { symbol: 'WETH', name: 'Wrapped Ether' },
    'wron': { symbol: 'RON',  name: 'Ronin' },
  },
};

/*
 * How the frontend presents the assets of each network: the symbol and name
 * a token is shown with, and the collateral a user may supply unwrapped for
 * the bulker to wrap. No chain, source repository or constant of this Worker
 * states them — they exist only in the frontend, and are copied here once so
 * the first version of the registry carries them and that file stops being
 * where they are decided. Copied from its src/constants/chains.ts.
 *
 * A display address of zero shows a wrapped native token as the chain's own
 * token. The frontend decides that by symbol and never reads the address it
 * keeps, so two addresses are written here as it behaves rather than as it
 * stores them: Ronin's WRON is shown and supplied as RON, and Mantle's WETH,
 * which is not Mantle's own token, is only renamed.
 */
const NATIVE = '0x0000000000000000000000000000000000000000';

function shown(tokenAddress: Address, symbol: string, name: string, displayAddress: Address = tokenAddress): AssetDisplayOverrideV1 {
  return { tokenAddress, displayAddress, symbol, name };
}

const PRESENTATION: Partial<Record<NetworkName, Presentation>> = {
  'ethereum-mainnet': {
    assetDisplayOverrides: [
      shown('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'ETH',    'Ether', NATIVE),
      shown('0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', 'wstETH', 'Lido Wrapped Staked ETH'),
      shown('0xa1290d69c65a6fe4df752f95823fae25cb99e5a7', 'rsETH',  'KelpDao Restaked ETH'),
      shown('0xf1c9acdc66974dfb6decb12aa385b9cd01190e38', 'osETH',  'StakeWise Staked ETH'),
      shown('0xfae103dc9cf190ed75350761e95403b7b8afa6c0', 'rswETH', 'Restaked Swell ETH'),
      shown('0x4c9edd5852cd905f086c759e8383e09bff1e68b3', 'USDe',   'Ethena USDe'),
    ],
    unwrappedCollateralAssets: [ {
      wrappedTokenAddress: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
      tokenAddress:        '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
      symbol:              'stETH',
      name:                'Lido Staked ETH',
    } ],
  },
  'optimism-mainnet': {
    assetDisplayOverrides: [
      shown('0x4200000000000000000000000000000000000006', 'ETH',    'Ether', NATIVE),
      shown('0x87eee96d50fb761ad85b1c982d28a042169d61b1', 'wrsETH', 'Wrapped rsETH'),
    ],
    unwrappedCollateralAssets: [],
  },
  'polygon-mainnet': {
    assetDisplayOverrides: [
      shown('0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', 'POL',    'Polygon', NATIVE),
      shown('0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', 'WBTC',   'Wrapped Bitcoin'),
      shown('0xfa68fb4628dff1028cfec22b4162fccd0d45efb6', 'MaticX', 'Stader MaticX'),
      shown('0x2791bca1f2de4661ed88a30c99a7a9449aa84174', 'USDC.e', 'Bridged USDC'),
    ],
    unwrappedCollateralAssets: [],
  },
  'arbitrum-mainnet': {
    assetDisplayOverrides: [
      shown('0x82af49447d8a07e3bd95bd0d56f35241523fbab1', 'ETH',    'Ether', NATIVE),
      shown('0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', 'WBTC',   'Wrapped Bitcoin'),
      shown('0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', 'USDC.e', 'Bridged USDC'),
      shown('0x5979d7b546e38e414f7e9822514be443a4800529', 'wstETH', 'Lido Wrapped Staked ETH'),
    ],
    unwrappedCollateralAssets: [],
  },
  'base-mainnet': {
    assetDisplayOverrides: [
      shown('0x4200000000000000000000000000000000000006', 'ETH',    'Ether', NATIVE),
      shown('0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', 'USDbC',  'Bridged USDC'),
      shown('0xedfa23602d0ec14714057867a78d01e94176bea0', 'wrsETH', 'Wrapped rsETH'),
    ],
    unwrappedCollateralAssets: [],
  },
  'scroll-mainnet': {
    assetDisplayOverrides: [
      shown('0x5300000000000000000000000000000000000004', 'ETH',    'Ether', NATIVE),
      shown('0xf610a9dfb7c89644979b4a0f27063e9e7d7cda32', 'wstETH', 'Lido Wrapped Staked ETH'),
      shown('0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4', 'USDC',   'USDC'),
    ],
    unwrappedCollateralAssets: [],
  },
  'mantle-mainnet': {
    assetDisplayOverrides: [
      shown('0xdeaddeaddeaddeaddeaddeaddeaddeaddead1111', 'ETH',  'Ether'),
      shown('0xc96de26018a54d51c097160568752c4e3bd6c364', 'FBTC', 'FunctionBTC'),
    ],
    unwrappedCollateralAssets: [],
  },
  'linea-mainnet': {
    assetDisplayOverrides: [
      shown('0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', 'ETH', 'Ether', NATIVE),
    ],
    unwrappedCollateralAssets: [],
  },
  'unichain-mainnet': {
    assetDisplayOverrides: [
      shown('0x4200000000000000000000000000000000000006', 'ETH', 'Ether', NATIVE),
    ],
    unwrappedCollateralAssets: [],
  },
  'ronin-mainnet': {
    assetDisplayOverrides: [
      shown('0xe514d9deb7966c8be0ca922de8a064264ea6bcd4', 'RON', 'Ronin', NATIVE),
    ],
    unwrappedCollateralAssets: [],
  },
};

// where PRESENTATION departs from the file it was copied from, and why
const PRESENTATION_DEPARTURES: Partial<Record<NetworkName, Array<Pick<Note, 'field' | 'value' | 'source'>>>> = {
  'mantle-mainnet': [ {
    field:  'assetDisplayOverrides[WETH].displayAddress',
    value:  '0xdeaddeaddeaddeaddeaddeaddeaddeaddead1111',
    source: 'the frontend keeps the zero address, which marks a chain\'s own token, but Mantle\'s own token is MNT and the frontend only renames WETH to ETH, so WETH keeps its address',
  } ],
  'ronin-mainnet': [ {
    field:  'assetDisplayOverrides[WRON].displayAddress',
    value:  NATIVE,
    source: 'the frontend keeps WRON\'s own address, but shows WRON as RON and supplies it as the native token, which is what the zero address states',
  } ],
};

// the wrapped native token of each chain, which a base asset is or is not
const WRAPPED_NATIVE: Partial<Record<NetworkName, string>> = {
  'ethereum-mainnet': 'WETH',
  'base-mainnet':     'WETH',
  'arbitrum-mainnet': 'WETH',
  'optimism-mainnet': 'WETH',
  'linea-mainnet':    'WETH',
  'scroll-mainnet':   'WETH',
  'unichain-mainnet': 'WETH',
  'polygon-mainnet':  'WPOL',
  'mantle-mainnet':   'WMNT',
  'ronin-mainnet':    'WRON',
};

const NETWORK_NAMES: Partial<Record<NetworkName, string>> = {
  'ethereum-mainnet': 'Ethereum',
  'polygon-mainnet':  'Polygon',
  'arbitrum-mainnet': 'Arbitrum',
  'optimism-mainnet': 'Optimism',
  'base-mainnet':     'Base',
  'scroll-mainnet':   'Scroll',
  'mantle-mainnet':   'Mantle',
  'linea-mainnet':    'Linea',
  'unichain-mainnet': 'Unichain',
  'ronin-mainnet':    'Ronin',
};

// the market the application opens when nothing else is selected
const DEFAULT_MARKET = { network: 'ethereum-mainnet' as NetworkName, deploymentKey: 'usdc' };

function staticFeed(network: NetworkName, key: string): Address | null {
  const feed = (Eth.wellKnownContractsByNetwork[network] as any)?.['PriceFeed']?.[key];
  return feed === undefined ? null : (feed.address as Address).toLowerCase() as Address;
}

function aliasAddresses(network: NetworkName, aliases: string[]): Set<string> {
  const comets = (Eth.wellKnownContractsByNetwork[network] as any)?.['Comet'] ?? {};
  const addresses = new Set<string>();
  for (const alias of aliases) {
    const comet = comets[alias];
    if (comet !== undefined) {
      addresses.add((comet.address as string).toLowerCase());
    }
  }
  return addresses;
}

function textOf(value: unknown): string | null {
  return typeof(value) === 'string' && value.length > 0 ? value : null;
}

/*
 * One market as the constants describe it today. Everything here is a
 * decision the API already acts on; the registry is where it moves to.
 */
function marketOverlay(
  network: NetworkName,
  deploymentKey: string,
  comet: CometContract | undefined,
  notes: Note[],
): MarketProposal {
  const scope       = `${deploymentKey} on ${network}`;
  const contractName = comet === undefined ? null : textOf(comet.displayName);
  const baseAsset    = comet === undefined ? null : comet.base.asset;
  const baseSymbol   = baseAsset === null ? null : textOf(baseAsset.canonicalName);
  const rewardFeed   = comet?.rewards?.priceFeed ?? null;

  if (comet === undefined) {
    notes.push({
      scope,
      field:  'the whole market',
      value:  'placeholders',
      source: 'the static constants do not describe this deployment: every field of it is a decision nobody has made yet',
      open:   true,
    });
  }
  const label = MARKET_LABELS[network]?.[deploymentKey];
  if (comet !== undefined && label === undefined) {
    notes.push({
      scope,
      field:  'displayName, baseAsset.displayName',
      value:  `${baseSymbol ?? deploymentKey.toUpperCase()}, ${textOf(baseAsset?.description) ?? 'null'}`,
      source: `${FRONTEND} lists no market for this deployment, so its label is the constants' base symbol until someone decides what the frontend calls it`,
      open:   true,
    });
  }
  if (comet !== undefined && contractName === null) {
    notes.push({ scope, field: 'contractName', value: 'null', source: 'the constants carry no display name for this market', open: true });
  }

  /*
   * The quote comes first and the USD feed follows from it: a market quoted
   * in its base asset needs the feed that converts that asset to USD, and a
   * market quoted in USD must not carry one, whatever the constants offer.
   */
  const quotedInBase  = comet !== undefined
    && aliasAddresses(network, QUOTED_IN_BASE[network] ?? []).has(comet.address.toLowerCase());
  const conversionKey = contractName === null ? null : USD_CONVERSIONS[network]?.[contractName] ?? null;
  const usdFromStatic = comet?.base.usdPriceFeed?.address ?? null;
  const usdOffered    = usdFromStatic !== null
    ? usdFromStatic.toLowerCase() as Address
    : conversionKey === null ? null : staticFeed(network, conversionKey);
  const usdSource     = usdFromStatic !== null
    ? 'the usdPriceFeed the constants carry beside the base feed'
    : `the feed ${conversionKey} that the rewards APR branches converted this market through`;
  const usdPriceFeed  = quotedInBase ? usdOffered : null;

  if (quotedInBase && usdOffered !== null) {
    notes.push({ scope, field: 'baseAsset.usdPriceFeedAddress', value: usdOffered, source: usdSource, open: false });
  }
  if (quotedInBase && usdOffered === null) {
    notes.push({
      scope,
      field:  'baseAsset.usdPriceFeedAddress',
      value:  'null',
      source: 'this market\'s feeds answer in its base asset and no source names the feed that converts it to USD; validation refuses it until one is set',
      open:   true,
    });
  }
  if (!quotedInBase && usdOffered !== null) {
    notes.push({
      scope,
      field:  'baseAsset.usdPriceFeedAddress',
      value:  'null',
      source: `${usdSource} is ${usdOffered}, but this market's own feeds already answer in USD, so it carries none and is quoted in USD`,
      open:   false,
    });
  }

  const history    = aliasAddresses(network, HISTORY_MARKETS[network] ?? []);
  const served     = comet !== undefined && history.has(comet.address.toLowerCase());
  const unrewarded = comet !== undefined
    && aliasAddresses(network, MARKETS_WITHOUT_REWARDS[network] ?? []).has(comet.address.toLowerCase());
  const rewards    = !WITHOUT_REWARDS.includes(network) && !unrewarded;
  if (unrewarded) {
    notes.push({
      scope,
      field:  'capabilities.rewards, capabilities.accountRewards, rewardPriceFeed',
      value:  'false, false, null',
      source: 'the rewards contract answers the zero address for this market\'s reward token and both tracking speeds are zero, although the constants declare COMP rewards for it',
      open:   false,
    });
  }

  const rewardInBase  = comet !== undefined
    && aliasAddresses(network, REWARDS_QUOTED_IN_BASE[network] ?? []).has(comet.address.toLowerCase());
  const rewardAddress = rewardFeed === null ? null : rewardFeed.address.toLowerCase() as Address;
  const baseFeed       = comet === undefined ? null : comet.base.priceFeed.address.toLowerCase();
  const rewardIsBase   = rewardAddress !== null && rewardAddress === baseFeed;
  // on a network without rewards no reward feed is needed, so there is nothing to decide
  if (rewardIsBase && rewards) {
    notes.push({
      scope,
      field:  'rewardPriceFeed',
      value:  'null',
      source: `the constants name this market's own base feed as its reward feed, which cannot be right`,
      open:   true,
    });
  }

  return {
    displayName:          label?.symbol ?? baseSymbol ?? deploymentKey.toUpperCase(),
    slug:                 label?.slug ?? null,
    contractName,
    isDefault:            network === DEFAULT_MARKET.network && deploymentKey === DEFAULT_MARKET.deploymentKey,
    isInstitutional:      label?.institutional === true,
    status:               'enabled',
    creationBlock:        comet === undefined ? 0 : comet.creation.block.number,
    collateralValueQuote: quotedInBase ? 'base' : 'usd',
    capabilities: {
      rewards,
      accountRewards:     rewards,
      transactionHistory: served,
    },
    baseAsset: {
      displayName:         label?.name ?? (baseAsset === null ? null : textOf(baseAsset.description)),
      isWrappedNative:     baseSymbol !== null && baseSymbol === WRAPPED_NATIVE[network],
      usdPriceFeedAddress: usdPriceFeed,
    },
    rewardPriceFeed: rewardAddress === null || rewardIsBase || !rewards
      ? null
      : { address: rewardAddress, quote: rewardInBase ? 'base' : 'usd' },
  };
}

function networkOverlay(network: NetworkName, notes: Note[] = []): NetworkProposal {
  for (const departure of PRESENTATION_DEPARTURES[network] ?? []) {
    notes.push({ scope: `chain ${network}`, ...departure, open: false });
  }
  return {
    displayName:               NETWORK_NAMES[network] ?? network,
    assetDisplayOverrides:     PRESENTATION[network]?.assetDisplayOverrides ?? [],
    unwrappedCollateralAssets: PRESENTATION[network]?.unwrappedCollateralAssets ?? [],
    priceExceptions:           PRICE_EXCEPTIONS[network] ?? [],
  };
}

type Generated = {
  commit:   string,
  reason:   string,
  notes:    Note[],
  networks: Array<{ chainId: number, network: NetworkName, overlay: NetworkProposal }>,
  markets:  Array<{ chainId: number, deploymentKey: string, network: NetworkName, overlay: MarketProposal }>,
};


/*
 * The proposal for the markets a candidate imported. The candidate is what
 * says which markets exist — the source it was imported from, at its commit —
 * so the proposal cannot describe another set of markets than the one it is
 * applied to.
 *
 * A market the constants do not describe is not proposed: there is nothing
 * to derive its decisions from, and a placeholder would read as a decision.
 * It stays switched off and unreviewed, and the review says so.
 */
function proposalFor(networks: NetworkV1[], source: { repository: string, commit: string }): Generated {
  const notes: Note[] = [];
  const markets: Generated['markets'] = [];

  for (const network of networks) {
    const name   = network.key as NetworkName;
    const comets = staticComets(name);
    for (const market of network.markets) {
      const comet = market.contracts.comet === null ? undefined : comets.get(market.contracts.comet);
      if (comet === undefined) {
        notes.push({
          scope:  `${market.deploymentKey} on ${name}`,
          field:  'the whole market',
          value:  'not proposed',
          source: 'the static constants do not describe this deployment, so it stays switched off until it is described with the market overlay route',
          open:   true,
        });
        continue;
      }
      markets.push({
        chainId:       network.chainId,
        deploymentKey: market.deploymentKey,
        network:       name,
        overlay:       marketOverlay(name, market.deploymentKey, comet, notes),
      });
    }
  }

  return {
    commit:  source.commit,
    reason:  `bootstrap: derived from the static constants against ${source.repository}@${source.commit.slice(0, 12)}`,
    notes,
    markets: markets.sort((left, right) => left.chainId - right.chainId || (left.deploymentKey < right.deploymentKey ? -1 : 1)),
    networks: [ ...networks ]
      .sort((left, right) => left.chainId - right.chainId)
      .map(network => ({
        chainId: network.chainId,
        network: network.key as NetworkName,
        overlay: networkOverlay(network.key as NetworkName, notes),
      })),
  };
}

/*
 * What identifies a proposal: the decisions it would write, and nothing else.
 * The review states it and the apply route asks for it, so a proposal that
 * changed after it was read — another release, another candidate — is refused
 * rather than applied unread.
 */
async function digestOf(generated: Generated): Promise<string> {
  const { reason: _reason, ...decisions } = bundleOf(generated);
  return (await sha256Hex(canonicalJson(decisions))).slice(0, 16);
}

function yes(value: boolean): string {
  return value ? 'yes' : 'no';
}

function code(value: string | null): string {
  return value === null ? '—' : `\`${value}\``;
}

// an integer string scaled down by its decimals, as a feed would report it
function scaled(value: string, decimals: number): string {
  const digits  = value.padStart(decimals + 1, '0');
  const whole   = digits.slice(0, digits.length - decimals);
  const decimal = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return decimal.length === 0 ? whole : `${whole}.${decimal}`;
}

function displayedAt(override: AssetDisplayOverrideV1): string {
  if (override.displayAddress === NATIVE) {
    return 'the chain\'s own token';
  }
  return override.displayAddress === override.tokenAddress ? 'itself' : code(override.displayAddress);
}

function describeException(exception: OverlayPriceException): string {
  switch (exception.kind) {
    case 'zero_price':
      return `priced at zero`;
    case 'fixed_price':
      return `fixed at ${scaled(exception.price.value, exception.price.decimals)}`;
    case 'deprecated_price_remap':
      return `read from ${code(exception.replacementPriceFeedAddress)} instead`;
  }
}

/*
 * What an operator signs off by applying the directory. Every decision is in
 * a table, so a wrong one is visible without opening 39 documents; the notes
 * say where a value departs from the general rules, and the open ones are
 * what has to be decided before the version can be validated.
 */
function reviewDocument(generated: Generated, repository: string, digest: string): string {
  const { markets, networks } = generated;
  const open     = generated.notes.filter(note => note.open);
  const derived  = generated.notes.filter(note => !note.open);
  const noteLine = (note: Note) => `- **${note.scope}** — \`${note.field}\` = \`${note.value}\`: ${note.source}`;

  const lines = [
    `# Reviewed overlay, proposed`,
    ``,
    `Proposed by this Worker's release, from its static constants, for the markets`,
    `a candidate imported from ${repository}@${generated.commit}.`,
    `Nothing here is decided: these are the values the API acts on today, written`,
    `in the form the registry stores them.`,
    ``,
    `**Digest: \`${digest}\`**`,
    ``,
    `If they are right, apply them by that digest:`,
    `\`POST /registry/v1/admin/versions/{id}/proposal/apply\` with`,
    `\`{"reason": "...", "digest": "${digest}"}\`. A proposal that changed since it`,
    `was read has another digest, and is refused.`,
    ``,
    `If something is wrong, it is corrected in the tables of`,
    `src/registry/bootstrap.ts, and the release that carries the correction`,
    `proposes it; nothing here is edited by hand.`,
    ``,
    `${networks.length} networks, ${markets.length} markets.`,
    ``,
    `## Needs a decision`,
    ``,
    ...(open.length === 0
      ? [ `Nothing. Every value below is one the API acts on today.` ]
      : open.map(noteLine)),
    ``,
    `## Markets`,
    ``,
    `| Network | Market | Label | Slug | Institutional | Base asset | Contract | Status | Default | Creation block | Rewards | Account rewards | History |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...markets.map(({ network, deploymentKey, overlay }) => (
      `| ${network} | ${deploymentKey} | ${overlay.displayName} | ${code(overlay.slug)} | ${yes(overlay.isInstitutional)} ` +
      `| ${overlay.baseAsset.displayName ?? '—'} ` +
      `| ${code(overlay.contractName)} | ${overlay.status} | ${yes(overlay.isDefault)} ` +
      `| ${overlay.creationBlock} | ${yes(overlay.capabilities.rewards)} | ${yes(overlay.capabilities.accountRewards)} ` +
      `| ${yes(overlay.capabilities.transactionHistory)} |`
    )),
    ``,
    `## Pricing`,
    ``,
    `The quote is the unit a market's own feeds answer in. A market quoted in its`,
    `base asset carries the feed that converts that asset to USD; a market quoted`,
    `in USD carries none.`,
    ``,
    `| Network | Market | Label | Wrapped native | Quote | USD feed | Reward feed | Reward quote |`,
    `|---|---|---|---|---|---|---|---|`,
    ...markets.map(({ network, deploymentKey, overlay }) => (
      `| ${network} | ${deploymentKey} | ${overlay.displayName} | ${yes(overlay.baseAsset.isWrappedNative)} ` +
      `| ${overlay.collateralValueQuote} | ${code(overlay.baseAsset.usdPriceFeedAddress)} ` +
      `| ${code(overlay.rewardPriceFeed?.address ?? null)} | ${overlay.rewardPriceFeed?.quote ?? '—'} |`
    )),
    ``,
    `## Networks`,
    ``,
    `| Chain | Network | Name | Price exceptions | Display overrides | Unwrapped collateral |`,
    `|---|---|---|---|---|---|`,
    ...networks.map(({ chainId, network, overlay }) => (
      `| ${chainId} | ${network} | ${overlay.displayName} | ${overlay.priceExceptions.length} ` +
      `| ${overlay.assetDisplayOverrides.length} | ${overlay.unwrappedCollateralAssets.length} |`
    )),
    ``,
    `Each price exception is a feed the price computation does not read as it answers:`,
    ``,
    ...networks.flatMap(({ network, overlay }) => overlay.priceExceptions.map(exception => (
      `- **${network}** ${code(exception.priceFeedAddress)} ${describeException(exception)}: ${exception.provenance}`
    ))),
    ``,
    `## Where the values came from`,
    ``,
    `- Contract names, creation blocks, base assets and reward feeds: the static constants.`,
    `- Status: \`enabled\` everywhere, because every market described here is served today.`,
    `- Default: ${DEFAULT_MARKET.deploymentKey} on ${DEFAULT_MARKET.network}, the market the application opens today.`,
    `  Exactly one market of the whole registry may carry it.`,
    `- History: the markets transaction-history-items-handler.ts listed by hand. No other`,
    `  market had reachable history.`,
    `- Rewards and account rewards: on everywhere except ${WITHOUT_REWARDS.join(' and ')},`,
    `  which the rewards computations skipped by name because no reward feed answers there,`,
    `  and a market whose Comet has no rewards configured.`,
    `- Quote: the unit each Comet's base token feed answers in, read from the chain.`,
    `- Reward quote: \`usd\`, except where the reward feed answers in the base asset, read from its`,
    `  description() on chain: ${Object.entries(REWARDS_QUOTED_IN_BASE).flatMap(([ network, aliases ]) => (aliases ?? []).map(alias => `${alias} on ${network}`)).join(', ')} (COMP / ETH).`,
    `- Wrapped native: the base asset is the wrapped form of the chain's own token.`,
    `- Price exceptions: the feeds asset-price.ts refused to read.`,
    `- Labels — what a market is listed as, its slug and section, and its base asset's name: copied from`,
    `  ${FRONTEND} src/helpers/markets.ts, the only place they exist.`,
    `- Presentation: copied from ${FRONTEND} src/constants/chains.ts, the only place it exists.`,
    ``,
    ...(derived.length === 0 ? [] : [
      `Where a value departs from those rules, or they need saying for one market:`,
      ``,
      ...derived.map(noteLine),
      ``,
    ]),
    `## Presentation`,
    ``,
    `How the frontend shows a network's assets. Nothing in this API reads it; the`,
    `registry serves it so the frontend can stop deciding it on its own.`,
    ``,
    `| Network | Token | Shown as | Name | Displayed as |`,
    `|---|---|---|---|---|`,
    ...networks.flatMap(({ network, overlay }) => overlay.assetDisplayOverrides.map(override => (
      `| ${network} | ${code(override.tokenAddress)} | ${override.symbol} | ${override.name} | ${displayedAt(override)} |`
    ))),
    ``,
    `Collateral a user may supply unwrapped, for the bulker to wrap in the same transaction:`,
    ``,
    ...networks.flatMap(({ network, overlay }) => overlay.unwrappedCollateralAssets.map(pair => (
      `- **${network}** ${code(pair.tokenAddress)} ${pair.symbol} (${pair.name}) as ${code(pair.wrappedTokenAddress)}`
    ))),
    ``,
  ];

  return lines.join('\n');
}

/*
 * The body of `PUT /versions/{id}/overlays`: what the operator reads in the
 * review document (`GET /versions/{id}/proposal/review`) is what that one
 * request applies, all of it or none.
 */
function bundleOf(generated: Generated): {
  reason:   string,
  networks: Record<string, NetworkProposal>,
  markets:  Record<string, MarketProposal>,
} {
  return {
    reason:   generated.reason,
    networks: Object.fromEntries(generated.networks.map(({ chainId, overlay }) => [ String(chainId), overlay ])),
    markets:  Object.fromEntries(generated.markets.map(({ chainId, deploymentKey, overlay }) => [
      marketKey(chainId, deploymentKey), overlay,
    ])),
  };
}


export type { Generated, MarketProposal, NetworkProposal, Note };
export { bundleOf, digestOf, marketOverlay, networkOverlay, proposalFor, reviewDocument };
