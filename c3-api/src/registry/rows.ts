import type {
  Address,
  AssetRole,
  ContractRole,
  ExceptionKind,
  MarketStatus,
  PriceQuote,
} from '../../lib/model/comet-registry.js';

/*
 * The rows of the APP_DB tables, as the migrations create them, and the
 * closed value sets of their columns that only the registry modules read.
 * They are kept here rather than in lib/model/comet-registry.ts, which holds
 * the wire contract and what the computations read: nothing outside
 * src/registry reads a row, so a change to one stays out of lib/.
 */
const VERSION_STATUSES   = [ 'importing', 'invalid', 'validated' ] as const;
const SYNC_TRIGGER_KINDS = [ 'scheduled', 'manual' ] as const;
const SYNC_RUN_STATUSES  = [ 'running', 'failed', 'completed' ] as const;
const SYNC_OUTCOMES      = [ 'imported', 'no_change' ] as const;
const SYNC_ITEM_STATUSES = [ 'pending', 'processing', 'completed', 'failed' ] as const;

type VersionStatus   = (typeof VERSION_STATUSES)[number];
type SyncTriggerKind = (typeof SYNC_TRIGGER_KINDS)[number];
type SyncRunStatus   = (typeof SYNC_RUN_STATUSES)[number];
type SyncOutcome     = (typeof SYNC_OUTCOMES)[number];
type SyncItemStatus  = (typeof SYNC_ITEM_STATUSES)[number];

/*
 * D1 rows. Booleans are INTEGER 0 or 1 and every nullable column is
 * explicitly nullable, matching the migrations.
 *
 * `reviewed` says whether someone made the decisions a network or market row
 * carries (0002). The column defaults to 1, which SQLite needs to add it to a
 * table that has rows, so a row inserted without it would claim a review
 * nobody made; the row types require it, and so every write states it.
 */
type RegistryVersionRow = {
  id:                string,
  source_repository: string,
  source_commit_sha: string,
  source_checksum:   string,
  snapshot_checksum: string | null,
  attempt:           number,
  status:            VersionStatus,
  created_at:        string,
  validated_at:      string | null,
  created_by:        string,
};

type RegistryNetworkRow = {
  id:                   string,
  registry_version_id:  string,
  chain_id:             number,
  upstream_network_key: string,
  canonical_name:       string,
  display_name:         string,
  is_testnet:           number,
  metadata:             string,
  reviewed:             number,
};

type MarketRow = {
  id:                          string,
  registry_version_id:         string,
  network_id:                  string,
  deployment_key:              string,
  display_name:                string,
  slug:                        string | null,
  contract_name:               string | null,
  creation_block:              number,
  status:                      MarketStatus,
  is_default:                  number,
  is_institutional:            number,
  rewards_enabled:             number,
  account_rewards_enabled:     number,
  transaction_history_enabled: number,
  collateral_value_quote:      PriceQuote,
  reviewed:                    number,
};

type TokenRow = {
  id:                  string,
  registry_version_id: string,
  network_id:          string,
  address:             Address,
  symbol:              string,
  name:                string,
  decimals:            number,
};

type MarketContractRow = {
  id?:       number,
  market_id: string,
  role:      ContractRole,
  address:   Address,
};

type MarketAssetRow = {
  id?:                     number,
  registry_version_id:     string,
  network_id:              string,
  market_id:               string,
  token_id:                string,
  role:                    AssetRole,
  asset_index:             number | null,
  price_feed_address:      Address | null,
  price_feed_decimals:     number | null,
  price_feed_quote:        PriceQuote | null,
  usd_price_feed_address:  Address | null,
  usd_price_feed_decimals: number | null,
  display_name:            string | null,
  is_wrapped_native:       number | null,
};

type NetworkPriceExceptionRow = {
  id?:                             number,
  registry_version_id:             string,
  network_id:                      string,
  price_feed_address:              Address,
  kind:                            ExceptionKind,
  fixed_price_value:               string | null,
  fixed_price_decimals:            number | null,
  replacement_price_feed_address:  Address | null,
  replacement_price_feed_decimals: number | null,
  provenance:                      string,
  expires_at:                      string | null,
};

type ValidationResultRow = {
  id?:                 number,
  registry_version_id: string,
  validation_attempt:  number,
  check_name:          string,
  scope:               string,
  passed:              number,
  details:             string,
  created_at:          string,
};

type RegistryOverlayEventRow = {
  id:                  string,
  registry_version_id: string,
  scope_type:          'network' | 'market',
  scope_key:           string,
  previous_digest:     string | null,
  new_digest:          string,
  actor:               string,
  reason:              string,
  created_at:          string,
};

