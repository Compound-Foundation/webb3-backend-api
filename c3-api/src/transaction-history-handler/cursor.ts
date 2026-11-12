import type * as Eth   from '../../lib/eth-constants.js';
import type * as Debug from '../../lib/debug-log.js';
import { sha256      } from '../../lib/hash.js';
import { BigNumber   } from '../../lib/bignumber.js';
import { BigFixnum   } from '../../lib/bigfixnum.js';

import { WorkersKvCache } from '../../lib/symbolic/cache.js';
import { firstBlockOf   } from '../../lib/symbolic/index/transaction-history-index.js';

import type * as KnownNetwork    from '../../lib/well-known/networks/network.js';
import type * as governanceModel from '../../lib/model/governance.js';

import type { Log } from '../log.js';
import type { Catalog } from '../registry/catalog.js';

/*
 * The cursor of transaction history: the streams it reads, the positions it
 * holds in them, how it is named and kept, and whether a version of the
 * registry reads it on. How a page is read from it is
 * transaction-history-items-handler.ts.
 */

/*
 * One log stream: the markets whose events are read together, and the rewards
 * contract whose claim events belong with them. Markets are grouped by their
 * rewards contract, because a stream is read as one range of logs and the
 * rewards contract is part of that range.
 */
type StreamEvent = {
  network: KnownNetwork.Name; // Will change to chain-id later
  marketContractAddresses: Eth.Address[];
  rewardsContractAddress: Eth.Address;
  /*
   * The block the stream's ranges of logs are counted from (firstBlockOf): a
   * block a cursor keeps for the stream ends one of its ranges only as
   * counted from this one.
   */
  firstBlock: Eth.BlockNumber;
};

function streamKeyOf({ network, rewardsContractAddress }: Pick<StreamEvent, 'network' | 'rewardsContractAddress'>): string {
  return `${network}|${rewardsContractAddress.toLowerCase()}`;
}

/*
 * The streams a cursor reads, as one value two lists of streams can be
 * compared by: each stream with the block its ranges are counted from and
 * every market it reads, in no particular order.
 */
function streamsOf(streams: StreamEvent[]): string {
  return streams
    .map(stream => `${streamKeyOf(stream)}@${stream.firstBlock}:${stream.marketContractAddresses.map(address => address.toLowerCase()).sort().join(',')}`)
    .sort()
    .join(';');
}

interface Cursor {
  network: KnownNetwork.Name;
  blockNumber: number;
  marketContractAddresses: Eth.Address[];
  rewardsContractAddress: Eth.Address;
  transactionHash: Eth.TransactionHash;
};

type CursorPayload = {
  /*
   * The registry version this page was read against. A cursor is meaningful
   * for as long as the version that answers reads the same streams from the
   * same first blocks, which are what the version's markets define.
   */
  registryVersionId: string;
  profilesByAddress: { [key: Eth.Address]: governanceModel.Profile };
  filter: {
    markets: string[];
    actions: string[];
    initiatedBy: string[];

    // Parsed from markets input, which will be used to filter out events
    contractAddresses: string[];
    networks: string[];
  };
  streamEvents: StreamEvent[];
  // keyed by stream, not by network: one network can have several streams
  cursors: { [key: string]: Cursor };
};

/*
 * A cursor as KV holds it. KV keeps cursors without an expiry, and a client
 * may keep one across visits, so a cursor issued before the registry, which
 * carries no version, can still be sent, and so can one kept before its
 * streams named their first blocks.
 */
type StoredCursor = Omit<CursorPayload, 'registryVersionId' | 'streamEvents'> & {
  registryVersionId?: string;
  streamEvents: Array<Omit<StreamEvent, 'firstBlock'> & { firstBlock?: Eth.BlockNumber }>;
};

function namesFirstBlocks(payload: StoredCursor): payload is StoredCursor & { streamEvents: StreamEvent[] } {
  return payload.streamEvents.every(stream => typeof stream.firstBlock === 'number');
}

/*
 * What a cursor is named by: the hex SHA-256 of what it holds, the only form
 * the history has handed out (keepCursor). A value of any other form names no
 * cursor and is not looked up, since KV refuses some keys outright, such as
 * '', '.' and '..', and the request would fail with that.
 */
