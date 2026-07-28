-- Trading Desk — Supabase schema + RLS
-- Run once in the Supabase SQL Editor (Project → SQL Editor → New query) for a FRESH project only.
-- If a project already has these tables with data, do NOT run this file — use the incremental
-- migration files in this folder instead (migration_002_setup_regime_sizing.sql,
-- migration_003_ema_breadth.sql, migration_004_segment_alloc_and_breadth_extras.sql,
-- migration_005_indexfuture_and_nifty500ema.sql, migration_006_newhighs_advdecl.sql),
-- which are additive (ALTER TABLE ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS)
-- and safe to re-run.

create extension if not exists pgcrypto;

-- ---------- trades (one row per trade) ----------
create table public.trades (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  segment      text not null,               -- 'Equity Cash' | 'Equity Futures' | 'Index Future'
  direction    text not null,               -- 'Long' | 'Short'
  instrument   text not null,
  entry        numeric,
  qty          numeric,
  entry_date   date,
  sl           numeric,
  target       numeric,
  trail        text,
  setup        text,                        -- one of rules.setup_options
  market_cap   text,                        -- 'Large Cap' | 'Mid Cap' | 'Small Cap', nullable
  notes        text,
  status       text not null default 'open', -- 'open' | 'closed'
  exit         numeric,
  exit_date    date,
  checklist    jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index trades_user_id_idx on public.trades(user_id);
create index trades_user_status_idx on public.trades(user_id, status);

-- ---------- rules (one row per user — the whole playbook) ----------
create table public.rules (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  sizing            text default '',
  stops             text default '',
  "trailing"        text default '',
  targets           text default '',
  leverage          text default '',
  setups            text default '',
  checklist         text default '',
  nonnegotiables    text default '',
  setup_options     jsonb not null default '["Cup & Handle","Rectangle Breakout","Multiyear Resistance","Head & Shoulders","Macro Thesis"]'::jsonb,
  setup_multipliers jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now()
);

-- ---------- capital (one row per user) ----------
-- Segments: Equity Cash, Equity Futures, Index Future — each with its own leverage cap
-- and capital-allocation slice (lev_comm/alloc_comm_pct existed for a since-removed
-- Commodity segment; the live project keeps those columns around, unused, rather than a
-- destructive drop, but a fresh install has no need for them).
create table public.capital (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  total          numeric default 0,
  lev_equity     numeric default 0,
  lev_fno        numeric default 0,
  lev_indexfut   numeric default 0,
  risk_per_trade numeric default 0,
  mult_large_cap numeric not null default 1.0,
  mult_mid_cap   numeric not null default 0.8,
  mult_small_cap numeric not null default 0.5,
  mult_risk_on   numeric not null default 1.2,
  mult_neutral   numeric not null default 1.0,
  mult_risk_off  numeric not null default 0.6,
  alloc_equity_pct   numeric not null default 50, -- % of total capital earmarked for each
  alloc_fno_pct      numeric not null default 30, -- segment — position-sizing risk % is
  alloc_indexfut_pct numeric not null default 20, -- measured against this slice, not 100%
  updated_at     timestamptz not null default now()
);

-- ---------- market_regime (history of saved daily snapshots) ----------
-- Auto-saves on every successful live fetch (tab-open + manual "Refresh from NSE") — this
-- reverses an earlier deliberate "no auto-save, user must click Save" decision, by explicit
-- user request (they didn't want a daily manual click). Contrast with market_breadth_history
-- below, which auto-saves for a different reason: it never had a button to click at all.
-- new_highs/new_lows (all-NSE-exchange 52-week counts) were part of an earlier design and
-- are no longer written by the app — replaced by market_breadth_history's Nifty-500-scoped
-- count_newhigh_n500/count_newlow_n500 (see nse-market-data skill) — so a fresh install
-- has no need for them at all.
create table public.market_regime (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  snapshot_date date not null,
  vix           numeric,
  fii_net       numeric,
  dii_net       numeric,
  pcr           numeric,       -- auto-fetched via NSE participant-OI data, see nse-market-data skill
  regime_label  text,          -- 'Risk-On' | 'Neutral' | 'Risk-Off'
  notes         text default '', -- unused by the UI (removed) but kept so old rows aren't orphaned
  nifty500_close numeric,      -- Nifty 500 index's own daily close (ind_close_all file)
  nifty500_ema20  numeric,     -- incremental 20-EMA of the above — feeds the Regime Score's
                                -- "index vs. its own trend" factor, seeded once via
                                -- scripts/backfill_nifty500_ema20.py then rolled forward daily
  created_at    timestamptz not null default now(),
  unique (user_id, snapshot_date)
);
create index market_regime_user_date_idx on public.market_regime(user_id, snapshot_date desc);

-- ---------- ema_state (one row per user, a jsonb map — NOT one row per stock) ----------
create table public.ema_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  state      jsonb not null default '{}'::jsonb,  -- { "RELIANCE": {"ema50":.., "ema200":.., "lastClose":.., "lastDate":"..", "recentCloses":[6 vals], "recentVolumes":[20 vals], "rsCloses":[66 vals], "close252":[252 vals]}, ... }
  updated_at timestamptz not null default now()
);

-- ---------- market_breadth_history (date-keyed, auto-updated — see nse-market-data skill) ----------
create table public.market_breadth_history (
  user_id            uuid not null references auth.users(id) on delete cascade,
  snapshot_date      date not null,
  pct_above_50ema    numeric,
  pct_above_200ema   numeric,
  count_up20_5d      integer,  -- stocks up 20%+ over the last 5 trading days
  count_up30_5d      integer,  -- stocks up 30%+ (inclusive of the up20 bucket, not mutually exclusive)
  count_up4pct_vol   integer,  -- stocks up 4%+ in a day AND on >1.5x their trailing 20-day avg volume
  count_down4pct_vol integer,  -- same, down 4%+ (both still computed/stored — the UI chart
                                -- for these two was removed by request, data kept for later)
  count_newhigh_n500 integer,  -- Nifty 500 stocks making a new 252-day (52-week) high today
  count_newlow_n500  integer,  -- same, new 252-day low
  count_advances     integer,  -- whole-market (all EQ-series bhavcopy symbols) close > prev close
  count_declines     integer,  -- same, close < prev close — Market Thrust pie chart, today-only,
                                -- not backfilled historically (see nse-market-data skill)
  updated_at         timestamptz not null default now(),
  primary key (user_id, snapshot_date)
);
create index market_breadth_history_user_date_idx on public.market_breadth_history(user_id, snapshot_date desc);

-- ---------- Row Level Security: every table, same 4-policy pattern ----------
alter table public.trades                enable row level security;
alter table public.rules                 enable row level security;
alter table public.capital               enable row level security;
alter table public.market_regime         enable row level security;
alter table public.ema_state             enable row level security;
alter table public.market_breadth_history enable row level security;

create policy "trades_select_own" on public.trades
  for select using (auth.uid() = user_id);
create policy "trades_insert_own" on public.trades
  for insert with check (auth.uid() = user_id);
create policy "trades_update_own" on public.trades
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "trades_delete_own" on public.trades
  for delete using (auth.uid() = user_id);

create policy "rules_select_own" on public.rules
  for select using (auth.uid() = user_id);
create policy "rules_insert_own" on public.rules
  for insert with check (auth.uid() = user_id);
create policy "rules_update_own" on public.rules
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "rules_delete_own" on public.rules
  for delete using (auth.uid() = user_id);

create policy "capital_select_own" on public.capital
  for select using (auth.uid() = user_id);
create policy "capital_insert_own" on public.capital
  for insert with check (auth.uid() = user_id);
create policy "capital_update_own" on public.capital
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "capital_delete_own" on public.capital
  for delete using (auth.uid() = user_id);

create policy "market_regime_select_own" on public.market_regime
  for select using (auth.uid() = user_id);
create policy "market_regime_insert_own" on public.market_regime
  for insert with check (auth.uid() = user_id);
create policy "market_regime_update_own" on public.market_regime
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "market_regime_delete_own" on public.market_regime
  for delete using (auth.uid() = user_id);

create policy "ema_state_select_own" on public.ema_state
  for select using (auth.uid() = user_id);
create policy "ema_state_insert_own" on public.ema_state
  for insert with check (auth.uid() = user_id);
create policy "ema_state_update_own" on public.ema_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "ema_state_delete_own" on public.ema_state
  for delete using (auth.uid() = user_id);

create policy "market_breadth_history_select_own" on public.market_breadth_history
  for select using (auth.uid() = user_id);
create policy "market_breadth_history_insert_own" on public.market_breadth_history
  for insert with check (auth.uid() = user_id);
create policy "market_breadth_history_update_own" on public.market_breadth_history
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "market_breadth_history_delete_own" on public.market_breadth_history
  for delete using (auth.uid() = user_id);
