import t from 'tap';

import type { Address, NetworkV1, PriceFeedV1, TokenV1 } from '../../../lib/model/comet-registry.js';
import { isAddress, marketKey, parseMarketKey } from '../../../lib/model/comet-registry.js';

import { overlayDocuments } from '../../../src/registry/admin-router.js';
import { chainIdOf } from '../../../src/registry/handlers.js';
import type { MarketOverlay, NetworkOverlay } from '../../../src/registry/overlay.js';
import {
  applyMarketOverlay,
  applyNetworkOverlay,
  networkOverlayFeedAddresses,
  overlayFeedAddresses,
  parseMarketOverlay,
  parseNetworkOverlay,
} from '../../../src/registry/overlay.js';
import { failures, validateCandidate } from '../../../src/registry/validation.js';

import type { SeedBody } from '../../util/registry-seed.js';
import { readSeedComets, readSeedText } from '../../util/registry-seed.js';

/*
 * The seed is the body of `PUT …/overlays` that reviews an environment's
 * first draft. What the route would refuse, and what validation would fail,
 * is refused here, before anything is deployed, but for the size of the
 * body, which seed-overlays.test.ts holds by sending the file as it is; what
 * only the chain can refuse — a creation block, a feed's scale — is the
 * PUT's to check.
 */
const text   = readSeedText();
const seed   = JSON.parse(text) as SeedBody;
const comets = readSeedComets();

const networks = Object.entries(seed.networks).map(([ key, document ]) => ({ key, document, overlay: parseNetworkOverlay(document, `networks.${key}`) }));
const markets  = Object.entries(seed.markets).map(([ key, document ]) => ({ key, document, overlay: parseMarketOverlay(document, `markets.${key}`) }));

t.test('the file is a body the overlays route takes', async t => {
  // the route's own reading of a body: its keys, its reason, every key's spelling and how many documents it holds
  const documents = overlayDocuments(seed, 'seed', 'seed.test');
  t.equal(documents.reason, seed.reason, 'with a reason the route stores as it is written');
  t.equal(text, `${JSON.stringify(seed, null, 2)}\n`, 'written as JSON.stringify writes it, two spaces and a newline');

  // a scope that holds a review refuses the whole request, so the file is never sent over one
  t.same(Object.keys(seed.expectedDigests ?? {}), [ ...networks, ...markets ].map(({ key }) => key), 'expectedDigests names every document, in the file\'s order');
  t.ok(Object.values(seed.expectedDigests ?? {}).every(digest => digest === null), 'as one nobody has reviewed');
});

t.test('every document is in the form the registry stores it', async t => {
  // the order GET …/overlay answers in, so a document diffs line by line with what an environment holds
  for (const { key, document, overlay } of [ ...networks, ...markets ]) {
    t.equal(JSON.stringify(overlay), JSON.stringify(document), `${key} parses to itself, key and array order included`);
  }
});

/*
 * What the source and the chain state of a market, made up so that no check
 * fails on them: its Comet as the companion names it, a rewards contract and
 * the token it pays, no collateral, and every feed with eight decimals. What
 * validation then fails is a decision of the file. The reward token is what
 * keeps the checks of a market's rewards live: without one there is no
 * reward to price, and a reward feed would pass whatever it is quoted in.
 */
const REWARDS    = '0x00000000000000000000000000000000000000a1' as Address;
const BASE_FEED  = '0x00000000000000000000000000000000000000a2' as Address;
const BASE_TOKEN = '0x00000000000000000000000000000000000000a3' as Address;
const REWARD     = '0x00000000000000000000000000000000000000a4' as Address;

function token(address: Address): TokenV1 {
  return { address, symbol: 'TOKEN', name: 'Token', decimals: 18 };
}

