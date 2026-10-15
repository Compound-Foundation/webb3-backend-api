import t from 'tap';

import * as Eth from '../../../lib/eth-constants.js';

import type { MarketV1, NetworkV1, PriceExceptionV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';
import type { RawTransactionHistoryItem } from '../../../lib/model/transaction-history/item.js';

import { BigFixnum } from '../../../lib/bigfixnum.js';
import { enrichTransactionHistoryItem, isBulker } from '../../../lib/computations/account/enrich-transaction-history-items.js';
import { rawTransactionHistoryItems, tokenSymbol } from '../../../lib/computations/account/raw-transaction-history-items.js';
import { baseAssetLabel, marketRewards } from '../../../lib/computations/market/market-rewards.js';
import { usdBasePriceFeedFor } from '../../../lib/computations/rewards/base-price-feed.js';
import type * as account from '../../../lib/computations/account.js';
import type * as comet from '../../../lib/computations/comet.js';
import type * as market from '../../../lib/computations/market.js';
import type * as rewards from '../../../lib/computations/rewards.js';
import { lookupInWellKnown, withRegistryContracts } from '../../../lib/well-known/contracts/utils.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import type { Catalog } from '../../../src/registry/catalog.js';
import { describeRegistryTargets } from '../../../src/governance-handlers/proposals.js';
import { describeContractCallForHumans, contractForLocation } from '../../../lib/well-known/contracts/utils.js';
import { defaultAbiCoder } from '@ethersproject/abi';
import { rewardGroups } from '../../../src/account-handlers/rewards.js';
import type { MarketRouteData } from '../../../src/router.js';
import {
  streamEventsOf,
  streamKeyOf,
} from '../../../src/transaction-history-handler/transaction-history-items-handler.js';

import { fixtureCatalog, loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * What the backend consumers now read out of one registry version instead of
 * out of the static constants: which markets to enumerate, which streams to
 * read, which feed a reward APR is measured against, and what a proposal
 * target is called.
 */
const snapshot = loadRegistrySnapshotFixture();
const catalog  = fixtureCatalog();

const MAINNET = 'ethereum-mainnet' as const;
const SCROLL  = 'scroll-mainnet' as const;
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WETH    = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
const USDT    = '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840';
const WBTC    = '0xe85dc543813b8c2cfeaac371517b925a166a9293';

function withMarket(key: string, change: (market: MarketV1) => MarketV1): RegistrySnapshotV1 {
  return {
    ...snapshot,
    networks: snapshot.networks.map(network => ({
      ...network,
      markets: network.markets.map(market => market.deploymentKey === key ? change(market) : market),
    })),
  };
}

/*
 * One Sleuth query reads the reward configs of every market it is handed from
 * a single CometRewards. Batching markets that do not share one would read
 * each market's configuration from the wrong contract and quietly report zero
 * rewards, so the grouping is what keeps that query correct.
 */
t.test('account rewards are grouped by the rewards contract that holds them', async t => {
  const groups = rewardGroups(catalog, [ MAINNET, SCROLL ]);

  t.equal(groups.length, 1, 'the fixture has one rewards contract with claimable markets');
  t.equal(groups[0]!.network, MAINNET, 'scroll states that account rewards are not claimable');
  t.equal(groups[0]!.contracts.length, 4, 'and every mainnet market of the fixture is in one group');

  for (const group of groups) {
    const rewards = new Set(group.contracts.map(comet => comet.rewards?.contract.address.toLowerCase()));
    t.equal(rewards.size, 1, 'each group reads from exactly one CometRewards');
  }

  const split = catalogOf(withMarket('weth', market => ({
    ...market,
    contracts: { ...market.contracts, rewards: '0x2222222222222222222222222222222222222222' },
  })));
  const groupsOf = rewardGroups(split, [ MAINNET ]);
  t.equal(groupsOf.length, 2, 'a market with its own rewards contract is queried on its own');
  t.same(groupsOf.map(group => group.contracts.length).sort(), [ 1, 3 ]);

  const none = rewardGroups(catalogOf(withMarket('usdc', market => ({
    ...market,
    capabilities: { ...market.capabilities, accountRewards: false },
  }))), [ MAINNET ]);
  t.equal(none[0]!.contracts.length, 3, 'a market whose account rewards are off is left out');
});

t.test('transaction history streams are the markets the version serves history for', async t => {
  const streams = streamEventsOf(catalog);

  t.equal(streams.length, 1, 'the fixture serves history for one group of markets');
  t.equal(streams[0]!.network, MAINNET);
  t.same(streams[0]!.marketContractAddresses.sort(), [ USDC, WETH, USDT ].sort(),
    'only the markets whose transaction history the version serves: not wbtc');
  t.equal(streams[0]!.rewardsContractAddress, '0x1b0e765f6224c21223aea2af16c1c46e38885a40');

  const enabled = streamEventsOf(catalogOf(withMarket('wbtc', market => ({
    ...market,
    capabilities: { ...market.capabilities, transactionHistory: true },
  }))));
  t.equal(enabled[0]!.marketContractAddresses.length, 4,
    'enabling a market in the version makes its history reachable, with no code change');
  t.ok(enabled[0]!.marketContractAddresses.includes(WBTC));

  const separate = streamEventsOf(catalogOf(withMarket('weth', market => ({
    ...market,
    contracts: { ...market.contracts, rewards: '0x2222222222222222222222222222222222222222' },
  }))));
  t.equal(separate.length, 2, 'markets with different rewards contracts are read as separate streams');
  t.equal(new Set(separate.map(streamKeyOf)).size, 2, 'and are keyed apart');
});

/*
 * A rewards APR is a ratio, so the reward price and the market value have to
 * be measured in the same unit. The registry states both units; these four
 * markets used to be listed by name in each APR computation.
 */
t.test('the base price feed of a rewards APR follows the unit of the reward feed', async t => {
  const usdc = catalog.marketAt(MAINNET, USDC)!.comet;
  const weth = catalog.marketAt(MAINNET, WETH)!.comet;
  const wbtc = catalog.marketAt(MAINNET, WBTC)!.comet;

  t.equal(usdBasePriceFeedFor(usdc), null, 'a USD-quoted market needs no conversion');
  t.equal(usdBasePriceFeedFor(weth), null, 'nor does one whose reward feed is quoted in its base asset');
  t.equal(usdBasePriceFeedFor(wbtc)?.address, '0xf4030086522a5beea4988f8ca5b36dbc97bee88c',
    'a USD reward feed against a base-quoted market converts through the USD feed');
});

/*
 * The rewards of a market name its base asset as the review does. On chain,
 * Tether's USDT now calls itself USD₮0 and bridged USDC plain USDC, which
 * would give two markets of one network the same label on the rewards page.
 */
t.test('the rewards of a market name its base asset as the review does', async t => {
  const renamed = catalogOf(withMarket('usdt', market => ({
    ...market,
    baseAsset: { ...market.baseAsset, token: { ...market.baseAsset.token, symbol: 'USD₮0', name: 'USD₮0' } },
  }))).marketAt(MAINNET, USDT)!.comet;

  t.equal(renamed.base.asset.symbol, 'USD₮0', 'the token carries its on-chain symbol');
  t.same(baseAssetLabel(renamed), { symbol: 'USDT', description: 'Tether' },
    'the rewards carry the market\'s reviewed name and the base asset\'s reviewed name');
});

/*
 * The computations take one kind of market: a Comet the request's catalog
 * materialized, whose description they read for its units, its labels, its
 * reward feed and the exceptions of its network. A Comet of the constants
 * has none of that to read, and the compiler refuses one read from them: to
 * every computation that reads the description, to every one that hands its
 * market to one that does, and to the market routes, which hand them theirs.
 * Each refusal below is a type error the build expects, so loosening one of
 * those types, or the constants' type of their Comets, fails the build, not a
 * request.
 */
t.test('a computation takes only a Comet the registry materialized', async t => {
  const usdc = catalog.marketAt(MAINNET, USDC)!.comet;
  t.equal(usdc.registry.market.deploymentKey, 'usdc', 'a Comet of the catalog carries the description of its market');
  t.equal(usdc.registry.versionId, catalog.versionId, 'as the version it was materialized from describes it');

  // what a computation takes as its market, and what a function of a market takes
  const marketOf   = <Spec extends { expects: { contract: unknown } }>(contract: Spec['expects']['contract']) => contract;
  const argumentOf = <Fn extends (contract: never) => unknown>(contract: Parameters<Fn>[0]) => contract;
  const routedTo   = (contract: MarketRouteData['contract']) => contract;

  const taken = [
    marketOf<comet.AssetPrice>(usdc),
    marketOf<comet.BaseUsdPrice>(usdc),
    marketOf<market.Collaterals>(usdc),
    marketOf<market.MarketSummary>(usdc),
    marketOf<market.MarketDaySummary>(usdc),
    marketOf<market.MarketMinutelySummary>(usdc),
    marketOf<market.VersionedCollaterals>(usdc),
    marketOf<market.MarketLatestSummary>(usdc),
    marketOf<market.HistoricalMarketDaySummaries>(usdc),
    marketOf<market.MarketRewards>(usdc),
    marketOf<rewards.SupplyRewardsApr>(usdc),
    marketOf<rewards.BorrowRewardsApr>(usdc),
    marketOf<rewards.RewardsSummary>(usdc),
    marketOf<account.AccountRewards>(usdc),
    argumentOf<typeof usdBasePriceFeedFor>(usdc),
    argumentOf<typeof baseAssetLabel>(usdc),
    routedTo(usdc),
  ];
  t.ok(taken.every(contract => contract === usdc), 'every one of them takes a Comet of the catalog');

  // the same market, as the constants name it
  const constant = Eth.wellKnownContractsByNetwork[MAINNET]['Comet']!['cUSDCv3'];
  t.equal(constant.address.toLowerCase(), USDC, 'the constants name the same market');
  // @ts-expect-error the price of a collateral is read at the scale the version states
  marketOf<comet.AssetPrice>(constant);
  // @ts-expect-error the base asset's USD price is read through the feed the version's quote calls for
  marketOf<comet.BaseUsdPrice>(constant);
  // @ts-expect-error and every price of a market's collateral is
  marketOf<market.Collaterals>(constant);
  // @ts-expect-error so a market summary prices with its version
  marketOf<market.MarketSummary>(constant);
  // @ts-expect-error and so do the summaries made of it
  marketOf<market.MarketDaySummary>(constant);
  // @ts-expect-error
  marketOf<market.MarketMinutelySummary>(constant);
  // @ts-expect-error a market's collateral is listed as the version describes it
  marketOf<market.VersionedCollaterals>(constant);
  // @ts-expect-error and the summary of the latest block reports it so
  marketOf<market.MarketLatestSummary>(constant);
  // @ts-expect-error
  marketOf<market.HistoricalMarketDaySummaries>(constant);
  // @ts-expect-error the rewards of a market are labelled and priced as its version says
  marketOf<market.MarketRewards>(constant);
  // @ts-expect-error and an account's rewards are those rewards
  marketOf<account.AccountRewards>(constant);
  // @ts-expect-error a rewards APR is measured in the unit the version states
  marketOf<rewards.SupplyRewardsApr>(constant);
  // @ts-expect-error
  marketOf<rewards.BorrowRewardsApr>(constant);
  // @ts-expect-error and the rewards summary is made of them
  marketOf<rewards.RewardsSummary>(constant);
  // @ts-expect-error
  argumentOf<typeof usdBasePriceFeedFor>(constant);
  // @ts-expect-error
  argumentOf<typeof baseAssetLabel>(constant);
  // @ts-expect-error and a market route is handed nothing else
  routedTo(constant);
});

/*
 * A market the version gives no reward feed has nothing to value its rewards
 * in, and its reward feed in the catalog is a placeholder at the zero address.
 * The rewards of such a market read only what they can, and report no rate,
 * rather than reading the placeholder and failing every market of the request.
 */
t.test('the rewards of a market without a reward feed are read without one', async t => {
  const scroll = snapshot.networks.find(network => network.chainId === 534352)!.markets[0]!;
  t.equal(scroll.rewardAsset?.priceFeed ?? null, null, 'the fixture\'s Scroll market has no reward feed');
  const comet = catalog.marketAt(SCROLL, scroll.contracts.comet!)!.comet;

  const outcome = await marketRewards.compute({
    apiHost: '', nodeHost: '', nodeKey: '', contract: comet, network: SCROLL,
    block: { number: 3_500_000, timestamp: 1_700_000_000 } as never,
  } as never, undefined as never, 'marketRewards') as unknown as [ boolean, { body: [ Array<[ string, unknown ]>, (resolved: unknown) => any ] } ];
  t.equal(outcome[0], true, 'the computation resolves');
  const redex = outcome[1];

  const [ dependencies, summarize ] = redex.body;
  t.same(dependencies.map(([ name ]) => name), [ 'baseBorrowMin' ],
    'only the minimum borrow is read; no rewards APR, and no price from the placeholder');

  const summary = summarize([ [ 'baseBorrowMin', BigFixnum.from({ value: 100 }) ] ]);
  t.same(
    { earn: summary.earnRewardsApr, borrow: summary.borrowRewardsApr, price: summary.rewardAsset.price },
    { earn: '0', borrow: '0', price: '0.0' },
    'and the market reports no reward rate',
  );
});

/*
 * History reaches back past bulker upgrades. A market names the bulker it
 * uses now; a transaction sent through the one it used before is still a bulk
 * transaction.
 */
t.test('a bulker is recognized whether the market uses it now or used it before', async t => {
  const current = snapshot.networks.find(network => network.chainId === 1)!.markets
    .find(market => market.deploymentKey === 'usdc')!.contracts.bulker!;

  t.ok(isBulker(current, MAINNET, catalog), 'the bulker the market names');
  t.ok(isBulker('0x74a81F84268744a40FEBc48f8b812a1f188D80C3', MAINNET, catalog),
    'mainnet\'s first Bulker, which no market names any more, in any case');
  t.notOk(isBulker('0x1111111111111111111111111111111111111111', MAINNET, catalog), 'and nothing else');
  t.notOk(isBulker(null, MAINNET, catalog), 'a transaction with no recipient is not bulk');
});

/*
 * History names a token as the website does where the network renames it —
 * bridged USDC calls itself USDC on chain — but a token the website offers as
 * the chain's own token, WETH as ETH, is still what the transaction moved.
 */
t.test('history names a token by the name its network renames it to', async t => {
  const usdt = snapshot.networks.find(network => network.chainId === 1)!.markets
    .find(market => market.deploymentKey === 'usdt')!;
  const renamed = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      presentation: {
        ...network.presentation,
        assetDisplayOverrides: [ ...network.presentation.assetDisplayOverrides, {
          tokenAddress:   usdt.baseAsset.token.address,
          displayAddress: usdt.baseAsset.token.address,
          symbol:         'USDT0',
          name:           'Tether',
        } ],
      },
    }),
  });
  const WETH_TOKEN = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

  t.equal(tokenSymbol(renamed, MAINNET, usdt.baseAsset.token.address), 'USDT0', 'a renamed token by its new name');
  t.equal(tokenSymbol(renamed, MAINNET, USDT), 'USDT0', 'also where the event names it by its market');
  t.equal(tokenSymbol(renamed, MAINNET, WETH_TOKEN), 'WETH', 'a token offered as the native one keeps its own');
  t.equal(tokenSymbol(catalog, MAINNET, usdt.baseAsset.token.address), 'USDT', 'and without a rename, the token\'s own');
  t.equal(tokenSymbol(catalog, MAINNET, '0x1111111111111111111111111111111111111111'), '', 'an unknown token has none');
});

