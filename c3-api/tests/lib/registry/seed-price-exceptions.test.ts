import t from 'tap';
import { readFileSync } from 'node:fs';

import { BigNumber } from '../../../lib/bignumber.js';
import { BigFixnum } from '../../../lib/bigfixnum.js';

import * as cometComputations from '../../../lib/computations/comet.js';

import type { NetworkV1, PriceExceptionV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import { parseNetworkOverlay } from '../../../src/registry/overlay.js';

import { evaluatorOver, stub } from '../../util/evaluator.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { sourceFiles } from '../../util/sources.js';

import '../../../shim/node-self.js';

/*
 * The seed file is the first review of an environment, applied with
 * `PUT …/overlays`: the price exceptions it holds are what a new environment
 * prices the feeds below by.
 */
const SEED = 'registry/seed/production.json';
const seed = JSON.parse(readFileSync(SEED, 'utf8')) as { networks: Record<string, unknown> };

const seededOn = (chainId: number) => parseNetworkOverlay(seed.networks[String(chainId)], `networks.${chainId}`).priceExceptions;

/*
 * Parity with the price computation of asset-price.ts before the
 * registry: every branch it carried, as the network it applied on, the
 * feed it matched as the Comet answered it, and the price it answered. Each
 * is an exception the seed holds for that network, and the registry's price
 * computation answers it with that same price, reading nothing — the proof
 * the branches could be removed.
 */
const REPLACED_BRANCHES = [
  { network: 'ethereum-mainnet', chainId: 1,     feed: '0xe3a409eD15CD53aFdEFdd191ad945cEC528A2496', value: '0',         decimals: 8 },
  { network: 'ethereum-mainnet', chainId: 1,     feed: '0x351a133Fd850ea81ed8a782016e308aCBADDec91', value: '102447384', decimals: 8 },
  { network: 'arbitrum-mainnet', chainId: 42161, feed: '0x13cDFB7db5e2F58e122B2e789b59dE13645349C4', value: '0',         decimals: 8 },
  { network: 'optimism-mainnet', chainId: 10,    feed: '0x66228d797eb83ecf3465297751f6b1D4d42b7627', value: '0',         decimals: 8 },
  // the branch matched this one on every network, by a precedence mistake; it was written for Optimism
  { network: 'optimism-mainnet', chainId: 10,    feed: '0x7E86318Cc4bc539043F204B39Ce0ebeD9F0050Dc', value: '0',         decimals: 8 },
] as const;

t.test('every seeded exception prices its feed as the branch it replaced did', async t => {
  const snapshot = loadRegistrySnapshotFixture();
  const template = snapshot.networks.find(network => network.chainId === 1)!.markets.find(market => market.deploymentKey === 'usdc')!;
  const networks: NetworkV1[] = ([ [ 'ethereum-mainnet', 1 ], [ 'arbitrum-mainnet', 42161 ], [ 'optimism-mainnet', 10 ] ] as const)
    .map(([ key, chainId ]) => ({
      chainId,
      key,
      upstreamKey:     key,
      displayName:     key,
      testnet:         false,
      presentation:    { assetDisplayOverrides: [], unwrappedCollateralAssets: [] },
      // a remap's scale is read when it is written, so only the kinds a branch was are taken as they are
      priceExceptions: seededOn(chainId).filter(exception => exception.kind !== 'deprecated_price_remap') as PriceExceptionV1[],
      markets:         [ { ...template, id: `00000000-0000-4000-8000-${String(chainId).padStart(12, '0')}` } ],
    }));
  const catalog = catalogOf({ ...snapshot, networks });

  const priceOf = async (network: typeof networks[number]['key'], feed: string) => {
    const read: string[] = [];
    const { evaluate, pull1 } = evaluatorOver({
      assetPrice: cometComputations.assetPrice,
      assetInfo:  stub(() => ({ asset: '0xc00e94Cb662C3520282E6f5717214004A7f26888', priceFeed: feed, scale: BigNumber.from(10).pow(18) })),
      getPrice:   stub(({ priceFeed }) => { read.push(priceFeed.address); return { status: 'error', message: 'execution reverted' }; }),
    });
    const contract = catalog.marketsOn(network as any)[0]!.comet;
    const price = await evaluate(pull1({ assetPrice: {
      apiHost: '', nodeHost: '', nodeKey: '', network, contract, assetNumber: 0, blockNumber: 20_000_000,
    } })) as { status: string, price?: BigFixnum };
    return { price, read };
  };

  for (const branch of REPLACED_BRANCHES) {
    const { price, read } = await priceOf(branch.network, branch.feed);
    t.same(
      { status: price.status, value: price.price?.value.toString(), decimals: price.price?.decimals },
      { status: 'success', value: branch.value, decimals: branch.decimals },
      `${branch.feed} on ${branch.network} is priced as before`,
    );
    t.same(read, [], 'and is not read');
  }

  const elsewhere = await priceOf('ethereum-mainnet', '0x7E86318Cc4bc539043F204B39Ce0ebeD9F0050Dc');
  t.same(elsewhere.read, [ '0x7E86318Cc4bc539043F204B39Ce0ebeD9F0050Dc' ],
    'the feed the mistaken branch matched everywhere is read on any other network, as an exception of Optimism alone');
});

/*
 * The branches survive only as that seed: no source file names a feed one of
 * them matched, so nothing prices one of them but the registry.
 */
t.test('the feeds the branches matched are named only by the seed', async t => {
  const sources = sourceFiles();
  t.ok(sources.length > 200, 'every source file is read');
  const naming = sources.filter(path => {
    const text = readFileSync(path, 'utf8').toLowerCase();
    return REPLACED_BRANCHES.some(branch => text.includes(branch.feed.toLowerCase()));
  });
  t.same(naming, [], 'no source file names a feed a branch matched');
  for (const branch of REPLACED_BRANCHES) {
    t.ok(seededOn(branch.chainId).some(exception => exception.priceFeedAddress === branch.feed.toLowerCase()),
      `the seed holds ${branch.feed} as an exception of ${branch.network}`);
  }
});
