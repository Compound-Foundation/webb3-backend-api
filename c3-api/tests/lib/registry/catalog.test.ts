import t from 'tap';

import type { MarketV1, NetworkV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { isServed, servedNetworks } from '../../../src/registry/catalog.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

const snapshot = loadRegistrySnapshotFixture();

const MAINNET  = 'ethereum-mainnet';
const USDC     = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const SCROLL   = 'scroll-mainnet';

function marketsOf(networks: NetworkV1[]): MarketV1[] {
  return networks.flatMap(network => network.markets);
}

/*
 * What is served is one rule, which the public reads, the drift check and the
 * comparison of two versions all ask: a market that is not disabled and names
 * its Comet, on a network that has one.
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
