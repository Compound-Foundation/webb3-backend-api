import t from 'tap';

import type {
  ActiveMarketV1,
  DeprecatedCollateralApplyV1,
  DeprecatedCollateralListV1,
  DeprecatedCollateralReviewV1,
} from '../../../lib/model/comet-registry.js';

import { foreignKeyViolations } from '../../util/d1.js';
import { ADMIN_ACTOR, adminClient, count, seedValidated } from '../../util/registry-admin.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { registryHarness } from '../../util/registry-harness.js';
import { readSeedComets, readSeedDeprecated, readSeedDeprecatedText } from '../../util/registry-seed.js';

import { DEPRECATED_COLLATERALS, decisionScenarios } from './decision-scenarios.js';

/*
 * Deprecated collaterals, through the real worker in workerd over local D1.
 * What every kind of decision does is in decision-scenarios.ts, run here for
 * deprecated collaterals: a decision and its audit, idempotency under a race,
 * survival across activations, the database guard against an activation
 * that races a write, a list refused for its problems or for a race, and the
 * market reads that flag a deprecated collateral. Beside them, the test of
 * deprecated collaterals alone: the first list of them the seed holds
 * (registry/seed/production.deprecated-collaterals.json), reviewed, applied
 * and exported through the deprecated-collaterals routes.
 *
 * Refusals of malformed requests are in deprecated-collateral-routes.test.ts,
 * and what the active reads answer in deprecated-collateral-reads.test.ts.
 */
const harness = await registryHarness({ admin: true });
const admin   = adminClient(harness.server);

decisionScenarios(harness, DEPRECATED_COLLATERALS);

const snapshot = loadRegistrySnapshotFixture();
const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;

const comet = (key: string) => mainnet.markets.find(market => market.deploymentKey === key)!.contracts.comet!;
const collateral = (key: string, symbol: string) => mainnet.markets.find(market => market.deploymentKey === key)!
  .collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address;

const USDT = comet('usdt');
const USDC = comet('usdc');
const WETH = comet('weth');
const METH = collateral('usdt', 'mETH');

// the collaterals a public market read flags deprecated, by symbol
async function flagged(market: string): Promise<string[]> {
  const { body } = await admin.read<{ market: ActiveMarketV1 }>(`/registry/v1/networks/1/markets/${market}`, {});
  return body.market.collateralAssets.filter(asset => asset.isDeprecated).map(asset => asset.token.symbol);
}

const REVIEW = DEPRECATED_COLLATERALS.list.review;
const APPLY  = DEPRECATED_COLLATERALS.list.apply;

type Refused = { error: { code: string, message: string, details?: { problems?: unknown[] } } };

// the list step 8 of the runbook's first bring-up sends, and the file as it sends it
const list = readSeedDeprecated();
const text = readSeedDeprecatedText();

/*
 * The rows of the wstETH and USDS markets, which the fixture does not hold,
 * as a review or a refusal names them: each Comet as the seed names its
 * market, and each token as the fixture's mainnet names its symbol.
 */
const comets = readSeedComets();
const named  = (symbol: string) => mainnet.markets.flatMap(market => market.collateralAssets)
  .find(asset => asset.token.symbol === symbol)!.token.address;
const UNHELD = ([
  [ 'wsteth', 'rsETH' ], [ 'wsteth', 'ezETH' ], [ 'wsteth', 'weETH' ],
  [ 'usds', 'USDe' ], [ 'usds', 'sdeUSD' ], [ 'usds', 'tBTC' ], [ 'usds', 'weETH' ], [ 'usds', 'deUSD' ],
] as const).map(([ key, symbol ], index) => ({
  row:          13 + index,
  chainId:      1,
  cometAddress: comets[`1/${key}`],
  tokenAddress: named(symbol),
  problem:      `${comets[`1/${key}`]} is not a market of the active registry on chain 1`,
}));

/*
 * The first list of deprecated collaterals applies where the version holds
 * every collateral it names, and the fixture's mainnet holds the USDC, WETH,
 * USDT and WBTC markets: review names the eight rows of the wstETH and USDS
 * markets as problems, and apply refuses the file whole. The twelve rows of
 * the markets it holds apply exactly as written, with every address
 * resolved, the Comets' deployment keys and the tokens' symbols checked, and
 * nothing else touched. The export is a file review and apply take back as
 * it is.
 */
