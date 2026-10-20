import t from 'tap';

import { isAddress, marketKey, parseMarketKey } from '../../../lib/model/comet-registry.js';

import { chainIdOf } from '../../../src/registry/handlers.js';
import type { MarketOverlay } from '../../../src/registry/overlay.js';
import { parseMarketOverlay, parseNetworkOverlay } from '../../../src/registry/overlay.js';

import type { SeedBody } from '../../util/registry-seed.js';
import { readSeedComets, readSeedText } from '../../util/registry-seed.js';

/*
 * The seed is the body of `PUT …/overlays` that reviews an environment's
 * first draft. What the route would refuse, and what validation would fail,
 * is refused here, before anything is deployed; what only the chain can
 * refuse — a creation block, a feed's scale — is the PUT's to check.
 */
const text   = readSeedText();
const seed   = JSON.parse(text) as SeedBody;
const comets = readSeedComets();

const networks = Object.entries(seed.networks).map(([ key, document ]) => ({ key, document, overlay: parseNetworkOverlay(document, `networks.${key}`) }));
const markets  = Object.entries(seed.markets).map(([ key, document ]) => ({ key, document, overlay: parseMarketOverlay(document, `markets.${key}`) }));

// what the route takes (admin-router.ts): a reason, the documents of one request and its body
const MAX_REASON    = 1000;
const MAX_DOCUMENTS = 100;
const MAX_BYTES     = 512 * 1024;

t.test('the file is a body the overlays route takes', async t => {
  t.same(Object.keys(seed).sort(), [ 'expectedDigests', 'markets', 'networks', 'reason' ], 'and nothing else');
  t.ok(seed.reason.length > 0 && seed.reason.length <= MAX_REASON && seed.reason === seed.reason.trim(),
    'with a reason the route stores as it is written');
  t.ok(networks.length + markets.length <= MAX_DOCUMENTS, `at most ${MAX_DOCUMENTS} documents`);
  t.ok(Buffer.byteLength(text) <= MAX_BYTES, 'in at most 512 KiB');
  t.equal(text, `${JSON.stringify(seed, null, 2)}\n`, 'written as JSON.stringify writes it, two spaces and a newline');

  for (const { key } of networks) {
    t.equal(String(chainIdOf(key)), key, `network ${key} is keyed as a path spells its chain id`);
  }
  for (const { key } of markets) {
    const market = parseMarketKey(key);
    t.ok(market !== null && marketKey(chainIdOf(market.chainId), market.deploymentKey) === key, `${key} is keyed as chainId/deploymentKey`);
  }

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

t.test('the decisions pass the checks validation makes of them', async t => {
  const chains = [ ...new Set(markets.map(({ key }) => parseMarketKey(key)!.chainId)) ];
  t.same(chains.sort(), networks.map(({ key }) => key).sort(), 'a network document for every chain of a market, and for no other');

  const defaults = markets.filter(({ overlay }) => overlay.isDefault);
  t.equal(defaults.length, 1, `one default market: ${defaults.map(({ key }) => key).join(', ')}`);
  t.equal(defaults[0]?.overlay.status, 'enabled', 'which is enabled');

  // validation counts a market served by its status alone
  const served = markets.filter(({ overlay }) => overlay.status !== 'disabled');
  for (const { key: chain } of networks) {
    const listed = served
      .filter(({ key }) => parseMarketKey(key)!.chainId === chain)
      .map(({ overlay }) => (overlay.slug ?? overlay.displayName).toLowerCase());
    t.equal(new Set(listed).size, listed.length, `the markets of ${chain} answer to distinct slugs or labels`);
  }

  const holds = (name: string, rule: (overlay: MarketOverlay) => boolean) => {
    t.same(markets.filter(({ overlay }) => !rule(overlay)).map(({ key }) => key), [], name);
  };
  holds('a served market states its creation block', overlay => overlay.status === 'disabled' || overlay.creationBlock > 0);
  holds('quoted in the base asset exactly where a USD feed converts it',
    overlay => (overlay.collateralValueQuote === 'base') === (overlay.baseAsset.usdPriceFeedAddress !== null));
  holds('a reward feed quoted in the base asset only on a market quoted in it',
    overlay => overlay.rewardPriceFeed?.quote !== 'base' || overlay.collateralValueQuote === 'base');
  holds('rewards only with a feed to price them', overlay => !overlay.capabilities.rewards || overlay.rewardPriceFeed !== null);

  const now = Date.now();
  const expired = networks.flatMap(({ key, overlay }) => overlay.priceExceptions
    .filter(exception => exception.expiresAt !== null && Date.parse(exception.expiresAt) <= now)
    .map(exception => `${key} ${exception.priceFeedAddress}`));
  t.same(expired, [], 'no price exception has expired, which the route refuses');
});

t.test('the companion names the Comet of every market, and of no other', async t => {
  t.same(Object.keys(comets), markets.map(({ key }) => key), 'the same keys, in the same order');
  t.ok(Object.values(comets).every(address => isAddress(address) && address === address.toLowerCase()), 'each a lowercase address');
  // validation holds Comets unique per network: 0x9c4e… is cUSDbCv3 on Base and cUSDCv3 on Arbitrum
  for (const { key: chain } of networks) {
    const held = Object.entries(comets).filter(([ key ]) => parseMarketKey(key)!.chainId === chain).map(([ , address ]) => address);
    t.equal(new Set(held).size, held.length, `no two markets of ${chain} share a Comet`);
  }
});
