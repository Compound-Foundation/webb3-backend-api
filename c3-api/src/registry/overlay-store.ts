import {
  Address,
  MARKET_KEY_SEPARATOR,
  MarketStatus,
  PriceQuote,
  marketKey,
} from '../../lib/model/comet-registry.js';

import {
  MarketOverlay,
  NetworkOverlay,
  overlayOfException,
  parseMarketOverlay,
  parseNetworkOverlay,
  storedInstant,
} from './overlay.js';
import { priceExceptionOfRow } from './repository.js';
import type { NetworkPriceExceptionRow } from './rows.js';
import type { SqlValue } from './sql-condition.js';

/*
 * The reviewed overlays of stored versions, read back from their rows: what
 * an overlay write compares a document with, what the overlay routes answer,
 * and what an import inherits. The documents and how they apply to a market
 * are overlay.ts.
 */

/*
 * The reviewed overlay of one stored version, keyed by chain id and by
 * market key (marketKey), which is how an import looks up the decisions made
 * for a market it rediscovers. `comets` is the Comet each market overlay was
 * made for: a key the source gives another Comet does not hand it them.
 */
type ClonedOverlays = {
  networks: Map<number, NetworkOverlay>,
  markets:  Map<string, MarketOverlay>,
  comets:   Map<string, Address | null>,
};

/*
 * An expiry as a version stored it. An overlay used to be stored with any
 * expiry Date.parse accepted, years before 0000 and after 9999 among them;
 * such a value is read as the instant a Worker reads it as, in the form an
 * expiry is stored in now, so a version that holds one can still be cloned.
 * Anything written now is already in that form.
 */
function storedExpiry(value: string | null): string | null {
  const instant = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(instant) ? storedInstant(instant) : value;
}

/*
 * The overlay a network's rows state: its row and its price exceptions, read
 * back through the parser as the document a PUT takes. Every reader of a
 * stored network overlay goes through it, so the digest a read answers is the
 * one a write compares its expectation with. An exception is the one the
 * snapshot serves (priceExceptionOfRow), as the decision it states.
 */
function networkOverlayOf(
  network: { display_name: string, metadata: string },
  exceptions: NetworkPriceExceptionRow[],
  scope: string,
): NetworkOverlay {
  const presentation = JSON.parse(network.metadata) as Record<string, unknown>;
  return parseNetworkOverlay({
    displayName:               network.display_name,
    assetDisplayOverrides:     presentation.assetDisplayOverrides ?? [],
    unwrappedCollateralAssets: presentation.unwrappedCollateralAssets ?? [],
    priceExceptions:           exceptions.map(row => overlayOfException({ ...priceExceptionOfRow(row), expiresAt: storedExpiry(row.expires_at) })),
  }, scope);
}

// a market's key as SQL computes it from the rows of its network and market: the text marketKey writes
function marketKeyIn(network: string, market: string): string {
  return `${network}.chain_id || '${MARKET_KEY_SEPARATOR}' || ${market}.deployment_key`;
}

/*
 * Whether a scope's overlay counts for a source: every reviewed one does,
 * unless the source is read for its edits, and then only the scopes an
 * overlay was written for in that version, which its audit events name.
 */
function countedIn(scopeType: 'network' | 'market', scopeKey: string): string {
  return `(sources.edited = 0 OR EXISTS (
    SELECT 1 FROM registry_overlay_events AS event
    WHERE event.registry_version_id = sources.id AND event.scope_type = '${scopeType}' AND event.scope_key = ${scopeKey}
  ))`;
}

/*
 * The reviewed overlays of the versions `sources` names, merged. `sources` is
 * the body of a common table expression selecting a version `id`, its
 * `precedence`, and whether it counts only for what was `edited` in it; a
 * version of higher precedence overrides a lower one for every network and
 * market both say something about. It is one batch, so one round trip
 * however many versions it reads.
 *
 * Only what someone reviewed is an overlay. A row written for a network or
 * market nobody reviewed carries provisional values, and cloning those into
 * the next version would turn them into decisions nobody made. Rows are read
 * back through the overlay parsers, which normalizes them and rejects a
 * version whose stored overlay no longer satisfies the contract.
 *
 * A version has one default market, and the versions merged here can each
 * name another; the default read at the highest precedence is the one kept,
 * and the market an earlier source made the default is merged as not being
 * it. Otherwise an import would write two defaults, which the schema refuses,
 * on every attempt of the commit.
 */
