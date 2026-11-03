import t from 'tap';

import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Compute    from '../../../../lib/symbolic/computation.js';
import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as comet from '../../../../lib/computations/comet.js';

import type { RegistryComet } from '../../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../../src/registry/catalog.js';

import { fixtureCatalog, loadRegistrySnapshotFixture } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * The feed a market's base asset is priced in USD through: the computation
 * runs on the real evaluator, over price reads that answer from a table
 * instead of a node.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network = 'ethereum-mainnet' as const;
const block   = { number: 50_000_000, timestamp: 1_790_000_000 };

const one  = (decimals = 8) => BigFixnum.from({ decimals, value: BigNumber.from(10).pow(decimals) });
const read = (price: BigFixnum) => ({ status: 'success' as const, price });

function stub(answer: (context: any) => unknown) {
  return Compute.Functor<any>({}).implement({ version: 0, compute: context => answer(context) });
}

function evaluator(computations: Record<string, unknown>) {
  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  return Evaluator.instantiate<any>(computations as any, { cache, debug, flags });
}

/*
 * The base asset's USD price converts the unit a market's own feeds answer
 * in to USD, so it is read from the feed the version's quote calls for, at
 * the scale the version states, and never from whichever feed happens to be
 * there.
 */
t.test('the base asset\'s USD price is read from the feed the quote calls for', async t => {
  const feeds: string[] = [];
  const { evaluate, pull1 } = evaluator({
    baseUsdPrice: comet.baseUsdPrice,
    getPrice:     stub(({ priceFeed }) => { feeds.push(`${priceFeed.address.toLowerCase()}/${priceFeed.decimals}`); return read(one()); }),
  });
  const priceOf = (contract: RegistryComet) => evaluate(pull1({
    baseUsdPrice: { apiHost: '', nodeHost: '', nodeKey: '', network, contract, blockNumber: block.number },
  }));
  const snapshot = loadRegistrySnapshotFixture();
  const marketOf = (key: string) => snapshot.networks.find(entry => entry.chainId === 1)!.markets.find(each => each.deploymentKey === key)!;
  const comets   = fixtureCatalog();
  const cometOf  = (key: string) => comets.marketsOn(network).find(entry => entry.deploymentKey === key)!.comet;

  await priceOf(cometOf('usdt'));
  await priceOf(cometOf('weth'));
  await priceOf(cometOf('wbtc'));
  t.strictSame(feeds, [
    `${marketOf('usdt').baseAsset.priceFeed.address}/8`,
    `${marketOf('weth').baseAsset.usdPriceFeed!.address}/8`,
    `${marketOf('wbtc').baseAsset.usdPriceFeed!.address}/8`,
  ], 'USDT through its own USD feed; WETH through ETH / USD and WBTC through BTC / USD, the units their own feeds answer in');

  const unconverted = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : {
      ...entry,
      markets: entry.markets.map(each => each.deploymentKey !== 'weth' ? each : { ...each, baseAsset: { ...each.baseAsset, usdPriceFeed: null } }),
    }),
  }).marketsOn(network).find(entry => entry.deploymentKey === 'weth')!.comet;
  await t.rejects(priceOf(unconverted), /quoted in its base asset without a USD feed/,
    'a market quoted in its base asset without one, which validation refuses, is not priced through its own feed instead');
});
