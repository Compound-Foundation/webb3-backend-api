import t from 'tap';

import { readFileSync } from 'node:fs';

import * as Fallible from '../../../lib/fallible/fallible.js';

import type * as jsonRpc from '../../../lib/json-rpc.js';

import { ChainEndpoint, MAX_CALLS_PER_BATCH, enrichMarket, proxyTransport, readCreationBlocks } from '../../../src/registry/enrichment.js';
import { parseDeploymentPath, parseRoot } from '../../../src/registry/source/roots.js';
import { isRegistryError } from '../../../src/registry/errors.js';

/*
 * On-chain enrichment, replaying responses recorded from Ethereum mainnet for
 * cUSDCv3 at the block the fixture names, which also says how they were
 * keyed: base asset, price feeds, thirteen collateral assets, and the reward
 * token the rewards contract names. Tests answer from the recording, so they
 * neither reach a node provider nor depend on current market state.
 */
const FIXTURE  = './tests/fixtures/registry/chain/ethereum-mainnet-usdc.json';
const ROOT_PATH = 'deployments/mainnet/usdc/roots.json';

type Recording = {
  chainId:   number,
  responses: Record<string, string>,
};

const recording: Recording = JSON.parse(readFileSync(FIXTURE, 'utf8'));

async function mainnetRoot() {
  return parseRoot(
    parseDeploymentPath(ROOT_PATH),
    readFileSync('./tests/fixtures/registry/source/roots/mainnet-usdc.json', 'utf8'),
    'a'.repeat(40),
  );
}

function keyOf(call: jsonRpc.Call): string {
  if (call.method === 'eth_getCode') {
    return `eth_getCode:${call.params[0]}`;
  }
  if (call.method === 'eth_call') {
    return `eth_call:${call.params[0].to}:${call.params[0].data}`;
  }
  return call.method;
}

/*
 * Replays the recording. `overrides` replaces the answer for one key,
 * `failures` makes a key revert, and `errors` makes it answer with any other
 * JSON-RPC error, which is how a revert, an unreadable contract or a node
 * that does not serve the call is exercised.
 */
function replay({ overrides = {}, failures = [], errors = {} }: {
  overrides?: Record<string, string>,
  failures?:  string[],
  errors?:    Record<string, jsonRpc.Error>,
} = {}) {
  const batches: number[] = [];
  const transport = async (calls: jsonRpc.Call[]) => {
    batches.push(calls.length);
    return calls.map(call => {
      const key = keyOf(call);
      if (failures.includes(key)) {
        return { error: { code: 3, message: 'execution reverted' } };
      }
      if (errors[key] !== undefined) {
        return { error: errors[key] };
      }
      const result = overrides[key] ?? recording.responses[key];
      if (result === undefined) {
        throw new Error(`no recorded response for ${key}`);
      }
      return { result };
    });
  };
  return { transport, batches };
}

async function rejects(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!isRegistryError(error)) {
      throw error;
    }
    t.equal(error.code, code, `rejected with ${code}`);
    return;
  }
  throw new Error(`expected ${code}, but the operation resolved`);
}

