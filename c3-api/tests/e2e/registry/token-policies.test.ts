import t from 'tap';

import { randomUUID } from 'node:crypto';

import type {
  TokenPoliciesV1,
  TokenPolicyApplyV1,
  TokenPolicyDetailV1,
  TokenPolicyListV1,
  TokenPolicyResultV1,
  TokenPolicyReviewV1,
} from '../../../lib/model/comet-registry.js';

import { foreignKeyViolations } from '../../util/d1.js';
import { ADMIN_ACTOR, adminClient, count, seedValidated } from '../../util/registry-admin.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { registryHarness } from '../../util/registry-harness.js';

import { TOKEN_POLICIES, decisionScenarios } from './decision-scenarios.js';

/*
 * Token policies, through the real worker in workerd over local D1. What
 * every kind of decision does is in decision-scenarios.ts, run here for
 * token policies: a decision and its audit, idempotency under a race,
 * survival across activations, the database guard against an activation
 * that races a write, and a list refused for its problems or for a race.
 * Beside them, the tests of token policies alone: the tokens of a network, a
 * chain the active version drops, and a list exported, edited, reviewed and
 * applied through the token-policies routes.
 *
 * Refusals of malformed requests are in token-policy-routes.test.ts.
 */
const harness = await registryHarness({ admin: true });
const admin   = adminClient(harness.server);

decisionScenarios(harness, TOKEN_POLICIES);

const snapshot = loadRegistrySnapshotFixture();

// tokens of the fixture, as the registry stores them
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
// the base of the fixture's one Base market
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';

const policyPath = (chainId: number, tokenAddress: string) => TOKEN_POLICIES.path(chainId, { tokenAddress });

t.test('the tokens of a network are listed, each with the decision in force', async t => {
  const db        = await harness.freshDatabase();
  const versionId = await seedValidated(db);
  await admin.switchTo(versionId);

  const listed = await admin.read<TokenPoliciesV1>('/registry/v1/admin/networks/1/tokens');
  t.equal(listed.status, 200);
  t.same(listed.body.registryVersion, { id: versionId, checksum: snapshot.registryVersion.checksum }, 'the list names the version it lists');
  t.equal(listed.header('x-registry-version'), versionId, 'in its headers too');
  t.equal(listed.body.inActiveVersion, true, 'a chain the version holds');
  const mainnet = new Set(snapshot.networks.find(network => network.chainId === 1)!.markets.flatMap(market => [
    market.baseAsset.token.address,
    ...(market.rewardAsset === null ? [] : [ market.rewardAsset.token.address ]),
    ...market.collateralAssets.map(asset => asset.token.address),
  ]));
  t.same(listed.body.tokens.map(token => token.address).sort(), [ ...mainnet ].sort(), 'every token of the network, once');
  t.ok(listed.body.tokens.every(token => !token.isStrategic && token.updatedAt === null && token.updatedBy === null),
    'and nobody has decided anything about any of them');

  const weth = await admin.patch<TokenPolicyResultV1>(policyPath(1, WETH), { isStrategic: true, reason: 'strategic' });
  const relisted = await admin.read<TokenPoliciesV1>('/registry/v1/admin/networks/1/tokens');
  t.same(
    relisted.body.tokens.filter(token => token.isStrategic).map(({ address, updatedAt, updatedBy }) => ({ address, updatedAt, updatedBy })),
    [ { address: WETH, updatedAt: weth.body.updatedAt, updatedBy: ADMIN_ACTOR } ],
    'a decision is listed with when it was made, and by whom',
  );
});

t.test('a chain the active version drops keeps its decisions, and still lists them', async t => {
  const db = await harness.freshDatabase();
  await admin.switchTo(await seedValidated(db));
  const aero = await admin.patch<TokenPolicyResultV1>(policyPath(8453, AERO), { isStrategic: true, reason: 'strategic' });
  await admin.switchTo(await seedValidated(db, {
    networks:  snapshot.networks.filter(network => network.chainId !== 8453),
    versionId: randomUUID(),
  }));

  const listed = await admin.read<TokenPoliciesV1>('/registry/v1/admin/networks/8453/tokens');
  t.equal(listed.status, 200, 'a chain the version does not hold is listed while a decision is kept for it');
  t.same(
    [ listed.body.inActiveVersion, listed.body.tokens, listed.body.retained ],
    [ false, [], [ { address: AERO, isStrategic: true, updatedAt: aero.body.updatedAt, updatedBy: ADMIN_ACTOR } ] ],
    'with no tokens, and the decision it keeps',
  );
  const detail = await admin.read<TokenPolicyDetailV1>(policyPath(8453, AERO));
  t.same([ detail.status, detail.body.inActiveVersion, detail.body.isStrategic ], [ 200, false, true ],
    'and the decision stays readable');
});

