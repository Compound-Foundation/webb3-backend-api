-- Approvals: the second person a version needs before it is switched on.
--
-- An activation decides what the registry serves, and one token deciding it
-- alone is one person, or one leaked token, changing every client at once. So
-- an admin switches a version on only once an admin of another name has
-- approved it. An approval names the version by its checksum, so it covers
-- exactly the bytes that go live, and the version that was on when it was
-- made, so it covers exactly the change somebody read. It holds until it
-- expires, until an activation uses it, or until any move switches its
-- version on: going back to a version and forward again is a new decision. An
-- activation records the approval it used, and an approval lets one through.
-- A rollback needs none, as break-glass, but goes back one step only: to the
-- version the one on replaced when it was last activated, if that is older.
--
-- The release before this migration activates without approvals and rolls
-- back to any validated version, and it is live between this migration and
-- the deploy that follows. So the triggers below act only once the
-- environment has recorded an approval, which that release never writes:
-- until then it works as it did, and the new table, column and index are
-- invisible to it. From the first approval on, the database refuses an
-- activation without an approval it may use, a rollback but the one step
-- back, and a move of the active pointer that no activation records,
-- whoever writes it. A release from before this migration deployed again
-- after that switches nothing on: roll forward.
--
-- Conventions follow 0001: every statement ends with a semicolon at the end
-- of a line, every trigger body ends with a line containing only END followed
-- by a semicolon, and D1 always enforces foreign keys.

CREATE TABLE registry_approvals (
  id                   TEXT PRIMARY KEY,
  registry_version_id  TEXT NOT NULL REFERENCES registry_versions (id) ON DELETE RESTRICT,
  snapshot_checksum    TEXT NOT NULL CHECK (
    length(snapshot_checksum) = 64 AND snapshot_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  -- the version on when it was approved, which the activation must replace; null when nothing was on
  active_version_id    TEXT REFERENCES registry_versions (id) ON DELETE RESTRICT,
  actor                TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  reason               TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 1000),
  created_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (active_version_id IS NULL OR active_version_id <> registry_version_id)
) STRICT;

CREATE INDEX registry_approvals_version_history
  ON registry_approvals (registry_version_id, created_at);

ALTER TABLE registry_activations ADD COLUMN approval_id TEXT REFERENCES registry_approvals (id) ON DELETE RESTRICT;

-- an approval lets one activation through
CREATE UNIQUE INDEX registry_activations_one_per_approval
  ON registry_activations (approval_id)
  WHERE approval_id IS NOT NULL;

CREATE TRIGGER registry_approvals_insert_requires_validated
BEFORE INSERT ON registry_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM registry_versions
  WHERE id = NEW.registry_version_id AND status = 'validated' AND snapshot_checksum = NEW.snapshot_checksum
)
BEGIN
  SELECT RAISE(ABORT, 'registry approvals must name a validated version by its checksum');
END;

CREATE TRIGGER registry_approvals_no_update
BEFORE UPDATE ON registry_approvals
BEGIN
  SELECT RAISE(ABORT, 'registry approvals are append-only');
END;

CREATE TRIGGER registry_approvals_no_delete
BEFORE DELETE ON registry_approvals
BEGIN
  SELECT RAISE(ABORT, 'registry approvals are append-only');
END;

-- The rule src/registry/repository.ts checks first (usableApprovalOf), with the
-- activation's own instant and the version it replaces: an approval of its
-- version by another name, in force, made while that version was on, and
-- neither used nor overtaken by a move that switched its version on since.
CREATE TRIGGER registry_activations_activate_requires_approval
BEFORE INSERT ON registry_activations
WHEN NEW.action = 'activate'
  AND (NEW.approval_id IS NOT NULL OR EXISTS (SELECT 1 FROM registry_approvals))
  AND NOT EXISTS (
    SELECT 1 FROM registry_approvals AS approval
    WHERE approval.id = NEW.approval_id
      AND approval.registry_version_id = NEW.registry_version_id
      AND approval.actor <> NEW.actor
      AND approval.expires_at > NEW.created_at
      AND approval.active_version_id IS NEW.previous_version_id
      AND NOT EXISTS (SELECT 1 FROM registry_activations AS spent WHERE spent.approval_id = approval.id)
      AND NOT EXISTS (
        SELECT 1 FROM registry_activations AS later
        WHERE later.registry_version_id = approval.registry_version_id AND later.created_at >= approval.created_at
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'an activation requires an approval of its version by another name, in force');
END;

-- The rule src/registry/repository.ts checks first (restorableFrom): a
-- rollback goes back one step, to the version the one it replaces had
-- replaced when an activation last switched that one on, and only when that
-- version is older in the order the version listing uses. A version switched
-- on in place of a newer one is left by an activation alone.
CREATE TRIGGER registry_activations_rollback_restores
BEFORE INSERT ON registry_activations
WHEN NEW.action = 'rollback'
  AND EXISTS (SELECT 1 FROM registry_approvals)
  AND (
    NEW.previous_version_id IS NULL
    OR NEW.registry_version_id IS NOT (
      SELECT latest.previous_version_id FROM registry_activations AS latest
      WHERE latest.action = 'activate' AND latest.registry_version_id = NEW.previous_version_id
      ORDER BY latest.created_at DESC, latest.rowid DESC
      LIMIT 1
    )
    OR NOT EXISTS (
      SELECT 1 FROM registry_versions AS target, registry_versions AS replaced
      WHERE target.id = NEW.registry_version_id AND replaced.id = NEW.previous_version_id
        AND (target.created_at, target.attempt, target.id) < (replaced.created_at, replaced.attempt, replaced.id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'a rollback restores only the older version the one on replaced when it was last activated');
END;

-- An activation writes its row and moves the pointer in one batch, both at
-- one instant, so a move with no row of that instant is no activation's.
CREATE TRIGGER registry_state_move_requires_activation
BEFORE UPDATE OF active_version_id ON registry_state
WHEN NEW.active_version_id IS NOT OLD.active_version_id
  AND EXISTS (SELECT 1 FROM registry_approvals)
  AND NOT EXISTS (
    SELECT 1 FROM registry_activations
    WHERE registry_version_id = NEW.active_version_id
      AND previous_version_id IS OLD.active_version_id
      AND created_at = NEW.updated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'the active registry version moves only with its activation');
END;
