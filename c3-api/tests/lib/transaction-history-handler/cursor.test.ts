import t from 'tap';

import * as Debug from '../../../lib/debug-log.js';
import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import {
  changedFilter,
  cursorStore,
  isCursorId,
  keepCursor,
  openCursor,
  resumeCursor,
  streamEventsOf,
  streamKeyOf,
} from '../../../src/transaction-history-handler/cursor.js';
import type { CursorPayload, StoredCursor } from '../../../src/transaction-history-handler/cursor.js';

import { MemoryKv, refusingKv } from '../../util/kv.js';
import { quietLog } from '../../util/quiet-log.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * What a transaction history cursor is, apart from the pages read with it:
 * what a first page starts from, whether a version reads a cursor on, and how
 * one is kept. What the route answers for each is consumer-routes.test.ts.
 */
const fixture: RegistrySnapshotV1 = loadRegistrySnapshotFixture();

// the fixture with its Base market's history served too: a stream on mainnet, and one on Base
const catalog = catalogOf({
  ...fixture,
  networks: fixture.networks.map(network => network.chainId !== 8453 ? network : {
    ...network,
    markets: network.markets.map(market => ({
      ...market,
      capabilities: { ...market.capabilities, transactionHistory: true },
    })),
  }),
});
const streams = streamEventsOf(catalog);

const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WETH    = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
const ANOTHER = '00000000-0000-4000-8000-0000000000aa';

// what a first page was asked for: the account's own borrows and supplies of the USDC market
const ASKED = { markets: [ `1_${USDC}` ], actions: [ 'Borrow', 'Supply' ], initiatedBy: [ 'me' ] };

// a cursor that page handed out, as KV holds it: some way into every stream
function stored(overrides: Partial<StoredCursor> = {}): StoredCursor {
  return {
    registryVersionId: catalog.versionId,
    profilesByAddress: {},
    filter:            { ...ASKED, contractAddresses: [ USDC ], networks: [ 'ethereum-mainnet' ] },
    streamEvents:      streams,
    cursors:           Object.fromEntries(streams.map(stream => [
      streamKeyOf(stream),
      { ...stream, blockNumber: 19_000_000, transactionHash: '0xabc' as const },
    ])),
    ...overrides,
  };
}

/*
 * A first page reads every stream the version reads, from its network's
 * latest block. The cursor it hands out is named by the digest of its JSON,
 * so the same page keeps the id it had only while what the cursor holds is
 * written out the same way.
 */
t.test('a first page starts every stream the version reads, at no position yet', async t => {
  t.same([ ...new Set(streams.map(stream => stream.network)) ].sort(), [ 'base-mainnet', 'ethereum-mainnet' ],
    'the version reads history on two networks');
  t.same(Object.fromEntries(streams.map(stream => [ stream.network, stream.firstBlock ])), {
    'ethereum-mainnet': 15_331_586,
    'base-mainnet':     20_852_405,
  }, 'each counting its ranges from the earliest creation among its contracts');

  // a filter given in another order than the cursor holds it in
  const filter = { networks: [ 'ethereum-mainnet' ], contractAddresses: [ USDC ], ...ASKED };
  t.equal(JSON.stringify(openCursor(catalog, streams, filter)), JSON.stringify({
    registryVersionId: catalog.versionId,
    profilesByAddress: {},
    filter: {
      markets:           ASKED.markets,
      actions:           ASKED.actions,
      initiatedBy:       ASKED.initiatedBy,
      contractAddresses: [ USDC ],
      networks:          [ 'ethereum-mainnet' ],
    },
    streamEvents:      streams,
    cursors:           Object.fromEntries(streams.map(stream => [ streamKeyOf(stream), {
      network:                 stream.network,
      marketContractAddresses: stream.marketContractAddresses,
      rewardsContractAddress:  stream.rewardsContractAddress,
      transactionHash:         '0x0',
      blockNumber:             0,
    } ])),
  }), 'read against the version that answers, with a position in each stream that holds none yet');
});

/*
 * A cursor's positions are in the logs of the streams it reads, in ranges
 * counted from each stream's first block. A version that reads the same
 * streams from the same blocks reads it on, whichever version handed it out;
 * one that reads other streams, or counts one from another block, ends it,
 * and the client starts over.
 */
t.test('a version reads on a cursor of the streams it reads, and ends any other', async t => {
  t.same(resumeCursor(stored(), catalog, streams), { kind: 'resumed', payload: stored() },
    'a cursor of the version that answers goes on as it was');

  const same = stored({
    registryVersionId: ANOTHER,
    // the same streams, listed in another order, as another version may list them
    streamEvents: streams.map(stream => ({
      ...stream,
      marketContractAddresses: [ ...stream.marketContractAddresses ].reverse(),
    })).reverse(),
  });
  t.same(resumeCursor(same, catalog, streams), { kind: 'resumed', payload: { ...same, registryVersionId: catalog.versionId } },
    'one of another version that read the same streams goes on, as a cursor of the version that answers');

  for (const [ streamEvents, what ] of [
    [ streams.filter(stream => stream.network === 'ethereum-mainnet'), 'a stream fewer' ],
    [ streams.map(stream => ({ ...stream, marketContractAddresses: stream.marketContractAddresses.slice(1) })), 'a market fewer in each' ],
    // a corrected creation block moves a stream's first block, and with it every range it is read in
    [ streams.map(stream => ({ ...stream, firstBlock: stream.firstBlock - 1 })), 'its streams from other blocks' ],
  ] as const) {
    t.same(resumeCursor(stored({ registryVersionId: ANOTHER, streamEvents }), catalog, streams),
      { kind: 'version-changed', cursorRegistryVersionId: ANOTHER }, `one of a version that read ${what} is ended, naming that version`);
  }

  const { registryVersionId: _, ...issuedBefore } = stored();
  t.same(resumeCursor(issuedBefore, catalog, streams), { kind: 'version-changed', cursorRegistryVersionId: null },
    'and so is one issued before the registry, which names none, though it reads the same streams');

  // a cursor kept before its streams named their first blocks
  const unnamed = stored({ streamEvents: streams.map(({ firstBlock: _firstBlock, ...stream }) => stream) });
  t.same(resumeCursor(unnamed, catalog, streams), { kind: 'version-changed', cursorRegistryVersionId: catalog.versionId },
    'as is one kept before its streams named the blocks they are counted from, by the version that answers too');
});

