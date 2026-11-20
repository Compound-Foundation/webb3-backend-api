import t from 'tap';

import { defaultAbiCoder } from '@ethersproject/abi';

import Quota          from '../../../lib/quota.js';
import * as Fallible  from '../../../lib/fallible/fallible.js';
import * as Index     from '../../../lib/symbolic/index.js';
import * as Compute   from '../../../lib/symbolic/computation.js';
import * as Evaluator from '../../../lib/symbolic/evaluator.js';
import * as Cache     from '../../../lib/symbolic/cache.js';
import { BigNumber }  from '../../../lib/bignumber.js';
import { BigFixnum }  from '../../../lib/bigfixnum.js';

import type { EthGetLogs } from '../../../lib/computations/evm/eth-get-logs.js';
import type { SleuthQuery } from '../../../lib/computations/sleuth/sleuth-query.js';
import { rawTransactionHistoryItems, type RawTransactionHistoryItems } from '../../../lib/computations/account/raw-transaction-history-items.js';
import { getRewardConfigsSleuth, type GetRewardConfigsSleuth } from '../../../lib/computations/comet-rewards/get-reward-configs-sleuth.js';
import { marketRewards } from '../../../lib/computations/market/market-rewards.js';
import type { MarketV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import type { Catalog } from '../../../src/registry/catalog.js';
import { rewardGroups } from '../../../src/account-handlers/rewards.js';
import { streamEventsOf } from '../../../src/transaction-history-handler/cursor.js';

import { MemoryKv } from '../../util/kv.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * KV refuses a key longer than 512 bytes of UTF-8, and some computations are
 * keyed by lists that grow: the markets an operator turns on, the proxies an
 * account has. A cached value of each is written and read back here through
 * the cache its route uses, over a KV double that refuses what the runtime
 * refuses. Names are versioned as the evaluator versions them, so a new
 * version of a computation keeps the test about its key.
 */
const MAINNET = 'ethereum-mainnet' as const;
const ACCOUNT = '0x420f253087044b8bcf028dd89f8fe83ba6275e84' as const;
const PROXIES = [ '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222' ] as const;
const COMP    = '0xc00e94cb662c3520282e6f5717214004a7f26888' as const;

const REVIVERS = [ BigNumber.JsonReviver, BigFixnum.JsonReviver ];

const fixture = loadRegistrySnapshotFixture();

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/*
 * The fixture's mainnet with `count` markets that read history and pay
 * account rewards through its one CometRewards: its own markets, then copies
 * of its USDC market at other addresses, as an operator turns more on.
 */
function mainnetWith(count: number): Catalog {
  const snapshot: RegistrySnapshotV1 = {
    ...fixture,
    networks: fixture.networks.map(network => {
      if (network.chainId !== 1) {
        return network;
      }
      const usdc   = network.markets[0]!;
      const copies = Array.from({ length: Math.max(0, count - network.markets.length) }, (_, index): MarketV1 => ({
        ...usdc,
        deploymentKey: `usdc-${index + 2}`,
        contracts:     { ...usdc.contracts, comet: `0x${(index + 1).toString(16).padStart(40, 'c')}` },
      }));
      return {
        ...network,
        markets: [ ...network.markets, ...copies ].slice(0, count).map(market => ({
          ...market,
          capabilities: { ...market.capabilities, transactionHistory: true, accountRewards: true },
        })),
      };
    }),
  };
  return catalogOf(snapshot);
}

t.test('a key KV takes is stored as it is, and a longer one under its name and digest', async t => {
  const name    = Compute.versionedName('marketRewards', marketRewards.version);
  const longest = `${name}:${'a'.repeat(Cache.KV_MAX_KEY_BYTES - name.length - 1)}`;
  t.equal(bytes(longest), Cache.KV_MAX_KEY_BYTES);
  t.equal(Cache.kvKeyOf(longest), longest, 'a key of 512 bytes is stored as it is');

  // a label is an operator's text, limited in characters, while KV counts bytes
  const wide = `${name}:(label:${'₮'.repeat(170)})`;
  t.ok(wide.length < Cache.KV_MAX_KEY_BYTES && bytes(wide) > Cache.KV_MAX_KEY_BYTES,
    'a key of fewer characters than the limit can be more bytes than it');

  for (const key of [ `${longest}b`, wide ]) {
    const stored = Cache.kvKeyOf(key);
    t.match(stored, new RegExp(`^${name}#keccak256:[0-9a-f]{64}$`), 'a longer one is stored under its computation and its digest');
    t.ok(bytes(stored) <= Cache.KV_MAX_KEY_BYTES, 'which KV takes');
    t.equal(Cache.kvKeyOf(key), stored, 'the same one every time');
  }
  t.not(Cache.kvKeyOf(`${longest}b`), Cache.kvKeyOf(`${longest}c`), 'two keys that differ past the limit are two entries');
  t.match(Cache.kvKeyOf('x'.repeat(600)), /^key#keccak256:[0-9a-f]{64}$/, 'and a key no computation names goes under a generic name');
});

t.test('the KV double refuses a key the runtime refuses, as the runtime does', async t => {
  const kv      = MemoryKv({});
  const key     = 'a'.repeat(513);
  const refused = (method: string) => ({
    message: `KV ${method} failed: 414 UTF-8 encoded length of 513 exceeds key length limit of 512.`,
  });

  await t.rejects(kv.get(key), refused('GET'));
  await t.rejects(kv.getWithMetadata(key), refused('GET'));
  await t.rejects(kv.put(key, 'value'), refused('PUT'));
  await t.rejects(kv.delete(key), refused('DELETE'));
  await t.rejects(kv.list({ prefix: key }), refused('GET'), 'a listing is a GET, and its prefix a key');
  await t.rejects(kv.get('₮'.repeat(171)), refused('GET'), 'counting bytes, not characters');

  await kv.put('a'.repeat(512), 'value');
  t.equal(await kv.get('a'.repeat(512)), 'value', 'while a key of 512 bytes is taken');
});

/*
 * A node with no logs for the account, which counts what it is asked: a
 * window computed again asks it again.
 */
function noLogs(): { ethGetLogs: Compute.Implementation<EthGetLogs>, asked: () => number } {
  let asked = 0;
  const ethGetLogs = Compute.Functor<EthGetLogs>({}).implement({
    version: 1,
    compute: () => {
      asked++;
      return [];
    },
  });
  return { ethGetLogs, asked: () => asked };
}

/*
 * A history window past the newest is cached, at an index point. Its key
 * names the stream's markets, the account's proxies and the network's
 * history: with two proxies and the fixture's four markets, or with six
 * markets, it is longer than KV takes. The window is read with the evaluator
 * and the cache the history route reads it with.
 */
for (const [ markets, proxies, what ] of [
  [ 4, PROXIES, 'four markets, of an account with two proxies' ],
  [ 6, [],      'six markets' ],
] as const) {
  t.test(`a history window of ${what} is cached, and read back`, async t => {
    const catalog    = mainnetWith(markets);
    const [ stream ] = streamEventsOf(catalog);
    t.equal(stream?.marketContractAddresses.length, markets, `one stream reads the ${markets} markets`);

    const comets = stream!.marketContractAddresses.map(address => catalog.marketAt(MAINNET, address)!.comet);
    const base   = {
      apiHost:         '',
      nodeHost:        '',
      nodeKey:         '',
      network:         MAINNET,
      accountAddress:  ACCOUNT,
      proxyAddresses:  [ ...proxies ],
      marketContracts: comets,
      rewardsContract: comets[0]!.rewards!.contract,
      catalog,
      blockNumber:     0,
    };
    const index   = Index.TransactionHistoryIndex;
    const context = { ...base, blockNumber: index.start(base) + 5 * index.stride(base) };
    t.ok(index.includes(context), 'at an index point');

    const name = Compute.versionedName('rawTransactionHistoryItems', rawTransactionHistoryItems.version);
    t.ok(bytes(await rawTransactionHistoryItems.key(name, context)) > Cache.KV_MAX_KEY_BYTES, 'its key is longer than KV takes');

    const kv   = MemoryKv({});
    const node = noLogs();
    const read = () => {
      // the node stands in for the reads of logs, so nothing below them is in scope
      const { evaluate, pull1 } = Evaluator.instantiate<RawTransactionHistoryItems, RawTransactionHistoryItems | EthGetLogs>(
        { rawTransactionHistoryItems, ethGetLogs: node.ethGetLogs },
        { cache: new Cache.WorkersKv(kv, REVIVERS), flags: { evaluatorAlgorithm: 'recursive' } },
      );
      return evaluate(pull1({ rawTransactionHistoryItems: context }));
    };

    t.same(await read(), [], 'the window is computed');
    t.same(await read(), [], 'and read again');
    t.equal(node.asked(), 2, 'by its two reads of logs, once: the second time it is read from KV');

    const stored = (await kv.list()).keys.map(key => key.name);
    t.equal(stored.length, 1);
    t.match(stored[0], new RegExp(`^${name}#keccak256:[0-9a-f]{64}$`), 'where it is stored under its digest');
  });
}

/*
 * One Sleuth query reads the reward configs of a whole rewards group, keyed
 * by its markets: eight markets make the key longer than KV takes. The
 * configs are read with the evaluator and the cache the account rewards
 * route reads them with.
 */
t.test('the reward configs of a group of eight markets are cached, and read back', async t => {
  const groups = rewardGroups(mainnetWith(8), [ MAINNET ]);
  t.equal(groups.length, 1);
  const { contracts } = groups[0]!;
  t.equal(contracts.length, 8, 'the eight markets are one group');

  const context = Fallible.must(getRewardConfigsSleuth.index.project({
    apiHost:      '',
    nodeHost:     '',
    nodeKey:      '',
    network:      MAINNET,
    block:        { number: 23_000_000 },
    cometMarkets: contracts,
  }));
  const name = Compute.versionedName('getRewardConfigsSleuth', getRewardConfigsSleuth.version);
  t.ok(bytes(await getRewardConfigsSleuth.key(name, context)) > Cache.KV_MAX_KEY_BYTES, 'its key is longer than KV takes');

  let asked = 0;
  const sleuthQuery = Compute.Functor<SleuthQuery>({}).implement({
    version: 0,
    compute: () => {
      asked++;
      return defaultAbiCoder.encode([ 'tuple(address,uint64,bool)[]' ], [ contracts.map(() => [ COMP, 1, false ]) ]);
    },
  });

  const kv   = MemoryKv({});
  const read = () => {
    const quota = Quota.initialize({ ops: Infinity, reads: Infinity, writes: Infinity });
    const { evaluate, pull1 } = Evaluator.instantiate<GetRewardConfigsSleuth, GetRewardConfigsSleuth | SleuthQuery>({ getRewardConfigsSleuth, sleuthQuery }, {
      cache: Cache.Layers.of([
        new Cache.Memory({}, REVIVERS),
        Cache.Quota.wrap(quota, new Cache.WorkersKv(kv, REVIVERS)),
      ]),
      flags: { batchingEnabled: true, evaluatorAlgorithm: 'workingset' },
    });
    return evaluate(pull1({ getRewardConfigsSleuth: context }));
  };

  const computed = await read();
  const cached   = await read();
  t.equal(asked, 1, 'Sleuth is asked once: the second time, with nothing in memory, the configs are read from KV');
  for (const configs of [ computed, cached ]) {
    t.same(configs.map(config => config.cometAddress), contracts.map(comet => comet.address));
    t.same(configs.map(config => config.rewardConfig.rewardToken.toLowerCase()), contracts.map(() => COMP));
  }

  const stored = (await kv.list()).keys.map(key => key.name);
  t.equal(stored.length, 1);
  t.match(stored[0], new RegExp(`^${name}#keccak256:[0-9a-f]{64}$`), 'where they are stored under their digest');
});
