import * as Eth      from '../../lib/eth-constants.js';
import * as Flags    from '../../lib/flags.js';
import * as Debug    from '../../lib/debug-log.js';
import * as Fallible from '../../lib/fallible/fallible.js';
import { BigNumber } from '../../lib/bignumber.js';
import { BigFixnum } from '../../lib/bigfixnum.js';

import * as KnownNetwork  from '../../lib/well-known/networks/network.js';

import { ApiError } from '../http/errors.js';
import type { Catalog } from '../registry/catalog.js';
import { refuseTestnet } from '../testnets.js';

import * as governanceModel from '../../lib/model/governance.js';

import {
  TransactionHistoryItem,
  RawTransactionHistoryItem,
} from '../../lib/model/transaction-history/item.js';

import {
  TransactionHistoryAction,
  RawTransactionHistoryAction,
} from '../../lib/model/transaction-history/action.js';

import {
  TransactionHistoryResponse,
  formatTransactionHistoryResponse,
} from '../../lib/model/transaction-history/history.js';

import * as Index         from '../../lib/symbolic/index.js';
import * as Evaluator     from '../../lib/symbolic/evaluator.js';
import { WorkersKvCache } from '../../lib/symbolic/cache.js';

import * as evm       from '../../lib/computations/evm.js';
import * as comet     from '../../lib/computations/comet.js';
import * as account   from '../../lib/computations/account.js';
import * as defisaver from '../../lib/computations/defisaver.js';

import { Env } from '../../entrypoint.js';

import type { TransactionHistoryRouteData } from '../router.js';

import {
  changedFilter,
  contractsOf,
  cursorStore,
  isCursorId,
  keepCursor,
  openCursor,
  resumeCursor,
  streamEventsOf,
  streamKeyOf,
} from './cursor.js';
import type { CursorPayload, StoredCursor } from './cursor.js';

// Default max items setting for transaction history query
const MAX_ITEMS_LIMIT = 15;
// The maximum number of transaction history items to process and enrich
// If this threshold is reaches before having MAX_ITEMS_LIMIT items, it will end the process prior to MAX_ITEMS_LIMIT items to avoid "too many API requests" error

// Estimation of the max item to enrich before reaching 1000 requests limit
// Testing in some accounts to estimate the max number of items to enrich before reaching 1000 requests limit
// TODO: Once quota monitor features is implemented, this can be removed and solely rely on remaining quota
const MAX_ENRICH_TRANSACTION_HISTORY_ITEMS = 50;

// Parallel batch size for parallel enriching process
const PARALLEL_BATCH_SIZE = 10;

interface Context {
  env: Env;
  debug: Debug.Logger;
  flags: Flags.SomeFlags;
}

type Dependencies = (
  | evm.EthGetBlock
  | account.RawTransactionHistoryItems
  | account.EnrichTransactionHistoryItem
  | defisaver.GetAllProxies
);

function Api({ env, debug, flags = {} }: Context) {
  return Evaluator.instantiate<Dependencies>({
    ...evm.applyIndexBias(
      Flags.defaults(flags).ethComputationIndexBias,
      evm,
    ),
    ...comet,
    ...account,
    ...defisaver,
  }, {
    flags,
    debug,
    cache: new WorkersKvCache(env[`kv_mainnet`], [
      BigNumber.JsonReviver,
      BigFixnum.JsonReviver,
    ], debug),
  });
}

function GetAllMigratorsAddresses(): Eth.Address[] {
  const migrators: Eth.Address[] = [];
  migrators.push(Eth.wellKnownContractsByNetwork['ethereum-mainnet']['CompoundMigrator']['V1'].address);
  migrators.push(Eth.wellKnownContractsByNetwork['ethereum-mainnet']['CompoundMigrator']['V2'].address);
  return migrators;
}

// Retrieve a DFSProxyRegistry contract for each network
function getDefiSaverProxyRegistryContract(): { [key: string]: Eth.Contract }{
  const proxyRegistryContract: { [key: string]: Eth.Contract } = {};
  proxyRegistryContract['ethereum-mainnet'] = Eth.wellKnownContractsByNetwork['ethereum-mainnet']['DFSProxyRegistry']['default'];
  return proxyRegistryContract;
}

