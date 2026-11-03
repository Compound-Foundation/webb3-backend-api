import t from 'tap';

import type { MarketV1, NetworkV1 } from '../../../lib/model/comet-registry.js';
import { failures, hasFailures, validateCandidate } from '../../../src/registry/validation.js';
import type { CandidateInput } from '../../../src/registry/validation.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * Candidate validation against the frozen RegistrySnapshotV1 fixture: it must
 * pass unchanged, and each mutation of it must fail the one check that covers
 * that mistake. A check that cannot be made to fail is not protecting
 * anything, so every case names the check it expects.
 */
const snapshot = loadRegistrySnapshotFixture();

function failingChecks(mutate: (networks: NetworkV1[]) => void, input: Omit<CandidateInput, 'networks'> = {}): string[] {
  const networks = structuredClone(snapshot.networks) as NetworkV1[];
  mutate(networks);
  return [ ...new Set(failures(validateCandidate({ ...input, networks })).map(result => result.check_name)) ].sort();
}

function mainnetMarket(networks: NetworkV1[], deploymentKey: string): MarketV1 {
  return networks.find(network => network.chainId === 1)!.markets.find(market => market.deploymentKey === deploymentKey)!;
}

t.test('the frozen fixture passes every check', async t => {
  const networks = snapshot.networks as NetworkV1[];
  const results  = validateCandidate({ networks });

  t.equal(hasFailures(results), false, 'a reviewed candidate validates');
  t.ok(results.length > 50, `every market and network is checked (${results.length} checks)`);
  t.same(failures(results), [], 'with no diagnostics');

  const scopes = new Set(results.map(result => result.scope));
  t.ok(scopes.has('global'), 'checks are scoped globally,');
  t.ok(scopes.has('network:1'), 'per network,');
  t.ok(scopes.has('market:1/usdc'), 'and per market');
});

t.test('a market whose parts disagree is rejected', async t => {
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'weth').baseAsset.usdPriceFeed = null; }),
    [ 'base-usd-feed-matches-quote' ],
    'a base-quoted market without its USD conversion feed',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdc').baseAsset.usdPriceFeed = { address: '0x'.padEnd(42, 'a') as `0x${string}`, decimals: 8 }; }),
    [ 'base-usd-feed-matches-quote' ],
    'a USD-quoted market carrying one',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'weth').rewardAsset!.priceFeedQuote = null; }),
    [ 'reward-feed-paired' ],
    'a reward feed without its unit',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdc').rewardAsset!.priceFeedQuote = 'base'; }),
    [ 'reward-feed-quote-supported' ],
    'a base-quoted reward feed in a USD-quoted market',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.rewardAsset!.priceFeed = null;
      market.rewardAsset!.priceFeedQuote = null;
    }),
    [ 'rewards-capability-has-feed' ],
    'rewards enabled without a feed to price them',
  );
});

/*
 * History is read from one range of logs covering the market and the rewards
 * contract its claims come from. A market whose history is served without
 * naming that contract would be addressable and answer nothing. The
 * capability is a review, made after the import, so this is checked over the
 * stored rows rather than at import time, where it could never fail: an
 * unreviewed market serves no history yet.
 */
t.test('history is served only by a market that names its rewards contract', async t => {
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.contracts    = { ...market.contracts, rewards: null };
      market.capabilities = { ...market.capabilities, rewards: false, accountRewards: false };
    }),
    [ 'transaction-history-requires-rewards-contract' ],
    'transaction history without the rewards contract it is read with',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.contracts    = { ...market.contracts, rewards: null };
      market.capabilities = { rewards: false, transactionHistory: false, accountRewards: false };
    }),
    [],
    'while a market that serves no history, and no rewards, needs no rewards contract',
  );
});

/*
 * The token a market pays is read through its rewards contract, which is the
 * only place the catalog finds it, so a market whose rewards are served names
 * that contract even where it serves nothing else of them. No import writes
 * one that does not; the check is that no version is served so.
 */
