-- Approvals and moves in the order the database wrote them, and approvals in
-- force by the database's clock.
--
-- 0011 counted an approval overtaken by a move that switched its version on
-- at or after the approval's created_at, both instants of the Workers that
-- wrote them. An approval written after an activation took its instant, but
-- before that activation was written, was then not overtaken by it, and after
-- a rollback it could switch the version on again without a new approval. So
-- an approval now records the newest move the database held when it was
-- written, moves_seen, the rowid of the newest row of registry_activations or
-- 0 for none, and a move overtakes it when its row comes after that one.
--
-- 0011's rollback rule took the last activation of the version on to be the
-- one with the latest instant. The instants of different Workers need not
-- follow the order their moves were written in, so it could take an earlier
-- activation for the last, and let a rollback restore what that one
-- replaced. It now takes the activation written last.
--
-- An activation is recorded at the instant its Worker decided it, a moment
-- before the write, and its approval was in force then. It now has to be in
-- force by the database's clock as well, when the row is written, so no
-- approval is used after it expired, however long the write took.
--
-- The order holds because registry_activations only grows: 0001's triggers
-- refuse an update or a delete of it, so the rowid a table without an
-- INTEGER PRIMARY KEY gives each new row, the largest so far plus one, is
-- never given twice, and a rebuild of the table must keep the rowids. With no
-- row ever deleted they run from 1 without a gap, so a VACUUM that numbers
-- them again gives each the number it had.
--
-- An approval written before this migration, or without moves_seen, gets 0:
-- any move ever made onto its version overtakes it, which refuses on the
-- safe side.
--
-- The triggers keep 0011's names and messages, by which
-- src/registry/repository.ts (writeMove) knows a refusal.
--
-- Conventions follow 0001: every statement ends with a semicolon at the end
-- of a line, every trigger body ends with a line containing only END followed
-- by a semicolon, and D1 always enforces foreign keys.

ALTER TABLE registry_approvals ADD COLUMN moves_seen INTEGER NOT NULL DEFAULT 0 CHECK (moves_seen >= 0);

DROP TRIGGER registry_activations_activate_requires_approval;

-- 0011's rule, src/registry/repository.ts's approvalUsable, with the order of
-- the rows in place of the Workers' instants for "overtaken", and the
-- database's clock beside the activation's instant for "in force".
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
      AND approval.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND approval.active_version_id IS NEW.previous_version_id
      AND NOT EXISTS (SELECT 1 FROM registry_activations AS spent WHERE spent.approval_id = approval.id)
      AND NOT EXISTS (
        SELECT 1 FROM registry_activations AS later
        WHERE later.registry_version_id = approval.registry_version_id AND later.rowid > approval.moves_seen
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'an activation requires an approval of its version by another name, in force');
END;

DROP TRIGGER registry_activations_rollback_restores;

-- 0011's rule, src/registry/repository.ts's restorableFrom, with the last
-- activation of the version on taken in the order the rows were written.
CREATE TRIGGER registry_activations_rollback_restores
BEFORE INSERT ON registry_activations
WHEN NEW.action = 'rollback'
  AND EXISTS (SELECT 1 FROM registry_approvals)
  AND (
    NEW.previous_version_id IS NULL
    OR NEW.registry_version_id IS NOT (
      SELECT latest.previous_version_id FROM registry_activations AS latest
      WHERE latest.action = 'activate' AND latest.registry_version_id = NEW.previous_version_id
      ORDER BY latest.rowid DESC
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
