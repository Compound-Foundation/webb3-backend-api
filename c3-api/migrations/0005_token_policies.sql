-- Migration number: 0005    2026-10-02T09:00:00.000Z
-- Token policies: which tokens an administrator has marked strategic.
--
-- A policy belongs to a token as a chain knows it, a chain id and an address,
-- and not to the row a registry version holds for it. Versions are immutable
-- and every import writes its tokens again, so a decision stored on a
-- versioned row would be lost the moment another version is activated. One
-- keyed by what the token is survives every activation, and applies again to
-- a token a later version brings back.
--
-- A token nobody has decided about is not strategic. That default has no row:
-- a row exists once someone has changed the decision, and keeps the latest.
--
-- Every change is recorded in token_policy_events, in the same transaction as
-- the row it changes, with who made it and why. The schema enforces that
-- rather than trusting the code that writes: a policy row is written only
-- beside its token's newest event, which records exactly that change; events
-- are never edited, replaced or deleted, and a policy row is never deleted.
-- A decision is reversed by recording the opposite one.
--
-- A token's history is read in the order it was committed, which is rowid
-- order: events are only ever appended, so each one takes the next rowid
-- inside its writing transaction. created_at is when the Worker stamped the
-- request, and two requests in flight together can commit in the opposite
-- order to their stamps.

