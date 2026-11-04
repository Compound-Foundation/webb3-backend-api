import t from 'tap';

import type { Address, PriceFeedV1 } from '../../../lib/model/comet-registry.js';

import {
  applyNetworkOverlay,
  networkDecisions,
  overlayDigest,
  overlayOfException,
  parseMarketOverlay,
  parseNetworkOverlay,
} from '../../../src/registry/overlay.js';
import { isRegistryError } from '../../../src/registry/errors.js';
import { priceExceptionOfRow } from '../../../src/registry/repository.js';

/*
 * Overlay documents are complete replacements with exact key sets: a missing
 * key is a missing decision and an unknown key is a mistake, so both are
 * rejected rather than defaulted. Parsing also normalizes, which is what lets
 * an identical overlay produce an identical digest.
 */
const ADDRESS   = '0xC3d688B66703497DAA19211EEdff47f25384cdc3';
const FEED      = '0x8fFfFfd4AFB6115b954Bd326cbe7B4BA576818f6';
const USD_FEED  = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const OTHER     = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const marketOverlay = {
  displayName:          'USDC',
  contractName:         'cUSDCv3',
  slug:                 null,
  isInstitutional:      false,
  isDefault:            true,
  status:               'enabled',
  creationBlock:        15331586,
  collateralValueQuote: 'usd',
  capabilities:         { rewards: true, accountRewards: true, transactionHistory: true },
  baseAsset:            { displayName: 'USD Coin', isWrappedNative: false, usdPriceFeedAddress: null },
  rewardPriceFeed:      { address: FEED, quote: 'usd' },
};

const networkOverlay = {
  displayName:           'Ethereum',
  assetDisplayOverrides: [
    { tokenAddress: OTHER, displayAddress: OTHER, symbol: 'USDC', name: 'USD Coin' },
    { tokenAddress: ADDRESS, displayAddress: ADDRESS, symbol: 'cUSDCv3', name: 'Compound USDC' },
  ],
  unwrappedCollateralAssets: [],
  priceExceptions: [
    { kind: 'zero_price', priceFeedAddress: FEED, provenance: 'feed reverts', expiresAt: null },
    {
      kind:             'fixed_price',
      priceFeedAddress: ADDRESS,
      price:            { value: '102447384', decimals: 8 },
      provenance:       'last answer of a retired aggregator',
      expiresAt:        '2027-01-01T00:00:00.000Z',
    },
  ],
};

function rejects(operation: () => unknown, message: RegExp, name: string): void {
  try {
    operation();
  } catch (error) {
    if (!isRegistryError(error)) {
      throw error;
    }
    t.equal(error.code, 'OVERLAY_INVALID', `${name} is rejected`);
    t.match(error.message, message, `${name} explains why`);
    return;
  }
  throw new Error(`expected ${name} to be rejected`);
}