t.test('rewards are served only by a market that names its rewards contract', async t => {
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.contracts    = { ...market.contracts, rewards: null };
      market.capabilities = { rewards: true, transactionHistory: false, accountRewards: false };
    }),
    [ 'rewards-capability-has-contract' ],
    'rewards without the contract the token they pay is read through',
  );
});

/*
 * What an account is owed is read from the rewards contract, in the token it
 * pays. A market's contracts carry only what it has — nothing stands in for a
 * token its rewards contract does not pay — so a market whose account
 * rewards are served must have both.
 */
t.test('account rewards are served only by a market that pays a token, through its rewards contract', async t => {
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.rewardAsset  = null;
      market.capabilities = { ...market.capabilities, rewards: false };
    }),
    [ 'account-rewards-have-token' ],
    'account rewards of a market whose rewards contract pays no token',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.contracts    = { ...market.contracts, rewards: null };
      market.capabilities = { ...market.capabilities, rewards: false, transactionHistory: false };
    }),
    [ 'account-rewards-have-token' ],
    'or of one without a rewards contract at all',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.rewardAsset  = null;
      market.capabilities = { ...market.capabilities, rewards: false, accountRewards: false };
    }),
    [],
    'while a market that serves none needs neither',
  );
});

/*
 * A network that serves a market is offered under its name and presentation,
 * which someone has to have decided. A chain the source has just added
 * arrives with nothing about it reviewed and every market disabled: it serves
 * nothing, is not listed, and does not hold the rest of the version back.
 */
t.test('a network that serves a market has been reviewed', async t => {
  const scroll = (networks: NetworkV1[]) => networks.find(network => network.chainId === 534352)!;

  t.same(
    failingChecks(() => {}, { unreviewedNetworks: [ 534352 ] }),
    [ 'served-network-reviewed' ],
    'a network nobody reviewed that serves a market',
  );
  t.same(
    failingChecks(networks => {
      for (const market of scroll(networks).markets) {
        market.status = 'deprecated';
      }
    }, { unreviewedNetworks: [ 534352 ] }),
    [ 'served-network-reviewed' ],
    'a deprecated market is served too',
  );
  t.same(
    failingChecks(networks => {
      for (const market of scroll(networks).markets) {
        market.status       = 'disabled';
        market.capabilities = { rewards: false, accountRewards: false, transactionHistory: false };
      }
    }, { unreviewedNetworks: [ 534352 ] }),
    [],
    'while a network whose every market is disabled needs no decision yet',
  );
});

t.test('malformed collateral is rejected', async t => {
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdc').collateralAssets.splice(0, 1); }),
    [ 'collateral-indices-contiguous' ],
    'a gap in the asset indices',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.collateralAssets[1]!.token = market.collateralAssets[0]!.token;
    }),
    [ 'collateral-assets-distinct' ],
    'the same collateral token twice',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.collateralAssets[0]!.token = market.baseAsset.token;
    }),
    [ 'collateral-excludes-base-asset' ],
    'the base asset listed as its own collateral',
  );
});