/*
 * The API wrote addresses out checksummed before the registry, and a client
 * comparing against them must keep matching. The registry stores them
 * lowercased, which is what every lookup keeps comparing.
 */
t.test('a materialized market carries checksummed addresses and is found by any case', async t => {
  const usdc = catalog.marketAt(MAINNET, USDC)!.comet;

  t.equal(usdc.address, '0xc3d688B66703497DAA19211EEdff47f25384cdc3', 'the Comet');
  t.equal(usdc.base.asset.address, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'its base token');
  t.match(usdc.base.priceFeed.address, /[A-F]/, 'and its feeds carry the checksum too');
  t.equal(catalog.marketAt(MAINNET, '0xC3D688B66703497DAA19211EEDFF47F25384CDC3' as never)?.comet, usdc,
    'a lookup does not care about case');
  t.match(usdc.key(), /^0xc3d688b66703497daa19211eedff47f25384cdc3@/, 'and the cache key keeps the stored form');
});

t.test('a materialized market keys its cached computations by its content', async t => {
  const usdc   = catalog.marketAt(MAINNET, USDC)!.comet;
  const digest = usdc.registry.digest;

  t.equal(usdc.key(), `${USDC}@${digest}`, 'the cache key is the address and the market digest');

  const reimported = catalogOf({
    ...snapshot,
    registryVersion: { ...snapshot.registryVersion, id: '00000000-0000-4000-8000-0000000000ff' },
  });
  t.equal(reimported.marketAt(MAINNET, USDC)!.comet.key(), usdc.key(),
    'a new version of the same market keeps every computation cached for it');

  const changed = catalogOf(withMarket('usdc', market => ({
    ...market,
    baseAsset: { ...market.baseAsset, priceFeed: { address: '0x3333333333333333333333333333333333333333', decimals: 8 } },
  })));
  t.not(changed.marketAt(MAINNET, USDC)!.comet.key(), usdc.key(),
    'while a changed feed retires them');

  /*
   * How the website lists a market is read by no computation, and daily
   * summaries reach back years: relabelling one must not throw them away.
   */
  const relisted = catalogOf(withMarket('usdc', market => ({
    ...market,
    displayName:     'USDC (main)',
    slug:            'usdc-main',
    isInstitutional: true,
    contractName:    'cUSDCv3-renamed',
    baseAsset:       { ...market.baseAsset, displayName: 'Circle USD' },
  })));
  t.equal(relisted.marketAt(MAINNET, USDC)!.comet.key(), usdc.key(), 'relabelling a market keeps its cached work');

  /*
   * Nor are the routes that serve a market, or why an exception was added and
   * until when it applies, read by any computation. What an exception does to
   * a price is, on whichever feed of the network a Comet reads at a block.
   */
  const recapped = catalogOf(withMarket('usdc', market => ({
    ...market,
    capabilities: { rewards: false, accountRewards: false, transactionHistory: false },
  })));
  t.equal(recapped.marketAt(MAINNET, USDC)!.comet.key(), usdc.key(), 'turning its capabilities off keeps its cached work');

  const excepted = (change: (exception: PriceExceptionV1) => PriceExceptionV1) => catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      priceExceptions: network.priceExceptions.map(change),
    }),
  }).marketAt(MAINNET, USDC)!.comet.key();
  t.equal(excepted(exception => ({ ...exception, provenance: 'reworded' })), usdc.key(),
    'and so does rewording why an exception was added');
  t.equal(excepted(exception => ({ ...exception, expiresAt: '2999-01-01T00:00:00.000Z' })), usdc.key(),
    'or giving it an expiry that has not passed');
  t.not(excepted(exception => exception.kind !== 'fixed_price' ? exception : { ...exception, price: { ...exception.price, value: '1' } }),
    usdc.key(), 'while the price an exception states retires it');
});