t.test('a market overlay states every reviewed decision', async t => {
  const parsed = parseMarketOverlay(marketOverlay);
  t.equal(parsed.displayName, 'USDC');
  t.equal(parsed.rewardPriceFeed?.address, FEED.toLowerCase(), 'feed addresses are normalized lowercase');

  const usdQuoted = parseMarketOverlay({
    ...marketOverlay,
    collateralValueQuote: 'base',
    baseAsset: { displayName: 'Ether', isWrappedNative: true, usdPriceFeedAddress: USD_FEED },
    rewardPriceFeed: { address: FEED, quote: 'base' },
  });
  t.equal(usdQuoted.baseAsset.usdPriceFeedAddress, USD_FEED.toLowerCase(), 'a base-quoted market names its USD feed');

  const withoutRewards = parseMarketOverlay({ ...marketOverlay, rewardPriceFeed: null });
  t.equal(withoutRewards.rewardPriceFeed, null, 'a market may have no reward feed');

  const { displayName: _omitted, ...missing } = marketOverlay;
  rejects(() => parseMarketOverlay(missing), /missing: displayName/, 'a missing decision');
  rejects(() => parseMarketOverlay({ ...marketOverlay, sortOrder: 3 }), /unexpected keys: sortOrder/, 'an unknown key');
  rejects(() => parseMarketOverlay({ ...marketOverlay, status: 'paused' }), /must be one of/, 'an unknown status');
  rejects(() => parseMarketOverlay({ ...marketOverlay, collateralValueQuote: 'eth' }), /must be one of/, 'an unknown quote');
  rejects(() => parseMarketOverlay({ ...marketOverlay, creationBlock: -1 }), /non-negative block/, 'a negative block');
  rejects(() => parseMarketOverlay({ ...marketOverlay, creationBlock: 1.5 }), /non-negative block/, 'a fractional block');
  rejects(() => parseMarketOverlay({ ...marketOverlay, isDefault: 'yes' }), /must be a boolean/, 'a non-boolean default');
  rejects(() => parseMarketOverlay({ ...marketOverlay, displayName: '   ' }), /non-empty string/, 'a blank label');
  rejects(
    () => parseMarketOverlay({ ...marketOverlay, capabilities: { rewards: true, accountRewards: true } }),
    /missing: transactionHistory/,
    'a partial capability set',
  );
  rejects(
    () => parseMarketOverlay({ ...marketOverlay, rewardPriceFeed: { address: FEED, quote: 'gbp' } }),
    /must be one of/,
    'an unknown reward feed unit',
  );
  rejects(
    () => parseMarketOverlay({ ...marketOverlay, baseAsset: { displayName: 'USD Coin', isWrappedNative: false, usdPriceFeedAddress: '0x1234' } }),
    /must be an address/,
    'a malformed USD feed',
  );
  rejects(() => parseMarketOverlay(null), /must be an object/, 'a null overlay');
  rejects(() => parseMarketOverlay([ marketOverlay ]), /must be an object/, 'an array');
});

t.test('a network overlay is normalized and duplicate-free', async t => {
  const parsed = parseNetworkOverlay(networkOverlay);
  t.same(
    parsed.assetDisplayOverrides.map(override => override.tokenAddress),
    [ OTHER, ADDRESS.toLowerCase() ].sort(),
    'display overrides are sorted by token address',
  );
  t.same(
    parsed.priceExceptions.map(exception => exception.priceFeedAddress),
    [ ADDRESS.toLowerCase(), FEED.toLowerCase() ].sort(),
    'price exceptions are sorted by feed address',
  );
  t.same(
    parsed.priceExceptions.map(exception => exception.kind),
    [ 'zero_price', 'fixed_price' ],
    'each exception keeps its kind through sorting',
  );

  const remap = parseNetworkOverlay({
    ...networkOverlay,
    priceExceptions: [
      { kind: 'deprecated_price_remap', priceFeedAddress: FEED, replacementPriceFeedAddress: USD_FEED, provenance: 'governance replaced it', expiresAt: null },
    ],
  });
  t.same(remap.priceExceptions, [ {
    kind:                        'deprecated_price_remap',
    priceFeedAddress:            FEED.toLowerCase(),
    replacementPriceFeedAddress: USD_FEED.toLowerCase(),
    provenance:                  'governance replaced it',
    expiresAt:                   null,
  } ], 'a remap names the feed to read instead, and no scale: enrichment reads that from the feed');

  /*
   * The wire shape carries the replacement feed with its decimals, so it is
   * assembled once they are read, and not before: there is nothing standing
   * in for a scale nobody read.
   */
  const identity = { chainId: 1, key: 'ethereum-mainnet', upstreamKey: 'mainnet', testnet: false };
  const replacement = USD_FEED.toLowerCase() as Address;
  const read = new Map<Address, PriceFeedV1>([ [ replacement, { address: replacement, decimals: 8 } ] ]);
  t.same(applyNetworkOverlay(identity, remap, [], read).priceExceptions, [ {
    kind:                 'deprecated_price_remap',
    priceFeedAddress:     FEED.toLowerCase(),
    replacementPriceFeed: { address: replacement, decimals: 8 },
    provenance:           'governance replaced it',
    expiresAt:            null,
  } ], 'the network carries the replacement feed with the decimals the chain answered');
  t.throws(
    () => applyNetworkOverlay(identity, remap, [], new Map()),
    { code: 'OVERLAY_FEED_UNREADABLE' },
    'and a network whose replacement feed was not read is not assembled at all',
  );

  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [
        { kind: 'zero_price', priceFeedAddress: FEED, provenance: 'one', expiresAt: null },
        { kind: 'zero_price', priceFeedAddress: FEED, provenance: 'two', expiresAt: null },
      ],
    }),
    /same address twice/,
    'two exceptions for one feed',
  );
  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [ { kind: 'fixed_price', priceFeedAddress: FEED, price: { value: '1.5', decimals: 8 }, provenance: 'x', expiresAt: null } ],
    }),
    /decimal string/,
    'a fractional fixed price',
  );
  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [ { kind: 'fixed_price', priceFeedAddress: FEED, provenance: 'x', expiresAt: null } ],
    }),
    /missing: price/,
    'a fixed price without a price',
  );
  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [ { kind: 'zero_price', priceFeedAddress: FEED, price: { value: '1', decimals: 8 }, provenance: 'x', expiresAt: null } ],
    }),
    /unexpected keys: price/,
    'a zero price with a price',
  );
  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [ { kind: 'deprecated_price_remap', priceFeedAddress: FEED, replacementPriceFeedAddress: FEED, provenance: 'x', expiresAt: null } ],
    }),
    /remaps a feed onto itself/,
    'a self remap',
  );
  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [ { kind: 'zero_price', priceFeedAddress: FEED, provenance: 'x', expiresAt: 'soon' } ],
    }),
    /RFC 3339/,
    'a malformed expiry',
  );
  rejects(
    () => parseNetworkOverlay({ ...networkOverlay, unwrappedCollateralAssets: {} }),
    /must be an array/,
    'a non-array pair list',
  );
});

