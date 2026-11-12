import {
  MarketV1,
  NetworkV1,
  marketKey,
} from '../../lib/model/comet-registry.js';

import { readSnapshot, readUnreviewed, snapshotChecksum } from './repository.js';
import { Condition, both } from './sql-condition.js';
import { endCandidateStatement, readRevision, unchanged, validationResultsStatement } from './validation-store.js';

/*
 * Candidate validation. Every invariant that cannot be expressed as a column
 * constraint is checked here, and every check is persisted: a candidate is
 * validated only when the latest attempt passes completely, and an invalid
 * candidate keeps its diagnostics for review.
 *
 * Checks are pure and operate on the stored snapshot, read back from its
 * rows, so the same pass decides a scheduled import and answers an operator
 * asking why a candidate failed. What the chain says about a market is not a
 * check: a market the chain cannot confirm fails its import instead, before
 * anything about it is written.
 */
type CheckResult = {
  check_name: string,
  scope:      string,
  passed:     number,
  details?:   Record<string, unknown>,
};

type CandidateInput = {
  networks: NetworkV1[],
  /*
   * The roots the run checkpointed, so a candidate assembled from an
   * incomplete import cannot validate. A root that exhausted its retries
   * stops being outstanding work, but the market it describes is still
   * missing.
   */
  roots?: Array<{ upstreamNetworkKey: string, deploymentKey: string }>,
  /*
   * The networks nobody has reviewed, by chain id: those an import wrote for
   * a chain no version described yet, under its provisional overlay.
   */
  unreviewedNetworks?: number[],
};

// the check that every root the run checkpointed produced a market
const ALL_ROOTS_CHECK = 'all-roots-imported';

function marketScope(network: NetworkV1, market: MarketV1): string {
  return `market:${marketKey(network.chainId, market.deploymentKey)}`;
}

function check(
  check_name: string,
  scope: string,
  passed: boolean,
  details?: Record<string, unknown>,
): CheckResult {
  return details === undefined || passed
    ? { check_name, scope, passed: passed ? 1 : 0 }
    : { check_name, scope, passed: 0, details };
}

