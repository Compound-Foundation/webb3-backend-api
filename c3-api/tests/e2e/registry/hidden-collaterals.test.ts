import t from 'tap';

import type {
  DeprecatedCollateralListV1,
  HiddenCollateralApplyV1,
  HiddenCollateralListV1,
  HiddenCollateralReviewV1,
} from '../../../lib/model/comet-registry.js';

import { foreignKeyViolations } from '../../util/d1.js';
import { ADMIN_ACTOR, adminClient, count, seedValidated } from '../../util/registry-admin.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { registryHarness } from '../../util/registry-harness.js';

import { DEPRECATED_COLLATERALS, HIDDEN_COLLATERALS, decisionScenarios } from './decision-scenarios.js';

/*
 * Hidden collaterals, through the real worker in workerd over local D1. What
 * every kind of decision does is in decision-scenarios.ts, run here for
 * hidden collaterals: a decision and its audit, idempotency under a race,
 * survival across activations, the database guard against an activation that
 * races a write, a list refused for its problems or for a race, and the
 * market reads that flag a hidden collateral. Beside them, the test of hidden
 * collaterals alone: a list exported, edited, reviewed and applied through
 * the hidden-collaterals routes, apart from the deprecated decisions about
 * the same collaterals.
 *
 * Refusals of malformed requests are in hidden-collateral-routes.test.ts, and
 * what the active reads answer, and the record the commands keep for an
 * outage, in hidden-collateral-reads.test.ts.
 */
const harness = await registryHarness({ admin: true });
const admin   = adminClient(harness.server);

decisionScenarios(harness, HIDDEN_COLLATERALS);

const snapshot = loadRegistrySnapshotFixture();
const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;

const comet = (key: string) => mainnet.markets.find(market => market.deploymentKey === key)!.contracts.comet!;
const collateral = (key: string, symbol: string) => mainnet.markets.find(market => market.deploymentKey === key)!
  .collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address;

const USDT  = comet('usdt');
const USDC  = comet('usdc');
// collateral of the USDT market alone
const METH  = collateral('usdt', 'mETH');
// collateral of the USDC, WETH and USDT markets
const WEETH = collateral('usdt', 'weETH');

const REVIEW = HIDDEN_COLLATERALS.list.review;
const APPLY  = HIDDEN_COLLATERALS.list.apply;

function marked<Row extends { deploymentKey?: string | null, symbol?: string | null }>(rows: Row[], flagged: (row: Row) => boolean): string[] {
  return rows.filter(flagged).map(row => `${row.deploymentKey}/${row.symbol}`);
}

/*
 * A list of decisions: exported as a file, edited, reviewed as the diff it
 * would make, and applied in one transaction. The file is the export itself,
 * so nobody writes an address by hand. A collateral's hidden decision is its
 * own: deprecating one hides nothing, and hiding one deprecates nothing.
 */
