import t, { type Test } from 'tap';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Compute    from '../../../../lib/symbolic/computation.js';
import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';
import { versionedName } from '../../../../lib/symbolic/computation.js';

import * as KnownNetwork from '../../../../lib/well-known/networks/network.js';

import * as market from '../../../../lib/computations/market.js';

import '../../../../shim/node-self.js';

/*
 * A historical day is the market at the first block of its UTC day, which
 * dayOpeningBlock finds from the blocks' own timestamps. These chains are
 * made up, and read through a stand-in for eth_getBlockByNumber that counts
 * its reads: no node is asked.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const DAY = 60 * 60 * 24;

type Chain = { head: number, timestampOf: (number: number) => number };

/*
 * A chain like Base: blocks 2 s apart, and from `switchedAt` on, 0.2 s apart,
 * five blocks to a second. The network's average block time says 2 s.
 */
function switching(headTime: number, switchedDaysAgo: number): Chain {
  const genesis    = headTime - 400 * DAY;
  const switchTime = headTime - switchedDaysAgo * DAY;
  const switchedAt = (switchTime - genesis) / 2;
  return {
    head: switchedAt + 5 * (headTime - switchTime),
    timestampOf: number => number < switchedAt
      ? genesis + 2 * number
      : switchTime + Math.floor((number - switchedAt) / 5),
  };
}

/*
 * A chain whose blocks come at no steady pace: up to 12 s apart, with runs of
 * blocks that share a second, from a fixed pseudo-random sequence.
 */
function irregular(headTime: number, blocks: number): Chain {
  const gaps = [ 0, 0, 1, 1, 1, 2, 2, 3, 5, 8, 12 ];
  const offsets = new Float64Array(blocks + 1);
  let seed = 0x2545f491;
  for (let number = 1; number <= blocks; number++) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    offsets[number] = offsets[number - 1] + gaps[seed % gaps.length];
  }
  const genesis = headTime - offsets[blocks];
  return { head: blocks, timestampOf: number => genesis + offsets[number] };
}