const CURSOR_ID = /^[0-9a-f]{64}$/;

// from the value alone, so a request whose cursor names none is refused before the registry is read
function isCursorId(value: string): boolean {
  return CURSOR_ID.test(value);
}

/*
 * The log streams of one registry version.
 *
 * A market is readable here when the version says its transaction history is
 * served, and markets that share a rewards contract are read as one stream.
 * Before the registry this list was written out by hand, which meant a market
 * missing from it had no reachable history at all — indistinguishable from a
 * market with no activity — while the `markets[]` query parameter could only
 * filter what these streams had already fetched.
 */
function streamEventsOf(catalog: Catalog): StreamEvent[] {
  const streams = new Map<string, Omit<StreamEvent, 'firstBlock'>>();

  for (const entry of catalog.markets()) {
    const comet   = entry.market.contracts.comet;
    const rewards = entry.market.contracts.rewards;
    if (!entry.market.capabilities.transactionHistory || rewards === null) {
      continue;
    }
    const stream = { network: entry.network, marketContractAddresses: [ comet ], rewardsContractAddress: rewards };
    const key    = streamKeyOf(stream);
    const known  = streams.get(key);
    if (known === undefined) {
      streams.set(key, stream);
    } else {
      known.marketContractAddresses.push(comet);
    }
  }

  // the first block as the reads count it, from the contracts they read
  return [ ...streams.values() ].map(stream => ({ ...stream, firstBlock: firstBlockOf(contractsOf(catalog, stream)) }));
}

/*
 * The contracts of a stream, as the pinned version materializes them. Every
 * address in a stream came from this same catalog, so a market that the
 * version does not describe cannot appear here.
 */
function contractsOf(catalog: Catalog, stream: Omit<StreamEvent, 'firstBlock'>): {
  marketContracts: Eth.Contract[],
  rewardsContract: Eth.Contract,
} {
  const markets = stream.marketContractAddresses
    .map(address => catalog.marketAt(stream.network, address))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (markets.length === 0) {
    throw new Error(`stream ${streamKeyOf(stream)} has no market in the active registry`);
  }
  // every market of a stream shares one rewards contract, by construction
  const rewards = markets[0]!.comet.rewards;
  if (rewards === undefined) {
    throw new Error(`invariant violated: stream ${streamKeyOf(stream)} reads a market without its rewards contract`);
  }
  return {
    marketContracts: markets.map(entry => entry.comet),
    rewardsContract: rewards.contract,
  };
}

/*
 * The cursor a first page starts from: every stream the version reads, at no
 * position yet. The page reads each stream from its network's latest block,
 * and the cursor it hands out holds where it stopped. What it holds is
 * written out here in one order, whatever order the filter came in, because
 * its id is the digest of its JSON.
 */
function openCursor(catalog: Catalog, streamEvents: StreamEvent[], filter: CursorPayload['filter']): CursorPayload {
  const cursorPayload: CursorPayload = {
    registryVersionId: catalog.versionId,
    profilesByAddress: {},
    filter: {
      markets: filter.markets,
      actions: filter.actions,
      initiatedBy: filter.initiatedBy,
      contractAddresses: filter.contractAddresses,
      networks: filter.networks,
    },
    streamEvents,
    cursors: {},
  };
  for (const stream of streamEvents) {
    cursorPayload.cursors[streamKeyOf(stream)] = {
      network: stream.network,
      marketContractAddresses: stream.marketContractAddresses,
      rewardsContractAddress: stream.rewardsContractAddress,
      transactionHash: '0x0',
      blockNumber: 0,
    };
  }
  return cursorPayload;
}

/*
 * Whether a cursor's positions still mean what they meant against the
 * streams a version reads: the version reads the same streams, and counts
 * their ranges from the same blocks.
 */
function readsSameStreams(payload: Pick<CursorPayload, 'streamEvents'>, streams: StreamEvent[]): boolean {
  return streamsOf(payload.streamEvents) === streamsOf(streams);
}

type Resumption =
  | { kind: 'resumed',         payload: CursorPayload }
  | { kind: 'version-changed', cursorRegistryVersionId: string | null };