// uint256-encoded value, as an eth_call result
function word(value: string | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

t.test('a market is read from its Comet and rewards contracts', async t => {
  const root = await mainnetRoot();
  const { transport, batches } = replay();
  const enriched = await enrichMarket(transport, root);

  t.same(enriched.baseToken, {
    address:  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol:   'USDC',
    name:     'USD Coin',
    decimals: 6,
  }, 'the base token comes from the Comet, not from the roots file');
  t.same(enriched.basePriceFeed, {
    address:  '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6',
    decimals: 8,
  }, 'the base price feed reports its own decimals');

  t.equal(enriched.rewardToken?.symbol, 'COMP', 'the reward token comes from rewardConfig');
  t.equal(enriched.rewardToken?.address, '0xc00e94cb662c3520282e6f5717214004a7f26888');

  t.equal(enriched.collateralAssets.length, 13);
  t.same(
    enriched.collateralAssets.map(asset => asset.assetIndex),
    [ ...Array(13).keys() ],
    'collateral indices are contiguous and ordered',
  );
  t.same(
    enriched.collateralAssets.slice(0, 3).map(asset => asset.token.symbol),
    [ 'COMP', 'WBTC', 'WETH' ],
    'collateral tokens keep the order getAssetInfo reports',
  );
  t.ok(
    enriched.collateralAssets.every(asset => asset.priceFeed.decimals === 8),
    'every collateral feed reports decimals',
  );
  t.ok(
    enriched.collateralAssets.every(asset => asset.token.address === asset.token.address.toLowerCase()),
    'addresses are normalized lowercase',
  );
  t.ok(batches.every(size => size <= MAX_CALLS_PER_BATCH), 'calls are sent in bounded batches');
});

/*
 * A market is read in three round trips, each one batch that waits only on
 * what the one before answered: the code of every declared contract with the
 * Comet's base fields and the reward token; the collateral assets, whose
 * count the first answered; and every token with every feed. The feeds a
 * reviewed overlay names are read in the last, beside the market's own, and
 * the chain id is not asked at all: the node provider proxy answers it from
 * its own table, so it would say nothing about the chain behind it.
 */
t.test('a market is read in three round trips, with the feeds its overlay names', async t => {
  const root    = await mainnetRoot();
  const usdFeed = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';
  const { transport } = replay({ overrides: { [`eth_call:${usdFeed}:0x313ce567`]: word(8) } });
  const trips: string[][] = [];
  const enriched = await enrichMarket(async calls => {
    trips.push(calls.map(keyOf));
    return transport(calls);
  }, root, [ usdFeed ]);

  t.equal(trips.length, 3, 'three round trips');
  t.ok(trips[0]!.includes(`eth_getCode:${root.contracts.comet}`) && trips[0]!.includes(`eth_call:${root.contracts.comet}:0xc55dae63`),
    'the first asks for the code beside the base fields');
  t.equal(trips[1]!.length, 13, 'the second for each collateral asset');
  t.ok(trips[2]!.includes(`eth_call:${usdFeed}:0x313ce567`), 'and the last for the feed the overlay names, with the rest');
  t.notOk(trips.flat().includes('eth_chainId'), 'the chain id is not asked');
  t.same(enriched.feeds.get(usdFeed), { address: usdFeed, decimals: 8 }, 'so the feed is read with its scale');
  t.same(
    enriched.feeds.get(enriched.basePriceFeed.address),
    enriched.basePriceFeed,
    'beside the feeds the market itself names',
  );
});

t.test('unreadable chain state fails the import', async () => {
  const root = await mainnetRoot();

  const noComet = replay({ overrides: { [`eth_getCode:${root.contracts.comet}`]: '0x' } });
  await rejects(() => enrichMarket(noComet.transport, root), 'CHAIN_CONTRACT_MISSING');

  /*
   * An address without code answers the reads sent beside its code with no
   * data. The code is judged first, so the market fails as the missing
   * contract it is — what an endpoint serving another chain looks like —
   * rather than as a read that answered nothing.
   */
  const nothingThere = replay({
    overrides: {
      [`eth_getCode:${root.contracts.comet}`]:           '0x',
      [`eth_call:${root.contracts.comet}:0xc55dae63`]: '0x',
    },
  });
  await rejects(() => enrichMarket(nothingThere.transport, root), 'CHAIN_CONTRACT_MISSING');

  /*
   * Any declared contract, not only the Comet: a market the registry cannot
   * fully read is not one it can serve, and dropping the role would serve it
   * as if the source had not declared one.
   */
  const noBulker = replay({ overrides: { [`eth_getCode:${root.contracts.bulker}`]: '0x' } });
  await rejects(() => enrichMarket(noBulker.transport, root), 'CHAIN_CONTRACT_MISSING');
  const noRewards = replay({ overrides: { [`eth_getCode:${root.contracts.rewards}`]: '0x' } });
  await rejects(() => enrichMarket(noRewards.transport, root), 'CHAIN_CONTRACT_MISSING');

  const reverting = replay({ failures: [ `eth_call:${root.contracts.comet}:0xc55dae63` ] });
  await rejects(() => enrichMarket(reverting.transport, root), 'CHAIN_CALL_REVERTED');

  const empty = replay({ overrides: { [`eth_getCode:${root.contracts.comet}`]: '' } });
  await rejects(() => enrichMarket(empty.transport, root), 'CHAIN_RESPONSE_INVALID');

  // a feed the overlay names that is no feed fails the market it was read for
  const notAFeed = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';
  const unreadable = replay({ failures: [ `eth_call:${notAFeed}:0x313ce567` ] });
  await rejects(() => enrichMarket(unreadable.transport, root, [ notAFeed ]), 'CHAIN_CALL_REVERTED');

  const tooManyAssets = replay({
    // numAssets() answers with a count no Comet has
    overrides: { [`eth_call:${root.contracts.comet}:0xa46fe83b`]: word(200) },
  });
  await rejects(() => enrichMarket(tooManyAssets.transport, root), 'CHAIN_RESPONSE_INVALID');

  const failing = async () => { throw new Error('socket closed'); };
  await rejects(() => enrichMarket(failing, root), 'CHAIN_REQUEST_FAILED');

  const short = async () => [];
  await rejects(() => enrichMarket(short, root), 'CHAIN_RESPONSE_INVALID');
});

/*
 * A revert is the contract's answer, the same from every provider. Any other
 * error a node answers with — a rate limit, a block it does not have — is the
 * node not serving the call: a provider that did not answer, which says
 * nothing about the market. And an address without code answers a call with
 * no data, which is the chain's answer about that address, and names it.
 */
t.test('only a revert is a revert, and an empty answer names its contract', async t => {
  const root      = await mainnetRoot();
  const baseToken = `eth_call:${root.contracts.comet}:0xc55dae63`;

  const limited = replay({ errors: { [baseToken]: { code: -32005, message: 'limit exceeded' } } });
  const busy    = await enrichMarket(limited.transport, root).then(() => null, (error: unknown) => error);
  t.ok(isRegistryError(busy) && busy.code === 'CHAIN_REQUEST_FAILED', 'a node that did not serve the call did not answer');
  t.same((busy as Error).cause, { code: -32005, message: 'limit exceeded' }, 'and what it said is the cause, for the log');

  // Geth answers a revert without data as -32000, with the same message
  const geth = replay({ errors: { [baseToken]: { code: -32000, message: 'execution reverted' } } });
  await rejects(() => enrichMarket(geth.transport, root), 'CHAIN_CALL_REVERTED');

  const empty    = replay({ overrides: { [baseToken]: '0x' } });
  const answered = await enrichMarket(empty.transport, root).then(() => null, (error: unknown) => error);
  t.ok(isRegistryError(answered) && answered.code === 'CHAIN_RESPONSE_INVALID',
    'an empty answer is the chain\'s answer, not a fault of the reader');
  t.match((answered as Error).message, root.contracts.comet!, 'and names the contract that gave it');
});

t.test('a market without a configured reward token has none', async t => {
  const root = await mainnetRoot();
  const rewards = root.contracts.rewards!;
  const { transport } = replay({
    overrides: {
      // rewardConfig() answering with the zero address means rewards are unset
      [`eth_call:${rewards}:0x2289b6b8000000000000000000000000c3d688b66703497daa19211eedff47f25384cdc3`]:
        `${word(0)}${word(0).slice(2)}${word(0).slice(2)}`,
    },
  });
  const enriched = await enrichMarket(transport, root);
  t.equal(enriched.rewardToken, null, 'no reward token is reported');
});

t.test('legacy bytes32 token metadata is accepted', async t => {
  const root = await mainnetRoot();
  const base = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const asBytes32 = (text: string) => '0x' + Buffer.from(text, 'utf8').toString('hex').padEnd(64, '0');
  const { transport } = replay({
    overrides: {
      // symbol() and name() of a token that predates the string return type
      [`eth_call:${base}:0x95d89b41`]: asBytes32('MKR'),
      [`eth_call:${base}:0x06fdde03`]: asBytes32('Maker'),
    },
  });
  const enriched = await enrichMarket(transport, root);
  t.equal(enriched.baseToken.symbol, 'MKR', 'a padded bytes32 symbol is decoded');
  t.equal(enriched.baseToken.name, 'Maker', 'so is the name');
});

/*
 * What failed underneath a node provider request is the failure's cause,
 * which the import logs and D1 does not keep: the error the request threw, or
 * the failure a fetch reported instead of an answer.
 */
t.test('a node provider request that failed carries what failed underneath', async t => {
  const root = await mainnetRoot();

  const thrown  = new Error('socket closed');
  const failure = await enrichMarket(async () => { throw thrown; }, root).then(() => null, (error: unknown) => error);
  t.ok(isRegistryError(failure) && failure.code === 'CHAIN_REQUEST_FAILED');
  t.equal((failure as Error).cause, thrown, 'a request that threw');

  const exhausted = { type: 'InsufficientQuota', error: new Error('fetch(..): bailing out; request quota exhausted') };
  const transport = proxyTransport({
    apiHost:  'v3-api.test',
    nodeHost: 'node-proxy.test',
    nodeKey:  'node-proxy-key',
    network:  'ethereum-mainnet',
    // a fetch that reports its failure rather than throwing it, as the request handler's counting fetch does
    fetch:    (async () => Fallible.Outcome.Of.Failure(exhausted)) as unknown as ChainEndpoint['fetch'],
  });
  const reported = await enrichMarket(transport, root).then(() => null, (error: unknown) => error);
  t.ok(isRegistryError(reported) && reported.code === 'CHAIN_REQUEST_FAILED');
  t.equal((reported as Error).cause, exhausted, 'and a failure the fetch reported');
});

/*
 * A batch the node provider proxy does not answer is cut at a deadline,
 * whether the answer never starts or its body stalls, and is a provider that
 * did not answer: the import is not held open by a connection nobody answers.
 * The stubs end as the platform's fetch ends a request whose signal fires.
 */
t.test('a node provider that does not answer is cut at its deadline', async t => {
  // Node does not stay up for a deadline's timer alone, as nothing in a Worker has to
  const alive = setInterval(() => {}, 1_000);
  t.teardown(() => clearInterval(alive));
  const root     = await mainnetRoot();
  const endpoint = {
    apiHost:   'v3-api.test',
    nodeHost:  'node-proxy.test',
    nodeKey:   'node-proxy-key',
    network:   'ethereum-mainnet' as const,
    timeoutMs: 50,
  };

  const silent = proxyTransport({
    ...endpoint,
    fetch: request => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason));
    }),
  });
  const started    = Date.now();
  const unanswered = await enrichMarket(silent, root).then(() => null, (error: unknown) => error);
  t.ok(isRegistryError(unanswered) && unanswered.code === 'CHAIN_REQUEST_FAILED', 'a provider that did not answer');
  t.equal((unanswered as Error).message, 'the node provider did not answer within 0.05 seconds', 'whose message names the deadline');
  t.ok((unanswered as Error).cause !== undefined, 'and keeps what the deadline cut short as the cause');
  t.ok(Date.now() - started < 5_000, 'at the deadline, not whenever the connection would have closed');

  const stalled = proxyTransport({
    ...endpoint,
    fetch: async request => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"jsonrpc":"2.0","id":0,'));
        request.signal.addEventListener('abort', () => controller.error(request.signal.reason));
      },
    })),
  });
  const cut = await enrichMarket(stalled, root).then(() => null, (error: unknown) => error);
  t.equal((cut as Error).message, 'the node provider did not answer within 0.05 seconds',
    'an answer whose body stalls is cut by the same deadline');
});

