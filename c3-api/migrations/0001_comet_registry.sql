-- Migration number: 0001    2026-09-21T18:26:34.867Z
-- Comet registry schema for the shared APP_DB database.
--
-- Registry versions are immutable snapshots of Comet markets built from one
-- pinned commit of the Comet repository. A version stays mutable only while
-- it is importing, becomes validated or invalid exactly once, and a singleton
-- pointer selects the active validated version.
--
-- Conventions this file follows (the test migration helper relies on them):
-- every statement ends with a semicolon at the end of a line, and every
-- trigger body ends with a line containing only END followed by a semicolon.
-- D1 always enforces foreign keys, so no PRAGMA is needed.

CREATE TABLE registry_versions (
  id                 TEXT PRIMARY KEY,
  source_repository  TEXT NOT NULL CHECK (
    length(source_repository) > 2
    AND source_repository = lower(source_repository)
    AND instr(source_repository, '/') > 1
  ),
  source_commit_sha  TEXT NOT NULL CHECK (
    length(source_commit_sha) = 40 AND source_commit_sha NOT GLOB '*[^0-9a-f]*'
  ),
  source_checksum    TEXT NOT NULL CHECK (
    length(source_checksum) = 64 AND source_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  snapshot_checksum  TEXT CHECK (
    snapshot_checksum IS NULL
    OR (length(snapshot_checksum) = 64 AND snapshot_checksum NOT GLOB '*[^0-9a-f]*')
  ),
  attempt            INTEGER NOT NULL CHECK (attempt > 0),
  status             TEXT NOT NULL CHECK (status IN ('importing', 'invalid', 'validated')),
  created_at         TEXT NOT NULL,
  validated_at       TEXT,
  created_by         TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  UNIQUE (source_repository, source_commit_sha, source_checksum, attempt),
  CHECK (status <> 'validated' OR (snapshot_checksum IS NOT NULL AND validated_at IS NOT NULL)),
  CHECK (status = 'validated' OR validated_at IS NULL)
) STRICT;

CREATE INDEX registry_versions_status_created
  ON registry_versions (status, created_at);

CREATE TABLE registry_state (
  singleton_id              INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  active_version_id         TEXT REFERENCES registry_versions (id) ON DELETE RESTRICT,
  last_upstream_checked_at  TEXT,
  updated_at                TEXT NOT NULL
) STRICT;

INSERT INTO registry_state (singleton_id, active_version_id, last_upstream_checked_at, updated_at)
VALUES (1, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE registry_networks (
  id                    TEXT PRIMARY KEY,
  registry_version_id   TEXT NOT NULL REFERENCES registry_versions (id) ON DELETE CASCADE,
  chain_id              INTEGER NOT NULL CHECK (chain_id > 0 AND chain_id <= 9007199254740991),
  upstream_network_key  TEXT NOT NULL CHECK (
    length(upstream_network_key) > 0
    AND upstream_network_key = lower(upstream_network_key)
    AND instr(upstream_network_key, '/') = 0
  ),
  canonical_name        TEXT NOT NULL CHECK (length(canonical_name) > 0),
  display_name          TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  is_testnet            INTEGER NOT NULL DEFAULT 0 CHECK (is_testnet IN (0, 1)),
  metadata              TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(metadata) AND json_type(metadata) = 'object'
  ),
  UNIQUE (id, registry_version_id),
  UNIQUE (registry_version_id, chain_id),
  UNIQUE (registry_version_id, canonical_name)
) STRICT;

CREATE TABLE network_price_exceptions (
  id                               INTEGER PRIMARY KEY,
  registry_version_id              TEXT NOT NULL REFERENCES registry_versions (id) ON DELETE CASCADE,
  network_id                       TEXT NOT NULL,
  price_feed_address               TEXT NOT NULL CHECK (
    length(price_feed_address) = 42
    AND substr(price_feed_address, 1, 2) = '0x'
    AND substr(price_feed_address, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  kind                             TEXT NOT NULL CHECK (
    kind IN ('zero_price', 'fixed_price', 'deprecated_price_remap')
  ),
  fixed_price_value                TEXT CHECK (
    fixed_price_value IS NULL
    OR (length(fixed_price_value) > 0 AND fixed_price_value NOT GLOB '*[^0-9]*')
  ),
  fixed_price_decimals             INTEGER CHECK (
    fixed_price_decimals IS NULL OR fixed_price_decimals BETWEEN 0 AND 255
  ),
  replacement_price_feed_address   TEXT CHECK (
    replacement_price_feed_address IS NULL
    OR (
      length(replacement_price_feed_address) = 42
      AND substr(replacement_price_feed_address, 1, 2) = '0x'
      AND substr(replacement_price_feed_address, 3) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  replacement_price_feed_decimals  INTEGER CHECK (
    replacement_price_feed_decimals IS NULL OR replacement_price_feed_decimals BETWEEN 0 AND 255
  ),
  provenance                       TEXT NOT NULL CHECK (
    length(trim(provenance)) > 0 AND length(provenance) <= 1000
  ),
  expires_at                       TEXT,
  UNIQUE (registry_version_id, network_id, price_feed_address),
  FOREIGN KEY (network_id, registry_version_id)
    REFERENCES registry_networks (id, registry_version_id) ON DELETE CASCADE,
  CHECK ((kind = 'fixed_price') = (fixed_price_value IS NOT NULL AND fixed_price_decimals IS NOT NULL)),
  CHECK (kind = 'fixed_price' OR (fixed_price_value IS NULL AND fixed_price_decimals IS NULL)),
  CHECK (
    (kind = 'deprecated_price_remap')
    = (replacement_price_feed_address IS NOT NULL AND replacement_price_feed_decimals IS NOT NULL)
  ),
  CHECK (
    kind = 'deprecated_price_remap'
    OR (replacement_price_feed_address IS NULL AND replacement_price_feed_decimals IS NULL)
  ),
  CHECK (replacement_price_feed_address IS NULL OR replacement_price_feed_address <> price_feed_address)
) STRICT;

CREATE TABLE markets (
  id                           TEXT PRIMARY KEY,
  registry_version_id          TEXT NOT NULL REFERENCES registry_versions (id) ON DELETE CASCADE,
  network_id                   TEXT NOT NULL,
  deployment_key               TEXT NOT NULL CHECK (
    length(deployment_key) > 0 AND deployment_key NOT GLOB '*[^a-z0-9._-]*'
  ),
  display_name                 TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  contract_name                TEXT CHECK (contract_name IS NULL OR length(trim(contract_name)) > 0),
  creation_block               INTEGER NOT NULL CHECK (
    creation_block >= 0 AND creation_block <= 9007199254740991
  ),
  status                       TEXT NOT NULL CHECK (status IN ('enabled', 'deprecated', 'disabled')),
  is_default                   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  rewards_enabled              INTEGER NOT NULL DEFAULT 1 CHECK (rewards_enabled IN (0, 1)),
  account_rewards_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (account_rewards_enabled IN (0, 1)),
  transaction_history_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (transaction_history_enabled IN (0, 1)),
  collateral_value_quote       TEXT NOT NULL CHECK (collateral_value_quote IN ('usd', 'base')),
  UNIQUE (id, registry_version_id, network_id),
  UNIQUE (registry_version_id, network_id, deployment_key),
  FOREIGN KEY (network_id, registry_version_id)
    REFERENCES registry_networks (id, registry_version_id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX markets_one_default_per_version
  ON markets (registry_version_id)
  WHERE is_default = 1;

CREATE INDEX markets_catalog_lookup
  ON markets (registry_version_id, network_id, status, creation_block, deployment_key);

CREATE TABLE tokens (
  id                   TEXT PRIMARY KEY,
  registry_version_id  TEXT NOT NULL REFERENCES registry_versions (id) ON DELETE CASCADE,
  network_id           TEXT NOT NULL,
  address              TEXT NOT NULL CHECK (
    length(address) = 42
    AND substr(address, 1, 2) = '0x'
    AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  symbol               TEXT NOT NULL CHECK (length(trim(symbol)) > 0),
  name                 TEXT NOT NULL CHECK (length(trim(name)) > 0),
  decimals             INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 255),
  UNIQUE (id, registry_version_id, network_id),
  UNIQUE (registry_version_id, network_id, address),
  FOREIGN KEY (network_id, registry_version_id)
    REFERENCES registry_networks (id, registry_version_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX tokens_network_symbol_lookup
  ON tokens (registry_version_id, network_id, symbol);

CREATE TABLE market_contracts (
  id         INTEGER PRIMARY KEY,
  market_id  TEXT NOT NULL REFERENCES markets (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (
    role IN ('comet', 'configurator', 'rewards', 'bulker', 'fauceteer', 'bridge_receiver')
  ),
  address    TEXT NOT NULL CHECK (
    length(address) = 42
    AND substr(address, 1, 2) = '0x'
    AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE (market_id, role)
) STRICT;

CREATE INDEX market_contracts_role_address_lookup
  ON market_contracts (role, address, market_id);

CREATE TABLE market_assets (
  id                       INTEGER PRIMARY KEY,
  registry_version_id      TEXT NOT NULL,
  network_id               TEXT NOT NULL,
  market_id                TEXT NOT NULL,
  token_id                 TEXT NOT NULL,
  role                     TEXT NOT NULL CHECK (role IN ('base', 'reward', 'collateral')),
  asset_index              INTEGER CHECK (asset_index IS NULL OR asset_index BETWEEN 0 AND 255),
  price_feed_address       TEXT CHECK (
    price_feed_address IS NULL
    OR (
      length(price_feed_address) = 42
      AND substr(price_feed_address, 1, 2) = '0x'
      AND substr(price_feed_address, 3) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  price_feed_decimals      INTEGER CHECK (
    price_feed_decimals IS NULL OR price_feed_decimals BETWEEN 0 AND 255
  ),
  price_feed_quote         TEXT CHECK (price_feed_quote IS NULL OR price_feed_quote IN ('usd', 'base')),
  usd_price_feed_address   TEXT CHECK (
    usd_price_feed_address IS NULL
    OR (
      length(usd_price_feed_address) = 42
      AND substr(usd_price_feed_address, 1, 2) = '0x'
      AND substr(usd_price_feed_address, 3) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  usd_price_feed_decimals  INTEGER CHECK (
    usd_price_feed_decimals IS NULL OR usd_price_feed_decimals BETWEEN 0 AND 255
  ),
  display_name             TEXT CHECK (display_name IS NULL OR length(trim(display_name)) > 0),
  is_wrapped_native        INTEGER CHECK (is_wrapped_native IS NULL OR is_wrapped_native IN (0, 1)),
  FOREIGN KEY (market_id, registry_version_id, network_id)
    REFERENCES markets (id, registry_version_id, network_id) ON DELETE CASCADE,
  FOREIGN KEY (token_id, registry_version_id, network_id)
    REFERENCES tokens (id, registry_version_id, network_id) ON DELETE RESTRICT,
  CHECK ((role = 'collateral') = (asset_index IS NOT NULL)),
  CHECK (role = 'reward' OR price_feed_address IS NOT NULL),
  CHECK ((price_feed_address IS NULL) = (price_feed_decimals IS NULL)),
  CHECK (role = 'reward' OR price_feed_quote IS NULL),
  CHECK (role <> 'reward' OR (price_feed_address IS NULL) = (price_feed_quote IS NULL)),
  CHECK (role = 'base' OR usd_price_feed_address IS NULL),
  CHECK ((usd_price_feed_address IS NULL) = (usd_price_feed_decimals IS NULL)),
  CHECK ((role = 'base') = (display_name IS NOT NULL)),
  CHECK ((role = 'base') = (is_wrapped_native IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX market_assets_single_base
  ON market_assets (market_id)
  WHERE role = 'base';

CREATE UNIQUE INDEX market_assets_single_reward
  ON market_assets (market_id)
  WHERE role = 'reward';

CREATE UNIQUE INDEX market_assets_collateral_index
  ON market_assets (market_id, asset_index)
  WHERE role = 'collateral';

CREATE INDEX market_assets_active_token_positions
  ON market_assets (registry_version_id, network_id, token_id, role);

CREATE INDEX market_assets_market_role_lookup
  ON market_assets (market_id, role);

CREATE TABLE validation_results (
  id                   INTEGER PRIMARY KEY,
  registry_version_id  TEXT NOT NULL REFERENCES registry_versions (id) ON DELETE CASCADE,
  validation_attempt   INTEGER NOT NULL CHECK (validation_attempt > 0),
  check_name           TEXT NOT NULL CHECK (length(check_name) > 0),
  scope                TEXT NOT NULL CHECK (length(scope) > 0),
  passed               INTEGER NOT NULL CHECK (passed IN (0, 1)),
  details              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
  created_at           TEXT NOT NULL,
  UNIQUE (registry_version_id, validation_attempt, check_name, scope)
) STRICT;

CREATE INDEX validation_results_attempt_summary
  ON validation_results (registry_version_id, validation_attempt, passed);

CREATE TABLE registry_overlay_events (
  id                   TEXT PRIMARY KEY,
  registry_version_id  TEXT NOT NULL REFERENCES registry_versions (id) ON DELETE RESTRICT,
  scope_type           TEXT NOT NULL CHECK (scope_type IN ('network', 'market')),
  scope_key            TEXT NOT NULL CHECK (length(scope_key) > 0),
  previous_digest      TEXT CHECK (
    previous_digest IS NULL
    OR (length(previous_digest) = 64 AND previous_digest NOT GLOB '*[^0-9a-f]*')
  ),
  new_digest           TEXT NOT NULL CHECK (
    length(new_digest) = 64 AND new_digest NOT GLOB '*[^0-9a-f]*'
  ),
  actor                TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  reason               TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 1000),
  created_at           TEXT NOT NULL
) STRICT;

CREATE INDEX registry_overlay_events_scope_history
  ON registry_overlay_events (registry_version_id, scope_type, scope_key, created_at);

CREATE TABLE registry_activations (
  id                   TEXT PRIMARY KEY,
  registry_version_id  TEXT NOT NULL REFERENCES registry_versions (id) ON DELETE RESTRICT,
  previous_version_id  TEXT REFERENCES registry_versions (id) ON DELETE RESTRICT,
  action               TEXT NOT NULL CHECK (action IN ('activate', 'rollback')),
  actor                TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  reason               TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 1000),
  created_at           TEXT NOT NULL,
  CHECK (previous_version_id IS NULL OR previous_version_id <> registry_version_id)
) STRICT;

CREATE INDEX registry_activations_target_history
  ON registry_activations (registry_version_id, created_at);

CREATE INDEX registry_activations_previous_history
  ON registry_activations (previous_version_id, created_at);

CREATE TABLE sync_runs (
  id                   TEXT PRIMARY KEY,
  source_commit_sha    TEXT NOT NULL CHECK (
    length(source_commit_sha) = 40 AND source_commit_sha NOT GLOB '*[^0-9a-f]*'
  ),
  tracked_ref          TEXT CHECK (tracked_ref IS NULL OR length(tracked_ref) > 0),
  registry_version_id  TEXT REFERENCES registry_versions (id) ON DELETE RESTRICT,
  trigger_kind         TEXT NOT NULL CHECK (trigger_kind IN ('scheduled', 'manual')),
  requested_by         TEXT CHECK (requested_by IS NULL OR length(trim(requested_by)) > 0),
  reason               TEXT CHECK (
    reason IS NULL OR (length(trim(reason)) > 0 AND length(reason) <= 1000)
  ),
  status               TEXT NOT NULL CHECK (status IN ('running', 'failed', 'completed')),
  outcome              TEXT CHECK (outcome IS NULL OR outcome IN ('imported', 'no_change')),
  lease_owner          TEXT,
  lease_generation     INTEGER NOT NULL DEFAULT 1 CHECK (lease_generation > 0),
  lease_expires_at     TEXT,
  expected_count       INTEGER NOT NULL DEFAULT 0 CHECK (expected_count >= 0),
  completed_count      INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  failed_count         INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  last_error           TEXT CHECK (last_error IS NULL OR length(last_error) <= 2000),
  started_at           TEXT NOT NULL,
  completed_at         TEXT,
  CHECK (completed_count + failed_count <= expected_count),
  CHECK ((status = 'completed') = (outcome IS NOT NULL)),
  CHECK ((status = 'running') = (completed_at IS NULL)),
  CHECK (trigger_kind = 'scheduled' OR requested_by IS NOT NULL),
  CHECK (tracked_ref IS NOT NULL OR reason IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX sync_runs_only_one_running
  ON sync_runs (status)
  WHERE status = 'running';

CREATE INDEX sync_runs_resumable_lookup
  ON sync_runs (status, lease_expires_at);

CREATE INDEX sync_runs_source_history
  ON sync_runs (source_commit_sha, started_at);

CREATE INDEX sync_runs_version_history
  ON sync_runs (registry_version_id, started_at);

CREATE TABLE sync_run_items (
  id                    TEXT PRIMARY KEY,
  sync_run_id           TEXT NOT NULL REFERENCES sync_runs (id) ON DELETE CASCADE,
  root_path             TEXT NOT NULL,
  source_blob_sha       TEXT NOT NULL CHECK (
    length(source_blob_sha) = 40 AND source_blob_sha NOT GLOB '*[^0-9a-f]*'
  ),
  root_checksum         TEXT NOT NULL CHECK (
    length(root_checksum) = 64 AND root_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  upstream_network_key  TEXT NOT NULL CHECK (
    length(upstream_network_key) > 0 AND instr(upstream_network_key, '/') = 0
  ),
  deployment_key        TEXT NOT NULL CHECK (
    length(deployment_key) > 0 AND instr(deployment_key, '/') = 0
  ),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'completed', 'failed')
  ),
  attempts              INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 100),
  claim_owner           TEXT,
  claim_generation      INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  claimed_at            TEXT,
  completed_at          TEXT,
  last_error            TEXT CHECK (last_error IS NULL OR length(last_error) <= 2000),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (sync_run_id, root_path),
  CHECK (root_path = 'deployments/' || upstream_network_key || '/' || deployment_key || '/roots.json'),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK (status = 'pending' OR claim_owner IS NOT NULL)
) STRICT;

CREATE INDEX sync_run_items_claim_lookup
  ON sync_run_items (sync_run_id, status, attempts, id);

CREATE INDEX sync_run_items_fence_lookup
  ON sync_run_items (sync_run_id, claim_generation, claim_owner);

-- Registry version lifecycle: importing -> importing | validated | invalid.

CREATE TRIGGER registry_versions_insert_importing
BEFORE INSERT ON registry_versions
WHEN NEW.status <> 'importing'
BEGIN
  SELECT RAISE(ABORT, 'registry versions must start as importing');
END;

CREATE TRIGGER registry_versions_terminal_immutable
BEFORE UPDATE ON registry_versions
WHEN OLD.status <> 'importing'
BEGIN
  SELECT RAISE(ABORT, 'validated and invalid registry versions are immutable');
END;

CREATE TRIGGER registry_versions_identity_immutable
BEFORE UPDATE ON registry_versions
WHEN NEW.id IS NOT OLD.id
  OR NEW.source_repository IS NOT OLD.source_repository
  OR NEW.source_commit_sha IS NOT OLD.source_commit_sha
  OR NEW.source_checksum IS NOT OLD.source_checksum
  OR NEW.attempt IS NOT OLD.attempt
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.created_by IS NOT OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'registry version identity and provenance are immutable');
END;

CREATE TRIGGER registry_versions_validated_requires_passing_checks
BEFORE UPDATE OF status ON registry_versions
WHEN OLD.status = 'importing'
  AND NEW.status = 'validated'
  AND (
    NOT EXISTS (SELECT 1 FROM validation_results WHERE registry_version_id = NEW.id)
    OR EXISTS (
      SELECT 1
      FROM validation_results AS result
      WHERE result.registry_version_id = NEW.id
        AND result.passed = 0
        AND result.validation_attempt = (
          SELECT max(validation_attempt) FROM validation_results WHERE registry_version_id = NEW.id
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'a validated registry version requires a fully passing latest validation attempt');
END;

CREATE TRIGGER registry_versions_invalid_requires_failed_check
BEFORE UPDATE OF status ON registry_versions
WHEN OLD.status = 'importing'
  AND NEW.status = 'invalid'
  AND NOT EXISTS (
    SELECT 1
    FROM validation_results AS result
    WHERE result.registry_version_id = NEW.id
      AND result.passed = 0
      AND result.validation_attempt = (
        SELECT max(validation_attempt) FROM validation_results WHERE registry_version_id = NEW.id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'an invalid registry version requires a failed check in its latest validation attempt');
END;

CREATE TRIGGER registry_versions_no_delete
BEFORE DELETE ON registry_versions
BEGIN
  SELECT RAISE(ABORT, 'registry versions cannot be deleted');
END;

-- Active version pointer: one seeded row that can only point at validated versions.

CREATE TRIGGER registry_state_singleton_insert
BEFORE INSERT ON registry_state
BEGIN
  SELECT RAISE(ABORT, 'registry_state is a seeded singleton');
END;

CREATE TRIGGER registry_state_no_delete
BEFORE DELETE ON registry_state
BEGIN
  SELECT RAISE(ABORT, 'registry_state is a seeded singleton');
END;

CREATE TRIGGER registry_state_singleton_key_immutable
BEFORE UPDATE OF singleton_id ON registry_state
WHEN NEW.singleton_id IS NOT OLD.singleton_id
BEGIN
  SELECT RAISE(ABORT, 'registry_state is a seeded singleton');
END;

CREATE TRIGGER registry_state_active_version_validated
BEFORE UPDATE OF active_version_id ON registry_state
WHEN NEW.active_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM registry_versions WHERE id = NEW.active_version_id AND status = 'validated'
  )
BEGIN
  SELECT RAISE(ABORT, 'the active registry version must be validated');
END;

CREATE TRIGGER registry_state_active_version_not_cleared
BEFORE UPDATE OF active_version_id ON registry_state
WHEN OLD.active_version_id IS NOT NULL AND NEW.active_version_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'the active registry version cannot be cleared');
END;

-- Versioned snapshot rows change only while their registry version is importing.

CREATE TRIGGER registry_networks_insert_requires_importing
BEFORE INSERT ON registry_networks
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = NEW.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER registry_networks_update_requires_importing
BEFORE UPDATE ON registry_networks
WHEN NEW.registry_version_id IS NOT OLD.registry_version_id
  OR EXISTS (SELECT 1 FROM registry_versions WHERE id = OLD.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER registry_networks_delete_requires_importing
BEFORE DELETE ON registry_networks
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = OLD.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER network_price_exceptions_insert_requires_importing
BEFORE INSERT ON network_price_exceptions
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = NEW.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER network_price_exceptions_update_requires_importing
BEFORE UPDATE ON network_price_exceptions
WHEN NEW.registry_version_id IS NOT OLD.registry_version_id
  OR EXISTS (SELECT 1 FROM registry_versions WHERE id = OLD.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER network_price_exceptions_delete_requires_importing
BEFORE DELETE ON network_price_exceptions
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = OLD.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER markets_insert_requires_importing
BEFORE INSERT ON markets
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = NEW.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER markets_update_requires_importing
BEFORE UPDATE ON markets
WHEN NEW.registry_version_id IS NOT OLD.registry_version_id
  OR EXISTS (SELECT 1 FROM registry_versions WHERE id = OLD.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER markets_delete_requires_importing
BEFORE DELETE ON markets
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = OLD.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER tokens_insert_requires_importing
BEFORE INSERT ON tokens
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = NEW.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER tokens_update_requires_importing
BEFORE UPDATE ON tokens
WHEN NEW.registry_version_id IS NOT OLD.registry_version_id
  OR EXISTS (SELECT 1 FROM registry_versions WHERE id = OLD.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER tokens_delete_requires_importing
BEFORE DELETE ON tokens
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = OLD.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER market_contracts_insert_requires_importing
BEFORE INSERT ON market_contracts
WHEN EXISTS (
  SELECT 1
  FROM markets AS market
  JOIN registry_versions AS version ON version.id = market.registry_version_id
  WHERE market.id = NEW.market_id AND version.status <> 'importing'
)
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER market_contracts_update_requires_importing
BEFORE UPDATE ON market_contracts
WHEN NEW.market_id IS NOT OLD.market_id
  OR EXISTS (
    SELECT 1
    FROM markets AS market
    JOIN registry_versions AS version ON version.id = market.registry_version_id
    WHERE market.id = OLD.market_id AND version.status <> 'importing'
  )
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER market_contracts_delete_requires_importing
BEFORE DELETE ON market_contracts
WHEN EXISTS (
  SELECT 1
  FROM markets AS market
  JOIN registry_versions AS version ON version.id = market.registry_version_id
  WHERE market.id = OLD.market_id AND version.status <> 'importing'
)
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER market_assets_insert_requires_importing
BEFORE INSERT ON market_assets
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = NEW.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER market_assets_update_requires_importing
BEFORE UPDATE ON market_assets
WHEN NEW.registry_version_id IS NOT OLD.registry_version_id
  OR EXISTS (SELECT 1 FROM registry_versions WHERE id = OLD.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER market_assets_delete_requires_importing
BEFORE DELETE ON market_assets
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = OLD.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

-- Append-only review and audit records.

CREATE TRIGGER validation_results_insert_requires_importing
BEFORE INSERT ON validation_results
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = NEW.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER validation_results_no_update
BEFORE UPDATE ON validation_results
BEGIN
  SELECT RAISE(ABORT, 'validation results are append-only');
END;

CREATE TRIGGER validation_results_no_delete
BEFORE DELETE ON validation_results
BEGIN
  SELECT RAISE(ABORT, 'validation results are append-only');
END;

CREATE TRIGGER registry_overlay_events_insert_requires_importing
BEFORE INSERT ON registry_overlay_events
WHEN EXISTS (SELECT 1 FROM registry_versions WHERE id = NEW.registry_version_id AND status <> 'importing')
BEGIN
  SELECT RAISE(ABORT, 'registry version is not importing');
END;

CREATE TRIGGER registry_overlay_events_no_update
BEFORE UPDATE ON registry_overlay_events
BEGIN
  SELECT RAISE(ABORT, 'registry overlay events are append-only');
END;

CREATE TRIGGER registry_overlay_events_no_delete
BEFORE DELETE ON registry_overlay_events
BEGIN
  SELECT RAISE(ABORT, 'registry overlay events are append-only');
END;

CREATE TRIGGER registry_activations_insert_requires_validated
BEFORE INSERT ON registry_activations
WHEN NOT EXISTS (
    SELECT 1 FROM registry_versions WHERE id = NEW.registry_version_id AND status = 'validated'
  )
  OR (
    NEW.previous_version_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM registry_versions WHERE id = NEW.previous_version_id AND status = 'validated'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'registry activations must reference validated versions');
END;

CREATE TRIGGER registry_activations_no_update
BEFORE UPDATE ON registry_activations
BEGIN
  SELECT RAISE(ABORT, 'registry activations are append-only');
END;

CREATE TRIGGER registry_activations_no_delete
BEFORE DELETE ON registry_activations
BEGIN
  SELECT RAISE(ABORT, 'registry activations are append-only');
END;