/*
 * History reads one network's markets and tokens, so its cache key is that
 * network's, not the whole version's: a change on another network, or to how
 * a market is listed, keeps every page computed so far.
 */
t.test('history is keyed by what its network says, not by the whole version', async t => {
  const onBase = catalogOf({
    ...snapshot,
    // a version whose content differs has another checksum
    registryVersion: { ...snapshot.registryVersion, checksum: 'f'.repeat(64) },
    networks: snapshot.networks.map(network => network.chainId !== 8453 ? network : {
      ...network,
      markets: network.markets.map(market => ({ ...market, creationBlock: market.creationBlock + 1 })),
    }),
  });
  t.not(onBase.key(), catalog.key(), 'the version as a whole changed');
  t.equal(onBase.historyKeyFor(MAINNET), catalog.historyKeyFor(MAINNET), 'but mainnet history keeps its key');
  t.not(onBase.historyKeyFor('base-mainnet'), catalog.historyKeyFor('base-mainnet'), 'and base history does not');

  const renamed = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      presentation: {
        ...network.presentation,
        assetDisplayOverrides: network.presentation.assetDisplayOverrides.map(override => (
          override.symbol === 'wstETH' ? { ...override, symbol: 'wstETH2' } : override
        )),
      },
    }),
  });
  t.not(renamed.historyKeyFor(MAINNET), catalog.historyKeyFor(MAINNET), 'a token the network renames is a change to its history');
});

