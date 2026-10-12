import t from 'tap';

import type * as KnownNetwork from '../../../lib/well-known/networks/network.js';
import type { Address, MarketV1, NetworkV1, PriceExceptionV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';
import { exceptionFor } from '../../../lib/computations/comet/asset-price.js';
import { Comet, ERC20 } from '../../../lib/well-known/contracts/types.js';

import type { Catalog } from '../../../src/registry/catalog.js';
import { catalogOf, isServed, servedNetworks } from '../../../src/registry/catalog.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * The request catalog materializes one snapshot into the contract objects the
 * computations already consume. What it must get right is which markets are
 * resolvable, how a market is addressed, and that everything it hands out
 * comes from the one version it was built from.
 */
const snapshot = loadRegistrySnapshotFixture();

const MAINNET  = 'ethereum-mainnet';
const USDC     = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const SCROLL   = 'scroll-mainnet';
// an address no market, token or feed of the fixture has
const NOBODY   = '0x0000000000000000000000000000000000000000';

function marketsOf(networks: NetworkV1[]): MarketV1[] {
  return networks.flatMap(network => network.markets);
}

/*
 * A copy of the fixture with one market rewritten, so a test can state the
 * case it is about without mutating what every other test reads.
 */
function withMarket(
  key: string,
  change: (market: MarketV1) => MarketV1,
  source: RegistrySnapshotV1 = snapshot,
): RegistrySnapshotV1 {
  return {
    ...source,
    networks: source.networks.map(network => ({
      ...network,
      markets: network.markets.map(market => market.deploymentKey === key ? change(market) : market),
    })),
  };
}

t.test('the catalog materializes every resolvable market of one version', async t => {
  const catalog = catalogOf(snapshot);

  t.equal(catalog.versionId, snapshot.registryVersion.id, 'it answers for the version it was built from');
  t.equal(catalog.checksum, snapshot.registryVersion.checksum, 'and carries the checksum of that version');
  t.equal(catalog.markets().length, marketsOf(snapshot.networks).length, 'every market of the fixture is present');
  t.equal(catalog.networks().length, snapshot.networks.length);

  const usdc = catalog.marketAt(MAINNET, USDC);
  t.ok(usdc, 'a market is addressed by its Comet address');
  t.ok(Comet.is(usdc!.comet), 'and is handed out as a Comet contract');
  t.equal(usdc!.comet.address.toLowerCase(), USDC, 'carrying the address it is found by, checksummed');
  t.equal(usdc!.comet.displayName, 'cUSDCv3', 'named as the registry names it');
  t.equal(usdc!.comet.creation.block.number, usdc!.market.creationBlock);
  t.equal(usdc!.comet.base.asset.canonicalName, 'USDC');
  t.equal(usdc!.comet.base.asset.decimals, 6);
  t.equal(usdc!.comet.base.priceFeed.decimals, 8, 'with the feed scale the registry read, not an assumed one');
  t.equal(usdc!.chainId, 1);
  t.equal(usdc!.deploymentKey, 'usdc');
});

/*
 * The contract shapes have two places for a name: `description` carries the
 * human name of a token, which is where the static constants put it and where
 * the market rewards response reads it from, and the canonical name carries
 * the symbol.
 */
t.test('a token keeps its name where the contract shapes carry it', async t => {
  const usdc = catalogOf(snapshot).marketAt(MAINNET, USDC)!;

  t.equal(usdc.comet.base.asset.description, 'USD Coin', 'the registry name is the description');
  t.equal(usdc.comet.base.asset.canonicalName, 'USDC', 'and the symbol stays the name it is known by');
  t.equal(usdc.comet.base.asset.symbol, 'USDC');
  t.equal(usdc.comet.rewards?.asset?.description, 'Compound', 'the reward token too');
});

t.test('a market is addressed case-insensitively, and only on its own network', async t => {
  const catalog = catalogOf(snapshot);

  t.ok(catalog.marketAt(MAINNET, '0xc3d688B66703497DAA19211EEdFf47f25384cdc3'), 'a checksummed address resolves');
  t.equal(catalog.marketAt(SCROLL, USDC), null, 'the same address on another network does not');
  t.equal(catalog.marketAt(MAINNET, NOBODY), null, 'and an address no market has does not');

  t.equal(catalog.marketsOn(MAINNET).length, 4);
  t.equal(catalog.marketsOn(SCROLL).length, 1);
});

/*
 * The status of a market decides what may resolve it: a disabled market must
 * not be reachable at all, while a deprecated one stays reachable so existing
 * positions and history keep working.
 */
t.test('a disabled market is unreachable, a deprecated one is readable', async t => {
  const disabled = catalogOf(withMarket('weth', market => ({ ...market, status: 'disabled' })));
  t.equal(disabled.marketsOn(MAINNET).length, 3, 'a disabled market is not in the catalog');
  t.equal(disabled.markets().length, 5);

  const deprecated = catalogOf(withMarket('weth', market => ({ ...market, status: 'deprecated' })));
  const weth = deprecated.marketAt(MAINNET, '0xa17581a9e3356d9a858b789d68b4d866e593ae94');
  t.ok(weth, 'a deprecated market still resolves');
  t.equal(deprecated.markets().length, 6);
});

/*
 * Validation refuses a market that does not declare its Comet, and the
 * catalog is typed on that: a market it hands out names its Comet, and no
 * consumer checks for one that is missing. A snapshot without it would have
 * the market left out, never addressed at no address.
 */
t.test('a market the catalog serves names its Comet', async t => {
  const usdc = catalogOf(snapshot).marketAt(MAINNET, USDC)!;
  // an assignment the compiler refuses if a catalog market's Comet may be null
  const comet: Address = usdc.market.contracts.comet;
  t.equal(comet, USDC, 'a market names the Comet it is addressed by');

  const missing = catalogOf(withMarket('weth', market => ({ ...market, contracts: { ...market.contracts, comet: null } })));
  t.equal(missing.marketsOn(MAINNET).length, 3, 'a market without one is not materialized');
  t.notOk(missing.markets().some(entry => entry.deploymentKey === 'weth'), 'on any network');
});

t.test('a network this API cannot name is not served', async t => {
  const catalog = catalogOf({
    ...snapshot,
    networks: [
      ...snapshot.networks,
      { ...snapshot.networks[0]!, key: 'nowhere-mainnet', chainId: 999999 },
    ],
  });

  t.equal(catalog.networks().length, snapshot.networks.length, 'the unknown network is dropped');
  t.equal(catalog.markets().length, marketsOf(snapshot.networks).length, 'and so are its markets');
});

/*
 * The exception the price of an asset applies to a feed, as a computation
 * finds it: through the Comet it was handed, which carries the exceptions of
 * its network as the catalog resolved them.
 */
function exceptionOn(catalog: Catalog, network: KnownNetwork.Name, feed: Address): PriceExceptionV1 | null {
  const [ market ] = catalog.marketsOn(network);
  return exceptionFor(market!.comet.registry, feed);
}

/*
 * A price exception is the registry saying a feed must not be read from the
 * chain. It is keyed by feed address, because that is what a computation has
 * in hand when it is about to read one.
 */
t.test('price exceptions are resolved by feed address, within their network', async t => {
  const catalog = catalogOf(snapshot);
  const fixed   = exceptionOn(catalog, MAINNET, '0x351A133fd850ea81Ed8a782016E308aCBAddec91');

  t.equal(fixed?.kind, 'fixed_price', 'a fixed price exception resolves from a checksummed address');
  t.equal(exceptionOn(catalog, MAINNET, '0xe3a409ed15cd53afdefdd191ad945cec528a2496')?.kind, 'zero_price');
  t.equal(exceptionOn(catalog, SCROLL, '0x351a133fd850ea81ed8a782016e308acbaddec91'), null,
    'an exception does not apply to another network');
  t.equal(exceptionOn(catalog, MAINNET, NOBODY), null);
});

/*
 * An exception may carry an expiry, and it is compared as an instant. An
 * overlay may state that instant in any form Date.parse accepts, and the same
 * moment written with an offset sorts differently as a string.
 */
t.test('a price exception stops applying when it expires, whatever form the expiry took', async t => {
  const feed = '0x351a133fd850ea81ed8a782016e308acbaddec91';
  const withExpiry = (expiresAt: string | null): RegistrySnapshotV1 => ({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      priceExceptions: network.priceExceptions.map(exception => ({ ...exception, expiresAt })),
    }),
  });
  const noon = new Date('2026-09-21T12:00:00.000Z');

  const applied = (expiresAt: string | null) => exceptionOn(catalogOf(withExpiry(expiresAt), noon), MAINNET, feed);

  t.ok(applied(null), 'an exception without an expiry applies');
  t.ok(applied('2026-09-21T15:00:00.000Z'), 'and one that has not expired yet');
  t.equal(applied('2026-09-21T11:00:00.000Z'), null, 'one that has expired does not');
  t.equal(applied('2026-09-21T13:00:00+02:00'), null,
    'including one written as an offset, which is 11:00Z and sorts after it as a string');
  t.equal(applied('whenever'), null, 'and one nobody can date is not one to keep suppressing a live feed with');
});

