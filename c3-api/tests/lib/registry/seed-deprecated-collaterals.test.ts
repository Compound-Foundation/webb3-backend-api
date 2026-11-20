import t from 'tap';

import { isAddress } from '../../../lib/model/comet-registry.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { readSeedComets, readSeedDeprecated, readSeedDeprecatedText } from '../../util/registry-seed.js';

/*
 * The first list of deprecated collaterals is the body of
 * `POST …/deprecated-collaterals/review` and `/apply` that step 8 of the
 * runbook's first bring-up sends once the seed's version is on, and review
 * holds every row against that version. What holds without one is held here:
 * the file's form, and each row against what the repository knows — the
 * Comet the seed names for its market, and the token the registry's fixture
 * names by its symbol on mainnet. Whether a market takes a token as
 * collateral, the fixture answers for the markets it holds
 * (tests/e2e/registry/deprecated-collaterals.test.ts), and only a version
 * imported from the source for the others.
 */
const text   = readSeedDeprecatedText();
const list   = readSeedDeprecated();
const comets = readSeedComets();

const REASON = 'Deprecated collateral the app hid by its own list until the registry served it';

// a row as the export writes one
const ROW = [ 'chainId', 'cometAddress', 'deploymentKey', 'tokenAddress', 'symbol', 'isDeprecated' ];

t.test('the file is a list review and apply take as it is', async t => {
  t.equal(text, `${JSON.stringify(list, null, 2)}\n`, 'written as JSON.stringify writes it, two spaces and a newline');
  t.same(Object.keys(list), [ 'reason', 'collaterals' ], 'a reason and its rows, and nothing else an export answers');
  t.equal(list.reason, REASON, 'the one reason every row is recorded with');
  t.equal(list.collaterals.length, 20, 'twenty rows, as the app\'s list has');
  t.same(list.collaterals.filter(row => Object.keys(row).join() !== ROW.join()), [],
    'each with the members of an exported row, in their order, and no reason of its own');
});

t.test('every row deprecates one collateral of an Ethereum market', async t => {
  t.ok(list.collaterals.every(row => row.chainId === 1), 'all on mainnet');
  t.ok(list.collaterals.every(row => row.isDeprecated === true), 'all deprecated');
  t.same(
    list.collaterals.flatMap(row => [ row.cometAddress, row.tokenAddress ]).filter(address => !isAddress(address) || address !== address.toLowerCase()),
    [],
    'every address lowercase',
  );
  const keys = list.collaterals.map(row => `${row.chainId}/${row.cometAddress}/${row.tokenAddress}`);
  t.same(keys.filter((key, index) => keys.indexOf(key) !== index), [], 'and no collateral twice');
});

t.test('every row names its Comet as the seed does, and its token as the fixture does', async t => {
  t.same(
    list.collaterals.map(row => row.cometAddress),
    list.collaterals.map(row => comets[`1/${row.deploymentKey}`]),
    'each Comet the one production.comets.json names for the row\'s market',
  );

  const mainnet = loadRegistrySnapshotFixture().networks.find(network => network.chainId === 1)!;
  const tokens  = mainnet.markets.flatMap(market => market.collateralAssets.map(asset => asset.token));
  // the one address the fixture's mainnet holds a collateral of that symbol at, or how many it holds
  const tokenOf = (symbol: string | null | undefined): string => {
    const addresses = [ ...new Set(tokens.filter(token => token.symbol === symbol).map(token => token.address)) ];
    return addresses.length === 1 ? addresses[0]! : `${addresses.length} collaterals ${symbol}`;
  };
  t.same(
    list.collaterals.map(row => row.tokenAddress),
    list.collaterals.map(row => tokenOf(row.symbol)),
    'and each token the one collateral of its symbol the fixture\'s mainnet holds',
  );
});