type RegistryApprovalRow = {
  id:                  string,
  registry_version_id: string,
  snapshot_checksum:   string,
  active_version_id:   string | null,
  actor:               string,
  reason:              string,
  created_at:          string,
  expires_at:          string,
};

type SyncRunRow = {
  id:                  string,
  source_commit_sha:   string,
  tracked_ref:         string | null,
  registry_version_id: string | null,
  trigger_kind:        SyncTriggerKind,
  requested_by:        string | null,
  reason:              string | null,
  status:              SyncRunStatus,
  outcome:             SyncOutcome | null,
  lease_owner:         string | null,
  lease_expires_at:    string | null,
  expected_count:      number,
  completed_count:     number,
  failed_count:        number,
  last_error:          string | null,
  started_at:          string,
  completed_at:        string | null,
  hold_for_review:     number,
};

type SyncRunItemRow = {
  id:                   string,
  sync_run_id:          string,
  root_path:            string,
  source_blob_sha:      string,
  upstream_network_key: string,
  deployment_key:       string,
  status:               SyncItemStatus,
  attempts:             number,
  claim_owner:          string | null,
  claimed_at:           string | null,
  completed_at:         string | null,
  last_error:           string | null,
  created_at:           string,
  updated_at:           string,
};

/*
 * The tables the registry writes row by row, with the row each one takes, so
 * a write names its table and is checked against that table's columns.
 */
type RegistryTables = {
  registry_versions:        RegistryVersionRow,
  registry_networks:        RegistryNetworkRow,
  network_price_exceptions: NetworkPriceExceptionRow,
  markets:                  MarketRow,
  tokens:                   TokenRow,
  market_contracts:         MarketContractRow,
  market_assets:            MarketAssetRow,
  registry_overlay_events:  RegistryOverlayEventRow,
};

/*
 * Token policies, from migrations/0005_token_policies.sql: the decisions an
 * administrator makes about a token, kept by chain id and address rather than
 * on a versioned row, so that they outlive every activation.
 */
type TokenPolicyRow = {
  chain_id:      number,
  token_address: Address,
  is_strategic:  number,
  updated_at:    string,
  updated_by:    string,
};

type TokenPolicyEventRow = {
  id:                    string,
  chain_id:              number,
  token_address:         Address,
  previous_is_strategic: number | null,
  is_strategic:          number,
  actor:                 string,
  reason:                string,
  created_at:            string,
};

/*
 * The decisions about a collateral of a Comet, a table a kind, which differ in
 * the name of the flag alone (`Flag`): deprecated collaterals, from
 * migrations/0006_legacy_collaterals.sql under the names
 * 0007_deprecated_collaterals.sql gave them, and hidden collaterals, from
 * migrations/0008_hidden_collaterals.sql. They are kept by chain id, Comet
 * address and token address rather than on a versioned row, so that they
 * outlive every activation as token policies do.
 */
type CollateralDecisionRow<Flag extends string> = {
  chain_id:      number,
  comet_address: Address,
  token_address: Address,
} & Record<Flag, number> & {
  updated_at:    string,
  updated_by:    string,
};

type CollateralDecisionEventRow<Flag extends string> = {
  id:            string,
  chain_id:      number,
  comet_address: Address,
  token_address: Address,
} & Record<`previous_${Flag}`, number | null> & Record<Flag, number> & {
  actor:         string,
  reason:        string,
  created_at:    string,
};

type DeprecatedCollateralRow      = CollateralDecisionRow<'is_deprecated'>;
type DeprecatedCollateralEventRow = CollateralDecisionEventRow<'is_deprecated'>;
type HiddenCollateralRow          = CollateralDecisionRow<'is_hidden'>;
type HiddenCollateralEventRow     = CollateralDecisionEventRow<'is_hidden'>;

export type {
  CollateralDecisionEventRow,
  CollateralDecisionRow,
  DeprecatedCollateralEventRow,
  DeprecatedCollateralRow,
  HiddenCollateralEventRow,
  HiddenCollateralRow,
  MarketAssetRow,
  MarketContractRow,
  MarketRow,
  NetworkPriceExceptionRow,
  RegistryApprovalRow,
  RegistryNetworkRow,
  RegistryOverlayEventRow,
  RegistryTables,
  RegistryVersionRow,
  SyncItemStatus,
  SyncOutcome,
  SyncRunItemRow,
  SyncRunRow,
  SyncRunStatus,
  SyncTriggerKind,
  TokenPolicyEventRow,
  TokenPolicyRow,
  ValidationResultRow,
  VersionStatus,
};
export { VERSION_STATUSES };
