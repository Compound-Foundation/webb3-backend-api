import t from 'tap';
import { readFileSync } from 'node:fs';
import * as streamInto from 'node:stream/consumers';

import { makeTestEnv } from '../../../../util/test-env.js';

import type { MarketV1, RegistrySnapshotV1 } from '../../../../../lib/model/comet-registry.js';
import { marketOverlay, staticComets } from '../../../../../src/registry/bootstrap.js';
import { catalogOf } from '../../../../../src/registry/catalog.js';
import { enrichMarket, proxyTransport } from '../../../../../src/registry/enrichment.js';
import { applyMarketOverlay, overlayFeedAddresses, parseMarketOverlay } from '../../../../../src/registry/overlay.js';
import { gitBlobSha } from '../../../../../src/registry/source/github.js';
import { parseDeploymentPath, parseRoot } from '../../../../../src/registry/source/roots.js';
import * as KnownNetwork from '../../../../../lib/well-known/networks/network.js';
import * as Debug    from '../../../../../lib/debug-log.js';
import * as Flags    from '../../../../../lib/flags.js';
import * as Eth   from '../../../../../lib/eth-constants.js';

import C3Api, { Env } from '../../../../../entrypoint.js';

import { setupTestEnvVars } from '../../../../util/setupTestEnvVars.js';
import { activeRegistryDatabase } from '../../../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../../../util/registry-fixture.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../../shim/node-self.js';

const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const testDebug = debug.scope('test');
testDebug.log({ flags });

const { apiHost, nodeHost, nodeKey } = setupTestEnvVars();

const CIUSDCV3 = '0x207158a267cbd2598bb3d611d8cbdee2709f2f8c';

// the market's roots.json, as Compound-Foundation/comet holds it
const ROOT_PATH = 'deployments/mainnet/institutional_usdc/roots.json';
const ROOT      = readFileSync('./tests/fixtures/registry/source/roots/mainnet-institutional_usdc.json', 'utf8');

/*
 * The institutional USDC market, as importing its root describes it: the
 * contracts its roots.json names, among them a configurator and a rewards
 * contract of its own; its assets as the chain answers for them, read live
 * like everything else in this test; and the decisions the bootstrap review
 * proposes for it, from the creation block of its deployment to rewards it
 * has none of. The frozen fixture does not carry it, and this test is about
 * what a near-empty market reports, not about the fixture.
 */
async function institutionalUsdc(): Promise<MarketV1> {
  const root   = await parseRoot(parseDeploymentPath(ROOT_PATH), ROOT, await gitBlobSha(ROOT));
  const review = parseMarketOverlay(
    marketOverlay('ethereum-mainnet', root.deploymentKey, staticComets('ethereum-mainnet').get(CIUSDCV3), []),
  );
  const chain = proxyTransport({
    apiHost:  apiHost,
    nodeHost: nodeHost,
    nodeKey:  nodeKey,
    network:  'ethereum-mainnet',
    // the Workers Response the runtime's fetch answers, which a build that also sees Node's types cannot tell
    fetch:    request => fetch(request) as Promise<Response>,
  });
  const enriched = await enrichMarket(chain, root, overlayFeedAddresses(review));
  return applyMarketOverlay(root, enriched, review, enriched.feeds, '00000000-0000-4000-8000-0000000001ff');
}

function withInstitutionalUsdc(market: MarketV1): RegistrySnapshotV1 {
  const snapshot = loadRegistrySnapshotFixture();
  return {
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: [ ...network.markets, market ],
    }),
  };
}

/*
 * ciUSDCv3 is newly deployed and nearly empty, which is the point of covering
 * it separately from 01-usdc: its summary is computed over a supply and a
 * borrow close to zero, for a market with no rewards.
 *
 * Assertions are on shape, not on values. The market is live and its balances
 * change; hardcoding today's zeros would turn the first deposit into a test
 * failure.
 *
 * NOTE: like the other e2e market tests, this one hits live node providers and
 * requires V3_API_HOST / NODE_PROXY_HOST / NODE_PROXY_KEY in the environment.
 */
t.test(`/market/.../summary response format looks reasonable for a near-empty market`, async t => {
  const market = await institutionalUsdc();
  t.same(
    [ market.deploymentKey, market.contracts.configurator, market.contracts.rewards, market.creationBlock ],
    [ 'institutional_usdc', '0xd61c0169e931381fb3cc4b40316805333808c1fa', '0x561e8e1e7eb56f558922c198a3c228545093f32d', 25_881_203 ],
    'the market is ciUSDCv3, as its own root and its deployment describe it',
  );
  t.same([ market.capabilities.rewards, market.capabilities.accountRewards ], [ false, false ], 'with no rewards');

  const registry = await activeRegistryDatabase({ snapshot: withInstitutionalUsdc(market) });
  t.teardown(() => registry.dispose());

  const testEnv: Env = makeTestEnv({
    'V3_API_HOST': apiHost,
    'NODE_PROXY_HOST': nodeHost,
    'NODE_PROXY_KEY': nodeKey,
    'MEMORY_CACHE_SEED': 'market',
    APP_DB: registry.db,
  });
  const network: KnownNetwork.Name = 'ethereum-mainnet';
  const contract = catalogOf(registry.snapshot).marketAt(network, CIUSDCV3)!.comet;
  const request  = new Request(`https://${nodeHost}/market/${network}/${contract.address}/summary`);

  const response = await C3Api.fetch(request, testEnv);
  t.ok(response.body);
  // non-null assert (!) is safe because of the t.ok(response.body) above.
  const [ responseJson ] = await streamInto.json(response.body! as any) as unknown[];

  const {
    chain_id,
    comet,
    borrow_apr,
    supply_apr,
    total_borrow_value,
    total_supply_value,
    total_collateral_value,
    utilization,
    base_price,
    deployment_key,
    display_name,
    base_asset_name,
    is_wrapped_native,
    is_default,
    is_institutional,
  } = responseJson as any;

  t.equal(chain_id, 1, 'reports ethereum mainnet');
  t.ok(Eth.parseAddress(comet.address), 'comet address parses');
  t.equal(
    comet.address.toLowerCase(),
    contract.address.toLowerCase(),
    'echoes back the requested comet'
  );

  /*
   * Interest APRs are rate-model outputs and are well-formed even at zero
   * utilization.
   */
  t.ok(/^\d+\.\d+$/.test(borrow_apr), 'borrow_apr is a decimal string');
  t.ok(/^\d+\.\d+$/.test(supply_apr), 'supply_apr is a decimal string');

  t.ok(/^\d+\.\d+$/.test(total_borrow_value), 'total_borrow_value is a decimal string');
  t.ok(/^\d+\.\d+$/.test(total_supply_value), 'total_supply_value is a decimal string');
  t.ok(/^\d+\.\d+$/.test(total_collateral_value), 'total_collateral_value is a decimal string');
  t.ok(BigInt(utilization) >= BigInt(0), 'utilization is non-negative');
  t.ok(/^\d+\.\d+$/.test(base_price), 'base_price is a decimal string');
  t.equal(typeof deployment_key, 'string', 'deployment_key is present');
  t.equal(typeof display_name, 'string', 'display_name is present');
  t.equal(typeof base_asset_name, 'string', 'base_asset_name is present');
  t.equal(typeof is_wrapped_native, 'boolean', 'is_wrapped_native is present');
  t.equal(typeof is_default, 'boolean', 'is_default is present');
  t.equal(typeof is_institutional, 'boolean', 'is_institutional is present');

  t.end();
});
