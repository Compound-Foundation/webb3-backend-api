import t from 'tap';

import * as Compute   from '../../../lib/symbolic/computation.js';
import * as Evaluator from '../../../lib/symbolic/evaluator.js';
import * as Cache     from '../../../lib/symbolic/cache.js';
import { BigNumber }  from '../../../lib/bignumber.js';
import { BigFixnum }  from '../../../lib/bigfixnum.js';
import {
  TransactionHistoryIndex,
  firstBlockOf,
  precedingRangeEnd,
  strideOf,
} from '../../../lib/symbolic/index/transaction-history-index.js';

import * as KnownNetwork from '../../../lib/well-known/networks/network.js';

import type { EthGetLogs } from '../../../lib/computations/evm/eth-get-logs.js';
import { rawTransactionHistoryItems, type RawTransactionHistoryItems } from '../../../lib/computations/account/raw-transaction-history-items.js';
import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import { streamEventsOf } from '../../../src/transaction-history-handler/transaction-history-items-handler.js';

import { MemoryKv } from '../../util/kv.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * The ranges a history is read in: their size by network, and how the
 * ranges of one stream, read from the newest down, cover its blocks.
 */
const ACCOUNT = '0x420f253087044b8bcf028dd89f8fe83ba6275e84' as const;

t.test('every mainnet has a range sized by time, and a testnet the old default', async t => {
  const sizes: Record<string, number> = {
    'ethereum-mainnet': 1_000_000,
    'polygon-mainnet':  2_000_000,
    'arbitrum-mainnet': 10_000_000,
    'optimism-mainnet': 1_000_000,
    'base-mainnet':     10_000_000,
    'mantle-mainnet':   1_000_000,
    'ronin-mainnet':    1_000_000,
    'unichain-mainnet': 2_000_000,
    'linea-mainnet':    250_000,
    'scroll-mainnet':   250_000,
  };
  const names = KnownNetwork.getNames({ includeTestnets: true });
  t.same(names.filter(name => !KnownNetwork.isNameOfTestnet(name)).sort(), Object.keys(sizes).sort(),
    'the mainnets are the networks sized here');
  for (const network of names) {
    const size = KnownNetwork.isNameOfTestnet(network) ? 50_000 : sizes[network];
    t.equal(strideOf(network), size, `${network}: ${size} blocks`);
  }
});

/*
 * The fixture with Base's AERO market reading history too: mainnet's stream,
 * counted from 15,331,586, and Base's, from 20,852,405.
 */
const fixture = loadRegistrySnapshotFixture();
const snapshot: RegistrySnapshotV1 = {
  ...fixture,
  networks: fixture.networks.map(network => network.chainId !== 8453 ? network : {
    ...network,
    markets: network.markets.map(market => ({ ...market, capabilities: { ...market.capabilities, transactionHistory: true } })),
  }),
};
const catalog = catalogOf(snapshot);

// the context a stream's ranges are read in, at a block
function streamOf(network: 'ethereum-mainnet' | 'base-mainnet') {
  const stream = streamEventsOf(catalog).find(candidate => candidate.network === network)!;
  const marketContracts = stream.marketContractAddresses.map(address => catalog.marketAt(network, address)!.comet);
  return {
    stream,
    context: (blockNumber: number) => ({
      apiHost:         '',
      nodeHost:        '',
      nodeKey:         '',
      network,
      accountAddress:  ACCOUNT,
      proxyAddresses:  [],
      marketContracts,
      rewardsContract: marketContracts[0]!.rewards!.contract,
      catalog,
      blockNumber,
    }),
  };
}

/*
 * The ranges of logs rawTransactionHistoryItems asks the node for, read from
 * `latest` down as the history route walks them: for each range, newest
 * first, the blocks each of its reads asks for.
 */