// Filter to apply before history items get enriched, if filter it before we can save some API calls in enrichment
// Return true if it pass the filter, otherwise false to discard
function filterRawTransactionHistoryItem(
  networks: string[],
  contractAddresses: string[],
  rawHistoryItem: RawTransactionHistoryItem,
) {
  // Filter items by networks
  if (networks.length > 0 && !networks.includes(rawHistoryItem.network)) {
    return false;
  }

  // Filter each actions in items by markets
  if (contractAddresses.length > 0) {
    let rawTransactionHistoryActions: RawTransactionHistoryAction[] = rawHistoryItem.actions;
    rawHistoryItem.actions = rawTransactionHistoryActions.filter((historyAction) => {
      return contractAddresses.filter((contractAddress) => {
        return contractAddress.toLowerCase() === historyAction.contract.address.toLowerCase();
      }).length > 0;
    });
    // Drop the whole item if there is no action left
    if (rawHistoryItem.actions.length === 0) {
      return false;
    }
  }

  return true;
}

// Filter to apply history item
// Return true if the item pass the filter, otherwise false to discard
function filterTransactionHistoryItem(
  accountAddress: Eth.Address,
  actions: string[],
  initiatedBy: string[],
  historyItem: TransactionHistoryItem,
) {
  // Filter items by initiated by
  if (initiatedBy !== undefined && initiatedBy.length > 0) {
    let passedFilter = false;
    if (initiatedBy.includes('me')) {
      passedFilter = passedFilter || historyItem.initiatedBy.address === accountAddress;
    }
    if (initiatedBy.includes('other')) {
      passedFilter = passedFilter || historyItem.initiatedBy.address !== accountAddress;
    }
    if (!passedFilter) {
      return false;
    }
  }

  // Filter each actions in items by actions
  if (actions !== undefined && actions.length > 0) {
    let transactionHistoryActions: TransactionHistoryAction[] = historyItem.actions;
    historyItem.actions = transactionHistoryActions.filter((historyAction) => {
      return actions.includes(historyAction.actionType);
    });
    // Drop the whole item if there is no action left
    if (historyItem.actions.length === 0) {
      return false;
    }
  }
  return true;
}

