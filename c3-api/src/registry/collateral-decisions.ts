import {
  ActiveMarketV1,
  ActiveNetworkV1,
  ServedMarket,
  ServedNetwork,
  isAddress,
  isChainId,
  normalizeAddress,
} from '../../lib/model/comet-registry.js';

import type { CacheDeps } from './cache.js';
import type { CollateralDecisionKind, CollateralOfComet } from './collateral-decision-repository.js';
import { DEPRECATED_COLLATERAL_KIND, HIDDEN_COLLATERAL_KIND, collateralKey } from './collateral-decision-repository.js';
import type { DecisionSet, RecordedKind } from './decision-records.js';
import { digestOf, markedDecisions } from './decision-records.js';
import { readMarked } from './decision-store.js';

/*
 * The decisions about collaterals of Comets that the active reads carry:
 * which collaterals of which Comets an administrator has marked deprecated,
 * and which ones hidden (collateral-decision-repository.ts), merged into the
 * active version's markets when an answer is made. The two kinds are read,
 * recorded, marked and answered with during an outage the same way, each
 * under a record and a flag of its own (recordedKind, markedMarket), so what
 * is said here of the decisions is said of either kind's.
 *
 * A decision is no part of the version — it outlives every activation — so
 * the version stays cached as it was imported (cache.ts), and the decisions
 * are read beside it on every request, each kind's in one statement. An
 * answer names the flags it carries in its ETag, so a client holding a copy
 * made before a decision is sent the new one rather than told its copy is
 * current.
 *
 * During an outage the version is the one D1 last named (cache.ts), and the
 * flags are the decisions the Worker last recorded in KV
 * (decision-records.ts). Such an answer says it could not be confirmed, as
 * every answer from the cache does.
 */

// the collateral an entry of a record names, its addresses lowercase as a decision names them
function recordedCollateral(entry: unknown): CollateralOfComet | null {
  const collateral = entry as Partial<CollateralOfComet> | null;
  return collateral !== null && typeof(collateral) === 'object'
    && isChainId(collateral.chainId) && isAddress(collateral.cometAddress) && isAddress(collateral.tokenAddress)
    ? {
        chainId:      collateral.chainId,
        cometAddress: normalizeAddress(collateral.cometAddress),
        tokenAddress: normalizeAddress(collateral.tokenAddress),
      }
    : null;
}

// the record of a kind of decision about a collateral, as the kind describes it (collateral-decision-repository.ts)
function recordedKind<Flag extends string, Column extends string, Rows extends string>(
  kind: CollateralDecisionKind<Flag, Column, Rows>,
): RecordedKind<CollateralOfComet> {
  return {
    key:       kind.recordKey,
    noun:      kind.label,
    member:    'collaterals',
    read:      db => readMarked(db, kind.tables),
    keyOf:     collateralKey,
    subjectOf: recordedCollateral,
  };
}

const DEPRECATED_RECORD = recordedKind(DEPRECATED_COLLATERAL_KIND);
const HIDDEN_RECORD     = recordedKind(HIDDEN_COLLATERAL_KIND);

const DEPRECATED_KEY = DEPRECATED_COLLATERAL_KIND.recordKey;
const HIDDEN_KEY     = HIDDEN_COLLATERAL_KIND.recordKey;

// the decisions of each kind the active reads mark collaterals with
type CollateralMarks = { deprecated: DecisionSet<CollateralOfComet>, hidden: DecisionSet<CollateralOfComet> };

/*
 * Both kinds' decisions, for the active reads, which mark every collateral
 * with each: read side by side, each kind by a statement of its own, and said
 * to come from a record where either kind's did. A kind that could not be
 * read fails the read, the deprecated kind first. /summary, which answers
 * without a kind it could not read, reads each kind apart.
 */
async function readMarks(deps: CacheDeps): Promise<{ marks: CollateralMarks, recorded: boolean }> {
  const [ deprecated, hidden ] = await Promise.allSettled([ markedDecisions(DEPRECATED_RECORD, deps), markedDecisions(HIDDEN_RECORD, deps) ]);
  if (deprecated.status === 'rejected') {
    throw deprecated.reason;
  }
  if (hidden.status === 'rejected') {
    throw hidden.reason;
  }
  return {
    marks:    { deprecated: deprecated.value.decisions, hidden: hidden.value.decisions },
    recorded: deprecated.value.recorded || hidden.value.recorded,
  };
}

/*
 * A market as the active reads serve it: every collateral says whether it is
 * deprecated in this Comet, and whether it is hidden there. The version's own
 * objects are left as they are, since the cache hands one snapshot to every
 * request of an isolate.
 */
function markedMarket(chainId: number, market: ServedMarket, { deprecated, hidden }: CollateralMarks): ActiveMarketV1 {
  const comet = market.contracts.comet;
  return {
    ...market,
    collateralAssets: market.collateralAssets.map(asset => {
      const collateral = { chainId, cometAddress: comet, tokenAddress: asset.token.address };
      return { ...asset, isDeprecated: deprecated.has(collateral), isHidden: hidden.has(collateral) };
    }),
  };
}

function markedNetwork(network: ServedNetwork, marks: CollateralMarks): ActiveNetworkV1 {
  return { ...network, markets: network.markets.map(market => markedMarket(network.chainId, market, marks)) };
}

/*
 * The representation an answer that carries the flags is tagged by: its name,
 * and for each flag a digest of the collaterals it flags, the deprecated ones
 * first. The version's id and checksum name the rest of it (handlers.ts,
 * etagOf), but the flags change without a new version, so a decision that
 * changes what an answer flags changes its tag. A decision about a collateral
 * the answer does not list leaves both as they are.
 */
function markedRepresentation(name: string, networks: Array<{ chainId: number, markets: ActiveMarketV1[] }>): string {
  const flagged = (flag: 'isDeprecated' | 'isHidden') => networks.flatMap(network => network.markets.flatMap(market => market.collateralAssets
    .filter(asset => asset[flag])
    .map(asset => collateralKey({ chainId: network.chainId, cometAddress: market.contracts.comet, tokenAddress: asset.token.address }))));
  return `${name}+deprecated-${digestOf(flagged('isDeprecated'))}+hidden-${digestOf(flagged('isHidden'))}`;
}

export type { CollateralMarks };
export {
  DEPRECATED_KEY,
  DEPRECATED_RECORD,
  HIDDEN_KEY,
  HIDDEN_RECORD,
  markedMarket,
  markedNetwork,
  markedRepresentation,
  readMarks,
};