/*
 * History reads the tokens an event names, the names the network renames
 * them to, and each market's contracts and creation block: nothing else a
 * version says about a market reaches an item. So a new feed, an exception or
 * a capability keeps every page computed so far — the raw items name their
 * contracts by address — while a symbol or a scale an amount is read at does
 * not.
 */
t.test('history is keyed by what it reads of a market, not by everything the market says', async t => {
  const onMainnet = (change: (market: MarketV1) => MarketV1, network: (network: NetworkV1) => NetworkV1 = same => same) => catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : network({
      ...entry,
      markets: entry.markets.map(change),
    })),
  });
  const usdcOnly = (change: (market: MarketV1) => MarketV1) => onMainnet(market => market.deploymentKey === 'usdc' ? change(market) : market);

  const refed     = usdcOnly(market => ({
    ...market,
    baseAsset: { ...market.baseAsset, priceFeed: { address: '0x3333333333333333333333333333333333333333', decimals: 8 } },
  }));
  const excepted  = onMainnet(market => market, network => ({
    ...network,
    priceExceptions: network.priceExceptions.map(exception => ({ ...exception, provenance: 'reworded' })),
  }));
  const recapped  = onMainnet(market => ({ ...market, capabilities: { ...market.capabilities, rewards: !market.capabilities.rewards } }));
  const relisted  = usdcOnly(market => ({ ...market, status: 'deprecated', displayName: 'USDC (old)' }));
  for (const [ changed, what ] of [
    [ refed, 'a feed' ], [ excepted, 'an exception' ], [ recapped, 'a capability' ], [ relisted, 'a status or a label' ],
  ] as const) {
    t.equal(changed.historyKeyFor(MAINNET), catalog.historyKeyFor(MAINNET), `changing ${what} keeps mainnet history`);
  }

  const resymboled = usdcOnly(market => ({
    ...market,
    baseAsset: { ...market.baseAsset, token: { ...market.baseAsset.token, symbol: 'USDC2' } },
  }));
  const rescaled = usdcOnly(market => ({
    ...market,
    collateralAssets: market.collateralAssets.map((asset, index) => index !== 0 ? asset : {
      ...asset,
      token: { ...asset.token, decimals: asset.token.decimals + 1 },
    }),
  }));
  const rebulked = usdcOnly(market => ({
    ...market,
    contracts: { ...market.contracts, bulker: '0x4444444444444444444444444444444444444444' },
  }));
  for (const [ changed, what ] of [
    [ resymboled, 'a token symbol' ], [ rescaled, 'a token scale' ], [ rebulked, 'a bulker' ],
  ] as const) {
    t.not(changed.historyKeyFor(MAINNET), catalog.historyKeyFor(MAINNET), `while changing ${what} is new history`);
  }

  const account = '0x1111111111111111111111111111111111111111';
  const rawKey  = async (lookup: Catalog) => {
    const usdc = lookup.marketAt(MAINNET, USDC)!.comet;
    return rawTransactionHistoryItems.key('rawTransactionHistoryItems', {
      apiHost: '', nodeHost: '', nodeKey: '', network: MAINNET, accountAddress: account, proxyAddresses: [],
      blockNumber: 19_000_000, marketContracts: [ usdc ], rewardsContract: usdc.rewards!.contract, catalog: lookup,
    });
  };
  t.not(refed.marketAt(MAINNET, USDC)!.comet.key(), catalog.marketAt(MAINNET, USDC)!.comet.key(),
    'a new feed is a new market to the computations that price it');
  t.equal(await rawKey(refed), await rawKey(catalog), 'but the same raw history');
  t.not(await rawKey(resymboled), await rawKey(catalog), 'unlike a new symbol');

  /*
   * An enriched item is kept under the history of its network too: what it
   * says of a market is what history reads, so it outlives a change to
   * anything else — in its own network, or in a version that changes another
   * network alone.
   */
  const item: RawTransactionHistoryItem = {
    network:         MAINNET,
    blockNumber:     19_000_000,
    transactionHash: `0x${'ab'.repeat(32)}`,
    actions:         [],
  };
  const enrichedKey = (lookup: Catalog) => enrichTransactionHistoryItem.key('enrichTransactionHistoryItem', {
    apiHost: '', nodeHost: '', nodeKey: '', network: MAINNET, accountAddress: account, item, catalog: lookup,
  });
  const elsewhere = catalogOf({
    ...snapshot,
    registryVersion: { ...snapshot.registryVersion, checksum: 'f'.repeat(64) },
    networks: snapshot.networks.map(network => network.chainId !== 8453 ? network : {
      ...network,
      markets: network.markets.map(market => ({ ...market, creationBlock: market.creationBlock + 1 })),
    }),
  });
  for (const [ changed, what ] of [
    [ refed, 'a feed' ], [ excepted, 'an exception' ], [ recapped, 'a capability' ], [ elsewhere, 'another network' ],
  ] as const) {
    t.equal(await enrichedKey(changed), await enrichedKey(catalog), `an enriched item outlives a change to ${what}`);
  }
  t.not(await enrichedKey(resymboled), await enrichedKey(catalog), 'but not a new symbol, which it shows');
});

