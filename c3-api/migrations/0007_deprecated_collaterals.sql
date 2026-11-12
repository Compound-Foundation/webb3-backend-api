-- Migration number: 0007    2026-10-12T09:00:00.000Z
-- Deprecated collaterals: the legacy collaterals of 0006, under the name the
-- API gives them. A collateral an administrator has marked so is deprecated
-- in its Comet, and the database says so as well: both tables, their
-- columns, the view, and every index and trigger 0006 created take the name,
-- and the triggers abort with messages that say deprecated.
--
-- Nothing else changes. Every decision and every event is kept, each event
-- at the rowid that orders its collateral's history, and what 0006 says of
-- its objects holds for them as renamed: a decision row is written only
-- beside its collateral's newest event, which records exactly that change;
-- events are never edited, replaced or deleted, and a decision row is never
-- deleted.
--
-- The tables and their columns are renamed in place by ALTER TABLE, which
-- rewrites the schema and not one row, and which D1 and the local database
-- run as SQLite does, as they ran the DROP COLUMN of 0004. A copy into new
-- tables would write every event at a rowid of its choosing, and every
-- decision whatever the active version holds, which is what the triggers
-- refuse; it would have to run before they exist. An index, a trigger or a
-- view cannot be renamed, so each is dropped and created again under its new
-- name, as 0006 created it. They are dropped first, so that no rename has a
-- trigger or a view to rewrite, and what is created after the renames is
-- what 0006 would have created under these names.
--
-- The release before this migration reads and writes the tables by their old
-- names. From this migration until the deploy that follows, its token list,
-- /active, the market reads and its legacy collateral routes answer 503,
-- naming the migrations; no other route reads these tables.
--
-- Conventions follow 0001: every statement ends with a semicolon at the end
-- of a line, every trigger body ends with a line containing only END followed
-- by a semicolon, and D1 always enforces foreign keys.

DROP TRIGGER legacy_collateral_expectations_require_active_collateral;
DROP TRIGGER legacy_collateral_expectations_require_decision;
DROP VIEW legacy_collateral_expectations;

DROP TRIGGER legacy_collaterals_require_active_collateral_insert;
DROP TRIGGER legacy_collaterals_require_active_collateral_update;
DROP TRIGGER legacy_collaterals_require_event_insert;
DROP TRIGGER legacy_collaterals_require_event_update;
DROP TRIGGER legacy_collaterals_identity_immutable;
DROP TRIGGER legacy_collaterals_no_delete;
DROP TRIGGER legacy_collateral_events_no_update;
DROP TRIGGER legacy_collateral_events_no_delete;
DROP TRIGGER legacy_collateral_events_no_replace;
DROP TRIGGER legacy_collateral_events_assigned_rowid;

DROP INDEX legacy_collaterals_marked;
DROP INDEX legacy_collateral_events_collateral_history;

ALTER TABLE legacy_collaterals RENAME TO deprecated_collaterals;
ALTER TABLE deprecated_collaterals RENAME COLUMN is_legacy TO is_deprecated;

ALTER TABLE legacy_collateral_events RENAME TO deprecated_collateral_events;
ALTER TABLE deprecated_collateral_events RENAME COLUMN previous_is_legacy TO previous_is_deprecated;
ALTER TABLE deprecated_collateral_events RENAME COLUMN is_legacy TO is_deprecated;

-- the deprecated collaterals, of every chain or of one, without reading the rows that say otherwise
CREATE INDEX deprecated_collaterals_marked
  ON deprecated_collaterals (chain_id, comet_address, token_address)
  WHERE is_deprecated = 1;

-- one collateral's events, in rowid order, which every index entry ends with
CREATE INDEX deprecated_collateral_events_collateral_history
  ON deprecated_collateral_events (chain_id, comet_address, token_address);

-- A decision is made about a collateral of a market of the active registry
-- version: the token is one of the collateral assets of the market whose
-- Comet that version holds at that address on that chain.