/*
 * A catalog decides which exceptions apply when it is built, so it also says
 * until when that holds: the next expiry among the exceptions it applies. An
 * isolate keeps it until then, and builds it again rather than go on applying
 * an exception that has expired.
 */
t.test('a catalog is valid until the next exception it applies expires', async t => {
  const noon = new Date('2026-09-21T12:00:00.000Z');
  const withExpiries = (...expiries: Array<string | null>): RegistrySnapshotV1 => ({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      priceExceptions: network.priceExceptions.map((exception, index) => ({ ...exception, expiresAt: expiries[index] ?? null })),
    }),
  });

  t.equal(catalogOf(withExpiries(), noon).validUntil, null, 'with nothing to expire, for as long as its version is on');
  t.equal(
    catalogOf(withExpiries('2026-09-21T15:00:00.000Z', '2026-09-21T13:00:00.000Z'), noon).validUntil,
    Date.parse('2026-09-21T13:00:00.000Z'),
    'otherwise until the first expiry to come',
  );
  t.equal(
    catalogOf(withExpiries('2026-09-21T11:00:00.000Z', '2026-09-21T13:00:00.000Z'), noon).validUntil,
    Date.parse('2026-09-21T13:00:00.000Z'),
    'an exception that has already expired is not applied, and changes nothing more',
  );
  t.equal(
    catalogOf(withExpiries('2026-09-21T15:00:00+02:00'), noon).validUntil,
    Date.parse('2026-09-21T13:00:00.000Z'),
    'and an expiry written with an offset is the moment it names',
  );
});

