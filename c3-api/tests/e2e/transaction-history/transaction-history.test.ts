import t from 'tap';

import * as fs         from 'node:fs/promises';
import * as streamInto from 'node:stream/consumers';

import * as Eth   from '../../../lib/eth-constants.js';
// import * as Json  from '../../../lib/json-types.js';
import * as Debug from '../../../lib/debug-log.js';
import * as Flags from '../../../lib/flags.js';

import { FormattedTransactionHistoryItem     } from '../../../lib/model/transaction-history/item.js';
import { FormattedTransactionHistoryAction   } from '../../../lib/model/transaction-history/action.js';
import { FormattedTransactionHistoryResponse } from '../../../lib/model/transaction-history/history.js';

import * as KnownNetwork from '../../../lib/well-known/networks/network.js';

/* FIXME: temporarily disabled due to Tally rate limiting. Should
 * re-enable once we've put Tally requests behind the cache.
 */
// import * as TallyApi from '../../../lib/model/governance/tally.js';

import C3Api, { Env } from '../../../entrypoint.js';

import * as mock     from '../../util/mock/mock.js';
import * as jsonUtil from '../../util/json.js';
import { MemoryKv, encodeSeed } from '../../util/kv.js';
import { makeTestEnv } from '../../util/test-env.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../shim/node-self.js';

import { setupTestEnvVars } from '../../util/setupTestEnvVars.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';

import type { NetworkV1 } from '../../../lib/model/comet-registry.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

const { apiHost, nodeHost, nodeKey } = setupTestEnvVars();

const globalEnv = makeTestEnv({
  'V3_API_HOST': apiHost,
  'NODE_PROXY_HOST': nodeHost,
  'NODE_PROXY_KEY': nodeKey,
  'MEMORY_CACHE_SEED': 'transaction-history',
}, process.env);
const flags = Flags.parseWithDefaults(globalEnv);

/* FIXME(base-mainnet): add base-mainnet for transaction history tests
 * once Comet is deployed to base-mainnet
 */
type Mainnets = Exclude<Extract<KnownNetwork.Name, `${string}-mainnet`>, 'scroll-mainnet' | 'mantle-mainnet' | 'linea-mainnet' | 'unichain-mainnet' | 'ronin-mainnet'>;
/*
 * Polygon's USDC market, whose history the first account's is recorded
 * across: the frozen registry fixture holds no Polygon, and a market the
 * active version does not hold is refused before any history is read. Read
 * from the chain on 2026-10-06; its collaterals have since been capped at
 * zero, which history does not depend on.
 */
