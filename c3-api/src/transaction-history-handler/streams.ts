import * as Eth from '../../lib/eth-constants.js';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import { firstBlockOf, strideOf } from '../../lib/symbolic/index/transaction-history-index.js';

import type { Catalog } from '../registry/catalog.js';

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
  /*
   * The blocks each of the stream's ranges spans (strideOf): the same block
   * ends another range in ranges of another size.
   */
  stride: number;
};

function streamKeyOf({ network, rewardsContractAddress }: Pick<StreamEvent, 'network' | 'rewardsContractAddress'>): string {
  return `${network}|${rewardsContractAddress.toLowerCase()}`;
}

/*
 * The streams a cursor reads, as one value two lists of streams can be
 * compared by: each stream with the block its ranges are counted from, the
 * size of its ranges and every market it reads, in no particular order.
 */
function streamsOf(streams: StreamEvent[]): string {
  return streams
    .map(stream => `${streamKeyOf(stream)}@${stream.firstBlock}/${stream.stride}:${stream.marketContractAddresses.map(address => address.toLowerCase()).sort().join(',')}`)
    .sort()
    .join(';');
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
  const streams = new Map<string, Omit<StreamEvent, 'firstBlock' | 'stride'>>();

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

  // the first block as the reads count it, from the contracts they read, and the size of the ranges they read
  return [ ...streams.values() ].map(stream => ({
    ...stream,
    firstBlock: firstBlockOf(contractsOf(catalog, stream)),
    stride:     strideOf(stream.network),
  }));
}

/*
 * The contracts of a stream, as the pinned version materializes them. Every
 * address in a stream came from this same catalog, so a market that the
 * version does not describe cannot appear here.
 */
function contractsOf(catalog: Catalog, stream: Omit<StreamEvent, 'firstBlock' | 'stride'>): {
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
 * Whether filterRawTransactionHistoryItem can keep an item of a stream. An
 * item is of its stream's network, and each of its actions names the
 * contract that logged it, a market of the stream or its rewards contract: a
 * DeFi Saver proxy or a migrator is named apart, and the filter does not read
 * them. A page reads no stream whose items the filter drops whole.
 */
function filterCanKeepItemsOf(networks: string[], contractAddresses: string[], stream: StreamEvent): boolean {
  const contracts = [ ...stream.marketContractAddresses, stream.rewardsContractAddress ].map(address => address.toLowerCase());
  return (networks.length === 0 || networks.includes(stream.network))
    && (contractAddresses.length === 0 || contractAddresses.some(address => contracts.includes(address.toLowerCase())));
}

/*
 * Whether a cursor's positions still mean what they meant against the
 * streams a version reads: the version reads the same streams, and counts
 * their ranges from the same blocks, in ranges of the same size.
 */
function readsSameStreams(payload: { streamEvents: StreamEvent[] }, streams: StreamEvent[]): boolean {
  return streamsOf(payload.streamEvents) === streamsOf(streams);
}

export type { StreamEvent };

export {
  contractsOf,
  filterCanKeepItemsOf,
  readsSameStreams,
  streamEventsOf,
  streamKeyOf,
};
