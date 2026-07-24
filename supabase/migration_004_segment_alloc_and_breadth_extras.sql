-- Trading Desk — migration 004: per-segment capital allocation + deferred breadth stats
-- Run once in the Supabase SQL Editor. Additive only — safe against existing data.

alter table public.capital
  add column if not exists alloc_equity_pct numeric not null default 50,
  add column if not exists alloc_fno_pct    numeric not null default 30,
  add column if not exists alloc_comm_pct   numeric not null default 20;

alter table public.market_breadth_history
  add column if not exists count_up20_5d      integer,
  add column if not exists count_up30_5d      integer,
  add column if not exists count_up4pct_vol   integer,
  add column if not exists count_down4pct_vol integer;