t.test('a list of hidden collaterals is exported, reviewed, and applied as one, apart from the deprecated ones', async t => {
  const db        = await harness.freshDatabase();
  const versionId = await seedValidated(db);
  await admin.switchTo(versionId);
  await admin.patch(HIDDEN_COLLATERALS.path(1, { cometAddress: USDT, tokenAddress: METH }), { isHidden: true, reason: 'decided by hand' });
  await admin.patch(DEPRECATED_COLLATERALS.path(1, { cometAddress: USDC, tokenAddress: WEETH }), { isDeprecated: true, reason: 'no longer offered' });

  const exported = await admin.read<HiddenCollateralListV1>(HIDDEN_COLLATERALS.list.export);
  t.equal(exported.status, 200);
  t.equal(exported.header('x-registry-version'), versionId, 'the export names the version it lists');
  t.same(exported.body.registryVersion, { id: versionId, checksum: snapshot.registryVersion.checksum });
  t.equal(exported.body.reason, null, 'with a place for the reason of the changes');
  const every = snapshot.networks.flatMap(network => network.markets.flatMap(market =>
    market.collateralAssets.map(asset => `${network.chainId}:${market.contracts.comet}:${asset.token.address}`)));
  t.same(exported.body.hiddenCollaterals.map(row => `${row.chainId}:${row.cometAddress}:${row.tokenAddress}`).sort(), every.sort(),
    'and every collateral of every market of the active version, once');
  t.same(exported.body.hiddenCollaterals.find(row => row.cometAddress === USDT && row.tokenAddress === METH),
    { chainId: 1, cometAddress: USDT, deploymentKey: 'usdt', tokenAddress: METH, symbol: 'mETH', isHidden: true },
    'each with its market, its symbol, and the decision in force');
  t.same(marked(exported.body.hiddenCollaterals, row => row.isHidden), [ 'usdt/mETH' ],
    'the one hidden, and not the one deprecated');
  t.same(exported.body.retained, [], 'with nothing kept apart, since the version holds every collateral decided about');

  const untouched = await admin.post<HiddenCollateralReviewV1>(REVIEW, exported.body);
  t.equal(untouched.status, 200, 'the export is a list review takes back as it is');
  t.same(untouched.body.summary, { change: 0, unchanged: every.length, problems: 0 }, 'and it changes nothing');

  // what an operator does with the file: hide weETH in two markets, show mETH again, and give the reason once
  const edited = {
    ...exported.body,
    reason:            'reviewed for discovery',
    hiddenCollaterals: exported.body.hiddenCollaterals.map(row =>
        row.cometAddress === USDT && row.tokenAddress === WEETH ? { ...row, isHidden: true }
      : row.cometAddress === USDC && row.tokenAddress === WEETH ? { ...row, isHidden: true, reason: 'deprecated, and not for discovery' }
      : row.cometAddress === USDT && row.tokenAddress === METH  ? { ...row, isHidden: false }
      : row),
  };
  const review = await admin.post<HiddenCollateralReviewV1>(REVIEW, edited);
  t.same(review.body.summary, { change: 3, unchanged: every.length - 3, problems: 0 });
  t.same(
    review.body.hiddenCollaterals.filter(row => row.action === 'change')
      .map(row => [ `${row.deploymentKey}/${row.symbol}`, row.current, row.requested, row.reason ]),
    // in the export's order: by chain, then by market, then by the market's own order
    [
      [ 'usdc/weETH', false, true,  'deprecated, and not for discovery' ],
      [ 'usdt/mETH',  true,  false, 'reviewed for discovery' ],
      [ 'usdt/weETH', false, true,  'reviewed for discovery' ],
    ],
    'the review names every change, with the reason it will be recorded with',
  );
  t.equal(await count(db, 'hidden_collateral_events'), 1, 'and writes nothing');

  const applied = await admin.post<HiddenCollateralApplyV1>(APPLY, edited);
  t.equal(applied.status, 200);
  t.same(applied.body.summary, { changed: 3, unchanged: every.length - 3 }, 'applying writes exactly the reviewed changes');
  t.equal(applied.header('x-registry-version'), versionId);
  t.equal(await count(db, 'hidden_collateral_events', `reason <> 'decided by hand'`), 3, 'one event per change');
  t.same(
    (await db.prepare(`SELECT DISTINCT actor FROM hidden_collateral_events WHERE reason <> 'decided by hand'`).all<{ actor: string }>()).results?.map(row => row.actor),
    [ ADMIN_ACTOR ],
    'each under the name of the token that applied the list',
  );
  const after = await admin.read<HiddenCollateralListV1>(HIDDEN_COLLATERALS.list.export);
  t.same(marked(after.body.hiddenCollaterals, row => row.isHidden), [ 'usdc/weETH', 'usdt/weETH' ],
    'and the decisions are what the list says');

  const again = await admin.post<HiddenCollateralApplyV1>(APPLY, edited);
  t.same(again.body.summary, { changed: 0, unchanged: every.length }, 'applying the same list again changes nothing');
  t.equal(await count(db, 'hidden_collateral_events'), 4, 'and records nothing');

  const deprecated = await admin.read<DeprecatedCollateralListV1>(DEPRECATED_COLLATERALS.list.export);
  t.same(marked(deprecated.body.collaterals, row => row.isDeprecated), [ 'usdc/weETH' ],
    'while the deprecated decisions are the one made by hand, which none of it changed');
  t.equal(await count(db, 'deprecated_collateral_events'), 1, 'with its own one event');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});