// the networks a draft holds once the file has reviewed it, each market built as an import builds it
function candidateOf(
  documents: Array<{ key: string, overlay: NetworkOverlay }>,
  decided: Array<{ key: string, overlay: MarketOverlay }>,
): NetworkV1[] {
  return documents.map(({ key: chain, overlay: network }) => {
    const chainId = chainIdOf(chain);
    const own     = decided.filter(({ key }) => parseMarketKey(key)!.chainId === chain);
    const feeds   = new Map<Address, PriceFeedV1>([
      ...networkOverlayFeedAddresses(network),
      ...own.flatMap(({ overlay }) => overlayFeedAddresses(overlay)),
    ].map(address => [ address, { address, decimals: 8 } ]));
    const built = own.map(({ key, overlay }) => {
      const { deploymentKey } = parseMarketKey(key)!;
      return applyMarketOverlay(
        {
          rootPath:           `deployments/${chain}/${deploymentKey}/roots.json`,
          upstreamNetworkKey: chain,
          deploymentKey,
          network:            `chain-${chain}`,
          chainId,
          sourceBlobSha:      '0'.repeat(40),
          contracts:          { comet: comets[key] as Address, rewards: REWARDS },
          otherRoots:         {},
          checksum:           '0'.repeat(64),
        },
        { baseToken: token(BASE_TOKEN), basePriceFeed: { address: BASE_FEED, decimals: 8 }, rewardToken: token(REWARD), collateralAssets: [] },
        overlay,
        feeds,
        key,
      );
    });
    return applyNetworkOverlay({ chainId, key: `chain-${chain}`, upstreamKey: chain, testnet: false }, network, built, feeds);
  });
}

t.test('the decisions pass the checks validation makes of them', async t => {
  const chains = [ ...new Set(markets.map(({ key }) => parseMarketKey(key)!.chainId)) ];
  t.same(chains.sort(), networks.map(({ key }) => key).sort(), 'a network document for every chain of a market, and for no other');

  const candidate = candidateOf(networks, markets);
  t.same(
    candidate.flatMap(network => network.markets.map(market => marketKey(network.chainId, market.deploymentKey))).sort(),
    markets.map(({ key }) => key).sort(),
    'built from every market of the file',
  );
  t.same(failures(validateCandidate({ networks: candidate })), [], 'and failing none of validation\'s checks');

  // a decision the file gets wrong is one validation names, so the check above is one that can fail
  const failing = (decided: typeof markets) => failures(validateCandidate({ networks: candidateOf(networks, decided) }))
    .map(result => result.check_name);
  const changing = (key: string, decision: Partial<MarketOverlay>) => markets
    .map(entry => entry.key === key ? { ...entry, overlay: { ...entry.overlay, ...decision } } : entry);

  const other = markets.find(({ overlay }) => !overlay.isDefault && overlay.status === 'enabled')!.key;
  t.same(failing(changing(other, { isDefault: true })), [ 'single-default-market' ], `as ${other} made a second default would`);

  const rewarded = markets.find(({ overlay }) => overlay.collateralValueQuote === 'usd' && overlay.rewardPriceFeed !== null)!;
  t.same(
    failing(changing(rewarded.key, { rewardPriceFeed: { ...rewarded.overlay.rewardPriceFeed!, quote: 'base' } })),
    [ 'reward-feed-quote-supported' ],
    `as ${rewarded.key}, quoted in USD, with its reward feed quoted in its base asset would`,
  );

  // refused by the route when a document writes it, not by validation (admin.ts, refuseExpired)
  const now = Date.now();
  const expired = networks.flatMap(({ key, overlay }) => overlay.priceExceptions
    .filter(exception => exception.expiresAt !== null && Date.parse(exception.expiresAt) <= now)
    .map(exception => `${key} ${exception.priceFeedAddress}`));
  t.same(expired, [], 'no price exception has expired, which the route refuses');
});

t.test('the companion names the Comet of every market, and of no other', async t => {
  t.same(Object.keys(comets), markets.map(({ key }) => key), 'the same keys, in the same order');
  t.ok(Object.values(comets).every(address => isAddress(address) && address === address.toLowerCase()), 'each a lowercase address');
});