const REVIEW = TOKEN_POLICIES.list.review;
const APPLY  = TOKEN_POLICIES.list.apply;

/*
 * A list of decisions: exported as a file, edited, reviewed as the diff it
 * would make, and applied in one transaction. The file is the export itself,
 * so nobody writes an address by hand.
 */
t.test('a list of decisions is exported, reviewed, and applied as one', async t => {
  const db        = await harness.freshDatabase();
  const versionId = await seedValidated(db);
  await admin.switchTo(versionId);
  await admin.patch(policyPath(1, USDC), { isStrategic: true, reason: 'decided by hand' });

  const exported = await admin.read<TokenPolicyListV1>(TOKEN_POLICIES.list.export);
  t.equal(exported.status, 200);
  t.equal(exported.header('x-registry-version'), versionId, 'the export names the version it lists');
  t.same(exported.body.registryVersion, { id: versionId, checksum: snapshot.registryVersion.checksum });
  t.equal(exported.body.reason, null, 'with a place for the reason of the changes');
  const every = snapshot.networks.flatMap(network => [ ...new Set(network.markets.flatMap(market => [
    market.baseAsset.token.address,
    ...(market.rewardAsset === null ? [] : [ market.rewardAsset.token.address ]),
    ...market.collateralAssets.map(asset => asset.token.address),
  ])) ].map(address => `${network.chainId}:${address}`));
  t.same(exported.body.policies.map(row => `${row.chainId}:${row.tokenAddress}`).sort(), every.sort(),
    'and every token of every network of the active version, once');
  t.same(exported.body.policies.find(row => row.chainId === 1 && row.tokenAddress === USDC),
    { chainId: 1, tokenAddress: USDC, symbol: 'USDC', isStrategic: true }, 'each with the decision in force');

  const untouched = await admin.post<TokenPolicyReviewV1>(REVIEW, exported.body);
  t.equal(untouched.status, 200, 'the export is a list review takes back as it is');
  t.same(untouched.body.summary, { change: 0, unchanged: every.length, problems: 0 }, 'and it changes nothing');

  // what an operator does with the file: mark two tokens, unmark one, and give the reason once
  const edited = {
    ...exported.body,
    reason:   'initial approved list',
    policies: exported.body.policies.map(row =>
        row.chainId === 1    && row.tokenAddress === WETH ? { ...row, isStrategic: true }
      : row.chainId === 8453 && row.tokenAddress === AERO ? { ...row, isStrategic: true, reason: 'the base of the Base market' }
      : row.chainId === 1    && row.tokenAddress === USDC ? { ...row, isStrategic: false }
      : row),
  };
  const review = await admin.post<TokenPolicyReviewV1>(REVIEW, edited);
  t.same(review.body.summary, { change: 3, unchanged: every.length - 3, problems: 0 });
  t.same(
    review.body.policies.filter(row => row.action === 'change').map(row => [ row.symbol, row.current, row.requested, row.reason ]),
    // in the export's order: by chain, then by symbol
    [
      [ 'USDC', true,  false, 'initial approved list' ],
      [ 'WETH', false, true,  'initial approved list' ],
      [ 'AERO', false, true,  'the base of the Base market' ],
    ],
    'the review names every change, with the reason it will be recorded with',
  );
  t.equal(await count(db, 'token_policy_events'), 1, 'and writes nothing');

  const applied = await admin.post<TokenPolicyApplyV1>(APPLY, edited);
  t.equal(applied.status, 200);
  t.same(applied.body.summary, { changed: 3, unchanged: every.length - 3 }, 'applying writes exactly the reviewed changes');
  t.equal(applied.header('x-registry-version'), versionId);
  t.same(
    (await db.prepare(
      `SELECT actor FROM token_policy_events WHERE reason <> 'decided by hand' ORDER BY rowid`
    ).all<{ actor: string }>()).results?.map(row => row.actor),
    [ ADMIN_ACTOR, ADMIN_ACTOR, ADMIN_ACTOR ],
    'one event per change, each under the name of the token that applied the list',
  );
  t.same(
    (await db.prepare(`SELECT chain_id, token_address, is_strategic FROM token_policies ORDER BY chain_id, token_address`).all()).results,
    [
      { chain_id: 1,    token_address: USDC, is_strategic: 0 },
      { chain_id: 1,    token_address: WETH, is_strategic: 1 },
      { chain_id: 8453, token_address: AERO, is_strategic: 1 },
    ],
    'and the decisions are what the list says',
  );

  const again = await admin.post<TokenPolicyApplyV1>(APPLY, edited);
  t.same(again.body.summary, { changed: 0, unchanged: every.length }, 'applying the same list again changes nothing');
  t.equal(await count(db, 'token_policy_events'), 4, 'and records nothing');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});
