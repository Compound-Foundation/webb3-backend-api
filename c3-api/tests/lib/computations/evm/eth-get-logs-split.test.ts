import t from 'tap';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as evm from '../../../../lib/computations/evm.js';
import { MAX_REFUSALS } from '../../../../lib/computations/evm/eth-get-logs.js';

import '../../../../shim/node-self.js';

/*
 * A node provider refuses an eth_getLogs whose logs do not fit one answer,
 * and the node provider proxy masks the refusal as "upstream error". The
 * node here refuses a range that holds more than `cap` of the account's
 * logs, one log for each entry of `blocks`, so a block named twice holds
 * two. It records every range it is asked for.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const CONTRACT = '0x784efeb622244d2348d4f2522f8860b96fbece89';
const TOPIC    = '0xfa56f7b24f17183d81894d3ac2ee654e3c26388d17a28dbd9549b8114304e1f4';

type Node = { cap: number, blocks: number[], asked: Array<[ number, number ]> };

function logAt(block: number, index: number) {
  return {
    address:          CONTRACT,
    topics:           [ TOPIC ],
    data:             '0x',
    blockNumber:      Eth.Hex.fromNumber(block),
    blockHash:        `0x${block.toString(16).padStart(64, '0')}`,
    transactionHash:  `0x${index.toString(16).padStart(8, '0')}${block.toString(16).padStart(56, '0')}`,
    transactionIndex: '0x0',
    logIndex:         Eth.Hex.fromNumber(index),
    removed:          false,
  };
}

const original = globalThis.fetch;
t.teardown(() => { globalThis.fetch = original; });

function serve(node: Node): void {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.json() as { id: number, method: string, params: any[] } | Array<{ id: number, method: string, params: any[] }>;
    const calls = body instanceof Array ? body : [ body ];
    const responses = calls.map(({ id, method, params }) => {
      if (method !== 'eth_getLogs') {
        throw new Error(`the node is not asked ${method}`);
      }
      const from = parseInt(params[0].fromBlock, 16);
      const to   = parseInt(params[0].toBlock, 16);
      node.asked.push([ from, to ]);
      const logs = node.blocks
        .map((block, index) => ({ block, index }))
        .filter(({ block }) => block >= from && block <= to)
        .map(({ block, index }) => logAt(block, index));
      return logs.length > node.cap
        ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'upstream error' } }
        : { jsonrpc: '2.0', id, result: logs };
    });
    return new Response(JSON.stringify(body instanceof Array ? responses : responses[0]));
  }) as typeof globalThis.fetch;
}

async function logsOf(node: Node, blockRange: [ number, number ]) {
  serve(node);
  const evaluator = Evaluator.instantiate<evm.EthGetLogs>(evm.applyIndexBias('default', evm) as any, {
    cache: new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]),
    debug,
    flags,
  });
  return await evaluator.evaluate(evaluator.pull1({
    ethGetLogs: {
      apiHost:   'api.test',
      nodeHost:  'node.test',
      nodeKey:   'key',
      network:   'base-mainnet',
      addresses: [ CONTRACT ],
      filter:    [ [ TOPIC ] ],
      blockRange,
    },
  })) as Array<{ blockNumber: string, logIndex: string }>;
}

const blocksOf = (logs: Array<{ blockNumber: string }>) => logs.map(log => parseInt(log.blockNumber, 16));

t.test('a range whose logs fit one answer is read once', async t => {
  const node: Node = { cap: 10_000, blocks: [ 3, 500, 9_999 ], asked: [] };
  t.same(blocksOf(await logsOf(node, [ 0, 10_000_000 ])), [ 3, 500, 9_999 ]);
  t.same(node.asked, [ [ 0, 10_000_000 ] ], 'in one call');
});

t.test('a range with more logs than one answer holds is read in halves, every log once, in block order', async t => {
  // a hundred logs over ten million blocks, eight to an answer at most
  const blocks = Array.from({ length: 100 }, (_, index) => index * 99_991 + 7);
  const node: Node = { cap: 8, blocks, asked: [] };
  const logs = await logsOf(node, [ 0, 9_999_999 ]);

  t.same(blocksOf(logs), blocks, 'every log, in block order');
  const answered = node.asked.filter(([ from, to ]) => blocks.filter(block => block >= from && block <= to).length <= 8);
  const refused  = node.asked.length - answered.length;
  t.ok(refused > 0 && refused <= MAX_REFUSALS, `${refused} ranges refused and split, at most ${MAX_REFUSALS}`);
  t.equal(answered.length, refused + 1, 'and each split answered by its two halves');
  const covered = answered.map(([ from, to ]) => to - from + 1).reduce((sum, size) => sum + size, 0);
  t.equal(covered, 10_000_000, 'which cover the range once, with no block read twice');
});

t.test('a node that refuses every range fails it after at most 1 + 2 × MAX_REFUSALS calls', async t => {
  const node: Node = { cap: -1, blocks: [], asked: [] };
  await t.rejects(logsOf(node, [ 0, 9_999_999 ]), /call error/, 'the range fails as the node did not serve it');
  t.ok(node.asked.length > 1 && node.asked.length <= 1 + 2 * MAX_REFUSALS,
    `${node.asked.length} calls, at most ${1 + 2 * MAX_REFUSALS}`);
});

t.test('a single block with more logs than one answer holds fails', async t => {
  const node: Node = { cap: 8, blocks: Array.from({ length: 20 }, () => 7), asked: [] };
  await t.rejects(logsOf(node, [ 7, 7 ]), /from 7 to 7/, 'a block cannot be split');
  t.same(node.asked, [ [ 7, 7 ] ], 'after one call');
});