async function readOverlaysOf(db: D1Database, sources: string, values: SqlValue[]): Promise<ClonedOverlays> {
  const from = `WITH sources (id, precedence, edited) AS (${sources})`;
  const [ networkRows, exceptionRows, marketRows ] = await db.batch([
    db.prepare(
      `${from}
       SELECT sources.id AS version_id, sources.precedence, network.chain_id, network.display_name, network.metadata
       FROM registry_networks AS network
       JOIN sources ON sources.id = network.registry_version_id
       WHERE network.reviewed = 1 AND ${countedIn('network', 'CAST(network.chain_id AS TEXT)')}
       ORDER BY sources.precedence, network.chain_id`
    ).bind(...values),
    db.prepare(
      `${from}
       SELECT sources.precedence, network.chain_id AS chain_id, exception.*
       FROM network_price_exceptions AS exception
       JOIN registry_networks AS network ON network.id = exception.network_id
       JOIN sources ON sources.id = exception.registry_version_id
       WHERE network.reviewed = 1 AND ${countedIn('network', 'CAST(network.chain_id AS TEXT)')}
       ORDER BY sources.precedence, network.chain_id, exception.price_feed_address`
    ).bind(...values),
    db.prepare(
      `${from}
       SELECT sources.id AS version_id, sources.precedence, network.chain_id AS chain_id, market.deployment_key,
              market.display_name, market.slug, market.contract_name, market.is_default, market.is_institutional,
              market.status, market.creation_block, market.collateral_value_quote,
              market.rewards_enabled, market.account_rewards_enabled, market.transaction_history_enabled,
              base.display_name AS base_display_name, base.is_wrapped_native,
              base.usd_price_feed_address, reward.price_feed_address AS reward_price_feed_address,
              reward.price_feed_quote AS reward_price_feed_quote, comet.address AS comet
       FROM markets AS market
       JOIN registry_networks AS network ON network.id = market.network_id
       JOIN sources ON sources.id = market.registry_version_id
       LEFT JOIN market_assets AS base ON base.market_id = market.id AND base.role = 'base'
       LEFT JOIN market_assets AS reward ON reward.market_id = market.id AND reward.role = 'reward'
       LEFT JOIN market_contracts AS comet ON comet.market_id = market.id AND comet.role = 'comet'
       WHERE market.reviewed = 1 AND ${countedIn('market', marketKeyIn('network', 'market'))}
       ORDER BY sources.precedence, network.chain_id, market.creation_block, market.deployment_key`
    ).bind(...values),
  ]) as [
    D1Result<{ version_id: string, precedence: number, chain_id: number, display_name: string, metadata: string }>,
    D1Result<NetworkPriceExceptionRow & { precedence: number, chain_id: number }>,
    D1Result<{
      version_id: string, precedence: number, chain_id: number, deployment_key: string,
      display_name: string, slug: string | null, contract_name: string | null,
      is_default: number, is_institutional: number, status: MarketStatus, creation_block: number,
      collateral_value_quote: PriceQuote, rewards_enabled: number, account_rewards_enabled: number,
      transaction_history_enabled: number, base_display_name: string | null, is_wrapped_native: number | null,
      usd_price_feed_address: string | null, reward_price_feed_address: string | null,
      reward_price_feed_quote: PriceQuote | null, comet: Address | null,
    }>,
  ];

  /*
   * The exceptions of each network, by the precedence it was read at rather
   * than by version: the same version can be a source twice, as the active
   * one and as an earlier attempt, and each reading carries its own.
   */
  const exceptionsOf = new Map<string, NetworkPriceExceptionRow[]>();
  for (const row of exceptionRows.results ?? []) {
    const key = `${row.precedence}:${row.chain_id}`;
    exceptionsOf.set(key, [ ...(exceptionsOf.get(key) ?? []), row ]);
  }

  // rows arrive in precedence order, so a later version's review replaces an earlier one's
  const networks = new Map<number, NetworkOverlay>();
  for (const row of networkRows.results ?? []) {
    networks.set(row.chain_id, networkOverlayOf(
      row,
      exceptionsOf.get(`${row.precedence}:${row.chain_id}`) ?? [],
      `version ${row.version_id} network ${row.chain_id}`,
    ));
  }

  const markets = new Map<string, MarketOverlay>();
  const comets  = new Map<string, Address | null>();
  let defaultMarket: string | null = null;
  for (const row of marketRows.results ?? []) {
    const key     = marketKey(row.chain_id, row.deployment_key);
    const overlay = parseMarketOverlay({
      displayName:          row.display_name,
      slug:                 row.slug,
      contractName:         row.contract_name,
      isDefault:            row.is_default === 1,
      isInstitutional:      row.is_institutional === 1,
      status:               row.status,
      creationBlock:        row.creation_block,
      collateralValueQuote: row.collateral_value_quote,
      capabilities: {
        rewards:            row.rewards_enabled === 1,
        accountRewards:     row.account_rewards_enabled === 1,
        transactionHistory: row.transaction_history_enabled === 1,
      },
      baseAsset: {
        displayName:         row.base_display_name,
        isWrappedNative:     row.is_wrapped_native === 1,
        usdPriceFeedAddress: row.usd_price_feed_address,
      },
      rewardPriceFeed: row.reward_price_feed_address === null ? null : {
        address: row.reward_price_feed_address,
        quote:   row.reward_price_feed_quote,
      },
    }, `version ${row.version_id} market ${key}`);

    if (overlay.isDefault) {
      const replaced = defaultMarket === key ? null : defaultMarket;
      const previous = replaced === null ? undefined : markets.get(replaced);
      if (replaced !== null && previous !== undefined) {
        markets.set(replaced, { ...previous, isDefault: false });
      }
      defaultMarket = key;
    } else if (defaultMarket === key) {
      defaultMarket = null;
    }
    markets.set(key, overlay);
    comets.set(key, row.comet);
  }

  return { networks, markets, comets };
}

