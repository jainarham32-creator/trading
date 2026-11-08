-- Migration 008: Market Thrust "unchanged" count + stored regime score
-- Run once in the Supabase SQL Editor. Additive and safe to re-run (IF NOT EXISTS).
--
-- market_breadth_history.count_unchanged — whole-market symbols with close == previous close,
--   so the Market Thrust card can show advances / declines / unchanged / A-D ratio per day.
-- market_regime.regime_score — the 0-100 composite behind regime_label, so the Regime History
--   table at the bottom of the tab can show the actual score and not just the label.
--
-- The app tolerates this migration not having been run yet (it retries writes without these
-- columns), but the unchanged count and the stored score only start persisting after it is.

alter table public.market_breadth_history add column if not exists count_unchanged integer;
alter table public.market_regime          add column if not exists regime_score    integer;