// what a cursor holds once the version reads it on
function resumed(cursor: StoredCursor): CursorPayload {
  const resumption = resumeCursor(cursor, catalog, streams);
  if (resumption.kind !== 'resumed') {
    throw new Error(`the version does not read on a cursor of ${resumption.cursorRegistryVersionId}`);
  }
  return resumption.payload;
}

/*
 * A cursor holds what its first page was filtered by, and goes on only with
 * the same filters: a page of other markets, actions or initiators from where
 * it stopped would leave out what the pages before it did not show.
 */
t.test('a cursor goes on only with the filters it was handed out with', async t => {
  const sent = (filters: Partial<typeof ASKED>) => changedFilter(resumed(stored()), { ...ASKED, ...filters });
  t.equal(sent({ actions: [ 'Supply', 'Borrow' ] }), null, 'named in any order');

  const changed: [ Partial<typeof ASKED>, string, string ][] = [
    [ { markets: [] },                                'markets',      'without its market' ],
    [ { markets: [ `1_${WETH}` ] },                   'markets',      'with another market' ],
    [ { markets: [ `1_${USDC}`, `1_${WETH}` ] },      'markets',      'with a market more' ],
    [ { actions: [ 'Borrow' ] },                      'actions',      'with an action fewer' ],
    [ { actions: [ 'Borrow', 'Withdraw' ] },          'actions',      'with another action' ],
    [ { initiatedBy: [] },                            'initiated by', 'without its initiator' ],
    [ { initiatedBy: [ 'other' ] },                   'initiated by', 'with another initiator' ],
    // several changed: the first of markets, actions and initiators is named
    [ { markets: [], actions: [], initiatedBy: [] }, 'markets',      'with none of them' ],
    [ { actions: [], initiatedBy: [] },               'actions',      'without its actions and initiator' ],
  ];
  for (const [ filters, filter, what ] of changed) {
    t.equal(sent(filters), filter, `a cursor sent ${what} is refused for its ${filter} filter`);
  }

  // the version decides first, before a request's markets are resolved against it, let alone compared
  const ended = stored({ registryVersionId: ANOTHER, streamEvents: streams.slice(1) });
  t.same(resumeCursor(ended, catalog, streams), { kind: 'version-changed', cursorRegistryVersionId: ANOTHER },
    'while one the version ends is ended, whatever filters it is sent with');
});

// the cursor a first page of every market keeps
const opened = openCursor(catalog, streams, { markets: [], actions: [], initiatedBy: [], contractAddresses: [], networks: [] });

t.test('a cursor is kept under the digest of what it holds, the id its page hands out', async t => {
  const store = cursorStore(MemoryKv({}), Debug.MakeLogger([]));
  const id    = await keepCursor(store, quietLog, opened);

  t.ok(isCursorId(id), 'which a request may name a cursor by');
  t.same(await store.read(id), opened, 'and under which KV holds it');
  t.notOk(isCursorId(id.toUpperCase()), 'while a value of another form names none');

  const other = openCursor(catalog, streams.slice(1), { markets: [], actions: [], initiatedBy: [], contractAddresses: [], networks: [] });
  t.not(await keepCursor(store, quietLog, other), id, 'another cursor is kept under another id');
});

/*
 * A cursor's id names no account, so the same page asked twice within a
 * second keeps one cursor twice, and KV refuses the second write of a key
 * within a second with 429. What it refused then is a cursor it holds. Any
 * other refusal is a cursor not kept, which no page may hand out.
 */
t.test('a cursor KV refuses to write again within a second is kept, and no other', async t => {
  const warned: string[] = [];
  const log = { warn: (...line: unknown[]) => { warned.push(line.join(' ')); } };

  const again = cursorStore(refusingKv(MemoryKv({}), method => method === 'put'), Debug.MakeLogger([]));
  const id    = await keepCursor(again, log, opened);
  t.equal(id, await keepCursor(cursorStore(MemoryKv({}), Debug.MakeLogger([])), quietLog, opened),
    'the page hands out the id it would have kept the cursor under');
  t.same(warned, [ `history cursor written twice in a second: KV PUT failed: 429 Too Many Requests: ${id}` ],
    'and the log says KV refused to write it again');

  // KV not answering refuses a write with 503
  const down = cursorStore(refusingKv(MemoryKv({}), method => method === 'put' && 'KV PUT failed: 503 Service Unavailable'), Debug.MakeLogger([]));
  await t.rejects(keepCursor(down, log, opened), { message: 'KV PUT failed: 503 Service Unavailable' },
    'a cursor KV did not keep fails the page');
  t.equal(warned.length, 1, 'and is not taken for one written twice');
});
