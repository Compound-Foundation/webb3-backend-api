import t from 'tap';
import { readFileSync } from 'node:fs';

/*
 * Contract freeze for RegistrySnapshotV1, the body of GET /registry/v1/active.
 *
 * The type in lib/model/comet-registry.ts gives its shape to the compiler, and
 * nothing checks the shape at run time, so this test is the executable
 * description of the wire contract, held against the committed fixture:
 * exact key sets, value formats, the order of a network's presentation and
 * price exceptions, and the network keys and market ids the schema keeps
 * unique. The rules between fields are validateCandidate's, and
 * validation.test.ts holds this fixture to them ('the frozen fixture passes
 * every check'); the order of networks and markets is readSnapshot's, which
 * d1-schema.test.ts holds it to. A copy of either here would be a second
 * statement of a rule, free to drift from the one the registry applies. Each
 * check collects every violation so a failing run lists all of them at once.
 */
const FIXTURE_PATH = './tests/fixtures/registry/registry-snapshot-v1.json';
const raw = readFileSync(FIXTURE_PATH, 'utf8');
const snapshot = JSON.parse(raw);

const ADDRESS  = /^0x[0-9a-f]{40}$/;
const UUID     = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA1     = /^[0-9a-f]{40}$/;
const SHA256   = /^[0-9a-f]{64}$/;
const SLUG     = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const REPO     = /^[a-z0-9-]+\/[a-z0-9._-]+$/;
const UINT     = /^[0-9]+$/;

const STATUSES = ['enabled', 'deprecated', 'disabled'];
const QUOTES   = ['usd', 'base'];

const NETWORK_KEYS      = ['chainId', 'key', 'upstreamKey', 'displayName', 'testnet', 'presentation', 'priceExceptions', 'markets'];
const PRESENTATION_KEYS = ['assetDisplayOverrides', 'unwrappedCollateralAssets'];
const OVERRIDE_KEYS     = ['tokenAddress', 'displayAddress', 'symbol', 'name'];
const UNWRAPPED_KEYS    = ['wrappedTokenAddress', 'tokenAddress', 'symbol', 'name'];
const MARKET_KEYS       = [
  'id', 'deploymentKey', 'displayName', 'slug', 'contractName', 'isDefault', 'isInstitutional', 'status', 'creationBlock',
  'collateralValueQuote', 'capabilities', 'contracts', 'baseAsset', 'rewardAsset', 'collateralAssets',
];
const CAPABILITY_KEYS   = ['rewards', 'accountRewards', 'transactionHistory'];
const CONTRACT_KEYS     = ['comet', 'configurator', 'rewards', 'bulker', 'fauceteer', 'bridgeReceiver'];
const BASE_ASSET_KEYS   = ['token', 'displayName', 'isWrappedNative', 'priceFeed', 'usdPriceFeed'];
const REWARD_ASSET_KEYS = ['token', 'priceFeed', 'priceFeedQuote'];
const COLLATERAL_KEYS   = ['assetIndex', 'token', 'priceFeed'];
const EXCEPTION_KEYS: Record<string, string[]> = {
  zero_price:             ['kind', 'priceFeedAddress', 'provenance', 'expiresAt'],
  fixed_price:            ['kind', 'priceFeedAddress', 'price', 'provenance', 'expiresAt'],
  deprecated_price_remap: ['kind', 'priceFeedAddress', 'replacementPriceFeed', 'provenance', 'expiresAt'],
};

type Problems = string[];

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(problems: Problems, value: unknown, keys: string[], where: string): value is Record<string, any> {
  if (!isObject(value)) {
    problems.push(`${where}: expected an object`);
    return false;
  }
  const actual = Object.keys(value).sort().join(',');
  const expected = [...keys].sort().join(',');
  if (actual !== expected) {
    problems.push(`${where}: keys [${actual}] != [${expected}]`);
    return false;
  }
  return true;
}

