import * as Eth      from '../../lib/eth-constants.js';
import * as Flags    from '../../lib/flags.js';
import * as Debug    from '../../lib/debug-log.js';
import * as Fallible from '../../lib/fallible/fallible.js';
import { sha256    } from '../../lib/hash.js';
import { BigNumber } from '../../lib/bignumber.js';
import { BigFixnum } from '../../lib/bigfixnum.js';

import { Comet }          from '../../lib/well-known/contracts/types.js';
import * as KnownNetwork  from '../../lib/well-known/networks/network.js';
import * as ContractUtils from '../../lib/well-known/contracts/utils.js';

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

interface Cursor {
  network: KnownNetwork.Name;
  blockNumber: number;
  marketContractAddresses: Eth.Address[];
  rewardsContractAddress: Eth.Address;
  transactionHash: Eth.TransactionHash;
};

type CursorPayload = {
  profilesByAddress: { [key: Eth.Address]: governanceModel.Profile };
  filter: {
    markets: string[];
    actions: string[];
    initiatedBy: string[];

    // Parsed from markets input, which will be used to filter out events
    contractAddresses: string[];
    networks: string[];
  };
  streamEvents: Array<{
    network: KnownNetwork.Name; // Will change to chain-id later
    marketContractAddresses: Eth.Address[];
    rewardsContractAddress: Eth.Address;
  }>;
  cursors: { [key: string]: Cursor };
};

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
    ]),
  });
}

function GetAllTestStreamEvents(): { network: KnownNetwork.Name, marketContractAddresses: Eth.Address[], rewardsContractAddress: Eth.Address }[] {
  const streamEvents: { network: KnownNetwork.Name, marketContractAddresses: Eth.Address[], rewardsContractAddress: Eth.Address }[] = [];
  // Get all Comet contracts in testnet
  // Maybe there will be a way to get all markets across all network, but now manually add all markets here
  streamEvents.push({
    network: 'ethereum-sepolia',
    marketContractAddresses: [
      Eth.wellKnownContractsByNetwork['ethereum-sepolia']['Comet']['cUSDCv3'].address,
      Eth.wellKnownContractsByNetwork['ethereum-sepolia']['Comet']['cWETHv3'].address,
    ],
    rewardsContractAddress: Eth.wellKnownContractsByNetwork['ethereum-sepolia']['Comet']['cUSDCv3'].rewards.contract.address,
  });

  return streamEvents;
}

