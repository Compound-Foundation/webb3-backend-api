import t from 'tap';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as evm   from '../../../../lib/computations/evm.js';
import * as comet from '../../../../lib/computations/comet.js';

import { checksumAddress, type Address } from '../../../../lib/model/comet-registry.js';
import { catalogOf } from '../../../../src/registry/catalog.js';

import { consoleLines } from '../../../util/console.js';
import { stub } from '../../../util/evaluator.js';
import * as mock from '../../../util/mock/mock.js';
import { loadRegistrySnapshotFixture } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * The price of a collateral whose feed the version remaps to another. A
 * replacement is younger than the history that reads it, and at a block
 * before it was deployed it reverts, while the feed the Comet named then
 * still answered. The computation runs on the real evaluator, over a Comet
 * that names the remapped feed and price reads that answer from a table.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network  = 'ethereum-mainnet' as const;
const nodeHost = 'node.test';
const nodeKey  = 'key';
const block    = 21_000_000;

// collateral feeds of the fixture's USDT market: COMP / USD, which this version states at 18 decimals, and WETH / USD
const RETIRED     = '0x69b50ff403e995d9c4441a303438d9049dac8ccd';
const RETIRED_TOO = '0xc0053f3fbccd593758258334dfce24c2a9a673ad';
const REPLACEMENT = '0x5555555555555555555555555555555555555555';
// the feeds the fixture's network already prices, wUSDM at zero and pumpBTC at its last answer
const ZERO_PRICED  = '0xe3a409ed15cd53afdefdd191ad945cec528a2496';
const FIXED_PRICED = '0x351a133fd850ea81ed8a782016e308acbaddec91';

/*
 * The fixture's USDT market, in a version that states its COMP / USD feed at
 * 18 decimals and remaps `retired` to `replacement`, read at eight.
 */
function remapping(retired: Address, replacement: Address) {
  const snapshot = loadRegistrySnapshotFixture();
  return catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : {
      ...entry,
      markets: entry.markets.map(market => market.deploymentKey !== 'usdt' ? market : {
        ...market,
        collateralAssets: market.collateralAssets.map(asset => asset.priceFeed.address !== RETIRED ? asset : {
          ...asset,
          priceFeed: { ...asset.priceFeed, decimals: 18 },
        }),
      }),
      priceExceptions: [ ...entry.priceExceptions, {
        kind:                 'deprecated_price_remap',
        priceFeedAddress:     retired,
        replacementPriceFeed: { address: replacement, decimals: 8 },
        provenance:           'the feed retired; its replacement answers the same pair',
        expiresAt:            null,
      } ],
    }),
  }).marketsOn(network).find(entry => entry.deploymentKey === 'usdt')!.comet;
}

const usdt = remapping(RETIRED, REPLACEMENT);

// the exception of the network a price was stated or read by, as the version describes it
const exceptionOf = (contract: typeof usdt, feed: string) => contract.registry.priceExceptions.find(exception => exception.priceFeedAddress === feed)!;

declare var fetch: mock.Fetch;

const price    = (decimals: number) => ({ status: 'success' as const, price: BigFixnum.from({ decimals, value: BigNumber.from(10).pow(decimals) }) });
const reverted = (message: string) => ({ status: 'error' as const, message });

/*
 * The price of a collateral of the USDT market whose Comet names `feed` at
 * the block, with every price read answered from `prices` by feed, and
 * recorded with its scale and whether it reports its revert.
 */
async function priceOf(feed: string, prices: Record<string, unknown>) {
  const reads: Array<[ address: string, decimals: number, unreported: boolean ]> = [];
  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  const { evaluate, pull1 } = Evaluator.instantiate<any>({
    assetPrice: comet.assetPrice,
    // a Comet answers its feeds checksummed
    assetInfo:  stub(() => ({ asset: '0x1111111111111111111111111111111111111111', scale: 1, priceFeed: checksumAddress(feed) })),
    getPrice:   stub(({ priceFeed, unreported }) => {
      const address = priceFeed.address.toLowerCase();
      reads.push([ address, priceFeed.decimals, unreported === true ]);
      return prices[address] ?? reverted('no feed answers at that address');
    }),
  } as any, { cache, debug, flags });
  const answer = await evaluate(pull1({
    assetPrice: { apiHost: '', nodeHost, nodeKey, network, contract: usdt, blockNumber: block, assetNumber: 0 },
  }));
  return { answer, reads };
}

t.test('a remapped feed is read from its replacement', async t => {
  const logged = consoleLines(t, [ 'warn' ]);
  const { answer, reads } = await priceOf(RETIRED, { [REPLACEMENT]: price(8), [RETIRED]: price(18) });

  t.strictSame(answer, { ...price(8), exception: exceptionOf(usdt, RETIRED) },
    'at the scale the version states for the replacement, naming the remap that priced it');
  t.strictSame(reads, [ [ REPLACEMENT, 8, true ] ], 'and the feed it replaces is not read');
  t.strictSame(logged, []);
});

/*
 * Whether the replacement's revert is one to report, and whether the price
 * the feed the Comet named gives is one to value by, are its reader's to
 * tell: at a block before the replacement was deployed, which the history
 * reads, its revert is expected, and at the latest block, which the summary
 * reads, the replacement has stopped answering (market-latest-summary.ts). So
 * that price names the remap it fell back from and carries the revert, naming
 * the replacement as the version names it, and the computation reports
 * nothing itself.
 */