function checkPattern(problems: Problems, value: unknown, pattern: RegExp, where: string) {
  if (typeof value !== 'string' || !pattern.test(value)) problems.push(`${where}: ${JSON.stringify(value)} does not match ${pattern}`);
}

function checkText(problems: Problems, value: unknown, where: string) {
  if (typeof value !== 'string' || value.trim() === '') problems.push(`${where}: expected non-empty text`);
}

function checkInteger(problems: Problems, value: unknown, min: number, max: number, where: string) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    problems.push(`${where}: expected an integer in [${min}, ${max}]`);
  }
}

function checkBoolean(problems: Problems, value: unknown, where: string) {
  if (typeof value !== 'boolean') problems.push(`${where}: expected a boolean`);
}

function checkToken(problems: Problems, token: unknown, where: string) {
  if (!exactKeys(problems, token, ['address', 'symbol', 'name', 'decimals'], where)) return;
  checkPattern(problems, token.address, ADDRESS, `${where}.address`);
  checkText(problems, token.symbol, `${where}.symbol`);
  checkText(problems, token.name, `${where}.name`);
  checkInteger(problems, token.decimals, 0, 255, `${where}.decimals`);
}

function checkFeed(problems: Problems, feed: unknown, where: string) {
  if (!exactKeys(problems, feed, ['address', 'decimals'], where)) return;
  checkPattern(problems, feed.address, ADDRESS, `${where}.address`);
  checkInteger(problems, feed.decimals, 0, 255, `${where}.decimals`);
}

function checkStrictlyAscending(problems: Problems, values: unknown[], where: string) {
  for (let i = 1; i < values.length; i++) {
    if (!((values[i - 1] as string) < (values[i] as string))) problems.push(`${where}: ${values[i]} is not sorted and unique`);
  }
}

function checkPriceException(problems: Problems, exception: any, where: string) {
  const keys = EXCEPTION_KEYS[exception?.kind];
  if (keys === undefined) {
    problems.push(`${where}.kind: ${JSON.stringify(exception?.kind)} is not one of ${Object.keys(EXCEPTION_KEYS)}`);
    return;
  }
  if (!exactKeys(problems, exception, keys, where)) return;
  checkPattern(problems, exception.priceFeedAddress, ADDRESS, `${where}.priceFeedAddress`);
  checkText(problems, exception.provenance, `${where}.provenance`);
  if (exception.expiresAt !== null && !(typeof exception.expiresAt === 'string' && new Date(exception.expiresAt).toISOString() === exception.expiresAt)) {
    problems.push(`${where}.expiresAt: expected null or a canonical ISO-8601 UTC timestamp`);
  }
  if (exception.kind === 'fixed_price' && exactKeys(problems, exception.price, ['value', 'decimals'], `${where}.price`)) {
    checkPattern(problems, exception.price.value, UINT, `${where}.price.value`);
    checkInteger(problems, exception.price.decimals, 0, 255, `${where}.price.decimals`);
  }
  if (exception.kind === 'deprecated_price_remap') checkFeed(problems, exception.replacementPriceFeed, `${where}.replacementPriceFeed`);
}

const networks: any[] = Array.isArray(snapshot.networks) ? snapshot.networks : [];
const markets: { network: any, market: any, where: string }[] = networks.flatMap((network, n) =>
  (Array.isArray(network.markets) ? network.markets : []).map((market: any, m: number) => ({
    network,
    market,
    where: `networks[${n}].markets[${m}]`,
  }))
);

t.test('fixture file is canonically formatted', async t => {
  t.equal(raw, JSON.stringify(snapshot, null, 2) + '\n');
});

