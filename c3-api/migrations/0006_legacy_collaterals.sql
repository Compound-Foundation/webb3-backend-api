-- Migration number: 0006    2026-10-08T09:00:00.000Z
-- Legacy collaterals: which collaterals of which Comets an administrator has
-- marked legacy. The frontend stops offering a legacy collateral, and keeps
-- showing it to a user who still holds some, so that it can be withdrawn.
--
-- A decision belongs to a collateral of a Comet as the chain knows them — a
-- chain id, the Comet's address and the token's address — and not to the rows
-- a registry version holds for them. Versions are immutable and every import
-- writes its markets again, so a decision stored on a versioned row would be
-- lost the moment another version is activated. One keyed by what the market
-- is survives every activation, and applies again to a collateral a later
-- version brings back.
--
-- A collateral nobody has decided about is not legacy. That default has no
-- row: a row exists once someone has changed the decision, and keeps the
-- latest.
--
-- Every change is recorded in legacy_collateral_events, in the same
-- transaction as the row it changes, with who made it and why. The schema
-- enforces that as 0005 does for token policies, rather than trusting the code
-- that writes: a decision row is written only beside its collateral's newest
-- event, which records exactly that change; events are never edited, replaced
-- or deleted, and a decision row is never deleted. A decision is reversed by
-- recording the opposite one.
--
-- A collateral's history is read in the order it was committed, which is
-- rowid order: events are only ever appended, so each one takes the next rowid
-- inside its writing transaction. created_at is when the Worker stamped the
-- request, and two requests in flight together can commit in the opposite
-- order to their stamps.
--
-- The migration only adds tables, with their indexes and triggers, and a
-- view: nothing the release before it reads or writes, so that release runs
-- on beside them until the deploy that follows.
--
-- Conventions follow 0001: every statement ends with a semicolon at the end
-- of a line, every trigger body ends with a line containing only END followed
-- by a semicolon, and D1 always enforces foreign keys.