/*
 * A price exception is one decision held in three shapes: the document an
 * overlay states it in, the wire shape a network serves it in — where a remap
 * carries the decimals read for the feed it reads instead — and the row a
 * version stores. An import and an overlay write both turn the document into
 * the wire shape through networkDecisions, every reader of a row reads the
 * wire shape back through priceExceptionOfRow, and the decision that shape
 * states is the document again.
 */
t.test('a price exception is one decision in every shape it is held in', async t => {
  const replacement = USD_FEED.toLowerCase() as Address;
  const feeds       = new Map<Address, PriceFeedV1>([ [ replacement, { address: replacement, decimals: 8 } ] ]);
  const overlay     = parseNetworkOverlay({
    ...networkOverlay,
    priceExceptions: [
      ...networkOverlay.priceExceptions,
      { kind: 'deprecated_price_remap', priceFeedAddress: OTHER, replacementPriceFeedAddress: USD_FEED, provenance: 'governance replaced it', expiresAt: null },
    ],
  });

  const served = [
    { kind: 'zero_price', priceFeedAddress: FEED.toLowerCase(), provenance: 'feed reverts', expiresAt: null },
    {
      kind:                 'deprecated_price_remap',
      priceFeedAddress:     OTHER,
      replacementPriceFeed: { address: replacement, decimals: 8 },
      provenance:           'governance replaced it',
      expiresAt:            null,
    },
    {
      kind:             'fixed_price',
      priceFeedAddress: ADDRESS.toLowerCase(),
      price:            { value: '102447384', decimals: 8 },
      provenance:       'last answer of a retired aggregator',
      expiresAt:        '2027-01-01T00:00:00.000Z',
    },
  ];
  const decisions = networkDecisions(overlay, feeds, 'ethereum-mainnet');
  t.same(decisions, {
    displayName:  'Ethereum',
    presentation: { assetDisplayOverrides: overlay.assetDisplayOverrides, unwrappedCollateralAssets: overlay.unwrappedCollateralAssets },
    priceExceptions: served,
  }, 'a remap carries the decimals read for its replacement, and every other decision is served as it is stated');
  t.throws(
    () => networkDecisions(overlay, new Map(), 'ethereum-mainnet'),
    { code: 'OVERLAY_FEED_UNREADABLE' },
    'and a remap whose replacement was not read is not decided at all',
  );

  const identity = { chainId: 1, key: 'ethereum-mainnet', upstreamKey: 'mainnet', testnet: false };
  t.equal(
    JSON.stringify(applyNetworkOverlay(identity, overlay, [], feeds)),
    JSON.stringify({
      chainId:         1,
      key:             'ethereum-mainnet',
      upstreamKey:     'mainnet',
      displayName:     decisions.displayName,
      testnet:         false,
      presentation:    decisions.presentation,
      priceExceptions: decisions.priceExceptions,
      markets:         [],
    }),
    'a network an import builds is those decisions, keyed in the order the wire contract writes them',
  );
  t.same(decisions.priceExceptions.map(overlayOfException), overlay.priceExceptions, 'and each states the decision it was built from');

  // the rows a version stores for them, as every reader selects them
  type ExceptionRow = Parameters<typeof priceExceptionOfRow>[0];
  const row = (columns: Partial<ExceptionRow>): ExceptionRow => ({
    id:                              1,
    registry_version_id:             'version',
    network_id:                      'network',
    price_feed_address:              FEED.toLowerCase() as Address,
    kind:                            'zero_price',
    fixed_price_value:               null,
    fixed_price_decimals:            null,
    replacement_price_feed_address:  null,
    replacement_price_feed_decimals: null,
    provenance:                      'feed reverts',
    expires_at:                      null,
    ...columns,
  });
  const rows = [
    row({}),
    row({
      price_feed_address:              OTHER as Address,
      kind:                            'deprecated_price_remap',
      replacement_price_feed_address:  replacement,
      replacement_price_feed_decimals: 8,
      provenance:                      'governance replaced it',
    }),
    row({
      price_feed_address:   ADDRESS.toLowerCase() as Address,
      kind:                 'fixed_price',
      fixed_price_value:    '102447384',
      fixed_price_decimals: 8,
      provenance:           'last answer of a retired aggregator',
      expires_at:           '2027-01-01T00:00:00.000Z',
    }),
  ];
  t.same(
    rows.map(priceExceptionOfRow).map(exception => JSON.stringify(exception)),
    served.map(exception => JSON.stringify(exception)),
    'a stored row reads back as the exception the network serves, keyed in the order the wire contract writes it',
  );
  t.same(
    parseNetworkOverlay({ ...overlay, priceExceptions: rows.map(priceExceptionOfRow).map(overlayOfException) }),
    overlay,
    'which states the decision the row was written from',
  );
});