t.test('a block before the replacement was deployed is read from the feed the Comet named', async t => {
  const logged = consoleLines(t, [ 'warn' ]);
  const { answer, reads } = await priceOf(RETIRED, { [RETIRED]: price(18) });

  t.strictSame(answer, { ...price(18), exception: exceptionOf(usdt, RETIRED), replacementRevert: { feed: REPLACEMENT, message: 'no feed answers at that address' } },
    'at the scale the version states for that feed, naming the remap it fell back from, and carrying what the replacement reverted with');
  t.strictSame(reads, [ [ REPLACEMENT, 8, true ], [ RETIRED, 18, true ] ], 'once the replacement reverted');
  t.strictSame(logged, [], 'and the revert of a replacement that did not exist yet is not reported here');
});

t.test('a remapped feed is reported only when neither feed answers', async t => {
  const logged = consoleLines(t, [ 'warn' ]);
  const { answer, reads } = await priceOf(RETIRED, {
    [REPLACEMENT]: reverted('the replacement reverted'),
    [RETIRED]:     reverted('the retired feed reverted'),
  });

  t.strictSame(answer, { ...reverted('the replacement reverted'), exception: null },
    'the collateral answers the revert of its replacement, priced by nothing, and leaves its reader nothing more to report');
  t.equal(reads.length, 2);
  t.equal(logged.length, 1, 'reported once');
  t.match(logged[0], /^price feed reverted: /, 'under the prefix the runbook alerts on');
  t.equal(logged[0], `price feed reverted: ${REPLACEMENT} read by ${usdt.address} on ${network} at block ${block}: the replacement reverted`,
    'naming the replacement, which the version prices the collateral with, and its revert');
});

t.test('a feed the version prices is not read', async t => {
  for (const [ feed, expected ] of [ [ ZERO_PRICED, '0.0' ], [ FIXED_PRICED, '1.02447384' ] ] as const) {
    const { answer, reads } = await priceOf(feed, {});
    t.match(answer, { status: 'success' });
    t.equal((answer as any).price.toString(), expected);
    t.strictSame(reads, [], `${feed} is answered by its exception`);
    t.strictSame((answer as any).exception, exceptionOf(usdt, feed), 'which the price names');
  }
});

t.test('a feed no exception describes is read, and its price names none', async t => {
  const { answer, reads } = await priceOf(RETIRED_TOO, { [RETIRED_TOO]: price(8) });
  t.strictSame(answer, { ...price(8), exception: null }, 'the price the Comet\'s feed answered');
  t.strictSame(reads, [ [ RETIRED_TOO, 8, false ] ], 'read once, its revert one to report');
});

/*
 * The same, through the real price read and a node: a replacement that was
 * not deployed yet is no contract, and a Comet's read of it reverts with no
 * data, which the node answers -32000. That read reports nothing, and the
 * feed the Comet named answers.
 */
t.test('a replacement with no code yet falls back through a real read, which reports nothing', async t => {
  const logged      = consoleLines(t, [ 'warn' ]);
  const replacement = '0x6666666666666666666666666666666666666666';
  const contract    = remapping(RETIRED_TOO, replacement);

  const fetchBefore = global.fetch;
  global.fetch = mock.fetch({ passthrough: false });
  t.teardown(() => { global.fetch = fetchBefore; });
  const answerWith = (feed: string, answer: { result: string } | { error: { code: number, message: string } }) => {
    mock.rpc.expectPost(fetch, Eth.nodeEndpoint(nodeHost, nodeKey, network), [
      {
        jsonrpc: '2.0',
        id:      0,
        method:  'eth_call',
        params:  [ { to: contract.address, data: `0x41976e09${feed.slice(2).padStart(64, '0')}` }, `0x${block.toString(16)}` ],
      },
      { jsonrpc: '2.0', id: 0, ...answer },
    ]);
  };
  answerWith(replacement, { error: { code: -32000, message: 'execution reverted' } });
  answerWith(RETIRED_TOO, { result: `0x${(250_000_000_000).toString(16).padStart(64, '0')}` });

  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  const { evaluate, pull1 } = Evaluator.instantiate<any>({
    ...evm,
    ...comet,
    assetInfo: stub(() => ({ asset: '0x1111111111111111111111111111111111111111', scale: 1, priceFeed: checksumAddress(RETIRED_TOO) })),
  } as any, { cache, debug, flags });
  const answer = await evaluate(pull1({
    assetPrice: { apiHost: '', nodeHost, nodeKey, network, contract, blockNumber: block, assetNumber: 0 },
  }));

  t.match(answer, { status: 'success' });
  t.equal((answer as any).price.toString(), '2500.0', 'the feed the Comet named, at its eight decimals');
  t.strictSame((answer as any).exception, exceptionOf(contract, RETIRED_TOO), 'naming the remap it fell back from');
  t.strictSame((answer as any).replacementRevert, { feed: replacement, message: 'execution reverted' }, 'carrying what the replacement reverted with');
  t.strictSame(logged, [], 'and the replacement\'s revert is not reported here');
  fetch.satisfy(t);
});