CREATE TRIGGER deprecated_collaterals_require_active_collateral_insert
BEFORE INSERT ON deprecated_collaterals
WHEN NOT EXISTS (
  SELECT 1
  FROM registry_state AS state
  JOIN registry_networks AS network
    ON network.registry_version_id = state.active_version_id
  JOIN markets AS market
    ON market.registry_version_id = state.active_version_id
   AND market.network_id = network.id
  JOIN market_contracts AS contract
    ON contract.market_id = market.id
   AND contract.role = 'comet'
  JOIN market_assets AS asset
    ON asset.market_id = market.id
   AND asset.role = 'collateral'
  JOIN tokens AS token
    ON token.id = asset.token_id
  WHERE state.singleton_id = 1
    AND network.chain_id = NEW.chain_id
    AND contract.address = NEW.comet_address
    AND token.address = NEW.token_address
)
BEGIN
  SELECT RAISE(ABORT, 'collateral is not in the active registry');
END;

CREATE TRIGGER deprecated_collaterals_require_active_collateral_update
BEFORE UPDATE ON deprecated_collaterals
WHEN NOT EXISTS (
  SELECT 1
  FROM registry_state AS state
  JOIN registry_networks AS network
    ON network.registry_version_id = state.active_version_id
  JOIN markets AS market
    ON market.registry_version_id = state.active_version_id
   AND market.network_id = network.id
  JOIN market_contracts AS contract
    ON contract.market_id = market.id
   AND contract.role = 'comet'
  JOIN market_assets AS asset
    ON asset.market_id = market.id
   AND asset.role = 'collateral'
  JOIN tokens AS token
    ON token.id = asset.token_id
  WHERE state.singleton_id = 1
    AND network.chain_id = NEW.chain_id
    AND contract.address = NEW.comet_address
    AND token.address = NEW.token_address
)
BEGIN
  SELECT RAISE(ABORT, 'collateral is not in the active registry');
END;

-- A decision row changes only beside the event that records the change: the
-- same collateral, the value it replaces, the value it sets, the actor, and
-- the time. The event must be the collateral's newest, which the writing
-- transaction's own event always is, so an older event that happens to
-- describe the same change cannot be reused to restore a row without
-- recording why. SQLite fires the insert trigger for an upsert that becomes
-- an update as well, before the update trigger, so the insert trigger reads
-- the value being replaced from the table rather than assuming there is none.