/*
 * Governance decodes proposal targets against the contracts this API knows by
 * name. The protocol's own contracts stay static; markets come from the
 * version, so a proposal that configures a newly added market reads as
 * something rather than as a bare address.
 */
t.test('registry markets are merged into the contracts governance decodes against', async t => {
  const merged = withRegistryContracts(Eth.wellKnownContractsByNetwork, catalog.markets());

  const governor = lookupInWellKnown(
    { network: MAINNET, address: (Eth.wellKnownContractsByNetwork[MAINNET] as any)['GovernorBravo']['default'].address },
    merged,
  );
  t.ok(governor, 'the governors are untouched');

  const scrollMarket = lookupInWellKnown(
    { network: SCROLL, address: '0xb2f97c1bd3bf02f5e74d13f02e3e26f93d77ce44' },
    merged,
  );
  t.ok(scrollMarket, 'a market of another chain is resolvable, because a proposal can bridge to it');
  t.equal(scrollMarket, catalog.marketAt(SCROLL, '0xb2f97c1bd3bf02f5e74d13f02e3e26f93d77ce44')!.comet,
    'and it is the Comet the version materialized');

  t.equal(
    withRegistryContracts(Eth.wellKnownContractsByNetwork, []),
    Eth.wellKnownContractsByNetwork,
    'with nothing to merge the constants are passed through untouched',
  );

  /*
   * A market whose rewards contract pays no token merges no token for it: the
   * constants of Base name nothing at the zero address, and neither does the
   * merge.
   */
  const AERO          = '0x784efeb622244d2348d4f2522f8860b96fbece89';
  const unpaidMarkets = catalogOf(withMarket('aero', market => ({ ...market, rewardAsset: null })));
  const unpaid        = withRegistryContracts(Eth.wellKnownContractsByNetwork, unpaidMarkets.markets());
  t.equal(unpaid['base-mainnet']['0x0000000000000000000000000000000000000000'], undefined,
    'nothing stands in for the token a market does not pay');
  t.equal(unpaid['base-mainnet'][AERO], unpaidMarkets.marketAt('base-mainnet', AERO)!.comet,
    'while the market itself is merged');
});