async function rangesRead(network: 'ethereum-mainnet' | 'base-mainnet', latest: number): Promise<Array<Array<[ number, number ]>>> {
  const { context } = streamOf(network);
  let asked: Array<[ number, number ]> = [];
  const ethGetLogs = Compute.Functor<EthGetLogs>({}).implement({
    version: 1,
    compute: ({ blockRange }) => {
      asked.push(blockRange);
      return [];
    },
  });
  const { evaluate, pull1 } = Evaluator.instantiate<RawTransactionHistoryItems, RawTransactionHistoryItems | EthGetLogs>(
    { rawTransactionHistoryItems, ethGetLogs },
    { cache: new Cache.WorkersKv(MemoryKv({}), [ BigNumber.JsonReviver, BigFixnum.JsonReviver ]), flags: { evaluatorAlgorithm: 'recursive' } },
  );
  const ranges: Array<Array<[ number, number ]>> = [];
  for (let end: number | null = latest; end !== null; end = precedingRangeEnd(context(end))) {
    asked = [];
    await evaluate(pull1({ rawTransactionHistoryItems: context(end) }));
    ranges.push(asked);
  }
  return ranges;
}

for (const [ network, latest, what ] of [
  [ 'ethereum-mainnet', 23_456_789, 'mainnet\'s stream' ],
  [ 'base-mainnet',     20_852_405 + 123_456_789, 'a Base stream of more than ten ranges' ],
  [ 'base-mainnet',     20_852_405 + 120_000_000, 'a Base stream whose latest block ends a range' ],
] as const) {
  t.test(`the ranges of ${what} cover its blocks once each, from its first block to the latest`, async t => {
    const { stream } = streamOf(network);
    const first  = stream.firstBlock;
    const stride = stream.stride;
    t.equal(first, firstBlockOf(streamOf(network).context(latest)), 'the stream is counted from its first block');
    t.equal(stride, TransactionHistoryIndex.stride(streamOf(network).context(latest)), 'in ranges of its network\'s size');

    const reads = await rangesRead(network, latest);
    t.ok(reads.every(read => read.length === 2 && read[0]![0] === read[1]![0] && read[0]![1] === read[1]![1]),
      'each range is read in two reads of the same blocks');
    const ranges = reads.map(([ read ]) => read!);
    t.equal(ranges.length, Math.ceil((latest - first) / stride), 'as many ranges as the blocks above the first one fill');
    t.equal(ranges[0]![1], latest, 'the newest ends at the latest block');
    t.equal(ranges[ranges.length - 1]![0], first, 'the oldest starts at the first block');
    const gaps = ranges.slice(0, -1).map(([ from ], index) => from - ranges[index + 1]![1]);
    t.same(gaps, gaps.map(() => 1), 'each starts one block above where the range below it ends');
    const widths = ranges.map(([ from, to ]) => to - from + 1);
    t.ok(widths.every((width, index) => width >= 1 && width <= stride + (index === ranges.length - 1 ? 1 : 0)),
      'none is wider than a range, but the oldest, which holds the first block too');
    t.notOk(ranges.some(([ from, to ]) => from === first && to === first), 'none is the first block alone');
  });
}

/*
 * A range is cached under the block it ends at, and a block ends another
 * range in ranges of another size: so the key names the size too, and a range
 * cached in one size is never read as a range of another.
 */
t.test('a range is cached under its size as well as its end block', async t => {
  const { context } = streamOf('base-mainnet');
  const name = Compute.versionedName('rawTransactionHistoryItems', rawTransactionHistoryItems.version);
  t.match(await rawTransactionHistoryItems.key(name, context(20_852_405 + 30_000_000)), /;stride:10000000[;)]/, 'the key names the size');
});

t.test('a stream younger than one range is read in one range, from its first block to the latest', async t => {
  const { stream, context } = streamOf('base-mainnet');
  const latest = stream.firstBlock + 123;
  t.equal(precedingRangeEnd(context(latest)), null, 'there is no range below it');
  t.same(await rangesRead('base-mainnet', latest), [ [ [ stream.firstBlock, latest ], [ stream.firstBlock, latest ] ] ]);
});
