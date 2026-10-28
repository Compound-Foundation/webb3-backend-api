import t from 'tap';

import type { NetworkV1 } from '../../../lib/model/comet-registry.js';

import { compareVersions } from '../../../src/registry/changes.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * What a version changes against the one that is on. The cases are the ones
 * a new commit of the source brings: a market it adds, one it drops, a feed
 * or a collateral that moves on a market already served.
 */
const snapshot = loadRegistrySnapshotFixture();

function copy(): NetworkV1[] {
  return structuredClone(snapshot.networks);
}

function mainnet(networks: NetworkV1[]): NetworkV1 {
  return networks.find(network => network.chainId === 1)!;
}

t.test('a version identical to the one that is on changes nothing', async t => {
  const renumbered = copy();
  // every version assigns its rows new ids, which is not a change
  mainnet(renumbered).markets[0]!.id = '00000000-0000-4000-8000-00000000abcd';

  t.same(compareVersions(snapshot.networks, renumbered, new Set()), {
    networks: { added: [], removed: [], changed: [] },
    markets:  { added: [], removed: [], changed: [], unserved: [] },
  });
});

t.test('without a version that is on, everything is added', async t => {
  const changes = compareVersions(null, snapshot.networks, new Set([ '1/weth' ]));

  t.same(changes.networks.added, [ 1, 8453, 534352 ], 'every network');
  t.same(changes.markets.added.map(entry => entry.scope), [
    '1/usdc', '1/usdt', '1/wbtc', '1/weth', '8453/aero', '534352/usdc',
  ], 'every market, by chain and deployment key');
  t.same(
    changes.markets.added.filter(entry => !entry.reviewed).map(entry => entry.scope),
    [ '1/weth' ],
    'saying which of them nobody has reviewed',
  );
  t.notOk('id' in changes.markets.added[0]!.market, 'a market is reported without its row id');
  t.same(changes.markets.unserved, [], 'and nothing is served yet, so nothing stops being');
});

t.test('a new commit is reported as what it adds, drops and changes', async t => {
  const after = copy();
  const network = mainnet(after);

  const usdc = network.markets.find(market => market.deploymentKey === 'usdc')!;
  const before = usdc.baseAsset.priceFeed.address;
  usdc.baseAsset.priceFeed = { ...usdc.baseAsset.priceFeed, address: '0x1111111111111111111111111111111111111111' };

  const weth  = network.markets.find(market => market.deploymentKey === 'weth')!;
  const count = weth.collateralAssets.length;
  weth.collateralAssets.push({ ...weth.collateralAssets[0]!, assetIndex: count });

  network.markets = network.markets.filter(market => market.deploymentKey !== 'wbtc');

  const usdt = network.markets.find(market => market.deploymentKey === 'usdt')!;
  network.markets.push({
    ...structuredClone(usdt),
    id:            '00000000-0000-4000-8000-00000000beef',
    deploymentKey: 'usde',
    status:        'disabled',
  });

  network.priceExceptions = [];

  const changes = compareVersions(snapshot.networks, after, new Set([ '1/usde' ]));

  t.same(changes.markets.added.map(({ scope, reviewed }) => ({ scope, reviewed })), [ { scope: '1/usde', reviewed: false } ],
    'the market the source added, which nobody has reviewed yet');
  t.equal(changes.markets.added[0]!.market.status, 'disabled', 'reported whole, with what its import read');
  t.same(changes.markets.removed, [ '1/wbtc' ], 'the market the source dropped');

  t.same(
    changes.markets.changed.filter(change => change.scope === '1/usdc'),
    [ { scope: '1/usdc', field: 'baseAsset.priceFeed.address', before, after: '0x1111111111111111111111111111111111111111' } ],
    'a moved feed is one field, with both answers',
  );
  const collateral = changes.markets.changed.filter(change => change.scope === '1/weth');
  t.same(collateral[0], { scope: '1/weth', field: 'collateralAssets.length', before: count, after: count + 1 },
    'an added collateral makes the list longer');
  t.ok(collateral.some(change => change.field === `collateralAssets[${count}].token.address` && change.before === null),
    'and is the entry that was not there');

  t.ok(changes.networks.changed.some(change => change.scope === '1' && change.field === 'priceExceptions.length'),
    'a network change is reported for the network');
  t.same(changes.networks.added, [], 'no network was added');
});