const POLYGON: NetworkV1 = {
  chainId:      137,
  key:          'polygon-mainnet',
  upstreamKey:  'polygon',
  displayName:  'Polygon',
  testnet:      false,
  presentation: { assetDisplayOverrides: [], unwrappedCollateralAssets: [] },
  priceExceptions: [],
  markets: [ {
    id:                   '00000000-0000-4000-8000-000000000201',
    deploymentKey:        'usdc',
    displayName:          'USDC.e',
    slug:                 null,
    contractName:         'cUSDCv3',
    isDefault:            false,
    isInstitutional:      false,
    status:               'enabled',
    creationBlock:        39_412_367,
    collateralValueQuote: 'usd',
    capabilities:         { rewards: true, accountRewards: true, transactionHistory: true },
    contracts: {
      comet:          '0xf25212e676d1f7f89cd72ffee66158f541246445',
      configurator:   '0x83e0f742cacbe66349e3701b171ee2487a26e738',
      rewards:        '0x45939657d1ca34a8fa39a924b71d28fe8431e581',
      bulker:         '0x59e242d352ae13166b4987ae5c990c232f7f7cd6',
      fauceteer:      null,
      bridgeReceiver: '0x18281dfc4d00905da1aaa6731414eaba843c468a',
    },
    baseAsset: {
      token:           { address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', symbol: 'USDC', name: 'USD Coin (PoS)', decimals: 6 },
      displayName:     'USD Coin (Bridged)',
      isWrappedNative: false,
      priceFeed:       { address: '0xfe4a8cc5b5b2366c1b58bea3858e81843581b2f7', decimals: 8 },
      usdPriceFeed:    null,
    },
    rewardAsset: {
      token:          { address: '0x8505b9d2254a7ae468c0e9dd10ccea3a837aef5c', symbol: 'COMP', name: '(PoS) Compound', decimals: 18 },
      priceFeed:      { address: '0x2a8758b7257102461bc958279054e372c2b1bde6', decimals: 8 },
      priceFeedQuote: 'usd',
    },
    collateralAssets: [
      { assetIndex: 0, token: { address: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', symbol: 'WETH',    name: 'Wrapped Ether',                    decimals: 18 }, priceFeed: { address: '0xf9680d99d6c9589e2a93a78a04a279e509205945', decimals: 8 } },
      { assetIndex: 1, token: { address: '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', symbol: 'WBTC',    name: '(PoS) Wrapped BTC',                decimals: 8 },  priceFeed: { address: '0xde31f8bfbd8c84b5360cfacca3539b938dd78ae6', decimals: 8 } },
      { assetIndex: 2, token: { address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', symbol: 'WPOL',    name: 'Wrapped Polygon Ecosystem Token',  decimals: 18 }, priceFeed: { address: '0xab594600376ec9fd91f8e885dadf0ce036862de0', decimals: 8 } },
      { assetIndex: 3, token: { address: '0xfa68fb4628dff1028cfec22b4162fccd0d45efb6', symbol: 'MaticX',  name: 'Liquid Staking Matic (PoS)',       decimals: 18 }, priceFeed: { address: '0x5d37e4b374e6907de8fc7fb33ee3b0af403c7403', decimals: 8 } },
      { assetIndex: 4, token: { address: '0x3a58a54c066fdc0f2d55fc9c89f0415c92ebf3c4', symbol: 'stMATIC', name: 'Staked MATIC (PoS)',               decimals: 18 }, priceFeed: { address: '0x5d173813b4505701e79e654b36a95e6c1fad4448', decimals: 8 } },
    ],
  } ],
};

const testBlocks: { [_ in Mainnets]: Eth.Block.WithTimestamp } = {
  'ethereum-mainnet': {
    number: 17_417_719,
    timestamp: 1_686_009_576,
    date: '2023-06-05',
  },
  'polygon-mainnet': {
    number: 43_576_059,
    timestamp: 1_686_009_576,
    date: '2023-06-05',
  },
  'arbitrum-mainnet': {
    number: 98_197_775,
    timestamp: 1_686_009_576,
    date: '2023-06-05',
  },
  "base-mainnet": {
    number: 2_625_142,
    timestamp: 1_710_188_307,
    date: "2024-03-11",
  },
  "optimism-mainnet": {
    number: 122_730_232,
    timestamp: 1_721_059_241,
    date: "2024-05-20",
  },
};

/*
 * Mock the 'fetch' global
 */
declare var fetch: mock.Fetch;
t.before(() => {
  /*
   * Configure the fetch mock only to allow passing through the cache when
   * test flags are set to explicitly enable it.
   */
  globalThis.fetch = mock.fetch({
    passthrough: flags.testAllowFetchPassthrough,
  });
});

t.test(`transaction history`, async t => {
  /*
   * 1. Setup
   */
  const cacheSeedDumpPath = (
    `./tests/dumps/account/transaction-history@`
    + `ethereum-mainnet:(blockNumber:${testBlocks['ethereum-mainnet'].number})`
    + `;polygon-mainnet:(blockNumber:${testBlocks['polygon-mainnet'].number})`
    + `;arbitrum-mainnet:(blockNumber:${testBlocks['arbitrum-mainnet'].number})`
    + `;optimism-mainnet:(blockNumber:${testBlocks['optimism-mainnet'].number})`
    + `;base-mainnet:(blockNumber:${testBlocks['base-mainnet'].number})`
    + `.cache-seed.json`
  );

  const debug = Debug.MakeLogger([]).configure(process.env);
  const testDebug = debug.scope('test');
  testDebug.log({ flags });

  // NOTE: Only load the cache seed if test flags configuration says so
  const seedJson = !flags.testShouldLoadCacheSeed ? {} : (
    await jsonUtil.load<{ [_: string]: any }>(cacheSeedDumpPath)
  );
  const seed = encodeSeed(seedJson);

  /*
   * The markets whose history is read, and the networks they are on, are what
   * the activated registry says they are. This test seeds the frozen snapshot
   * fixture with Polygon's USDC market added, and mocks a latest block for each
   * network that version serves history for: mainnet, whose USDC, WETH and
   * USDT markets have it, and Polygon. The list is written here rather than
   * computed by the code under test, which could not then be caught wrong.
   */
  const fixture  = loadRegistrySnapshotFixture();
  const registry = await activeRegistryDatabase({ snapshot: { ...fixture, networks: [ ...fixture.networks, POLYGON ] } });
  t.teardown(() => registry.dispose());
  const historyNetworks: Mainnets[] = [ 'ethereum-mainnet', 'polygon-mainnet' ];

  /*
   * Set up the test env, seeding in-memory test KVs with the cache seed.
   */
  const testEnv: Env = {
    ...globalEnv,
    'kv_testnet': MemoryKv({ seed }),
    'kv_mainnet': MemoryKv({ seed }),
    'APP_DB':     registry.db,
  };

  /*
   * TallyApi.Profiles and 'latest' block requests should be mocked; all
   * other I/O  should be served out of cache.
   *
   * All mocked fetch expectations must be satisfied after each test.
   */
  t.afterEach((t) => fetch.satisfy(t));
  t.beforeEach(async () => {
    /*
     * Mock Tally API governance profiles response from a dump file.
     */
    /*
     * Mock 1 'latest' block request per supported mainnet.
     */
    for (const network of historyNetworks) {
      mock.rpc.expectPost(fetch, Eth.nodeEndpoint(testEnv.NODE_PROXY_HOST, testEnv.NODE_PROXY_KEY, network),
        mock.rpc.ethGetBlock(testBlocks[network], { reference: 'latest' })
      );
    }
  });

  t.test('Test on Account#1 0x420f253087044b8BCf028dd89F8fe83Ba6275E84', async t => {
    const accountAddress = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';
    const limit = 15;
    // All mainnet USDC, WETH markets, and polygon USDC market
    const markets = '1_0xc3d688B66703497DAA19211EEdff47f25384cdc3,137_0xF25212E676D1F7F89Cd72fFEe66158f541246445,1_0xa17581a9e3356d9a858b789d68b4d866e593ae94';
    const testUrl = `http://test.local/account/${accountAddress}/transaction_history?limit=${limit}&markets[]=${markets}`;
    const request = new Request(testUrl);
    const response = await C3Api.fetch(request, testEnv);
    t.equal(response.status, 200, `the history is answered, not refused`);
    t.ok(response.body, `response has no body`);

    // non-null assert (!) is safe because of the t.ok(response.body) above.
    const responseJson = await streamInto.json(response.body! as any);

    // This account first batch should contains 15 transactions and all from polygon network from the block number specified above
    const {
      done,
      cursor,
      item_count,
      item_limit,
      items,
    } = responseJson as FormattedTransactionHistoryResponse;

    t.ok(!done, `not done`);
    // Cursor on first one on latest block should be this, as the latest block is set
    t.equal(item_count, 15, `item_count should be 15`);
    t.equal(item_limit, limit, `item_limit should be ${limit}`);
    t.ok(Array.isArray(items), `items is an Array`);
    // Hand picked some transaction block numbers to make sure data is correct
    const testTx = items.find(({ transaction_hash }) => (
      transaction_hash === '0x0eaa5d1bdeefc6a807fdca2430c30cd4aa0b520e67e9a22eb093031776f3a8c3'
    ))!;
    t.ok(testTx, `items should contain transaction_hash '0x0eaa5d1bdeefc6a807fdca2430c30cd4aa0b520e67e9a22eb093031776f3a8c3`);
    t.equal(items[0].transaction_hash, '0x0eaa5d1bdeefc6a807fdca2430c30cd4aa0b520e67e9a22eb093031776f3a8c3');
    t.equal(testTx.item_type, 'Bulk');
    t.equal(testTx.actions.length, 3);
    t.equal(testTx.actions[0].event_type, 'Supply');
    t.equal(testTx.actions[0].action_type, 'Repay');

    // Trace all the way to the end of history and make sure block numbers are all in order
    let isDone = false;
    let cursorHash = cursor;
    while (!isDone) {
      const testUrl = `http://test.local/account/${accountAddress}/transaction_history?cursor=${cursorHash}&limit=${limit}&markets[]=${markets}`;
      const request = new Request(testUrl);
      const response = await C3Api.fetch(request, testEnv);
      t.equal(response.status, 200, `the history is answered, not refused`);
      t.ok(response.body, `response has no body`);

      // non-null assert (!) is safe because of the t.ok(response.body) above.
      const responseJson = await streamInto.json(response.body! as any);
      const { done, items, cursor } = responseJson as any;
      isDone = done;
      cursorHash = cursor;

      if (isDone) {
        // Some couple more checks on the earliest items
        t.equal(items[items.length - 1].transaction_hash, '0xe7f4020445b02009daa0ac59916f3f964f85752178ca1b56583ca697d14c645b', `last item should have tx hash 0xe7f4...645b`);
        t.equal(items[items.length - 1].item_type, 'Bulk', `last item should have item_type Bulk`);
        t.equal(items[items.length - 1].network.chain_id, 1, `last item chain_id should be 1`);
        t.equal(items[items.length - 1].network.alias, 'ethereum-mainnet', `last item network.alias should be mainnet`);
      }
    }
  });

  t.test('Test on Account#2 0x49707808908f0C2450B3F2672E012eDBf49eD808', async t => {
    const accountAddress = '0x49707808908f0C2450B3F2672E012eDBf49eD808';
    const limit = 15;
    // All market only WETH and USDC on mainnet
    const markets = '1_0xc3d688B66703497DAA19211EEdff47f25384cdc3,1_0xa17581a9e3356d9a858b789d68b4d866e593ae94';
    const testUrl = `http://test.local/account/${accountAddress}/transaction_history?limit=${limit}&markets[]=${markets}`;
    const request = new Request(testUrl);
    const response = await C3Api.fetch(request, testEnv);
    t.equal(response.status, 200, `the history is answered, not refused`);
    t.ok(response.body, `response has no body`);

    // non-null assert (!) is safe because of the t.ok(response.body) above.
    const responseJson = await streamInto.json(response.body! as any);
    // check basic formatting of the summary response
    const {
      done,
      cursor,
      item_count,
      item_limit,
      items,
    } = responseJson as any;

    t.ok(!done, `not done`);
    t.equal(item_count, 15, `item_count should be 15`);
    t.equal(item_limit, limit, `item_limit should be ${limit}`);
    t.ok(Array.isArray(items), `items is an Array`);
    // t.equal(items[0].transaction_hash, '', `items[0].transaction_hash should be 0x.....`);
    t.equal(items[0].actions.length, 2, `items[0].actions.length should be 2`);
    t.equal(items[0].item_type, 'Bulk', `items[0].item_type should be Bulk`);
    t.equal(items[0].actions[0].action_type, 'Repay', `items[0].actions[0].action_type should be Repay`);

    // Trace all the way to the end of history and make sure block numbers are all in order
    let isDone = false;
    let cursorHash = cursor;
    const allItems: FormattedTransactionHistoryItem[] = [];
    while (!isDone) {
      const testUrl = `http://test.local/account/${accountAddress}/transaction_history?cursor=${cursorHash}&limit=${limit}&markets[]=${markets}`;
      const request = new Request(testUrl);
      const response = await C3Api.fetch(request, testEnv);
      t.equal(response.status, 200, `the history is answered, not refused`);
      t.ok(response.body, `response has no body`);

      // non-null assert (!) is safe because of the t.ok(response.body) above.
      const responseJson = await streamInto.json(response.body! as any);
      const { done, cursor } = responseJson as any;
      allItems.push(...(responseJson as any).items);
      isDone = done;
      cursorHash = cursor;
    }

    const testTx = allItems.find(({ transaction_hash }) => transaction_hash === '0xd9a1937efb8d73729721383d4b2948a2f3d34961464c6c28956361d04fa0889d')!;
    t.ok(testTx, `items should contain transaction_hash 0xd9a1937...0889d`);
    // Some couple more checks on the earliest items
    t.equal(allItems[allItems.length - 1].transaction_hash, '0xd9a1937efb8d73729721383d4b2948a2f3d34961464c6c28956361d04fa0889d', `items[items.length - 1].transaction_hash should be 0xd9a1937...0889d`);
    t.equal(testTx.item_type, 'Bulk', `0xd9a1937...0889d item_type should be Bulk`);
    t.equal(testTx.network.chain_id, 1, `0xd9a1937...0889d network.chain_id should be 1`);
    t.equal(testTx.network.alias, 'ethereum-mainnet', `0xd9a1937...0889d network.alias should be mainnet`);
    t.equal(testTx.actions.length, 2, `0xd9a1937...0889d actions.length should be 2`);
    t.equal(testTx.actions[0].event_type, 'SupplyCollateral', `0xd9a1937...0889d actions[0].event_type should be SupplyCollateral`);
    t.equal(testTx.actions[1].action_type, 'Borrow', `0xd9a1937...0889d actions[1].action_type should be Borrow`);
  });

  t.test('Test on Account#1 0x420f253087044b8BCf028dd89F8fe83Ba6275E84 with market filter', async t => {
    const accountAddress = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';
    const limit = 15;
    // All mainnet USDC, WETH markets, and polygon USDC market
    const markets = '1_0xc3d688B66703497DAA19211EEdff47f25384cdc3';
    const testUrl = `http://test.local/account/${accountAddress}/transaction_history?limit=${limit}&markets[]=${markets}`;
    const request = new Request(testUrl);
    const response = await C3Api.fetch(request, testEnv);
    t.equal(response.status, 200, `the history is answered, not refused`);
    t.ok(response.body, `response has no body`);

    // non-null assert (!) is safe because of the t.ok(response.body) above.
    const responseJson = await streamInto.json(response.body! as any);

    // This account first batch should contains 15 transactions and all from polygon network from the block number specified above
    const { done, items } = responseJson as any;

    t.ok(!done, `not done`);
    // Make sure only mainnet USDC market
    items.forEach((item: FormattedTransactionHistoryItem) => {
      t.equal(item.network.chain_id, 1, `item ${item.transaction_hash} network.chain_id should be 1`);
      t.equal(item.network.alias, 'ethereum-mainnet', `item ${item.transaction_hash} network.alias should be mainnet`);
    });
  });

  t.test('Test on Account#3 0xcfc50541c3dEaf725ce738EF87Ace2Ad778Ba0C5 with action filter', async t => {
    const accountAddress = '0xcfc50541c3dEaf725ce738EF87Ace2Ad778Ba0C5';
    const limit = 15;
    const actions = 'borrow';
    const testUrl = `http://test.local/account/${accountAddress}/transaction_history?limit=${limit}&actions[]=${actions}`;
    const request = new Request(testUrl);
    const response = await C3Api.fetch(request, testEnv);
    t.equal(response.status, 200, `the history is answered, not refused`);
    t.ok(response.body, `response has no body`);

    // non-null assert (!) is safe because of the t.ok(response.body) above.
    const responseJson = await streamInto.json(response.body! as any);
    // This account first batch should contains 15 transactions and all from polygon network from the block number specified above
    const { items } = responseJson as any;

    items.forEach((item: FormattedTransactionHistoryItem) => {
      item.actions.forEach((action: FormattedTransactionHistoryAction) => {
        t.equal(action.action_type, 'Borrow', `action_type should be Borrow`);
      });
    });
  });

  t.test('Test on Account#4 0x11b50686d3983C14C0d0972a5e46e38e0D9B2E14', async t => {
    const accountAddress = '0x11b50686d3983C14C0d0972a5e46e38e0D9B2E14';
    const limit = 15;
    const markets = '1_0xc3d688B66703497DAA19211EEdff47f25384cdc3';
    // Trace all the way to the end of history and make sure block numbers are all in order
    let isDone = false;
    let cursorHash = '';
    let totalEvents = 0;
    let eventsCount: { [key: string]: any } = {};
    let totalItems = 0;
    while (!isDone) {
      const testUrl = cursorHash === ''
        ? `http://test.local/account/${accountAddress}/transaction_history?limit=${limit}&markets[]=${markets}`
        : `http://test.local/account/${accountAddress}/transaction_history?cursor=${cursorHash}&limit=${limit}&markets[]=${markets}`;
      const request = new Request(testUrl);
      const response = await C3Api.fetch(request, testEnv);
      t.equal(response.status, 200, `the history is answered, not refused`);
      t.ok(response.body, `response has no body`);

      // non-null assert (!) is safe because of the t.ok(response.body) above.
      const responseJson = await streamInto.json(response.body! as any);
      const {
        done,
        cursor,
        items,
      } = responseJson as any;
      // Add all block numbers to the array
      items.forEach((item: FormattedTransactionHistoryItem) => {
        totalItems++;
        totalEvents += item.actions.length;
        item.actions.forEach((action: FormattedTransactionHistoryAction) => {
          if (eventsCount[action.event_type]) {
            eventsCount[action.event_type] += 1;
          } else {
            eventsCount[action.event_type] = 1;
          }
        });
      });
      isDone = done;
      cursorHash = cursor;
    }

    // Stats shows total events should be somewhat between
    t.equal(totalEvents, 676, `totalEvents should be 676`);
    t.equal(totalItems, 429, `totalItems should be 429`);
    t.equal(eventsCount['WithdrawCollateral'], 164, `WithdrawCollateral count should be 164`);
  });

  t.test('Test on Account#5 0xD36Daf280D5F3a972AE77adB451aEBdC87189f67 with defisaver transactions', async t => {
    const accountAddress = '0xD36Daf280D5F3a972AE77adB451aEBdC87189f67';
    const limit = 15;
    const markets = '1_0xc3d688B66703497DAA19211EEdff47f25384cdc3';
    const testUrl = `http://test.local/account/${accountAddress}/transaction_history?limit=${limit}&markets[]=${markets}`;
    const request = new Request(testUrl);
    const response = await C3Api.fetch(request, testEnv);
    t.equal(response.status, 200, `the history is answered, not refused`);
    t.ok(response.body, `response has no body`);

    // non-null assert (!) is safe because of the t.ok(response.body) above.
    const responseJson = await streamInto.json(response.body! as any);
    const {
      items,
    } = responseJson as FormattedTransactionHistoryResponse;

    t.ok(Array.isArray(items), `items is an Array`);
    // Hand picked some transaction block numbers to make sure data is correct
    const testTx = items.find(({ transaction_hash }) => (
      transaction_hash === '0xac340be5defdeabc0943055306b39e2bb9d1b8eca38adeb9bb9d2b6daaaad03d'
    ))!;
    t.ok(testTx, `items should contain transaction_hash '0xac340be5defdeabc0943055306b39e2bb9d1b8eca38adeb9bb9d2b6daaaad03d`);
    t.equal(items[0].transaction_hash, '0xac340be5defdeabc0943055306b39e2bb9d1b8eca38adeb9bb9d2b6daaaad03d');
    t.equal(testTx.initiated_by.display_name, 'DeFi Saver');
    t.equal(testTx.actions.length, 1);
    t.equal(testTx.actions[0].event_type, 'Withdraw');
    t.equal(testTx.actions[0].action_type, 'Borrow');
  });

  t.test('Test on Account#6 0xa5e6b86b278ae2511518e0837047ae9595777434 with Migrator transactions', async t => {
    const accountAddress = '0xa5e6b86b278ae2511518e0837047ae9595777434';
    // Trace all the way to the end of history and make sure block numbers are all in order
    const testUrl = `http://test.local/account/${accountAddress}/transaction_history`;
    const request = new Request(testUrl);
    const response = await C3Api.fetch(request, testEnv);
    t.equal(response.status, 200, `the history is answered, not refused`);
    t.ok(response.body, `response has no body`);
    // non-null assert (!) is safe because of the t.ok(response.body) above.
    const responseJson = await streamInto.json(response.body! as any);
    const { done, items } = responseJson as any;

    // Stats shows total events should be somewhat between
    t.equal(done, true);
    // Find items by transaction hash
    const tx = items.find((item: any) => item.transaction_hash === '0xf1d15b12c209259ecde03625983d796069789b697ded220cc77587531237716c');
    // Make sure this item has been marked migrator correctly
    t.equal(tx.item_type, 'Multi');
    t.equal(tx.initiated_by.display_name, 'Compound V3 Position Migrator');
  });

  t.skip('Test on Account#7 0x0cC5A715b06C8eCe9F2fa49Cdc75750539255779 that got liquidated', async t => {
    const accountAddress = '0x0cC5A715b06C8eCe9F2fa49Cdc75750539255779';
    const limit = 15;
    const testUrl = `http://test.local/account/${accountAddress}/transaction_history?limit=${limit}`;
    const request = new Request(testUrl);
    const response = await C3Api.fetch(request, testEnv);
    t.equal(response.status, 200, `the history is answered, not refused`);
    t.ok(response.body, `response has no body`);

    // non-null assert (!) is safe because of the t.ok(response.body) above.
    const responseJson = await streamInto.json(response.body! as any);
    // This account first batch should contains 15 transactions and all from polygon network from the block number specified above
    const { items } = responseJson as any;

    // Check on first item that contain liquidation actions
    const liquidatedItem = items[0];
    t.equal(liquidatedItem.actions.length, 3, `liquidatedItem should have 3 actions: AbsorbCollateral, AbsorbDebt, Refund`);
    t.equal(liquidatedItem.actions[0].action_type, 'Seized', `liquidatedItem first action should be AbsorbCollateral`);
    t.equal(liquidatedItem.actions[1].action_type, 'Repay', `liquidatedItem second action should be AbsorbDebt`);
    t.equal(liquidatedItem.actions[1].amount, '15162200.699302', `repay amount should be 15162200.699302`);
    t.equal(liquidatedItem.actions[2].action_type, 'Refund', `liquidatedItem third action should be Refund`);
    t.equal(liquidatedItem.actions[2].amount, '3527137.214037', `refund amount should be 3527137.214037`);
  });

  /*
   * If we're supposed to regenerate the cache seed, write all the cache
   * entries beginning with 'eth' to the cache seed.
   */
  t.teardown(async () => {
    if (flags.testRegenerateCacheSeed) {
      const newSeedStringEntriesMainnet: string[] = [];
      for (const [key, { value: utf8Bytes }] of seed.entries()) {
        // only add eth* computations to the cache seed
        if (!key.startsWith('eth')) {
          continue;
        }
        // already JSON.stringify-ed, so don't re-parse-stringify it...
        const valueString = Buffer.from(utf8Bytes).toString('utf8');
        newSeedStringEntriesMainnet.push(`"${key}":${valueString}`);
      }
      const newSeedMainnet = `{${newSeedStringEntriesMainnet.join(',')}}`;
      await fs.writeFile(cacheSeedDumpPath, newSeedMainnet);
    }
  });
});