t.test('top level and registry version', async t => {
  const problems: Problems = [];
  if (exactKeys(problems, snapshot, ['schemaVersion', 'registryVersion', 'networks'], 'snapshot')) {
    if (snapshot.schemaVersion !== 1) problems.push('snapshot.schemaVersion: expected 1');
    const version = snapshot.registryVersion;
    if (exactKeys(problems, version, ['id', 'sourceRepository', 'sourceCommitSha', 'checksum'], 'registryVersion')) {
      checkPattern(problems, version.id, UUID, 'registryVersion.id');
      checkPattern(problems, version.sourceRepository, REPO, 'registryVersion.sourceRepository');
      checkPattern(problems, version.sourceCommitSha, SHA1, 'registryVersion.sourceCommitSha');
      checkPattern(problems, version.checksum, SHA256, 'registryVersion.checksum');
    }
    if (!Array.isArray(snapshot.networks)) problems.push('snapshot.networks: expected an array');
  }
  t.same(problems, []);
});

t.test('networks are typed, with unique keys and sorted lists', async t => {
  const problems: Problems = [];
  networks.forEach((network, n) => {
    const where = `networks[${n}]`;
    if (!exactKeys(problems, network, NETWORK_KEYS, where)) return;
    checkInteger(problems, network.chainId, 1, Number.MAX_SAFE_INTEGER, `${where}.chainId`);
    checkPattern(problems, network.key, SLUG, `${where}.key`);
    checkPattern(problems, network.upstreamKey, SLUG, `${where}.upstreamKey`);
    checkText(problems, network.displayName, `${where}.displayName`);
    checkBoolean(problems, network.testnet, `${where}.testnet`);
    if (!Array.isArray(network.markets)) problems.push(`${where}.markets: expected an array`);

    const presentation = network.presentation;
    if (exactKeys(problems, presentation, PRESENTATION_KEYS, `${where}.presentation`)) {
      const overrides: any[] = presentation.assetDisplayOverrides;
      overrides.forEach((o, i) => {
        const at = `${where}.presentation.assetDisplayOverrides[${i}]`;
        if (!exactKeys(problems, o, OVERRIDE_KEYS, at)) return;
        checkPattern(problems, o.tokenAddress, ADDRESS, `${at}.tokenAddress`);
        checkPattern(problems, o.displayAddress, ADDRESS, `${at}.displayAddress`);
        checkText(problems, o.symbol, `${at}.symbol`);
        checkText(problems, o.name, `${at}.name`);
      });
      checkStrictlyAscending(problems, overrides.map(o => o.tokenAddress), `${where}.presentation.assetDisplayOverrides`);

      const unwrapped: any[] = presentation.unwrappedCollateralAssets;
      unwrapped.forEach((u, i) => {
        const at = `${where}.presentation.unwrappedCollateralAssets[${i}]`;
        if (!exactKeys(problems, u, UNWRAPPED_KEYS, at)) return;
        checkPattern(problems, u.wrappedTokenAddress, ADDRESS, `${at}.wrappedTokenAddress`);
        checkPattern(problems, u.tokenAddress, ADDRESS, `${at}.tokenAddress`);
        checkText(problems, u.symbol, `${at}.symbol`);
        checkText(problems, u.name, `${at}.name`);
      });
      checkStrictlyAscending(problems, unwrapped.map(u => u.wrappedTokenAddress), `${where}.presentation.unwrappedCollateralAssets`);
    }

    if (!Array.isArray(network.priceExceptions)) {
      problems.push(`${where}.priceExceptions: expected an array`);
    } else {
      network.priceExceptions.forEach((exception: any, e: number) => checkPriceException(problems, exception, `${where}.priceExceptions[${e}]`));
      checkStrictlyAscending(problems, network.priceExceptions.map((e: any) => e?.priceFeedAddress), `${where}.priceExceptions`);
    }
  });

  const keys = networks.map(network => network.key);
  if (new Set(keys).size !== keys.length) problems.push('networks: key must be unique');
  t.same(problems, []);
});