/*
 * A cursor holds a position in each stream it reads: a block and a
 * transaction in the logs of those contracts. The block ends one of the
 * ranges the stream is read in, which are counted from its first block. The
 * positions stay true for as long as the version that answers reads the same
 * streams from the same first blocks, so a rollback, a re-import of the same
 * markets, or a new label on one leaves pagination going; what each page
 * says about its items is the version that answered that page, which the
 * headers name. A version that reads other streams, or counts one from
 * another block, as a corrected creation block can, leaves the positions
 * meaning nothing: resumed, the cursor would answer again what it has
 * answered. The client is told to start over.
 *
 * A cursor issued before the registry names no version, and keeps its
 * positions by network rather than by stream. It is ended as one of another
 * version is, whatever it reads, and the client starts over. So is one kept
 * before its streams named their first blocks, by its own version too, so
 * that every cursor that goes on names them.
 *
 * A cursor is judged before the request's markets are resolved against the
 * version: they were resolved against the version that issued it, and a
 * market whose history this version no longer serves is a change of streams
 * like any other. The client is told to start over, not that a market it was
 * paging through is invalid; the page that starts over says that. Its
 * filters are compared once they are resolved (changedFilter).
 */
function resumeCursor(stored: StoredCursor, catalog: Catalog, streamEvents: StreamEvent[]): Resumption {
  if (typeof stored.registryVersionId !== 'string' || !namesFirstBlocks(stored)
    || (stored.registryVersionId !== catalog.versionId && !readsSameStreams(stored, streamEvents))) {
    return { kind: 'version-changed', cursorRegistryVersionId: stored.registryVersionId ?? null };
  }
  return { kind: 'resumed', payload: { ...stored, registryVersionId: catalog.versionId } };
}

/*
 * A cursor the version reads on goes on only with the filters its first page
 * was asked with: as many values in each, and each of the cursor's among the
 * request's. They are compared in this order, and the first that differs is
 * named; null when none does.
 */
function changedFilter(
  payload: CursorPayload,
  request: Pick<CursorPayload['filter'], 'markets' | 'actions' | 'initiatedBy'>,
): 'markets' | 'actions' | 'initiated by' | null {
  for (const [ filter, kept, asked ] of [
    [ 'markets',      payload.filter.markets,     request.markets ],
    [ 'actions',      payload.filter.actions,     request.actions ],
    [ 'initiated by', payload.filter.initiatedBy, request.initiatedBy ],
  ] as const) {
    if (kept.length !== asked.length || !kept.every(value => asked.includes(value))) {
      return filter;
    }
  }
  return null;
}

/*
 * Cursors are kept in the namespace history is cached in, but they are not
 * a cache: a value KV cannot read or keep is computed again, and a cursor
 * cannot be. So a cursor KV cannot read or keep fails the request, as it
 * always has, rather than being answered as invalid, or handed out without
 * being kept.
 */
function cursorStore(kv: KVNamespace, debug: Debug.Logger): WorkersKvCache {
  return new WorkersKvCache(kv, [
    BigNumber.JsonReviver,
    BigFixnum.JsonReviver,
  ], debug);
}

/*
 * Keeps a page's cursor, and answers the id the page hands out for it.
 *
 * A cursor's id is the digest of what it holds, which names no account: the
 * same page asked twice, or the first pages of two accounts without history
 * at one block, keep one cursor under one id. KV refuses the second write of
 * a key within a second with 429: what it refuses then is the same cursor,
 * written a moment before, and the page is answered with it.
 */
async function keepCursor(store: WorkersKvCache, log: Pick<Log, 'warn'>, payload: CursorPayload): Promise<string> {
  const id = await sha256(JSON.stringify(payload));
  try {
    await store.write(id, payload);
  } catch (error) {
    if (!(error instanceof Error && /^KV PUT failed: 429\b/.test(error.message))) {
      throw error;
    }
    log.warn(`history cursor written twice in a second: ${error.message}: ${id}`);
  }
  return id;
}

export type {
  CursorPayload,
  StoredCursor,
};

export {
  changedFilter,
  contractsOf,
  cursorStore,
  isCursorId,
  keepCursor,
  openCursor,
  resumeCursor,
  streamEventsOf,
  streamKeyOf,
};