/*
 * Not every market rewards, and a market's rewards are what it has of them:
 * nothing stands in for a feed nobody states or a token the chain does not
 * name, so a consumer that needs one finds it missing rather than reading a
 * plausible placeholder at the zero address.
 */
t.test('a market carries what it has of its rewards, and nothing in place of the rest', async t => {
  const catalog = catalogOf(snapshot);
  const scroll  = catalog.marketsOn(SCROLL)[0]!;

  t.equal(scroll.market.rewardAsset?.priceFeed, null, 'the fixture has no reward feed on scroll');
  t.equal(scroll.comet.rewards?.priceFeed, undefined, 'so the contract carries no feed for its rewards');
  t.equal(scroll.comet.rewards?.asset?.canonicalName, 'COMP', 'while the reward token itself is real');
  t.equal(scroll.comet.rewards?.contract.address.toLowerCase(), scroll.market.contracts.rewards);
  t.notOk(ERC20.is(scroll.comet.rewards!.contract), 'and the rewards contract is a contract, not a token of no decimals');

  const unpaid = catalogOf(withMarket('usdc', market => ({ ...market, rewardAsset: null }))).marketAt(MAINNET, USDC)!;
  t.equal(unpaid.comet.rewards?.contract.address.toLowerCase(), unpaid.market.contracts.rewards,
    'a market whose rewards contract pays no token keeps the contract');
  t.same([ unpaid.comet.rewards?.asset, unpaid.comet.rewards?.priceFeed ], [ undefined, undefined ],
    'and has no reward token or feed');

  const without = catalogOf(withMarket('usdc', market => ({
    ...market,
    contracts:   { ...market.contracts, rewards: null },
    rewardAsset: null,
  }))).marketAt(MAINNET, USDC)!;
  t.equal(without.comet.rewards, undefined, 'a market with no rewards contract has no rewards at all');
});