function validateMarket(network: NetworkV1, market: MarketV1): CheckResult[] {
  const scope   = marketScope(network, market);
  const results: CheckResult[] = [];

  /*
   * collateralValueQuote states the unit the on-chain feeds answer in. A
   * base-quoted market needs the reviewed feed that converts that unit to
   * USD, and a USD-quoted market must not carry one.
   */
  const quotedInBase = market.collateralValueQuote === 'base';
  results.push(check(
    'base-usd-feed-matches-quote',
    scope,
    quotedInBase === (market.baseAsset.usdPriceFeed !== null),
    { collateralValueQuote: market.collateralValueQuote, usdPriceFeed: market.baseAsset.usdPriceFeed },
  ));

  const reward = market.rewardAsset;
  results.push(check(
    'reward-feed-paired',
    scope,
    reward === null || (reward.priceFeed === null) === (reward.priceFeedQuote === null),
    { priceFeed: reward?.priceFeed ?? null, priceFeedQuote: reward?.priceFeedQuote ?? null },
  ));
  // a reward feed denominated in the market's quote unit only makes sense
  // where that unit is not USD, as with mainnet COMP/ETH
  results.push(check(
    'reward-feed-quote-supported',
    scope,
    reward === null || reward.priceFeedQuote !== 'base' || quotedInBase,
    { priceFeedQuote: reward?.priceFeedQuote ?? null, collateralValueQuote: market.collateralValueQuote },
  ));
  /*
   * Transaction history is read from one range of logs covering a market and
   * the rewards contract its claims are emitted by, so a market whose history
   * is served must name that contract. Without it the market would be
   * addressable and answer an empty page, which is indistinguishable from a
   * market nobody has used. The capability is a reviewed decision, made after
   * the import, so this is checked over the stored rows.
   */
  results.push(check(
    'transaction-history-requires-rewards-contract',
    scope,
    !market.capabilities.transactionHistory || market.contracts.rewards !== null,
    { transactionHistory: market.capabilities.transactionHistory, rewards: market.contracts.rewards },
  ));

  // rewards cannot be priced without a feed, so the capability must be off
  results.push(check(
    'rewards-capability-has-feed',
    scope,
    !market.capabilities.rewards || (reward !== null && reward.priceFeed !== null),
    { rewards: market.capabilities.rewards, priceFeed: reward?.priceFeed ?? null },
  ));
  /*
   * Nor without the rewards contract: the token a market pays is read through
   * it (catalog.ts, cometOf), and a market served with rewards but without
   * one fails the routes that serve them, every market of the answer with it.
   * No import writes such a market, since it reads the token through that
   * contract too; this keeps any version that holds one from being served.
   */
  results.push(check(
    'rewards-capability-has-contract',
    scope,
    !market.capabilities.rewards || market.contracts.rewards !== null,
    { rewards: market.capabilities.rewards, rewardsContract: market.contracts.rewards },
  ));
  /*
   * What an account is owed is read from the rewards contract, in the token
   * it pays, and nothing stands in for either where a market lacks it: a
   * market whose account rewards are served must have both.
   */
  results.push(check(
    'account-rewards-have-token',
    scope,
    !market.capabilities.accountRewards || (market.contracts.rewards !== null && reward !== null),
    { accountRewards: market.capabilities.accountRewards, rewards: market.contracts.rewards, token: reward?.token.address ?? null },
  ));

  const indices = market.collateralAssets.map(asset => asset.assetIndex);
  results.push(check(
    'collateral-indices-contiguous',
    scope,
    indices.every((index, position) => index === position),
    { assetIndices: indices },
  ));
  const collateralAddresses = market.collateralAssets.map(asset => asset.token.address);
  results.push(check(
    'collateral-assets-distinct',
    scope,
    new Set(collateralAddresses).size === collateralAddresses.length,
    { collateralAssets: collateralAddresses },
  ));
  results.push(check(
    'collateral-excludes-base-asset',
    scope,
    !collateralAddresses.includes(market.baseAsset.token.address),
    { baseAsset: market.baseAsset.token.address },
  ));

  /*
   * History and indexes start from the creation block, so a market the API
   * serves must state it. One that is disabled is not served; a market
   * nobody has reviewed is disabled and does not know it yet.
   */
  results.push(check(
    'creation-block-known',
    scope,
    market.status === 'disabled' || market.creationBlock > 0,
    { creationBlock: market.creationBlock, status: market.status },
  ));
  results.push(check(
    'comet-contract-declared',
    scope,
    market.contracts.comet !== null,
  ));
  // a deprecated or disabled market stays in the snapshot, but cannot be the
  // one the frontend opens by default
  results.push(check(
    'default-market-is-enabled',
    scope,
    !market.isDefault || market.status === 'enabled',
    { isDefault: market.isDefault, status: market.status },
  ));

  return results;
}

function validateNetwork(network: NetworkV1, reviewed: boolean): CheckResult[] {
  const scope   = `network:${network.chainId}`;
  const results: CheckResult[] = [];

  results.push(check('network-has-markets', scope, network.markets.length > 0));

  /*
   * A network that serves a market is offered under its name and its
   * presentation, so someone has to have decided them: one nobody reviewed
   * carries the provisional overlay — its canonical name, nothing presented,
   * no exceptions. A network whose every market is disabled serves nothing
   * and is not listed, so it needs no decision yet: a chain the source has
   * just added arrives that way, and does not hold the rest of the version
   * back.
   *
   * Wherever validation asks, a candidate's market is served by its status
   * alone, not as the catalog has it (isServed): one without a Comet still
   * counts, and fails comet-contract-declared.
   */
  const served = network.markets.filter(market => market.status !== 'disabled').map(market => market.deploymentKey);
  results.push(check('served-network-reviewed', scope, reviewed || served.length === 0, { served }));

  const comets = network.markets.map(market => market.contracts.comet);
  results.push(check(
    'comet-addresses-unique',
    scope,
    new Set(comets).size === comets.length,
    { comets },
  ));

  /*
   * The frontend addresses a market of a network by its slug, or by its label
   * where it has none, so no two markets it lists may answer to the same one:
   * the second would be unreachable, and a link to it would open the first.
   * Two markets may share a label only if a slug tells them apart. A disabled
   * market is not listed, so it takes no key.
   */
  const listingKeys = network.markets
    .filter(market => market.status !== 'disabled')
    .map(market => (market.slug ?? market.displayName).toLowerCase());
  results.push(check(
    'market-listing-keys-unique',
    scope,
    new Set(listingKeys).size === listingKeys.length,
    { listingKeys: listingKeys.filter((key, index) => listingKeys.indexOf(key) !== index) },
  ));

  return results;
}