function GetAllStreamEvents(): { network: KnownNetwork.Name, marketContractAddresses: Eth.Address[], rewardsContractAddress: Eth.Address }[] {
  const streamEvents: { network: KnownNetwork.Name, marketContractAddresses: Eth.Address[], rewardsContractAddress: Eth.Address }[] = [];
  // Get all Comet contracts in both 'cUSDCv3' and 'weth' markets
  // Maybe there will be a way to get all markets across all network, but now manually add all markets here
  streamEvents.push({
    network: 'ethereum-mainnet',
    marketContractAddresses: [
      Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Comet']['cUSDCv3'].address,
      Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Comet']['cWETHv3'].address,
      Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Comet']['cUSDTv3'].address,
    ],
    rewardsContractAddress: Eth.wellKnownContractsByNetwork['ethereum-mainnet']['Comet']['cUSDCv3'].rewards.contract.address,
  });

  streamEvents.push({
    network: 'polygon-mainnet',
    marketContractAddresses: [
      Eth.wellKnownContractsByNetwork['polygon-mainnet']['Comet']['cUSDCv3'].address,
    ],
    rewardsContractAddress: Eth.wellKnownContractsByNetwork['polygon-mainnet']['Comet']['cUSDCv3'].rewards.contract.address,
  });

  streamEvents.push({
    network: 'arbitrum-mainnet',
    marketContractAddresses: [
      Eth.wellKnownContractsByNetwork['arbitrum-mainnet']['Comet']['cUSDCv3'].address,
      Eth.wellKnownContractsByNetwork['arbitrum-mainnet']['Comet']['cUSDC.ev3'].address,
    ],
    rewardsContractAddress: Eth.wellKnownContractsByNetwork['arbitrum-mainnet']['Comet']['cUSDCv3'].rewards.contract.address,
  });

  streamEvents.push({
    network: 'base-mainnet',
    marketContractAddresses: [
      Eth.wellKnownContractsByNetwork['base-mainnet']['Comet']['cUSDCv3'].address,
      Eth.wellKnownContractsByNetwork['base-mainnet']['Comet']['cUSDbCv3'].address,
      Eth.wellKnownContractsByNetwork['base-mainnet']['Comet']['cWETHv3'].address,
    ],
    rewardsContractAddress: Eth.wellKnownContractsByNetwork['base-mainnet']['Comet']['cUSDCv3'].rewards.contract.address,
  });

  streamEvents.push({
    network: 'optimism-mainnet',
    marketContractAddresses: [
      Eth.wellKnownContractsByNetwork['optimism-mainnet']['Comet']['cUSDCv3'].address,
      Eth.wellKnownContractsByNetwork['optimism-mainnet']['Comet']['cUSDTv3'].address,
      Eth.wellKnownContractsByNetwork['optimism-mainnet']['Comet']['cWETHv3'].address,
    ],
    rewardsContractAddress: Eth.wellKnownContractsByNetwork['optimism-mainnet']['Comet']['cUSDCv3'].rewards.contract.address,
  });
  
  return streamEvents;
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
  { apiHost, nodeHost, nodeKey, accountAddress, queryParams }: TransactionHistoryRouteData,
  context: Context,
): Promise<Response> {
  // ****************** HELPER FUNCTIONS ******************
  const { evaluate, pull1, cache } = Api(context);

  async function getRawTransactionHistoryItems(
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
          blockNumber: startBlockNumber,
        }
      }));
  }

  async function enrichRawTransactionHistoryItem(
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
      }
    }));
  }

  async function loadTransactionHistoryItems(
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

    // DefiSaver proxy registry contract
    const defiSaverProxyRegistryContract = getDefiSaverProxyRegistryContract();

    // Proxies that associate with account address in each network
    const defiSaverProxies: { [key: string]: Promise<Eth.Address[]> } = {};

    // Initialize queues on first run
    streamEvents.map(({ network, marketContractAddresses, rewardsContractAddress }) => {
      const targetMarketContracts = marketContractAddresses.map(address => (
        Fallible.must(ContractUtils.lookupInWellKnown(
          { network, address },
          Eth.wellKnownContractsByNetwork
        ))));
      const targetRewardsContract: Eth.Contract = Fallible.must(ContractUtils.lookupInWellKnown(
        { network, address: rewardsContractAddress },
        Eth.wellKnownContractsByNetwork
      ));
      const cursor = cursors[network];
      if (cursor === undefined) {
        throw new Error('Cursor is undefined, cursor may failed on initialization');
      }
      if (rawItemsLoadingBatch[network] === undefined) {
        rawItemsLoadingBatch[network] = [];
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
      rawItemsLoadingBatch[network].push(
        Promise.all([latestBlockNumber, defiSaverProxies[network]]).then(([latestBlockNum, proxies]) => {
          return getRawTransactionHistoryItems(
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
      let maxTimestampNetwork: KnownNetwork.Name | undefined = undefined;
      for (const m of streamEvents) {
        const { network, marketContractAddresses, rewardsContractAddress } = m;
        const targetMarketContracts = marketContractAddresses.map(address => (
          Fallible.must(ContractUtils.lookupInWellKnown(
            { network, address },
            Eth.wellKnownContractsByNetwork
          ))));
        const targetRewardsContract = Fallible.must(ContractUtils.lookupInWellKnown(
          { network, address: rewardsContractAddress },
          Eth.wellKnownContractsByNetwork
        ));

        // Initialize blockNumberAnchor to populate the first anchor number
        if (blockNumberAnchor[network] === undefined) {
          if (latestBlockPromises[network] === undefined) {
            blockNumberAnchor[network] = [cursors[network].blockNumber];
          } else {
            // This means the anchor should be initialized from async promise input
            blockNumberAnchor[network] = [await latestBlockPromises[network].then(block => block.number)];
            // Also update cursor blocknumber for later uses
            cursors[network] = {
              ...cursors[network],
              blockNumber: blockNumberAnchor[network][0],
            };
          }
        }
        // Immediate item is undefined, need to load more items from raw queue and enrich it
        let reachedEnd = false;
        while (true
          && immediateEnrichedItem[network] === undefined
          && !reachedEnd
          && enrichedItemCount <= MAX_ENRICH_TRANSACTION_HISTORY_ITEMS
        ) {
          // Fill/Refill the PARALLEL_BATCH_SIZE raw items queue to load all raw items in parallel
          if (false
            || rawItemsLoadingBatch[network] === undefined
            || rawItemsLoadingBatch[network].length < PARALLEL_BATCH_SIZE) {
            if (rawItemsLoadingBatch[network] === undefined) {
              rawItemsLoadingBatch[network] = [];
            }
            while (rawItemsLoadingBatch[network].length < PARALLEL_BATCH_SIZE) {
              const blockNumber = blockNumberAnchor[network][blockNumberAnchor[network].length - 1];
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
              blockNumberAnchor[network].push(newPrecedingBlockNumber);
              rawItemsLoadingBatch[network].push(getRawTransactionHistoryItems(
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
            || rawItemsQueue[network] === undefined
            || rawItemsQueue[network].length === 0
          ) {
            let moreRawTransactionHistory = [];
            while (moreRawTransactionHistory.length < 1 && rawItemsLoadingBatch[network].length > 0) {
              const rawItems = await rawItemsLoadingBatch[network].shift()!;
              moreRawTransactionHistory.push(...rawItems);
            }
            if (rawItemsLoadingBatch[network].length === 0) {
              reachedEnd = true;
            }
            rawItemsQueue[network] = moreRawTransactionHistory;
          }

          // Fill/Refill up to PARALLEL_BATCH_SIZE items into enrichingBatch to process in parallel
          if (false
            || enrichingBatch[network] === undefined
            || enrichingBatch[network].length < PARALLEL_BATCH_SIZE) {
            if (enrichingBatch[network] === undefined) {
              enrichingBatch[network] = [];
            }
            // Keep moving items from raw queue until the batch is filled back to BATCH_SIZE or raw queue is empty
            while (enrichingBatch[network].length < PARALLEL_BATCH_SIZE && rawItemsQueue[network].length > 0) {
              const rawItem = rawItemsQueue[network].pop()!;
              if (filterRawTransactionHistoryItem(networks, contractAddresses, rawItem)) {
                enrichingBatch[network].push(
                  enrichRawTransactionHistoryItem(accountAddress, network, rawItem)
                );
              }
            }
          }

          // Pull 1 item from enrichingBatch and filter the enriched item into immediateEnrichedItem
          if (enrichingBatch[network] !== undefined && enrichingBatch[network].length > 0) {
            const itemPromise = enrichingBatch[network].shift();
            if (itemPromise === undefined) {
              throw new Error('Queue shall not be empty here');
            }
            const enrichedItem = await itemPromise;
            enrichedItemCount += 1;
            while (blockNumberAnchor[network].length > 1 && enrichedItem.blockNumber < blockNumberAnchor[network][1]) {
              // Previous index projected block number is not longer needed
              blockNumberAnchor[network].shift();
              // Update cursor preceding block number
              cursors[network] = {
                ...cursors[network],
                blockNumber: blockNumberAnchor[network][0],
              };
            }
            if (filterTransactionHistoryItem(accountAddress, actions, initiatedBy, enrichedItem)) {
              immediateEnrichedItem[network] = enrichedItem;
            } else {
              // Update cursor transaction hash, so next time we can start from the next item
              cursors[network] = {
                ...cursors[network],
                transactionHash: enrichedItem.transactionHash,
              };
            }
          }
        }

        // Compare immediate item with max block number
        if (immediateEnrichedItem[network] !== undefined) {
          const item = immediateEnrichedItem[network];
          if (item.timestamp > maxTimestamp) {
            maxTimestamp = item.timestamp;
            maxTimestampItem = item;
            maxTimestampNetwork = network;
          }
        }
      }

      if (maxTimestampItem !== undefined && maxTimestampNetwork !== undefined) {
        // Add max item cadidate to mergedTrxHistItems
        mergedItems.push(maxTimestampItem);

        // Delete immediate item
        delete immediateEnrichedItem[maxTimestampNetwork];

        // Update cursor
        const currentCursor = cursors[maxTimestampNetwork];
        if (currentCursor === undefined) {
          throw new Error('Cursor is undefined, cursor may failed on initialization');
        }

        const newCursor = {
          ...currentCursor,
          transactionHash: maxTimestampItem.transactionHash,
        };

        cursors[maxTimestampNetwork] = newCursor;
      } else {
        // No more items to load, break and return
        done = true;
        // TODO: hans: A little hacky one off update cursor to the last block number
        // But now the cursor block# is tracked along the items getting loaded, which no item will be able to trigger this when it's on contract creation time
        for (const network of networks) {
          cursors[network] = {
            ...cursors[network],
            blockNumber: blockNumberAnchor[network][0],
          };
        }
        break;
      }
    }

    // Upsert cursor info before return
    const cursorHash = await sha256(JSON.stringify(cursorPayload));
    Fallible.must(await cache.put(cursorHash, cursorPayload));

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

  const contractAddresses: string[] = [];
  const networks: string[] = [];
  let loadTestnet = false;
  if (parsedMarkets.length > 0) {
    for (const m of parsedMarkets) {
      const { networkParam, address } = m;
      const chainId = parseInt(networkParam);

      if (isNaN(chainId)) {
        // If network is a number, it is a network id
        return new Response(`Invalid network id ${networkParam}`, { status: 400 });
      }

      const network = KnownNetwork.lookup({ chainId });
      if (Fallible.isFailure(network)) {
        return new Response(`Invalid network id ${networkParam}`, { status: 400 });
      }

      if (!Eth.parseAddress(address)) {
        return new Response(`Invalid address ${address}`, { status: 400 });
      }

      const networkAlias = KnownNetwork.canonicalNameOf(network);
      if (networkAlias === 'ethereum-sepolia') loadTestnet = true;
      if (!networks.includes(networkAlias)) networks.push(networkAlias);
      if ((networks.includes('ethereum-mainnet') || networks.includes('polygon-mainnet')) && loadTestnet) {
        return new Response(`Request can't mix with ethereum-mainnet and testnet`, { status: 400 });
      }
      const cometContract = ContractUtils.lookupInWellKnown(
        { network: networkAlias, address },
        Eth.wellKnownContractsByNetwork
      );
      if (!Comet.is(cometContract)) {
        return new Response(`Invalid market address ${address}`, { status: 400 });
      }
      contractAddresses.push(address);
      // Push rewards contract address to contractAddresses if it is not already there
      // TODO: contract addresses used in api seems are mixing between with upper case and all lower case ones, should be consistent
      // For now, we use filter and compare both in lower case for comparison
      if (contractAddresses.filter((a) => a.toLowerCase() === cometContract.rewards.contract.address.toLowerCase()).length === 0) {
        contractAddresses.push(cometContract.rewards.contract.address);
      }
    }
  } else {
    // Default to include all ethereum-mainnet markets
    // Just include everything from sources
    GetAllStreamEvents().forEach((m) => {
      if (!networks.includes(m.network)) networks.push(m.network);
      m.marketContractAddresses.forEach((contractAddress) => {
        contractAddresses.push(contractAddress);
      });
      contractAddresses.push(m.rewardsContractAddress);
    });
  }

  const streamEvents = loadTestnet ? GetAllTestStreamEvents() : GetAllStreamEvents();
  if (cursor === null || cursor === undefined) {
    let profilesByAddress: { [_ in Eth.Address]: governanceModel.Profile } = {};
    // No cursor provided, use provided filters
    // Iterate over all markets and get transaction history items
    // Initializing cursor
    const cursorPayload: CursorPayload = {
      profilesByAddress,
      filter: {
        markets: markets,
        actions: actions ?? [],
        initiatedBy: initiatedBy ?? [],
        contractAddresses,
        networks
      },
      streamEvents: streamEvents,
      cursors: {},
    };

    // Populate cursor info
    const latestBlocks: {[key: string]: Promise<Eth.Block>} = {};
    streamEvents.map((m) => {
      cursorPayload.cursors[m.network] = {
        network: m.network,
        marketContractAddresses: m.marketContractAddresses,
        rewardsContractAddress: m.rewardsContractAddress,
        transactionHash: '0x0',
        blockNumber: 0,
      };
      latestBlocks[m.network] = evaluate(pull1({ ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network: m.network } }));
    });

    const [ transactionHistoryResponse, defiSaverProxies ] = await (
      loadTransactionHistoryItems(
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
          profilesByAddress,
          defiSaverProxies
        )
      )
    ), { status: 200 });
  } else {
    // Cursor provided, parse cursor
    const cursorPayload = Fallible.must(await cache.get<CursorPayload>(cursor));
    if (cursorPayload === null) {
      return new Response('Cursor is invalid', { status: 400 });
    } else {
      // Validate cursor and match if the provided filters are the same
      if (cursorPayload.filter.markets.length !== markets.length) {
        return new Response('Cursor is having different markets filter', { status: 400 });
      } else {
        for (const m of cursorPayload.filter.markets) {
          if (!markets.includes(m)) {
            return new Response('Cursor is having different markets filter', { status: 400 });
          }
        }
      }

      if (cursorPayload.filter.actions.length !== (actions?.length ?? 0)) {
        return new Response('Cursor is having different actions filter', { status: 400 });
      } else {
        for (const a of cursorPayload.filter.actions) {
          if (!actions?.includes(a)) {
            return new Response('Cursor is having different actions filter', { status: 400 });
          }
        }
      }

      if (cursorPayload.filter.initiatedBy.length !== (initiatedBy?.length ?? 0)) {
        return new Response('Cursor is having different initiated by filter', { status: 400 });
      } else {
        for (const i of cursorPayload.filter.initiatedBy) {
          if (!initiatedBy?.includes(i)) {
            return new Response('Cursor is having different initiated by filter', { status: 400 });
          }
        }
      }

      const [ transactionHistoryResponse, defiSaverProxies ] = await (
        loadTransactionHistoryItems(
          accountAddress,
          cursorPayload,
          itemsLimit,
          {}
        )
      );
      // Manually add DefiSaver to profilesByAddress
      return new Response(JSON.stringify(
        formatTransactionHistoryResponse(
          transactionHistoryResponse,
          populateDefiSaverProxyProfiles(
            cursorPayload.profilesByAddress,
            defiSaverProxies
          )
        )
      ), { status: 200 });
    }
  }
}

export type {
  Context,
  Dependencies,
};

export {
  getTransactionHistory,
};