// the first block at or after `target`, by halving over the whole chain
function truth(chain: Chain, target: number): number {
  let lo = 0, hi = chain.head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (chain.timestampOf(mid) >= target) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function latestOf(chain: Chain) {
  return { number: chain.head, timestamp: chain.timestampOf(chain.head) };
}

const reviver = [ BigFixnum.JsonReviver, BigNumber.JsonReviver ];

/*
 * The real dayOpeningBlock and day summaries, over stand-ins for
 * eth_getBlockByNumber and for the summary of a market at a block.
 */
function evaluatorOf(chain: Chain, cache = new MemoryCache({}, reviver)) {
  let reads = 0;
  const ethGetBlock = Compute.Functor<any>({}).implement({
    version: 0,
    compute: ({ blockReference }: { blockReference: Eth.BlockReference }) => {
      reads++;
      const number = blockReference === 'latest' ? chain.head : blockReference;
      if (number < 0 || number > chain.head) {
        throw new Error(`there is no block ${number}`);
      }
      const timestamp = chain.timestampOf(number);
      return { number, timestamp, date: Eth.Timestamp.toDateString(timestamp), transactions: [] };
    },
  });
  const marketSummary = Compute.Functor<any>({}).implement({
    version: 0,
    compute: ({ block }: { block: Eth.Block }) => ({ status: 'success', block: block.number }),
  });
  const evaluator = Evaluator.instantiate<any>({
    ethGetBlock,
    marketSummary,
    dayOpeningBlock:              market.dayOpeningBlock,
    marketDaySummary:             market.marketDaySummary,
    historicalMarketDaySummaries: market.historicalMarketDaySummaries,
  } as any, { cache, debug, flags });
  return { evaluator, cache, reads: () => reads };
}

async function openingOf(
  { evaluator }: ReturnType<typeof evaluatorOf>,
  network: KnownNetwork.Name,
  chain: Chain,
  date: string,
) {
  return await evaluator.evaluate(evaluator.pull1({
    dayOpeningBlock: { apiHost: '', nodeHost: '', nodeKey: '', network, date, latestBlock: latestOf(chain) },
  })) as { number: number, timestamp: number, date: string };
}

const HEAD_TIME = 1_795_046_400 + 12_345; // 2026-11-19T03:25:45Z

function pastDates(days: number): string[] {
  return Array.from({ length: days }, (_, index) => Eth.Timestamp.toDateString(HEAD_TIME - (index + 1) * DAY));
}

async function checkEveryDay(t: Test, network: KnownNetwork.Name, chain: Chain, maxReadsPerDay: number) {
  const evaluation = evaluatorOf(chain);
  for (const date of pastDates(29)) {
    const start = Date.parse(`${date}T00:00:00Z`) / 1000;
    const expected = truth(chain, start);
    const found = await openingOf(evaluation, network, chain, date);
    t.strictSame(found, {
      number: expected,
      timestamp: chain.timestampOf(expected),
      date,
    }, `${date}: the first block at or after 00:00:00 UTC`);
  }
  const perDay = evaluation.reads() / 29;
  t.ok(perDay <= maxReadsPerDay, `${perDay.toFixed(1)} reads a day, at most ${maxReadsPerDay}`);
}

t.test('a chain whose blocks came ten times faster two weeks ago: every day at its first block', async t => {
  await checkEveryDay(t, 'base-mainnet', switching(HEAD_TIME, 14), 30);
});

t.test('a chain with no steady pace, and blocks sharing a second: every day at its first block', async t => {
  await checkEveryDay(t, 'linea-mainnet', irregular(HEAD_TIME, 1_200_000), 30);
});

t.test('a day that has ended is kept; the day still running is searched again', async t => {
  const chain = switching(HEAD_TIME, 14);
  const evaluation = evaluatorOf(chain);
  const [ yesterday ] = pastDates(1);
  const today = Eth.Timestamp.toDateString(HEAD_TIME);

  const first = await openingOf(evaluation, 'base-mainnet', chain, yesterday);
  const readsOnce = evaluation.reads();
  t.ok(readsOnce > 0, 'the first request searches');
  t.strictSame(await openingOf(evaluatorOf(chain, evaluation.cache), 'base-mainnet', chain, yesterday), first,
    'a later request answers the same block');
  t.ok(
    Object.keys(evaluation.cache.store).includes(
      `${versionedName('dayOpeningBlock', market.dayOpeningBlock.version)}:(date:${yesterday};network:base-mainnet)`,
    ),
    'kept under the network and the date alone',
  );

  const again = evaluatorOf(chain, evaluation.cache);
  t.strictSame(await openingOf(again, 'base-mainnet', chain, today), {
    number: truth(chain, Math.floor(HEAD_TIME / DAY) * DAY),
    timestamp: chain.timestampOf(truth(chain, Math.floor(HEAD_TIME / DAY) * DAY)),
    date: today,
  }, 'the running day has a first block too');
  const readsToday = again.reads();
  await openingOf(again, 'base-mainnet', chain, today);
  t.equal(again.reads(), 2 * readsToday, 'which is not kept');
});

t.test('a date the chain has not reached, or not a date, is refused', async t => {
  const chain = switching(HEAD_TIME, 14);
  const tomorrow = Eth.Timestamp.toDateString(HEAD_TIME + DAY);
  await t.rejects(openingOf(evaluatorOf(chain), 'base-mainnet', chain, tomorrow));
  await t.rejects(openingOf(evaluatorOf(chain), 'base-mainnet', chain, '2026-02-30'));
});

/*
 * The history of a market at the first block of each past UTC day, and today
 * at the latest block, each with its block's own timestamp.
 */
t.test('a history: each past day at its first block, today at the latest, days before the market left out', async t => {
  const chain = switching(HEAD_TIME, 14);
  const createdAt = truth(chain, HEAD_TIME - 10 * DAY);
  const contract = { address: '0x784efeb622244d2348d4f2522f8860b96fbece89', creation: { block: { number: createdAt } }, key: () => 'aero-base' };
  const evaluation = evaluatorOf(chain);
  const latest = latestOf(chain);

  const days = await evaluation.evaluator.evaluate(evaluation.evaluator.pull1({
    historicalMarketDaySummaries: {
      apiHost: '', nodeHost: '', nodeKey: '', network: 'base-mainnet', contract, daysBack: 30, startBlock: latest,
    },
  })) as Array<{ block: number, timestamp: number, date: string }>;

  const expectedDates = pastDates(29).reverse()
    .filter(date => truth(chain, Date.parse(`${date}T00:00:00Z`) / 1000) >= createdAt)
    .concat(Eth.Timestamp.toDateString(HEAD_TIME));
  t.strictSame(days.map(day => day.date), expectedDates, 'the days the market lived through, oldest first, and today');
  t.equal(days.length, 10, 'nine whole days since its creation, and today');
  for (const day of days.slice(0, -1)) {
    const opening = truth(chain, Date.parse(`${day.date}T00:00:00Z`) / 1000);
    t.strictSame(day, { status: 'success', block: opening, timestamp: chain.timestampOf(opening), date: day.date },
      `${day.date}: at its first block, with that block's timestamp`);
  }
  t.strictSame(days[days.length - 1], { status: 'success', block: latest.number, timestamp: latest.timestamp, date: expectedDates[9] },
    'today: at the latest block');

  const kept = Object.keys(evaluation.cache.store);
  t.ok(kept.includes(`${versionedName('marketDaySummary', market.marketDaySummary.version)}:(contract:aero-base;date:${expectedDates[0]};network:base-mainnet)`),
    'a past day is kept by its date');
  t.notOk(kept.some(key => key.startsWith(versionedName('marketDaySummary', market.marketDaySummary.version)) && key.includes(`date:${expectedDates[9]}`)),
    'today is not kept as a day');
});