/*
 * An expiry decides when a live feed is read again, so it has to name one
 * moment wherever it is read. Date.parse takes far more than that — "1" is the
 * year 2001, and a time without an offset is local time in Node and UTC in a
 * Worker — so only an RFC 3339 instant is accepted, and it is stored as the
 * UTC instant it names.
 */
t.test('an expiry is an instant with its offset, stored in UTC', async t => {
  const expiring = (expiresAt: unknown) => parseNetworkOverlay({
    ...networkOverlay,
    priceExceptions: [ { kind: 'zero_price', priceFeedAddress: FEED, provenance: 'feed reverts', expiresAt } ],
  });

  t.equal(expiring('2027-01-01T00:00:00Z').priceExceptions[0]!.expiresAt, '2027-01-01T00:00:00.000Z');
  t.equal(
    expiring('2026-09-21T13:00:00+02:00').priceExceptions[0]!.expiresAt,
    '2026-09-21T11:00:00.000Z',
    'an offset is applied, so the stored value is the moment itself',
  );
  t.equal(expiring('2026-09-21t11:00:00.5z').priceExceptions[0]!.expiresAt, '2026-09-21T11:00:00.500Z',
    'in either case, with fractions of a second');
  t.equal(expiring(null).priceExceptions[0]!.expiresAt, null, 'and an exception may not expire at all');

  for (const [ value, what ] of [
    [ '1',                      'a number Date.parse reads as a year' ],
    [ '2026',                   'a year' ],
    [ 'Sep 21 2026',            'a date in words' ],
    [ '2026-09-21',             'a date without a time' ],
    [ '2026-09-21T12:00:00',    'a time without an offset' ],
    [ '2026-02-30T00:00:00Z',   'a day the month does not have' ],
    [ '2026-09-21T24:00:00Z',   'an hour past the last' ],
    [ '2026-09-21T12:00:00+24:00', 'an offset past a day' ],
    [ 1790000000000,            'a number' ],
  ] as const) {
    rejects(() => expiring(value), /RFC 3339/, what);
  }

  t.equal(
    await overlayDigest(expiring('2026-09-21T13:00:00+02:00')),
    await overlayDigest(expiring('2026-09-21T11:00:00Z')),
    'two spellings of one moment are one decision',
  );

  /*
   * What is stored is read back through this same parser, so it is always an
   * instant the parser takes: within the years 0000 to 9999 in UTC.
   */
  for (const [ value, stored, what ] of [
    [ '0026-09-21T00:00:00Z',      '0026-09-21T00:00:00.000Z', 'a year before 100 is that year' ],
    [ '9999-12-31T23:30:00-01:00', '9999-12-31T23:59:59.999Z', 'an offset that carries it past the year 9999 stores the last instant' ],
    [ '0000-01-01T00:30:00+01:00', '0000-01-01T00:00:00.000Z', 'and one that carries it before the year 0000, the first' ],
  ] as const) {
    const expiry = expiring(value).priceExceptions[0]!.expiresAt;
    t.equal(expiry, stored, what);
    t.equal(expiring(expiry).priceExceptions[0]!.expiresAt, stored, 'which reads back as itself');
  }
});