t.test('the first list of deprecated collaterals is reviewed and applied as one', async t => {
  const db        = await harness.freshDatabase();
  const versionId = await seedValidated(db);
  await admin.switchTo(versionId);

  t.same(
    list.collaterals.map(row => `${row.deploymentKey}/${row.symbol}`),
    [
      'usdt/mETH', 'usdt/weETH', 'usdt/sdeUSD', 'usdt/wUSDM', 'usdt/deUSD', 'usdt/USDe',
      'usdc/rsETH', 'usdc/USDe', 'usdc/deUSD', 'usdc/sdeUSD',
      'wbtc/LBTC', 'wbtc/pumpBTC',
      'wsteth/rsETH', 'wsteth/ezETH', 'wsteth/weETH',
      'usds/USDe', 'usds/sdeUSD', 'usds/tBTC', 'usds/weETH', 'usds/deUSD',
    ],
    'the file names the twenty pairs of the app\'s list: the twelve of the USDT, USDC and WBTC markets, '
      + 'then the eight of the wstETH and USDS markets, each market\'s in the order the frontend lists them',
  );
  t.ok(list.collaterals.every(row => row.chainId === 1 && row.isDeprecated === true), 'all on mainnet, all deprecated');

  const whole = await admin.post<DeprecatedCollateralReviewV1>(REVIEW, text);
  t.equal(whole.status, 200, 'review takes the file as it is');
  t.same(whole.body.summary, { change: 20, unchanged: 0, problems: 8 }, 'every row changes, and eight cannot be applied');
  t.same(
    (whole.body.collaterals ?? []).filter(row => row.problem !== null)
      .map(({ row, chainId, cometAddress, tokenAddress, problem }) => ({ row, chainId, cometAddress, tokenAddress, problem })),
    UNHELD,
    'the eight of the wstETH and USDS markets, whose Comets the fixture does not hold',
  );

  const refused = await admin.post<Refused>(APPLY, text);
  t.equal(refused.status, 422, 'so apply refuses the file');
  t.same(refused.body.error?.details?.problems, UNHELD, 'naming the same eight');
  t.equal(await count(db, 'deprecated_collateral_events'), 0, 'and neither writes anything');

  // the twelve rows of the markets the fixture holds, as the file has them
  const held = new Set(mainnet.markets.map(market => market.contracts.comet));
  const seed: DeprecatedCollateralListV1 = { reason: list.reason, collaterals: list.collaterals.filter(row => held.has(row.cometAddress)) };
  t.same(
    seed.collaterals.map(row => `${row.deploymentKey}/${row.symbol}`),
    [
      'usdt/mETH', 'usdt/weETH', 'usdt/sdeUSD', 'usdt/wUSDM', 'usdt/deUSD', 'usdt/USDe',
      'usdc/rsETH', 'usdc/USDe', 'usdc/deUSD', 'usdc/sdeUSD',
      'wbtc/LBTC', 'wbtc/pumpBTC',
    ],
    'the rows of the markets the fixture holds are the twelve of the USDT, USDC and WBTC markets',
  );

  const review = await admin.post<DeprecatedCollateralReviewV1>(REVIEW, seed);
  t.equal(review.status, 200);
  t.same(review.body.summary, { change: 12, unchanged: 0, problems: 0 }, 'every pair is a collateral of its Comet, and changes');
  t.equal(await count(db, 'deprecated_collateral_events'), 0, 'and the review writes nothing');

  const applied = await admin.post<DeprecatedCollateralApplyV1>(APPLY, seed);
  t.equal(applied.status, 200);
  t.same(applied.body.summary, { changed: 12, unchanged: 0 }, 'applying writes exactly the reviewed changes');
  t.equal(applied.header('x-registry-version'), versionId);
  t.same(
    (await db.prepare(`SELECT DISTINCT reason FROM deprecated_collateral_events`).all<{ reason: string }>()).results?.map(row => row.reason),
    [ seed.reason ],
    'each with the file\'s reason',
  );
  t.same(
    (await db.prepare(`SELECT DISTINCT actor FROM deprecated_collateral_events`).all<{ actor: string }>()).results?.map(row => row.actor),
    [ ADMIN_ACTOR ],
    'and under the name of the token that applied it',
  );
  t.same(await flagged(USDT), [ 'wUSDM', 'mETH', 'weETH', 'sdeUSD', 'deUSD', 'USDe' ], 'the USDT market flags its six');
  t.same(await flagged(USDC), [ 'deUSD', 'sdeUSD', 'rsETH', 'USDe' ], 'the USDC market its four, and not its weETH');
  t.same(await flagged(WETH), [], 'and the WETH market, which the list does not name, none');

  const again = await admin.post<DeprecatedCollateralApplyV1>(APPLY, seed);
  t.same(again.body.summary, { changed: 0, unchanged: 12 }, 'applying them again changes nothing');
  t.equal(await count(db, 'deprecated_collateral_events'), 12, 'and records nothing');

  const after = await admin.post<DeprecatedCollateralReviewV1>(REVIEW, text);
  t.same(after.body.summary, { change: 8, unchanged: 12, problems: 8 }, 'the file now reviews the twelve as unchanged');

  const exported = await admin.read<DeprecatedCollateralListV1>(DEPRECATED_COLLATERALS.list.export);
  t.equal(exported.status, 200);
  t.equal(exported.header('x-registry-version'), versionId, 'the export names the version it lists');
  t.equal(exported.body.reason, null, 'with a place for the reason of the changes');
  const every = mainnet.markets.flatMap(market => market.collateralAssets.map(asset => `${market.contracts.comet}:${asset.token.address}`));
  t.same(exported.body.collaterals.filter(row => row.chainId === 1).map(row => `${row.cometAddress}:${row.tokenAddress}`).sort(), every.sort(),
    'and every collateral of every market of mainnet, once');
  t.same(exported.body.collaterals.filter(row => row.isDeprecated).length, 12, 'twelve of them deprecated');
  t.same(exported.body.collaterals.find(row => row.cometAddress === USDT && row.tokenAddress === METH),
    { chainId: 1, cometAddress: USDT, deploymentKey: 'usdt', tokenAddress: METH, symbol: 'mETH', isDeprecated: true },
    'each with its market, its symbol, and the decision in force');

  const untouched = await admin.post<DeprecatedCollateralReviewV1>(REVIEW, exported.body);
  t.equal(untouched.status, 200, 'the export is a list review takes back as it is');
  t.same(untouched.body.summary, { change: 0, unchanged: exported.body.collaterals.length, problems: 0 }, 'and it changes nothing');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});