CREATE TABLE legacy_collaterals (
  chain_id       INTEGER NOT NULL CHECK (chain_id > 0 AND chain_id <= 9007199254740991),
  comet_address  TEXT NOT NULL CHECK (
    length(comet_address) = 42
    AND substr(comet_address, 1, 2) = '0x'
    AND substr(comet_address, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  token_address  TEXT NOT NULL CHECK (
    length(token_address) = 42
    AND substr(token_address, 1, 2) = '0x'
    AND substr(token_address, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  is_legacy      INTEGER NOT NULL CHECK (is_legacy IN (0, 1)),
  updated_at     TEXT NOT NULL,
  updated_by     TEXT NOT NULL CHECK (length(trim(updated_by)) > 0),
  PRIMARY KEY (chain_id, comet_address, token_address)
) STRICT, WITHOUT ROWID;
-- without a rowid, a REPLACE can only name a decision by its collateral: it
-- cannot reach another collateral's row through a rowid and delete it unaudited

-- the legacy collaterals, of every chain or of one, without reading the rows that say otherwise
CREATE INDEX legacy_collaterals_marked
  ON legacy_collaterals (chain_id, comet_address, token_address)
  WHERE is_legacy = 1;

CREATE TABLE legacy_collateral_events (
  id                  TEXT PRIMARY KEY,
  chain_id            INTEGER NOT NULL CHECK (chain_id > 0 AND chain_id <= 9007199254740991),
  comet_address       TEXT NOT NULL CHECK (
    length(comet_address) = 42
    AND substr(comet_address, 1, 2) = '0x'
    AND substr(comet_address, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  token_address       TEXT NOT NULL CHECK (
    length(token_address) = 42
    AND substr(token_address, 1, 2) = '0x'
    AND substr(token_address, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  -- null when the collateral had no decision row, which means it was not legacy
  previous_is_legacy  INTEGER CHECK (
    previous_is_legacy IS NULL OR previous_is_legacy IN (0, 1)
  ),
  is_legacy           INTEGER NOT NULL CHECK (is_legacy IN (0, 1)),
  actor               TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  reason              TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 1000),
  created_at          TEXT NOT NULL,
  -- an event records a change, so the decision it records differs from the one it replaced
  CHECK (COALESCE(previous_is_legacy, 0) <> is_legacy)
) STRICT;

-- one collateral's events, in rowid order, which every index entry ends with
CREATE INDEX legacy_collateral_events_collateral_history
  ON legacy_collateral_events (chain_id, comet_address, token_address);

-- A decision is made about a collateral of a market of the active registry
-- version: the token is one of the collateral assets of the market whose
-- Comet that version holds at that address on that chain.

CREATE TRIGGER legacy_collaterals_require_active_collateral_insert
BEFORE INSERT ON legacy_collaterals
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

CREATE TRIGGER legacy_collaterals_require_active_collateral_update
BEFORE UPDATE ON legacy_collaterals
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

CREATE TRIGGER legacy_collaterals_require_event_insert
BEFORE INSERT ON legacy_collaterals
WHEN NOT EXISTS (
  SELECT 1
  FROM legacy_collateral_events AS event
  WHERE event.chain_id = NEW.chain_id
    AND event.comet_address = NEW.comet_address
    AND event.token_address = NEW.token_address
    AND event.previous_is_legacy IS (
      SELECT decision.is_legacy
      FROM legacy_collaterals AS decision
      WHERE decision.chain_id = NEW.chain_id
        AND decision.comet_address = NEW.comet_address
        AND decision.token_address = NEW.token_address
    )
    AND event.is_legacy = NEW.is_legacy
    AND event.actor = NEW.updated_by
    AND event.created_at = NEW.updated_at
    AND NOT EXISTS (
      SELECT 1
      FROM legacy_collateral_events AS later
      WHERE later.chain_id = event.chain_id
        AND later.comet_address = event.comet_address
        AND later.token_address = event.token_address
        AND later.rowid > event.rowid
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a legacy collateral decision changes only with its audit event');
END;

CREATE TRIGGER legacy_collaterals_require_event_update
BEFORE UPDATE ON legacy_collaterals
WHEN NOT EXISTS (
  SELECT 1
  FROM legacy_collateral_events AS event
  WHERE event.chain_id = NEW.chain_id
    AND event.comet_address = NEW.comet_address
    AND event.token_address = NEW.token_address
    AND event.previous_is_legacy IS OLD.is_legacy
    AND event.is_legacy = NEW.is_legacy
    AND event.actor = NEW.updated_by
    AND event.created_at = NEW.updated_at
    AND NOT EXISTS (
      SELECT 1
      FROM legacy_collateral_events AS later
      WHERE later.chain_id = event.chain_id
        AND later.comet_address = event.comet_address
        AND later.token_address = event.token_address
        AND later.rowid > event.rowid
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a legacy collateral decision changes only with its audit event');
END;

CREATE TRIGGER legacy_collaterals_identity_immutable
BEFORE UPDATE OF chain_id, comet_address, token_address ON legacy_collaterals
WHEN NEW.chain_id IS NOT OLD.chain_id
  OR NEW.comet_address IS NOT OLD.comet_address
  OR NEW.token_address IS NOT OLD.token_address
BEGIN
  SELECT RAISE(ABORT, 'a legacy collateral decision belongs to one collateral');
END;

CREATE TRIGGER legacy_collaterals_no_delete
BEFORE DELETE ON legacy_collaterals
BEGIN
  SELECT RAISE(ABORT, 'legacy collateral decisions are changed, not deleted');
END;

CREATE TRIGGER legacy_collateral_events_no_update
BEFORE UPDATE ON legacy_collateral_events
BEGIN
  SELECT RAISE(ABORT, 'legacy collateral events are append-only');
END;

CREATE TRIGGER legacy_collateral_events_no_delete
BEFORE DELETE ON legacy_collateral_events
BEGIN
  SELECT RAISE(ABORT, 'legacy collateral events are append-only');
END;

-- REPLACE removes the row it conflicts with without firing a delete trigger,
-- since D1 runs with recursive_triggers off, so it is refused before it can:
-- whether it names an existing id or a rowid. Any rowid chosen by the writer
-- is refused, since history is read in rowid order; SQLite reports NEW.rowid
-- as -1 in a BEFORE INSERT trigger when it assigns the next one itself.
CREATE TRIGGER legacy_collateral_events_no_replace
BEFORE INSERT ON legacy_collateral_events
WHEN NEW.rowid <> -1
  OR EXISTS (SELECT 1 FROM legacy_collateral_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'legacy collateral events are append-only');
END;

-- A writer that names rowid -1 itself is the one case the trigger above cannot
-- tell from an assigned rowid. After the insert the real rowid is known, and
-- one the table did not assign — never below 1 — is refused, a REPLACE at
-- that rowid included.
CREATE TRIGGER legacy_collateral_events_assigned_rowid
AFTER INSERT ON legacy_collateral_events
WHEN NEW.rowid < 1
BEGIN
  SELECT RAISE(ABORT, 'legacy collateral events are append-only');
END;

-- What a write of decisions expects to hold once it is done. Inserting into
-- this view writes nothing: its triggers abort the transaction when a
-- collateral is not in the active registry version, or does not hold the
-- decision expected.

CREATE VIEW legacy_collateral_expectations AS
SELECT chain_id, comet_address, token_address, is_legacy FROM legacy_collaterals WHERE 0;

CREATE TRIGGER legacy_collateral_expectations_require_active_collateral
INSTEAD OF INSERT ON legacy_collateral_expectations
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

CREATE TRIGGER legacy_collateral_expectations_require_decision
INSTEAD OF INSERT ON legacy_collateral_expectations
WHEN COALESCE((
  SELECT decision.is_legacy
  FROM legacy_collaterals AS decision
  WHERE decision.chain_id = NEW.chain_id
    AND decision.comet_address = NEW.comet_address
    AND decision.token_address = NEW.token_address
), 0) IS NOT NEW.is_legacy
BEGIN
  SELECT RAISE(ABORT, 'legacy collateral decisions changed while they were being written');
END;