async function getTransactionHistory(
  { apiHost, nodeHost, nodeKey, accountAddress, queryParams, registry }: TransactionHistoryRouteData,
  context: Context,
): Promise<Response> {
  // ****************** HELPER FUNCTIONS ******************
  const { evaluate, pull1 } = Api(context);
  const store = cursorStore(context.env[`kv_mainnet`], context.debug);

  async function getRawTransactionHistoryItems(
    catalog: Catalog,
    accountAddress: Eth.Address,
    proxyAddresses: Eth.Address[],
    startBlockNumber: Eth.BlockNumber,
    network: KnownNetwork.Name,
    marketContracts: Eth.Contract[],
    rewardsContract: Eth.Contract,
  ) {
    return evaluate(pull1(
      {
        rawTransactionHistoryItems: {
          apiHost,
          nodeHost,
          nodeKey,
          accountAddress,
          proxyAddresses,
          network,
          marketContracts,
          rewardsContract,
          catalog,
          blockNumber: startBlockNumber,
        }
      }));
  }

  async function enrichRawTransactionHistoryItem(
    catalog: Catalog,
    accountAddress: Eth.Address,
    network: KnownNetwork.Name,
    rawItem: RawTransactionHistoryItem,
  ) {
    return evaluate(pull1({
      enrichTransactionHistoryItem: {
        apiHost,
        nodeHost,
        nodeKey,
        network,
        accountAddress,
        item: rawItem,
        catalog,
      }
    }));
  }

  async function loadTransactionHistoryItems(
    catalog: Catalog,
    accountAddress: Eth.Address,
    cursorPayload: CursorPayload,
    itemsLimit: number,
    latestBlockPromises: { [key: string]: Promise<Eth.Block> },
  ): Promise<[TransactionHistoryResponse, Eth.Address[]]> {
    const { filter, streamEvents, cursors } = cursorPayload;
    const { actions, initiatedBy, contractAddresses, networks } = filter;
    // Merge sort across trxHistItemsQueuesByMarket by blockNumber
    const mergedItems = [];
    const rawItemsLoadingBatch: { [key: string]: Promise<RawTransactionHistoryItem[]>[] } = {};
    // Each queue is sorted with block number, but it won't be enrich until the last moment
    const rawItemsQueue: { [key: string]: RawTransactionHistoryItem[] } = {};
    // Immediate item queue which contains enriched items, so we can merge it with different network items via timestamp
    const immediateEnrichedItem: { [key: string]: TransactionHistoryItem } = {};
    // Batch promises run in parallel
    const enrichingBatch: { [key: string]: Promise<TransactionHistoryItem>[] } = {};

    // Block number anchor tracking, to track the last raw items loaded block number according to the index projected block number
    const blockNumberAnchor: { [key: string]: Eth.BlockNumber[] } = {};

    /*
     * The contracts of every stream, resolved once. They are fixed for the
     * whole request, while the merge loop below revisits every stream on every
     * item it emits.
     */
    const streamContracts = new Map(
      streamEvents.map(stream => [ streamKeyOf(stream), contractsOf(catalog, stream) ]),
    );

    // DefiSaver proxy registry contract
    const defiSaverProxyRegistryContract = getDefiSaverProxyRegistryContract();

    // Proxies that associate with account address in each network
    const defiSaverProxies: { [key: string]: Promise<Eth.Address[]> } = {};

    // Initialize queues on first run
    streamEvents.map((stream) => {
      const { network } = stream;
      const streamId = streamKeyOf(stream);
      const { marketContracts: targetMarketContracts, rewardsContract: targetRewardsContract } =
        streamContracts.get(streamId)!;
      const cursor = cursors[streamId];
      if (cursor === undefined) {
        throw new Error('Cursor is undefined, cursor may failed on initialization');
      }
      if (rawItemsLoadingBatch[streamId] === undefined) {
        rawItemsLoadingBatch[streamId] = [];
      }

      // Promise to get latest block
      const latestBlockNumber = latestBlockPromises[network] !== undefined ?
        latestBlockPromises[network].then(block => block.number) :
        Promise.resolve(cursor.blockNumber);

      // Promise to get all proxy addresses
      // Each network find all proxies associate with the account address, and save in defiSaverProxies map
      if (defiSaverProxies[network] === undefined) {
        defiSaverProxies[network] = defiSaverProxyRegistryContract[network] !== undefined ?
          latestBlockNumber.then(blockNumber => (
            evaluate(pull1({
              getAllProxies: {
                apiHost,
                nodeHost,
                nodeKey,
                network,
                contract: defiSaverProxyRegistryContract[network],
                address: accountAddress,
                blockNumber,
              },
            }))
          )) : Promise.resolve([]);
      }

      // Initialize and populate the first loading batch job to include the offset settings from query
      rawItemsLoadingBatch[streamId].push(
        Promise.all([latestBlockNumber, defiSaverProxies[network]]).then(([latestBlockNum, proxies]) => {
          return getRawTransactionHistoryItems(
            catalog,
            accountAddress,
            proxies,
            latestBlockNum,
            network,
            targetMarketContracts,
            targetRewardsContract
          );
        }).then((rawItems) => {
          // Hash offset
          const offset = rawItems.findIndex(item => (
            item.transactionHash === cursor.transactionHash
          ));

          if (offset !== -1) {
            return rawItems.slice(0, offset);
          } else {
            return rawItems;
          }
        })
      );
    });

    let enrichedItemCount = 0;
    let done = false;

    while (mergedItems.length < itemsLimit && enrichedItemCount <= MAX_ENRICH_TRANSACTION_HISTORY_ITEMS) {
      let maxTimestamp = Number.MIN_SAFE_INTEGER;
      let maxTimestampItem: TransactionHistoryItem | undefined = undefined;
      let maxTimestampStream: string | undefined = undefined;
      for (const stream of streamEvents) {
        const { network } = stream;
        const streamId = streamKeyOf(stream);
        const { marketContracts: targetMarketContracts, rewardsContract: targetRewardsContract } =
          streamContracts.get(streamId)!;

        // Initialize blockNumberAnchor to populate the first anchor number
        if (blockNumberAnchor[streamId] === undefined) {
          if (latestBlockPromises[network] === undefined) {
            blockNumberAnchor[streamId] = [cursors[streamId].blockNumber];
          } else {
            // This means the anchor should be initialized from async promise input
            blockNumberAnchor[streamId] = [await latestBlockPromises[network].then(block => block.number)];
            // Also update cursor blocknumber for later uses
            cursors[streamId] = {
              ...cursors[streamId],
              blockNumber: blockNumberAnchor[streamId][0],
            };
          }
        }
        // Immediate item is undefined, need to load more items from raw queue and enrich it
        let reachedEnd = false;
        while (true
          && immediateEnrichedItem[streamId] === undefined
          && !reachedEnd
          && enrichedItemCount <= MAX_ENRICH_TRANSACTION_HISTORY_ITEMS
        ) {
          // Fill/Refill the PARALLEL_BATCH_SIZE raw items queue to load all raw items in parallel
          if (false
            || rawItemsLoadingBatch[streamId] === undefined
            || rawItemsLoadingBatch[streamId].length < PARALLEL_BATCH_SIZE) {
            if (rawItemsLoadingBatch[streamId] === undefined) {
              rawItemsLoadingBatch[streamId] = [];
            }
            while (rawItemsLoadingBatch[streamId].length < PARALLEL_BATCH_SIZE) {
              const blockNumber = blockNumberAnchor[streamId][blockNumberAnchor[streamId].length - 1];
              const newPrecedingBlockResult = Index.TransactionHistoryIndex.preceding(
                {
                  accountAddress,
                  network,
                  marketContracts: targetMarketContracts,
                  rewardsContract: targetRewardsContract,
                  blockNumber
                });
              if (Fallible.isFailure(newPrecedingBlockResult)) {
                break;
              }
              const newPrecedingBlockNumber = Fallible.unwrap(newPrecedingBlockResult).blockNumber;
              blockNumberAnchor[streamId].push(newPrecedingBlockNumber);
              rawItemsLoadingBatch[streamId].push(getRawTransactionHistoryItems(
                catalog,
                accountAddress,
                [ ...await defiSaverProxies[network] ],
                newPrecedingBlockNumber,
                network,
                targetMarketContracts,
                targetRewardsContract
              ));
            }
          }

          // If rawItemsQueue is empty, load more raw items
          if (false
            || rawItemsQueue[streamId] === undefined
            || rawItemsQueue[streamId].length === 0
          ) {
            let moreRawTransactionHistory = [];
            while (moreRawTransactionHistory.length < 1 && rawItemsLoadingBatch[streamId].length > 0) {
              const rawItems = await rawItemsLoadingBatch[streamId].shift()!;
              moreRawTransactionHistory.push(...rawItems);
            }
            if (rawItemsLoadingBatch[streamId].length === 0) {
              reachedEnd = true;
            }
            rawItemsQueue[streamId] = moreRawTransactionHistory;
          }

          // Fill/Refill up to PARALLEL_BATCH_SIZE items into enrichingBatch to process in parallel
          if (false
            || enrichingBatch[streamId] === undefined
            || enrichingBatch[streamId].length < PARALLEL_BATCH_SIZE) {
            if (enrichingBatch[streamId] === undefined) {
              enrichingBatch[streamId] = [];
            }
            // Keep moving items from raw queue until the batch is filled back to BATCH_SIZE or raw queue is empty
            while (enrichingBatch[streamId].length < PARALLEL_BATCH_SIZE && rawItemsQueue[streamId].length > 0) {
              const rawItem = rawItemsQueue[streamId].pop()!;
              if (filterRawTransactionHistoryItem(networks, contractAddresses, rawItem)) {
                enrichingBatch[streamId].push(
                  enrichRawTransactionHistoryItem(catalog, accountAddress, network, rawItem)
                );
              }
            }
          }

          // Pull 1 item from enrichingBatch and filter the enriched item into immediateEnrichedItem
          if (enrichingBatch[streamId] !== undefined && enrichingBatch[streamId].length > 0) {
            const itemPromise = enrichingBatch[streamId].shift();
            if (itemPromise === undefined) {
              throw new Error('Queue shall not be empty here');
            }
            const enrichedItem = await itemPromise;
            enrichedItemCount += 1;
            while (blockNumberAnchor[streamId].length > 1 && enrichedItem.blockNumber < blockNumberAnchor[streamId][1]) {
              // Previous index projected block number is not longer needed
              blockNumberAnchor[streamId].shift();
              // Update cursor preceding block number
              cursors[streamId] = {
                ...cursors[streamId],
                blockNumber: blockNumberAnchor[streamId][0],
              };
            }
            if (filterTransactionHistoryItem(accountAddress, actions, initiatedBy, enrichedItem)) {
              immediateEnrichedItem[streamId] = enrichedItem;
            } else {
              // Update cursor transaction hash, so next time we can start from the next item
              cursors[streamId] = {
                ...cursors[streamId],
                transactionHash: enrichedItem.transactionHash,
              };
            }
          }
        }

        // Compare immediate item with max block number
        if (immediateEnrichedItem[streamId] !== undefined) {
          const item = immediateEnrichedItem[streamId];
          if (item.timestamp > maxTimestamp) {
            maxTimestamp = item.timestamp;
            maxTimestampItem = item;
            maxTimestampStream = streamId;
          }
        }
      }

      if (maxTimestampItem !== undefined && maxTimestampStream !== undefined) {
        // Add max item cadidate to mergedTrxHistItems
        mergedItems.push(maxTimestampItem);

        // Delete immediate item
        delete immediateEnrichedItem[maxTimestampStream];

        // Update cursor
        const currentCursor = cursors[maxTimestampStream];
        if (currentCursor === undefined) {
          throw new Error('Cursor is undefined, cursor may failed on initialization');
        }

        const newCursor = {
          ...currentCursor,
          transactionHash: maxTimestampItem.transactionHash,
        };

        cursors[maxTimestampStream] = newCursor;
      } else {
        // No more items to load, break and return
        done = true;
        // TODO: hans: A little hacky one off update cursor to the last block number
        // But now the cursor block# is tracked along the items getting loaded, which no item will be able to trigger this when it's on contract creation time
        for (const stream of streamEvents) {
          const streamId = streamKeyOf(stream);
          if (blockNumberAnchor[streamId] !== undefined) {
            cursors[streamId] = {
              ...cursors[streamId],
              blockNumber: blockNumberAnchor[streamId][0],
            };
          }
        }
        break;
      }
    }

    // Upsert cursor info before return
    const cursorHash = await keepCursor(store, context.debug, cursorPayload);

    let transactionHistoryResponse: TransactionHistoryResponse = {
      done,
      cursor: cursorHash,
      itemCount: mergedItems.length,
      itemLimit: itemsLimit,
      items: mergedItems,
    };

    const proxyAddresses = (await Promise.all(Object.values(defiSaverProxies))).flat();
    return [transactionHistoryResponse, proxyAddresses];
  }

  function populateDefiSaverProxyProfiles(
    governanceProfiles: { [key: `0x${string}`]: governanceModel.Profile; },
    proxyAddresses: `0x${string}`[]
  ) {
    const profilesWithDefiSaverProxy = Object.assign({}, governanceProfiles);
    for (const proxyAddress of proxyAddresses) {
      const proxyAddressKey = proxyAddress.toLowerCase() as `0x${string}`;
      if (profilesWithDefiSaverProxy[proxyAddressKey] === undefined) {
        profilesWithDefiSaverProxy[proxyAddressKey] = {
          address: proxyAddress,
          image_url: null,
          display_name: `DeFi Saver`,
        };
      }
    }

    // Insert DefiSaver Bot Profile info
    const defiSaverBotAddress = Eth.DefiSaverBotAddresses['ethereum-mainnet'];
    const botAddressKey = defiSaverBotAddress.toLowerCase() as `0x${string}`;
    profilesWithDefiSaverProxy[botAddressKey] = {
      address: defiSaverBotAddress,
      image_url: null,
      display_name: `DeFi Saver`,
    };

    for (const migratorAddress of GetAllMigratorsAddresses()) {
      const migratorAddressKey = migratorAddress.toLowerCase() as `0x${string}`;
      if (profilesWithDefiSaverProxy[migratorAddressKey] === undefined) {
        profilesWithDefiSaverProxy[migratorAddressKey] = {
          address: migratorAddress,
          image_url: null,
          display_name: `Compound V3 Position Migrator`,
        };
      }
    }
    return profilesWithDefiSaverProxy;
    // Insert Compound Migrator Profile info
  }

  // ***************************** END OF HELPER FUNCTIONS *****************************
  // Get all parameters cursor, limit and filters markets, actions, initiated_by
  const cursor = queryParams.get('cursor');
  // Default limit is MAX_ITMES_LIMIT
  const limit = parseInt(queryParams.get('limit') ?? MAX_ITEMS_LIMIT.toString());
  const markets = queryParams.get('markets[]')?.split(',') ?? [];
  const actions = queryParams.get('actions[]')?.split(',') ?? [];
  const initiatedBy = queryParams.get('initiated_by[]')?.split(',') ?? [];

  // Max to be MAX_ITEMS_LIMIT items
  const itemsLimit = Math.min(limit, MAX_ITEMS_LIMIT);

  // Parse and validate markets input
  const parsedMarkets = markets.map((market) => {
    const [networkParam, address] = market.split('_');
    return { networkParam, address };
  });

  /*
   * What the request names is checked before the registry is read, as the
   * market routes check theirs: a market on a network this API does not
   * know, or named by what is no address, is refused whatever the registry
   * holds, and so is a market of a testnet, which the registry never imports.
   */
  const namedMarkets: Array<{ network: KnownNetwork.Name, address: Eth.Address }> = [];
  for (const { networkParam, address } of parsedMarkets) {
    const chainId = parseInt(networkParam);

    if (isNaN(chainId)) {
      // If network is a number, it is a network id
      return new Response(`Invalid network id ${networkParam}`, { status: 400 });
    }

    const network = KnownNetwork.lookup({ chainId });
    if (Fallible.isFailure(network)) {
      return new Response(`Invalid network id ${networkParam}`, { status: 400 });
    }
    const networkAlias = KnownNetwork.canonicalNameOf(network);
    // a market of a testnet is refused as the market routes refuse its network
    refuseTestnet(networkAlias);

    if (!Eth.parseAddress(address)) {
      return new Response(`Invalid address ${address}`, { status: 400 });
    }
    namedMarkets.push({ network: networkAlias, address });
  }
  // a cursor of another form than the history hands out names none (isCursorId), and is refused the same way
  if (cursor !== null && !isCursorId(cursor)) {
    return new Response('Cursor is invalid', { status: 400 });
  }

  // the one registry version this request resolves its markets against
  const catalog = await registry.load();

  /*
   * The streams this version serves. A `markets[]` filter narrows which items
   * are kept, not which streams are read: a market is only addressable when
   * the active version describes it and says its history is served.
   */
  const streamEvents = streamEventsOf(catalog);

  /*
   * A cursor is judged against this version before the request's markets
   * are resolved against it (resumeCursor): a filter naming a market whose
   * history the version no longer serves ends the cursor, as any change of
   * the streams does, rather than being refused as invalid.
   */
  let resumed: CursorPayload | null = null;
  if (cursor !== null) {
    const storedPayload = await store.read<StoredCursor>(cursor);
    if (storedPayload === null) {
      return new Response('Cursor is invalid', { status: 400 });
    }
    const resumption = resumeCursor(storedPayload, catalog, streamEvents);
    if (resumption.kind === 'version-changed') {
      throw new ApiError(
        'REGISTRY_VERSION_CHANGED',
        'the markets of the registry changed; restart pagination without a cursor',
        {
          cursorRegistryVersionId: resumption.cursorRegistryVersionId,
          registryVersionId:       catalog.versionId,
        },
      );
    }
    resumed = resumption.payload;
  }

  const contractAddresses: string[] = [];
  const networks: string[] = [];
  if (namedMarkets.length > 0) {
    for (const { network: networkAlias, address } of namedMarkets) {
      if (!networks.includes(networkAlias)) networks.push(networkAlias);

      /*
       * A market is filterable only if some stream actually reads it. The
       * capability alone is not enough: a market the version describes
       * without the rewards contract its stream is grouped by has no logs
       * fetched for it, and answering 200 with an empty page would be
       * indistinguishable from a market nobody has used.
       */
      const market = catalog.marketAt(networkAlias, address);
      const stream = market === null ? undefined : streamEvents.find(candidate => (
        candidate.network === networkAlias
          && candidate.marketContractAddresses.includes(market.market.contracts.comet)
      ));
      if (market === null || stream === undefined) {
        return new Response(`Invalid market address ${address}`, { status: 400 });
      }
      contractAddresses.push(address);
      // Push rewards contract address to contractAddresses if it is not already there
      // TODO: contract addresses used in api seems are mixing between with upper case and all lower case ones, should be consistent
      // For now, we use filter and compare both in lower case for comparison
      const rewardsAddress = stream.rewardsContractAddress;
      if (contractAddresses.filter((a) => a.toLowerCase() === rewardsAddress.toLowerCase()).length === 0) {
        contractAddresses.push(rewardsAddress);
      }
    }
  } else {
    // Default to every market the version serves history for
    streamEvents.forEach((m) => {
      if (!networks.includes(m.network)) networks.push(m.network);
      m.marketContractAddresses.forEach((contractAddress) => {
        contractAddresses.push(contractAddress);
      });
      contractAddresses.push(m.rewardsContractAddress);
    });
  }

  if (resumed === null) {
    // No cursor provided, use provided filters
    const cursorPayload = openCursor(catalog, streamEvents, {
      markets,
      actions,
      initiatedBy,
      contractAddresses,
      networks,
    });

    // one latest block per network, however many streams it has
    const latestBlocks: {[key: string]: Promise<Eth.Block>} = {};
    for (const stream of streamEvents) {
      latestBlocks[stream.network] ??= evaluate(pull1({ ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network: stream.network } }));
    }

    const [ transactionHistoryResponse, defiSaverProxies ] = await (
      loadTransactionHistoryItems(
        catalog,
        accountAddress,
        cursorPayload,
        itemsLimit,
        latestBlocks
      )
    );
    return new Response(JSON.stringify(
      formatTransactionHistoryResponse(
        transactionHistoryResponse,
        populateDefiSaverProxyProfiles(
          cursorPayload.profilesByAddress,
          defiSaverProxies
        )
      )
    ), { status: 200 });
  } else {
    // a cursor the version reads on goes on only with the filters it was handed out with
    const changed = changedFilter(resumed, { markets, actions, initiatedBy });
    if (changed !== null) {
      return new Response(`Cursor is having different ${changed} filter`, { status: 400 });
    }

    // every stream of a cursor resumes from its own position
    const [ transactionHistoryResponse, defiSaverProxies ] = await (
      loadTransactionHistoryItems(
        catalog,
        accountAddress,
        resumed,
        itemsLimit,
        {}
      )
    );
    // Manually add DefiSaver to profilesByAddress
    return new Response(JSON.stringify(
      formatTransactionHistoryResponse(
        transactionHistoryResponse,
        populateDefiSaverProxyProfiles(
          resumed.profilesByAddress,
          defiSaverProxies
        )
      )
    ), { status: 200 });
  }
}

export type {
  Context,
  Dependencies,
};

export {
  getTransactionHistory,
};
