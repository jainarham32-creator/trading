-- Adds Nifty-500-scoped 52-week (252-trading-day) new-high/new-low counts, and whole-market
-- advance/decline counts for the Market Thrust pie chart. Both computed from the same
-- bhavcopy pipeline already used for EMA breadth — no new data source. Additive, safe to re-run.

alter table public.market_breadth_history
  add column if not exists count_newhigh_n500 integer, -- Nifty 500 stocks making a new 252-day high today
  add column if not exists count_newlow_n500  integer, -- same, new 252-day low
  add column if not exists count_advances     integer, -- whole-market (all EQ-series bhavcopy symbols) close > prev close
  add column if not exists count_declines     integer; -- same, close < prev close