/*
 * The block a Comet was deployed in is the one where it has code and had none
 * the block before. A block past the latest one is no block yet, so the code
 * is asked only at the blocks the chain has reached.
 */
t.test('a creation block is held against the code its Comet has there and the block before', async t => {
  const comet    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
  const deployed = 15331586;
  const head     = deployed + 1_000;
  const batches: string[][] = [];
  const transport = async (calls: jsonRpc.Call[]) => {
    batches.push(calls.map(call => [ call.method, ...call.params as string[] ].join(' ')));
    return calls.map(call => call.method === 'eth_blockNumber'
      ? { result: `0x${head.toString(16)}` }
      : { result: Number.parseInt(call.params[1] as string, 16) >= deployed ? '0x6080604052' : '0x' });
  };
  const market = (scope: string, block: number) => ({ scope, comet, block } as const);

  t.same(await readCreationBlocks(transport, [ market('overlay', deployed) ], 'ethereum-mainnet'), [],
    'the block it was deployed in is right');
  t.same(batches, [
    [ 'eth_blockNumber' ],
    [ `eth_getCode ${comet} 0x${deployed.toString(16)}`, `eth_getCode ${comet} 0x${(deployed - 1).toString(16)}` ],
  ], 'read in two round trips: the latest block, then the code at the block and at the one before it');

  batches.length = 0;
  t.same(await readCreationBlocks(transport, [
    market('markets.1/early', deployed - 1),
    market('markets.1/past', head + 1),
    market('markets.1/right', deployed),
    market('markets.1/late', deployed + 1),
    market('markets.1/head', head),
  ], 'ethereum-mainnet'), [
    `markets.1/early.creationBlock ${deployed - 1} is before the Comet ${comet} was deployed: it has no code at that block`,
    `markets.1/past.creationBlock ${head + 1} is past the latest block, ${head}`,
    `markets.1/late.creationBlock ${deployed + 1} is after the Comet ${comet} was deployed: it has code at block ${deployed}`,
    `markets.1/head.creationBlock ${head} is after the Comet ${comet} was deployed: it has code at block ${head - 1}`,
  ], 'every block that is not it is named, in the order it was asked about');
  t.same(batches.map(batch => batch.length), [ 1, 8 ], 'and a block past the latest one is not read at all');

  batches.length = 0;
  t.same(await readCreationBlocks(transport, [], 'ethereum-mainnet'), [], 'no market is nothing to read');
  t.same(batches, [], 'and asks nothing');

  // a provider that does not answer, one that does not serve the state of a past block, and one that answers no block
  const down        = async () => { throw new TypeError('fetch failed'); };
  const archiveless = async (calls: jsonRpc.Call[]) => calls.map(call => call.method === 'eth_blockNumber'
    ? { result: `0x${head.toString(16)}` }
    : { error: { code: -32000, message: 'missing trie node' } });
  const blockless   = async (calls: jsonRpc.Call[]) => calls.map(() => ({ result: '0x' }));
  await rejects(() => readCreationBlocks(down, [ market('overlay', deployed) ], 'ethereum-mainnet'), 'CHAIN_REQUEST_FAILED');
  await rejects(() => readCreationBlocks(archiveless, [ market('overlay', deployed) ], 'ethereum-mainnet'), 'CHAIN_REQUEST_FAILED');
  await rejects(() => readCreationBlocks(blockless, [ market('overlay', deployed) ], 'ethereum-mainnet'), 'CHAIN_RESPONSE_INVALID');
});