CREATE TABLE token_policies (
  chain_id       INTEGER NOT NULL CHECK (chain_id > 0 AND chain_id <= 9007199254740991),
  token_address  TEXT NOT NULL CHECK (
    length(token_address) = 42
    AND substr(token_address, 1, 2) = '0x'
    AND substr(token_address, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  is_strategic   INTEGER NOT NULL CHECK (is_strategic IN (0, 1)),
  updated_at     TEXT NOT NULL,
  updated_by     TEXT NOT NULL CHECK (length(trim(updated_by)) > 0),
  PRIMARY KEY (chain_id, token_address)
) STRICT, WITHOUT ROWID;
-- without a rowid, a REPLACE can only name a policy by its token: it cannot
-- reach another token's row through a rowid and delete it unaudited

-- the strategic tokens of a chain, without reading the rows that say otherwise
CREATE INDEX token_policies_strategic
  ON token_policies (chain_id, token_address)
  WHERE is_strategic = 1;

CREATE TABLE token_policy_events (
  id                     TEXT PRIMARY KEY,
  chain_id               INTEGER NOT NULL CHECK (chain_id > 0 AND chain_id <= 9007199254740991),
  token_address          TEXT NOT NULL CHECK (
    length(token_address) = 42
    AND substr(token_address, 1, 2) = '0x'
    AND substr(token_address, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  -- null when the token had no policy row, which means it was not strategic
  previous_is_strategic  INTEGER CHECK (
    previous_is_strategic IS NULL OR previous_is_strategic IN (0, 1)
  ),
  is_strategic           INTEGER NOT NULL CHECK (is_strategic IN (0, 1)),
  actor                  TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  reason                 TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 1000),
  created_at             TEXT NOT NULL,
  -- an event records a change, so the decision it records differs from the one it replaced
  CHECK (COALESCE(previous_is_strategic, 0) <> is_strategic)
) STRICT;

-- one token's events, in rowid order, which every index entry ends with
CREATE INDEX token_policy_events_token_history
  ON token_policy_events (chain_id, token_address);

-- A policy is decided for a token of the active registry version.

CREATE TRIGGER token_policies_require_active_token_insert
BEFORE INSERT ON token_policies
WHEN NOT EXISTS (
  SELECT 1
  FROM registry_state AS state
  JOIN registry_networks AS network
    ON network.registry_version_id = state.active_version_id
  JOIN tokens AS token
    ON token.registry_version_id = state.active_version_id
   AND token.network_id = network.id
  WHERE state.singleton_id = 1
    AND network.chain_id = NEW.chain_id
    AND token.address = NEW.token_address
)
BEGIN
  SELECT RAISE(ABORT, 'token is not in the active registry');
END;

CREATE TRIGGER token_policies_require_active_token_update
BEFORE UPDATE ON token_policies
WHEN NOT EXISTS (
  SELECT 1
  FROM registry_state AS state
  JOIN registry_networks AS network
    ON network.registry_version_id = state.active_version_id
  JOIN tokens AS token
    ON token.registry_version_id = state.active_version_id
   AND token.network_id = network.id
  WHERE state.singleton_id = 1
    AND network.chain_id = NEW.chain_id
    AND token.address = NEW.token_address
)
BEGIN
  SELECT RAISE(ABORT, 'token is not in the active registry');
END;

-- A policy row changes only beside the event that records the change: the
-- same token, the value it replaces, the value it sets, the actor, and the
-- time. The event must be the token's newest, which the writing transaction's
-- own event always is, so an older event that happens to describe the same
-- change cannot be reused to restore a row without recording why. SQLite
-- fires the insert trigger for an upsert that becomes an update as well,
-- before the update trigger, so the insert trigger reads the value being
-- replaced from the table rather than assuming there is none.

CREATE TRIGGER token_policies_require_event_insert
BEFORE INSERT ON token_policies
WHEN NOT EXISTS (
  SELECT 1
  FROM token_policy_events AS event
  WHERE event.chain_id = NEW.chain_id
    AND event.token_address = NEW.token_address
    AND event.previous_is_strategic IS (
      SELECT policy.is_strategic
      FROM token_policies AS policy
      WHERE policy.chain_id = NEW.chain_id AND policy.token_address = NEW.token_address
    )
    AND event.is_strategic = NEW.is_strategic
    AND event.actor = NEW.updated_by
    AND event.created_at = NEW.updated_at
    AND NOT EXISTS (
      SELECT 1
      FROM token_policy_events AS later
      WHERE later.chain_id = event.chain_id
        AND later.token_address = event.token_address
        AND later.rowid > event.rowid
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a token policy changes only with its audit event');
END;

CREATE TRIGGER token_policies_require_event_update
BEFORE UPDATE ON token_policies
WHEN NOT EXISTS (
  SELECT 1
  FROM token_policy_events AS event
  WHERE event.chain_id = NEW.chain_id
    AND event.token_address = NEW.token_address
    AND event.previous_is_strategic IS OLD.is_strategic
    AND event.is_strategic = NEW.is_strategic
    AND event.actor = NEW.updated_by
    AND event.created_at = NEW.updated_at
    AND NOT EXISTS (
      SELECT 1
      FROM token_policy_events AS later
      WHERE later.chain_id = event.chain_id
        AND later.token_address = event.token_address
        AND later.rowid > event.rowid
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a token policy changes only with its audit event');
END;

CREATE TRIGGER token_policies_identity_immutable
BEFORE UPDATE OF chain_id, token_address ON token_policies
WHEN NEW.chain_id IS NOT OLD.chain_id OR NEW.token_address IS NOT OLD.token_address
BEGIN
  SELECT RAISE(ABORT, 'a token policy belongs to one token');
END;

CREATE TRIGGER token_policies_no_delete
BEFORE DELETE ON token_policies
BEGIN
  SELECT RAISE(ABORT, 'token policies are changed, not deleted');
END;

CREATE TRIGGER token_policy_events_no_update
BEFORE UPDATE ON token_policy_events
BEGIN
  SELECT RAISE(ABORT, 'token policy events are append-only');
END;

CREATE TRIGGER token_policy_events_no_delete
BEFORE DELETE ON token_policy_events
BEGIN
  SELECT RAISE(ABORT, 'token policy events are append-only');
END;

-- REPLACE removes the row it conflicts with without firing a delete trigger,
-- since D1 runs with recursive_triggers off, so it is refused before it can:
-- whether it names an existing id or a rowid. Any rowid chosen by the writer
-- is refused, since history is read in rowid order; SQLite reports NEW.rowid
-- as -1 in a BEFORE INSERT trigger when it assigns the next one itself.
CREATE TRIGGER token_policy_events_no_replace
BEFORE INSERT ON token_policy_events
WHEN NEW.rowid <> -1
  OR EXISTS (SELECT 1 FROM token_policy_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'token policy events are append-only');
END;

-- A writer that names rowid -1 itself is the one case the trigger above cannot
-- tell from an assigned rowid. After the insert the real rowid is known, and
-- one the table did not assign — never below 1 — is refused, a REPLACE at
-- that rowid included.
CREATE TRIGGER token_policy_events_assigned_rowid
AFTER INSERT ON token_policy_events
WHEN NEW.rowid < 1
BEGIN
  SELECT RAISE(ABORT, 'token policy events are append-only');
END;

-- What a write of decisions expects to hold once it is done. Inserting into
-- this view writes nothing: its triggers abort the transaction when a token is
-- not in the active registry version, or does not hold the decision expected.

CREATE VIEW token_policy_expectations AS
SELECT chain_id, token_address, is_strategic FROM token_policies WHERE 0;

CREATE TRIGGER token_policy_expectations_require_active_token
INSTEAD OF INSERT ON token_policy_expectations
WHEN NOT EXISTS (
  SELECT 1
  FROM registry_state AS state
  JOIN registry_networks AS network
    ON network.registry_version_id = state.active_version_id
  JOIN tokens AS token
    ON token.registry_version_id = state.active_version_id
   AND token.network_id = network.id
  WHERE state.singleton_id = 1
    AND network.chain_id = NEW.chain_id
    AND token.address = NEW.token_address
)
BEGIN
  SELECT RAISE(ABORT, 'token is not in the active registry');
END;

CREATE TRIGGER token_policy_expectations_require_decision
INSTEAD OF INSERT ON token_policy_expectations
WHEN COALESCE((
  SELECT policy.is_strategic
  FROM token_policies AS policy
  WHERE policy.chain_id = NEW.chain_id AND policy.token_address = NEW.token_address
), 0) IS NOT NEW.is_strategic
BEGIN
  SELECT RAISE(ABORT, 'token policies changed while they were being written');
END;