t.test('registry-wide invariants are enforced', async t => {
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'weth').isDefault = true; }),
    [ 'single-default-market' ],
    'two default markets',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdc').isDefault = false; }),
    [ 'single-default-market' ],
    'no default market at all',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.status = 'deprecated';
    }),
    [ 'default-market-is-enabled' ],
    'a deprecated market as the default',
  );
  /*
   * The frontend addresses a market by its slug, or by its label where it has
   * none. Two listed markets of one network answering to the same key would
   * make the second unreachable.
   */
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdt').displayName = 'usdc'; }),
    [ 'market-listing-keys-unique' ],
    'two markets of one network under one label, compared as the frontend does, ignoring case',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdt').slug = 'usdc'; }),
    [ 'market-listing-keys-unique' ],
    'or a slug that is another market\'s label',
  );
  t.same(
    failingChecks(networks => {
      const institutional = mainnetMarket(networks, 'usdt');
      institutional.displayName     = 'USDC';
      institutional.slug            = 'usdc-institutional';
      institutional.isInstitutional = true;
    }),
    [],
    'a shared label is fine where a slug tells the markets apart',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdt');
      market.displayName = 'USDC';
      market.status      = 'disabled';
    }),
    [],
    'and a disabled market is not listed, so it takes no key',
  );
  t.same(
    failingChecks(networks => {
      const mainnet = networks.find(network => network.chainId === 1)!;
      mainnet.markets[1]!.contracts.comet = mainnet.markets[0]!.contracts.comet;
    }),
    [ 'comet-addresses-unique' ],
    'one Comet address serving two markets',
  );
  t.same(
    failingChecks(networks => {
      networks.find(network => network.chainId === 1)!.markets.length = 0;
    }),
    [ 'single-default-market', 'network-has-markets' ].sort(),
    'a network with no markets',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdc').creationBlock = 0; }),
    [ 'creation-block-known' ],
    'a served market with no creation block',
  );
  /*
   * A market nobody has reviewed is imported disabled, and the chain cannot
   * cheaply say when it was deployed. It is not served, so nothing starts an
   * index from it, and it must not fail the commit it arrived with.
   */
  t.same(
    failingChecks(networks => {
      const weth = mainnetMarket(networks, 'weth');
      weth.creationBlock = 0;
      weth.status        = 'disabled';
    }),
    [],
    'while a disabled market may leave it unknown',
  );
});

/*
 * The roots a run checkpointed are matched with the markets the candidate
 * holds, by network and deployment key. A count would say what the run
 * finished; only the rows say what the candidate is, and a candidate holding
 * as many markets as the run expected can still be missing one of them.
 */
t.test('an incomplete import cannot validate', async t => {
  const networks = snapshot.networks as NetworkV1[];
  const roots    = networks.flatMap(network => network.markets.map(market => ({
    upstreamNetworkKey: network.upstreamKey,
    deploymentKey:      market.deploymentKey,
  })));
  t.same(
    failures(validateCandidate({ networks, roots })),
    [],
    'a candidate holding every checkpointed root passes',
  );

  const incomplete = failures(validateCandidate({
    networks,
    roots: [ ...roots, { upstreamNetworkKey: 'mainnet', deploymentKey: 'usds' } ],
  }));
  t.same(incomplete.map(result => result.check_name), [ 'all-roots-imported' ], 'a missing market fails the candidate');
  t.same(
    incomplete[0]!.details,
    { expected: roots.length + 1, imported: roots.length, missing: [ 'mainnet/usds' ] },
    'and the diagnostic names the roots that never made it',
  );

  const swapped = failures(validateCandidate({
    networks,
    roots: roots.map(root => root.deploymentKey === 'weth' ? { ...root, deploymentKey: 'wsteth' } : root),
  }));
  t.same(
    swapped.map(result => result.details),
    [ { expected: roots.length, imported: roots.length - 1, missing: [ 'mainnet/wsteth' ] } ],
    'as many markets as roots is not enough: they have to be the markets the roots name',
  );
});

t.test('failures carry diagnostics, passes stay compact', async t => {
  const networks = structuredClone(snapshot.networks) as NetworkV1[];
  mainnetMarket(networks, 'weth').baseAsset.usdPriceFeed = null;

  const failed = failures(validateCandidate({ networks }));
  t.equal(failed.length, 1);
  t.equal(failed[0]!.scope, 'market:1/weth', 'the scope names the market that failed');
  t.same(failed[0]!.details, {
    collateralValueQuote: 'base',
    usdPriceFeed:         null,
  }, 'diagnostics explain the mismatch without dumping the snapshot');

  const passing = validateCandidate({ networks: snapshot.networks as NetworkV1[] });
  t.ok(passing.every(result => result.details === undefined), 'a passing check stores no details');
});