/*
 * Governance describes a proposal against the constants, and again against
 * the registry only where the registry can say more: an action whose target
 * only the registry describes, a bridge whose inner actions may target one,
 * and a call to a contract that administers markets. A target neither knows
 * is left as it was.
 */
t.test('proposal actions are described again where the registry says more', async t => {
  const NEW_MAINNET = '0x3333333333333333333333333333333333333333';
  const NEW_BASE    = '0x2222222222222222222222222222222222222222';
  const NOBODY      = '0x4444444444444444444444444444444444444444';

  const withNew = (chainId: number, comet: string, contractName: string, deploymentKey: string) =>
    (network: typeof snapshot.networks[number]) => network.chainId !== chainId ? network : {
      ...network,
      markets: [ ...network.markets, {
        ...structuredClone(network.markets[0]!),
        id:            `00000000-0000-4000-8000-00000000${chainId.toString(16).padStart(4, '0')}`,
        deploymentKey,
        contractName,
        isDefault:     false,
        contracts:     { ...network.markets[0]!.contracts, comet: comet as never },
      } ],
    };
  const registry = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(withNew(1, NEW_MAINNET, 'cMAINv3', 'newmain')).map(withNew(8453, NEW_BASE, 'cNEWv3', 'newbase')),
  });

  const pause  = 'pause(bool,bool,bool,bool,bool)';
  const paused = defaultAbiCoder.encode([ 'bool', 'bool', 'bool', 'bool', 'bool' ], [ true, false, false, false, false ]);
  const messenger = (Eth.wellKnownContractsByNetwork[MAINNET] as any)['BaseL1CrossDomainMessenger']['default'].address;
  const receiver  = (Eth.wellKnownContractsByNetwork['base-mainnet'] as any)['BridgeReceiver']['default'].address;
  const bridged   = defaultAbiCoder.encode(
    [ 'address', 'bytes', 'uint32' ],
    [ receiver, defaultAbiCoder.encode([ 'address[]', 'uint256[]', 'string[]', 'bytes[]' ], [ [ NEW_BASE ], [ 0 ], [ pause ], [ paused ] ]), 0 ],
  );

  // each action as the constants alone describe it, which is what the proposal list computed
  const action = (target: string, signature: string, data: string) => {
    const described = describeContractCallForHumans(
      contractForLocation({ network: MAINNET, address: target as never }, Eth.wellKnownContractsByNetwork as never) as never,
      signature, data, BigFixnum.from({ value: 0 }), Eth.wellKnownContractsByNetwork as never,
    );
    return { target, signature, data, value: BigFixnum.from({ value: 0 }), title: described.title, subtitles: described.subtitles ?? [] };
  };
  /*
   * A market is usually configured through the Configurator, whose address is
   * static: the market it acts on is an argument of the call, and may be one
   * only the registry knows.
   */
  const configurator = (Object.values((Eth.wellKnownContractsByNetwork[MAINNET] as any)['Configurator'])[0] as { address: string }).address;
  const speed        = 'setBaseTrackingSupplySpeed(address,uint64)';
  const speedData    = defaultAbiCoder.encode([ 'address', 'uint64' ], [ NEW_MAINNET, 1000 ]);
  // its upgrade goes through the proxy admin, which the constants call CometAdmin, and its reward token through CometRewards
  const cometAdmin   = (Object.values((Eth.wellKnownContractsByNetwork[MAINNET] as any)['CometAdmin'])[0] as { address: string }).address;
  const cometRewards = (Object.values((Eth.wellKnownContractsByNetwork[MAINNET] as any)['CometRewards'])[0] as { address: string }).address;
  const comp         = (Eth.wellKnownContractsByNetwork[MAINNET] as any)['COMP']['default'].address;
  const upgrade      = defaultAbiCoder.encode([ 'address', 'address' ], [ configurator, NEW_MAINNET ]);
  const rewardConfig = defaultAbiCoder.encode([ 'address', 'address' ], [ NEW_MAINNET, comp ]);

  const proposals = [ { actions: [
    action(NEW_MAINNET, pause, paused),
    action(NOBODY, pause, paused),
    action(messenger, 'sendMessage(address,bytes,uint32)', bridged),
    action(configurator, speed, speedData),
    action(cometAdmin, 'deployAndUpgradeTo(address,address)', upgrade),
    action(cometRewards, 'setRewardConfig(address,address)', rewardConfig),
  ] } ] as never as Parameters<typeof describeRegistryTargets>[0];
  const [ onRegistry, onNobody, onBridge, onConfigurator, onCometAdmin, onCometRewards ] = (proposals[0] as any).actions;
  t.notMatch([ onConfigurator.title, ...onConfigurator.subtitles ].join(' '), /cMAINv3/,
    'which the constants alone cannot name');
  t.notMatch(onCometAdmin.title, /cMAINv3/, 'nor the market an upgrade deploys');
  t.notMatch(onCometRewards.title, /cMAINv3/, 'nor the market a reward token is set for');
  const before = { nobody: onNobody.title, bridge: onBridge.subtitles.join(' ') };
  t.match(onBridge.title, /^Bridge wrapped actions to Base/, 'the constants decode the bridge');
  t.notMatch(before.bridge, /cNEWv3/, 'but not the market it configures');

  let loads = 0;
  await describeRegistryTargets(proposals, MAINNET, {
    registry: { load: async () => { loads += 1; return registry; } } as never,
    debug:    undefined as never,
  });

  t.equal(loads, 1, 'the registry is read once');
  t.match(onRegistry.title, /cMAINv3/, 'a target only the registry describes is named by it');
  t.equal(onNobody.title, before.nobody, 'a target nobody describes is left as it was');
  t.match(onBridge.subtitles.join(' '), /cNEWv3/, 'and a bridged action names the market it configures on the other chain');
  t.match([ onConfigurator.title, ...onConfigurator.subtitles ].join(' '), /cMAINv3/,
    'and an action on the Configurator names the market it configures');
  t.match(onCometAdmin.title, /^Deploy and upgrade new implementation for \[cMAINv3\]/,
    'as an upgrade through the CometAdmin names the market it deploys');
  t.match(onCometRewards.title, /^Set reward token for market \[cMAINv3\]/,
    'and a reward token set through CometRewards the market it is set for');

  let unread = 0;
  const known = [ { actions: [ action(USDC, pause, paused) ] } ] as never as Parameters<typeof describeRegistryTargets>[0];
  await describeRegistryTargets(known, MAINNET, {
    registry: { load: async () => { unread += 1; return registry; } } as never,
    debug:    undefined as never,
  });
  t.equal(unread, 0, 'a proposal of known targets that bridges nothing never reads the registry');
});