CREATE TRIGGER deprecated_collaterals_require_event_insert
BEFORE INSERT ON deprecated_collaterals
WHEN NOT EXISTS (
  SELECT 1
  FROM deprecated_collateral_events AS event
  WHERE event.chain_id = NEW.chain_id
    AND event.comet_address = NEW.comet_address
    AND event.token_address = NEW.token_address
    AND event.previous_is_deprecated IS (
      SELECT decision.is_deprecated
      FROM deprecated_collaterals AS decision
      WHERE decision.chain_id = NEW.chain_id
        AND decision.comet_address = NEW.comet_address
        AND decision.token_address = NEW.token_address
    )
    AND event.is_deprecated = NEW.is_deprecated
    AND event.actor = NEW.updated_by
    AND event.created_at = NEW.updated_at
    AND NOT EXISTS (
      SELECT 1
      FROM deprecated_collateral_events AS later
      WHERE later.chain_id = event.chain_id
        AND later.comet_address = event.comet_address
        AND later.token_address = event.token_address
        AND later.rowid > event.rowid
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a deprecated collateral decision changes only with its audit event');
END;

CREATE TRIGGER deprecated_collaterals_require_event_update
BEFORE UPDATE ON deprecated_collaterals
WHEN NOT EXISTS (
  SELECT 1
  FROM deprecated_collateral_events AS event
  WHERE event.chain_id = NEW.chain_id
    AND event.comet_address = NEW.comet_address
    AND event.token_address = NEW.token_address
    AND event.previous_is_deprecated IS OLD.is_deprecated
    AND event.is_deprecated = NEW.is_deprecated
    AND event.actor = NEW.updated_by
    AND event.created_at = NEW.updated_at
    AND NOT EXISTS (
      SELECT 1
      FROM deprecated_collateral_events AS later
      WHERE later.chain_id = event.chain_id
        AND later.comet_address = event.comet_address
        AND later.token_address = event.token_address
        AND later.rowid > event.rowid
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a deprecated collateral decision changes only with its audit event');
END;

CREATE TRIGGER deprecated_collaterals_identity_immutable
BEFORE UPDATE OF chain_id, comet_address, token_address ON deprecated_collaterals
WHEN NEW.chain_id IS NOT OLD.chain_id
  OR NEW.comet_address IS NOT OLD.comet_address
  OR NEW.token_address IS NOT OLD.token_address
BEGIN
  SELECT RAISE(ABORT, 'a deprecated collateral decision belongs to one collateral');
END;

CREATE TRIGGER deprecated_collaterals_no_delete
BEFORE DELETE ON deprecated_collaterals
BEGIN
  SELECT RAISE(ABORT, 'deprecated collateral decisions are changed, not deleted');
END;

CREATE TRIGGER deprecated_collateral_events_no_update
BEFORE UPDATE ON deprecated_collateral_events
BEGIN
  SELECT RAISE(ABORT, 'deprecated collateral events are append-only');
END;

CREATE TRIGGER deprecated_collateral_events_no_delete
BEFORE DELETE ON deprecated_collateral_events
BEGIN
  SELECT RAISE(ABORT, 'deprecated collateral events are append-only');
END;

-- REPLACE removes the row it conflicts with without firing a delete trigger,
-- since D1 runs with recursive_triggers off, so it is refused before it can:
-- whether it names an existing id or a rowid. Any rowid chosen by the writer
-- is refused, since history is read in rowid order; SQLite reports NEW.rowid
-- as -1 in a BEFORE INSERT trigger when it assigns the next one itself.
CREATE TRIGGER deprecated_collateral_events_no_replace
BEFORE INSERT ON deprecated_collateral_events
WHEN NEW.rowid <> -1
  OR EXISTS (SELECT 1 FROM deprecated_collateral_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'deprecated collateral events are append-only');
END;

-- A writer that names rowid -1 itself is the one case the trigger above cannot
-- tell from an assigned rowid. After the insert the real rowid is known, and
-- one the table did not assign — never below 1 — is refused, a REPLACE at
-- that rowid included.
CREATE TRIGGER deprecated_collateral_events_assigned_rowid
AFTER INSERT ON deprecated_collateral_events
WHEN NEW.rowid < 1
BEGIN
  SELECT RAISE(ABORT, 'deprecated collateral events are append-only');
END;

-- What a write of decisions expects to hold once it is done. Inserting into
-- this view writes nothing: its triggers abort the transaction when a
-- collateral is not in the active registry version, or does not hold the
-- decision expected.

CREATE VIEW deprecated_collateral_expectations AS
SELECT chain_id, comet_address, token_address, is_deprecated FROM deprecated_collaterals WHERE 0;

CREATE TRIGGER deprecated_collateral_expectations_require_active_collateral
INSTEAD OF INSERT ON deprecated_collateral_expectations
WHEN NOT EXISTS (
  SELECT 1
  FROM registry_state AS state
  JOIN registry_networks AS network
    ON network.registry_version_id = state.active_version_id
  JOIN markets AS market
    ON market.registry_version_id = state.active_version_id
   AND market.network_id = network.id
  JOIN market_contracts AS contract
    ON contract.market_id = market.id
   AND contract.role = 'comet'
  JOIN market_assets AS asset
    ON asset.market_id = market.id
   AND asset.role = 'collateral'
  JOIN tokens AS token
    ON token.id = asset.token_id
  WHERE state.singleton_id = 1
    AND network.chain_id = NEW.chain_id
    AND contract.address = NEW.comet_address
    AND token.address = NEW.token_address
)
BEGIN
  SELECT RAISE(ABORT, 'collateral is not in the active registry');
END;

CREATE TRIGGER deprecated_collateral_expectations_require_decision
INSTEAD OF INSERT ON deprecated_collateral_expectations
WHEN COALESCE((
  SELECT decision.is_deprecated
  FROM deprecated_collaterals AS decision
  WHERE decision.chain_id = NEW.chain_id
    AND decision.comet_address = NEW.comet_address
    AND decision.token_address = NEW.token_address
), 0) IS NOT NEW.is_deprecated
BEGIN
  SELECT RAISE(ABORT, 'deprecated collateral decisions changed while they were being written');
END;
