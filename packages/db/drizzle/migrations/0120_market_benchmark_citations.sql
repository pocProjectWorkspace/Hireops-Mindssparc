-- =====================================================================
-- 0120_market_benchmark_citations.sql — MI-0a (hand-written)
--
-- Provenance columns for market_benchmarks so every figure the Market
-- Intelligence table, the Feasibility card and the feasibility prompt show
-- can answer "where is this number from?". Until now a row carried only the
-- free-text `source_note`; these three nullable columns let a human record
-- the published guide's URL, its publication date and its sample size.
--
--   market_benchmarks.source_url           text NULL — link to the guide
--   market_benchmarks.source_published_on  date NULL — guide publication date
--   market_benchmarks.sample_n             integer NULL — survey sample size,
--                                          CHECK > 0 when present
--
-- All three are NULLABLE and carry no default: an unknown citation stays
-- NULL (the UI omits the part) rather than being invented. Purely additive —
-- no backfill, no RLS / policy / audit-trigger change (the table's existing
-- FORCE RLS tenant_isolation policy and audit trigger cover the new columns).
-- =====================================================================

ALTER TABLE public.market_benchmarks
  ADD COLUMN source_url text NULL,
  ADD COLUMN source_published_on date NULL,
  ADD COLUMN sample_n integer NULL,
  ADD CONSTRAINT market_benchmarks_sample_n_positive CHECK (sample_n IS NULL OR sample_n > 0);