/*
 * A network whose every market is disabled serves nothing: a chain the
 * source has just added arrives that way, with nothing about it reviewed,
 * and the catalog does not offer it. One whose markets are deprecated is
 * still served, because positions and history in them stay reachable.
 */
t.test('a network with no market the API serves is not one the catalog offers', async t => {
  const status = (status: MarketV1['status']): RegistrySnapshotV1 => ({
    ...snapshot,
    networks: snapshot.networks.map(network => network.key !== SCROLL ? network : {
      ...network,
      markets: network.markets.map(market => ({ ...market, status, isDefault: false })),
    }),
  });

  const disabled = catalogOf(status('disabled'));
  t.notOk(disabled.networks().some(network => network.key === SCROLL), 'a network of disabled markets is not listed');
  t.same(disabled.marketsOn(SCROLL), [], 'and serves no market');

  const deprecated = catalogOf(status('deprecated'));
  t.ok(deprecated.networks().some(network => network.key === SCROLL), 'a network of deprecated markets is');
  t.equal(deprecated.marketsOn(SCROLL).length, 1);
});

/*
 * What is served is one rule, which the catalog, the public reads, the drift
 * check and the comparison of two versions all ask: a market that is not
 * disabled and names its Comet, on a network that has one.
 */
t.test('a market is served unless it is disabled, and a network while it serves one', async t => {
  const usdc = marketsOf(snapshot.networks).find(market => market.contracts.comet === USDC)!;
  t.ok(isServed(usdc), 'an enabled market is served');
  t.ok(isServed({ ...usdc, status: 'deprecated' }), 'and so is a deprecated one');
  t.notOk(isServed({ ...usdc, status: 'disabled' }), 'a disabled one is not');
  t.notOk(isServed({ ...usdc, contracts: { ...usdc.contracts, comet: null } }), 'nor one that names no Comet');

  const listed = (version: RegistrySnapshotV1) => servedNetworks(version)
    .map(({ network, markets }) => `${network.key}: ${markets.map(market => market.deploymentKey).join(', ')}`);
  t.same(listed(snapshot), [ `${MAINNET}: usdc, weth, usdt, wbtc`, 'base-mainnet: aero', `${SCROLL}: usdc` ],
    'every network of the fixture serves every market it has');

  const disabled: RegistrySnapshotV1 = {
    ...snapshot,
    networks: snapshot.networks.map(network => ({
      ...network,
      markets: network.markets.map(market => (
        market.deploymentKey === 'weth' || network.key === SCROLL ? { ...market, status: 'disabled' as const } : market
      )),
    })),
  };
  t.same(listed(disabled), [ `${MAINNET}: usdc, usdt, wbtc`, 'base-mainnet: aero' ],
    'a disabled market is left out of its network, and a network of disabled markets altogether');
});
