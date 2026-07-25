-- Adds a dedicated Index Future capital bucket (separate from F&O — different margin/notional
-- characteristics) and two columns on market_regime for tracking the NIFTY 500 index's own
-- 20-EMA (used by the reweighted Regime Score). Additive, safe to re-run.

alter table public.capital
  add column if not exists alloc_indexfut_pct numeric not null default 20,
  add column if not exists lev_indexfut        numeric default 0;

alter table public.market_regime
  add column if not exists nifty500_close numeric,
  add column if not exists nifty500_ema20 numeric;