t.test('markets are typed, with ids unique across the snapshot', async t => {
  const problems: Problems = [];
  markets.forEach(({ market, where }) => {
    if (!exactKeys(problems, market, MARKET_KEYS, where)) return;
    checkPattern(problems, market.id, UUID, `${where}.id`);
    checkPattern(problems, market.deploymentKey, SLUG, `${where}.deploymentKey`);
    checkText(problems, market.displayName, `${where}.displayName`);
    if (market.contractName !== null) checkText(problems, market.contractName, `${where}.contractName`);
    if (market.slug !== null) checkPattern(problems, market.slug, /^[a-z0-9][a-z0-9.-]{0,63}$/, `${where}.slug`);
    checkBoolean(problems, market.isDefault, `${where}.isDefault`);
    checkBoolean(problems, market.isInstitutional, `${where}.isInstitutional`);
    if (!STATUSES.includes(market.status)) problems.push(`${where}.status: ${JSON.stringify(market.status)} is not one of ${STATUSES}`);
    checkInteger(problems, market.creationBlock, 0, Number.MAX_SAFE_INTEGER, `${where}.creationBlock`);
    if (!QUOTES.includes(market.collateralValueQuote)) problems.push(`${where}.collateralValueQuote: not one of ${QUOTES}`);

    if (exactKeys(problems, market.capabilities, CAPABILITY_KEYS, `${where}.capabilities`)) {
      for (const key of CAPABILITY_KEYS) checkBoolean(problems, market.capabilities[key], `${where}.capabilities.${key}`);
    }
    if (exactKeys(problems, market.contracts, CONTRACT_KEYS, `${where}.contracts`)) {
      checkPattern(problems, market.contracts.comet, ADDRESS, `${where}.contracts.comet`);
      for (const key of CONTRACT_KEYS.filter(k => k !== 'comet')) {
        if (market.contracts[key] !== null) checkPattern(problems, market.contracts[key], ADDRESS, `${where}.contracts.${key}`);
      }
    }
  });

  const ids = markets.map(({ market }) => market.id);
  if (new Set(ids).size !== ids.length) problems.push('markets: id must be unique across the snapshot');
  t.same(problems, []);
});

t.test('base, reward, and collateral assets are typed', async t => {
  const problems: Problems = [];
  markets.forEach(({ market, where }) => {
    const base = market.baseAsset;
    if (exactKeys(problems, base, BASE_ASSET_KEYS, `${where}.baseAsset`)) {
      checkToken(problems, base.token, `${where}.baseAsset.token`);
      checkText(problems, base.displayName, `${where}.baseAsset.displayName`);
      checkBoolean(problems, base.isWrappedNative, `${where}.baseAsset.isWrappedNative`);
      checkFeed(problems, base.priceFeed, `${where}.baseAsset.priceFeed`);
      if (base.usdPriceFeed !== null) checkFeed(problems, base.usdPriceFeed, `${where}.baseAsset.usdPriceFeed`);
    }

    if (market.rewardAsset !== null) {
      const reward = market.rewardAsset;
      if (exactKeys(problems, reward, REWARD_ASSET_KEYS, `${where}.rewardAsset`)) {
        checkToken(problems, reward.token, `${where}.rewardAsset.token`);
        if (reward.priceFeed !== null) checkFeed(problems, reward.priceFeed, `${where}.rewardAsset.priceFeed`);
        if (reward.priceFeedQuote !== null && !QUOTES.includes(reward.priceFeedQuote)) {
          problems.push(`${where}.rewardAsset.priceFeedQuote: not one of ${QUOTES}`);
        }
      }
    }

    const collaterals: any[] = Array.isArray(market.collateralAssets) ? market.collateralAssets : [];
    if (!Array.isArray(market.collateralAssets)) problems.push(`${where}.collateralAssets: expected an array`);
    collaterals.forEach((collateral, i) => {
      const at = `${where}.collateralAssets[${i}]`;
      if (!exactKeys(problems, collateral, COLLATERAL_KEYS, at)) return;
      checkInteger(problems, collateral.assetIndex, 0, 255, `${at}.assetIndex`);
      checkToken(problems, collateral.token, `${at}.token`);
      checkFeed(problems, collateral.priceFeed, `${at}.priceFeed`);
    });
  });
  t.same(problems, []);
});