// the version that is on, as a source of overlays; none before the first activation
const ACTIVE_SOURCE = `SELECT active_version_id, 0, 0 FROM registry_state WHERE singleton_id = 1 AND active_version_id IS NOT NULL`;

/*
 * Rebuilds the reviewed overlay of a stored version: what an overlay write
 * compares a document with. An import reads what it inherits through
 * readImportOverlays.
 */
async function readOverlays(db: D1Database, versionId: string): Promise<ClonedOverlays> {
  return readOverlaysOf(db, `SELECT ?1, 0, 0`, [ versionId ]);
}

/*
 * The overlay one network of a version holds, and whether somebody reviewed
 * it, or null for a chain the version has not imported. A network nobody
 * reviewed holds the provisional overlay its import wrote. Both statements
 * find the network by its version and chain, so they are one round trip.
 */
async function readNetworkOverlay(
  db: D1Database,
  versionId: string,
  chainId: number,
): Promise<{ overlay: NetworkOverlay, reviewed: boolean } | null> {
  const target = `(SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = ?2)`;
  const [ networkRows, exceptionRows ] = await db.batch([
    db.prepare(`SELECT display_name, metadata, reviewed FROM registry_networks WHERE id = ${target}`),
    db.prepare(`SELECT * FROM network_price_exceptions WHERE network_id = ${target} ORDER BY price_feed_address`),
  ].map(statement => statement.bind(versionId, chainId))) as [
    D1Result<{ display_name: string, metadata: string, reviewed: number }>, D1Result<NetworkPriceExceptionRow>,
  ];

  const network = networkRows.results?.[0];
  return network === undefined ? null : {
    overlay:  networkOverlayOf(network, exceptionRows.results ?? [], `version ${versionId} network ${chainId}`),
    reviewed: network.reviewed === 1,
  };
}

/*
 * The overlay an import applies: what the active version says, with what was
 * reviewed for the earlier attempts at the same commit over it.
 *
 * An earlier attempt matters because a review happens in place, in the rows
 * of an importing candidate, and a candidate that ends invalid is frozen with
 * those rows in it. The next attempt at the same source inherits them rather
 * than asking for the same review again. A different commit does not: what
 * was reviewed for it and then activated is already the active version.
 *
 * What an earlier attempt contributes is what was reviewed for it: the
 * networks and markets an overlay was written for in that attempt. The rest
 * of its rows are marked reviewed too, but they are copies of the version
 * that was on when it was imported, and that version may have been replaced
 * since — by a hotfix, or by a rollback — so they would bring its decisions
 * back over the ones on now.
 *
 * What an attempt reviewed stops being handed down once it, or a later
 * attempt of the commit, has been switched on and off again. Switched on, an
 * attempt had validated, which closed every draft before it, so the reviews
 * it and those drafts hold were all made before it went on; the move that
 * switched it off, a rollback or a hotfix, was made against them, or the
 * version it put on carries them. A review still waiting to be switched on
 * keeps being handed down past moves that switched off another commit, or an
 * earlier attempt.
 *
 * Every earlier attempt is read, oldest first, so the newest review of a
 * market wins and one attempt that reviewed nothing — it failed on the chain
 * before anyone saw it — does not lose the review an attempt before it
 * carried.
 */
async function readImportOverlays(db: D1Database, versionId: string): Promise<ClonedOverlays> {
  return readOverlaysOf(db, `
    ${ACTIVE_SOURCE}
    UNION ALL
    SELECT previous.id, previous.attempt, 1
    FROM registry_versions AS current
    JOIN registry_versions AS previous
      ON previous.source_repository = current.source_repository
     AND previous.source_commit_sha = current.source_commit_sha
     AND previous.attempt < current.attempt
    WHERE current.id = ?1
      AND NOT EXISTS (
        SELECT 1 FROM registry_activations AS activation
        JOIN registry_versions AS replaced ON replaced.id = activation.previous_version_id
        WHERE replaced.source_repository = previous.source_repository
          AND replaced.source_commit_sha = previous.source_commit_sha
          AND replaced.attempt >= previous.attempt
      )`, [ versionId ]);
}

export type { ClonedOverlays };
export { readImportOverlays, readNetworkOverlay, readOverlays };
