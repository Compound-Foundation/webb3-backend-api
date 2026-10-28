-- Columns and indexes of the registry schema that nothing uses.
--
-- A run's lease and a checkpoint's claim are fenced by their owner token,
-- which an invocation draws anew every time it takes a run, so the generation
-- counters beside the owners decide nothing the owners do not. A checkpoint's
-- root checksum was written and never read.
--
-- Three indexes serve no query. Tokens are looked up by version and network,
-- which their unique address constraint already covers; no query looks a
-- contract up by its role and address; and checkpoints are looked up by run,
-- which the claim index and the unique root path cover.
--
-- The release before this migration still writes the dropped columns, so a
-- sync it runs between this migration and the deploy that follows fails. The
-- next sync takes the run over once its lease expires.
--
-- Conventions follow 0001: every statement ends with a semicolon at the end
-- of a line, and D1 always enforces foreign keys.

DROP INDEX tokens_network_symbol_lookup;

DROP INDEX market_contracts_role_address_lookup;

-- the fence index names claim_generation, so it goes before the column
DROP INDEX sync_run_items_fence_lookup;

ALTER TABLE sync_runs DROP COLUMN lease_generation;

ALTER TABLE sync_run_items DROP COLUMN claim_generation;

ALTER TABLE sync_run_items DROP COLUMN root_checksum;