/*
 * What users of the version on lose is a Comet, whatever key it is under: the
 * source dropping its deployment, renaming it to a key nobody has reviewed,
 * or giving its key to another Comet, and a review switching it off, all
 * stop it being served, while `removed` lists only the keys that are gone.
 */
t.test('every Comet the version on serves and this one does not is named, with where it is now', async t => {
  const after   = copy();
  const network = mainnet(after);
  const comet   = (key: string) => mainnet(snapshot.networks).markets.find(market => market.deploymentKey === key)!.contracts.comet;
  const market  = (key: string) => network.markets.find(entry => entry.deploymentKey === key)!;

  network.markets = network.markets.filter(entry => entry.deploymentKey !== 'wbtc');
  Object.assign(market('weth'), { deploymentKey: 'weth-renamed', status: 'disabled', isDefault: false });
  market('usdt').status = 'disabled';
  market('usdc').contracts = { ...market('usdc').contracts, comet: '0x1111111111111111111111111111111111111111' };
  Object.assign(market('usdc'), { status: 'disabled', isDefault: false });

  /*
   * A Comet renamed and reviewed under its new key, and one deprecated, are
   * still served; a market at wbtc's address on Base is another Comet.
   */
  const scroll = after.find(entry => entry.chainId === 534352)!.markets[0]!;
  scroll.deploymentKey = 'usdc-renamed';
  const base = after.find(entry => entry.chainId === 8453)!;
  base.markets[0]!.status = 'deprecated';
  base.markets.push({
    ...structuredClone(base.markets[0]!),
    id:            '00000000-0000-4000-8000-00000000cafe',
    deploymentKey: 'wbtc-twin',
    status:        'enabled',
    contracts:     { ...base.markets[0]!.contracts, comet: comet('wbtc') },
  });

  const changes = compareVersions(snapshot.networks, after, new Set([ '1/usdc', '1/weth-renamed' ]));
  t.same(changes.markets.unserved, [
    { scope: '1/usdc', comet: comet('usdc'), now: null },
    { scope: '1/usdt', comet: comet('usdt'), now: { scope: '1/usdt', status: 'disabled' } },
    { scope: '1/wbtc', comet: comet('wbtc'), now: null },
    { scope: '1/weth', comet: comet('weth'), now: { scope: '1/weth-renamed', status: 'disabled' } },
  ], 'each by the key the version on serves it under, with the key and the status this one holds it under, if any');
  t.same(changes.markets.removed, [ '1/wbtc', '1/weth', '534352/usdc' ],
    'while only the keys the version no longer has are removed, a Comet served under another key among them');

  const more = copy();
  mainnet(more).markets.push({
    ...structuredClone(mainnet(more).markets[0]!),
    id:            '00000000-0000-4000-8000-00000000beef',
    deploymentKey: 'usde',
    isDefault:     false,
    contracts:     { ...mainnet(more).markets[0]!.contracts, comet: '0x2222222222222222222222222222222222222222' },
  });
  t.same(compareVersions(snapshot.networks, more, new Set()).markets.unserved, [],
    'a version that serves every Comet the one on does, and more, stops serving none');

  const switchedOff = (networks: NetworkV1[]) => {
    networks.find(entry => entry.chainId === 534352)!.markets[0]!.status = 'disabled';
    return networks;
  };
  t.same(compareVersions(switchedOff(copy()), switchedOff(copy()), new Set()).markets.unserved, [],
    'and a market the version on does not serve is nothing to lose');
});
