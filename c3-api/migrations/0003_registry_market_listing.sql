-- How the frontend lists a market, beside the label it already has.
--
-- `slug` names a market in the frontend's URLs where its label cannot. Two
-- markets of one network may share a label — mainnet has a USDC market and an
-- institutional USDC market — and the one with a slug is addressed by it
-- instead of by its label. A market without one is addressed by its label, as
-- every market was before this column.
--
-- `is_institutional` lists a market in the frontend's institutional section,
-- apart from the standard markets.
--
-- Both are reviewed decisions like the label: an overlay states them, and the
-- next version inherits them with the rest of a market's overlay. Existing
-- rows get no slug and are not institutional, which is what every market was
-- before these columns.
--
-- Conventions follow 0001: every statement ends with a semicolon at the end
-- of a line, and D1 always enforces foreign keys.

ALTER TABLE markets ADD COLUMN slug TEXT CHECK (
  slug IS NULL OR (length(slug) BETWEEN 1 AND 64 AND slug NOT GLOB '*[^a-z0-9.-]*')
);

ALTER TABLE markets ADD COLUMN is_institutional INTEGER NOT NULL DEFAULT 0 CHECK (is_institutional IN (0, 1));

-- a slug addresses one market of a network, so no two markets of one network share it
CREATE UNIQUE INDEX markets_slug_per_network
  ON markets (registry_version_id, network_id, slug)
  WHERE slug IS NOT NULL;