t.test('the digest identifies an overlay, not its spelling', async t => {
  const digest = await overlayDigest(parseNetworkOverlay(networkOverlay));

  const reordered = await overlayDigest(parseNetworkOverlay({
    ...networkOverlay,
    assetDisplayOverrides: [ ...networkOverlay.assetDisplayOverrides ].reverse(),
    priceExceptions:       [ ...networkOverlay.priceExceptions ].reverse(),
  }));
  t.equal(reordered, digest, 'array order does not change the digest');

  const recased = await overlayDigest(parseNetworkOverlay({
    ...networkOverlay,
    priceExceptions: networkOverlay.priceExceptions.map(exception => ({
      ...exception,
      priceFeedAddress: exception.priceFeedAddress.toUpperCase().replace('0X', '0x'),
    })),
  }));
  t.equal(recased, digest, 'address casing does not change the digest');

  const changed = await overlayDigest(parseNetworkOverlay({ ...networkOverlay, displayName: 'Ethereum Mainnet' }));
  t.not(changed, digest, 'a reviewed change does change the digest');
});

/*
 * The parser builds every object in one order, but an overlay that says the
 * same with its keys assigned in another — built by a later release, or by a
 * route that does not parse — is the same decision, and an expectation read
 * from one has to hold against the other.
 */
t.test('the digest does not depend on the order an overlay assigns its keys in', async t => {
  // the same value, with the keys of every object in it assigned the other way round
  const reversed = (value: unknown): unknown => Array.isArray(value)
    ? value.map(reversed)
    : typeof(value) === 'object' && value !== null
      ? Object.fromEntries(Object.entries(value).reverse().map(([ key, entry ]) => [ key, reversed(entry) ]))
      : value;

  for (const [ overlay, what ] of [
    [ parseMarketOverlay(marketOverlay), 'a market overlay' ],
    [ parseNetworkOverlay(networkOverlay), 'a network overlay' ],
  ] as const) {
    const copy = reversed(overlay) as typeof overlay;
    t.not(JSON.stringify(copy), JSON.stringify(overlay), `${what} written in another order`);
    t.equal(await overlayDigest(copy), await overlayDigest(overlay), 'has the same digest');
  }
});
