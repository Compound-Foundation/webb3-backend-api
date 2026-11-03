-- Markets the registry has imported but nobody has reviewed yet.
--
-- An import reads everything the source and the chain can state: addresses,
-- tokens, decimals, feeds, collateral. What neither can state — how a market
-- is named, whether it is served, which capabilities it has, which unit its
-- base is quoted in, which feed prices its rewards — is a reviewed decision,
-- inherited from the active version for every market it already describes.
--
-- A market the active version does not describe has no decision to inherit:
-- the first import of an environment, or a deployment the source has just
-- added. It is still imported, so that its rows exist and can be reviewed in
-- place, but as a market nobody has decided anything about: disabled, with
-- every capability off, never the default, and marked unreviewed. It changes
-- nothing the API serves until an operator reviews it.
--
-- An unreviewed row is not cloned into the next version. The decision was
-- never made, so there is nothing to inherit, and the next import imports
-- the market as unreviewed again.
--
-- Conventions follow 0001: every statement ends with a semicolon at the end
-- of a line, every trigger body ends with a line containing only END followed
-- by a semicolon, and D1 always enforces foreign keys.

ALTER TABLE registry_networks ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 1 CHECK (reviewed IN (0, 1));

ALTER TABLE markets ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 1 CHECK (reviewed IN (0, 1));

-- A market nobody has reviewed is never served and never the default: what
-- the API offers is always something an operator decided to offer.
CREATE TRIGGER markets_unreviewed_not_served_insert
BEFORE INSERT ON markets
FOR EACH ROW
WHEN NEW.reviewed = 0 AND (NEW.status <> 'disabled' OR NEW.is_default = 1)
BEGIN
  SELECT RAISE(ABORT, 'a market nobody has reviewed must be disabled');
END;

CREATE TRIGGER markets_unreviewed_not_served_update
BEFORE UPDATE ON markets
FOR EACH ROW
WHEN NEW.reviewed = 0 AND (NEW.status <> 'disabled' OR NEW.is_default = 1)
BEGIN
  SELECT RAISE(ABORT, 'a market nobody has reviewed must be disabled');
END;

-- A run that imports every root but leaves its candidate open, so the markets
-- it imported can be reviewed before anything validates the version. The
-- first import of an environment is held regardless, since its markets can
-- only be reviewed in place; this flag is how an operator asks for the same
-- thing later, to review a market the source has added.
ALTER TABLE sync_runs ADD COLUMN hold_for_review INTEGER NOT NULL DEFAULT 0 CHECK (hold_for_review IN (0, 1));