/*
 * Every check of one candidate. The caller persists the results and uses
 * hasFailures to decide between validated and invalid.
 */
function validateCandidate({ networks, roots, unreviewedNetworks = [] }: CandidateInput): CheckResult[] {
  const results: CheckResult[] = [];

  results.push(check('networks-present', 'global', networks.length > 0));

  if (roots !== undefined) {
    /*
     * Every root the run checkpointed must have produced a market. Roots are
     * matched with the markets the candidate holds, not counted: a count of
     * finished checkpoints says what the run did, and only the rows say what
     * the candidate is.
     */
    const held = new Set(networks.flatMap(network => network.markets.map(
      market => `${network.upstreamKey}/${market.deploymentKey}`,
    )));
    const missing = roots
      .map(root => `${root.upstreamNetworkKey}/${root.deploymentKey}`)
      .filter(root => !held.has(root));
    results.push(check(
      ALL_ROOTS_CHECK,
      'global',
      missing.length === 0,
      { expected: roots.length, imported: roots.length - missing.length, missing },
    ));
  }

  const defaults = networks.flatMap(network => network.markets
    .filter(market => market.isDefault)
    .map(market => marketKey(network.chainId, market.deploymentKey)));
  results.push(check('single-default-market', 'global', defaults.length === 1, { defaults }));

  for (const network of networks) {
    results.push(...validateNetwork(network, !unreviewedNetworks.includes(network.chainId)));
    for (const market of network.markets) {
      results.push(...validateMarket(network, market));
    }
  }

  return results;
}

function hasFailures(results: CheckResult[]): boolean {
  return results.some(result => result.passed === 0);
}

function failures(results: CheckResult[]): CheckResult[] {
  return results.filter(result => result.passed === 0);
}

/*
 * A stored candidate, checked: every check over its rows, the attempt the
 * results are to be recorded as, and the revision the candidate was read at.
 * Nothing is written here; verdictStatements writes it.
 *
 * The scheduled import and an operator's validate both decide a candidate
 * this way, so the two cannot drift apart in what they read or record.
 */
type Verdict = {
  versionId: string,
  attempt:   number,
  revision:  number,
  results:   CheckResult[],
  // the snapshot checksum, when every check passed
  checksum:  string | null,
  // every root the run checkpointed produced a market
  complete:  boolean,
};

async function judgeVersion(
  db: D1Database,
  versionId: string,
  roots: NonNullable<CandidateInput['roots']> | null,
): Promise<Verdict> {
  // read before the rows, so an overlay written while they are read moves it past them
  const { revision, attempt } = await readRevision(db, versionId);
  const [ networks, unreviewed ] = await Promise.all([ readSnapshot(db, versionId), readUnreviewed(db, versionId) ]);
  const results = validateCandidate({
    networks,
    unreviewedNetworks: unreviewed.networks,
    ...(roots === null ? {} : { roots }),
  });
  return {
    versionId,
    attempt:  attempt + 1,
    revision,
    results,
    checksum: hasFailures(results) ? null : await snapshotChecksum(networks),
    complete: !results.some(result => result.check_name === ALL_ROOTS_CHECK && result.passed === 0),
  };
}

/*
 * What a verdict decides, as statements to commit in one transaction: the
 * attempt's results and, unless the candidate is held for review, the status
 * they decide. Both require `when` — that whoever decides it still may — and
 * the candidate to be at the revision it was checked at: checks of rows an
 * overlay has since changed are not recorded, and no status is decided by
 * them.
 */
function verdictStatements(
  db: D1Database,
  verdict: Verdict,
  options: { hold: boolean, when: Condition, at: string },
): D1PreparedStatement[] {
  const condition = both(options.when, unchanged(verdict.versionId, verdict.revision));
  return [
    validationResultsStatement(db, verdict.versionId, verdict.attempt, verdict.results, options.at, condition),
    ...(options.hold ? [] : [ endCandidateStatement(
      db,
      verdict.versionId,
      verdict.checksum === null ? { status: 'invalid' } : { status: 'validated', checksum: verdict.checksum },
      options.at,
      condition,
    ) ]),
  ];
}

export type { CandidateInput, CheckResult, Verdict };

export {
  ALL_ROOTS_CHECK,
  failures,
  hasFailures,
  judgeVersion,
  validateCandidate,
  verdictStatements,
};
