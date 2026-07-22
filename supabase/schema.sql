-- Trading Desk — Supabase schema + RLS
-- Run once in the Supabase SQL Editor (Project → SQL Editor → New query) for a FRESH project only.
-- If a project already has these tables with data, do NOT run this file — use the incremental
-- migration files in this folder instead (e.g. migration_002_setup_regime_sizing.sql), which are
-- additive (ALTER TABLE ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS) and safe to re-run.

create extension if not exists pgcrypto;

-- ---------- trades (one row per trade) ----------
create table public.trades (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  segment      text not null,               -- 'Equity' | 'F&O - Futures' | 'F&O - Options' | 'Commodity'
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
create table public.capital (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  total          numeric default 0,
  lev_equity     numeric default 0,
  lev_fno        numeric default 0,
  lev_comm       numeric default 0,
  risk_per_trade numeric default 0,
  mult_large_cap numeric not null default 1.0,
  mult_mid_cap   numeric not null default 0.8,
  mult_small_cap numeric not null default 0.5,
  mult_risk_on   numeric not null default 1.2,
  mult_neutral   numeric not null default 1.0,
  mult_risk_off  numeric not null default 0.6,
  updated_at     timestamptz not null default now()
);

-- ---------- market_regime (history of saved daily snapshots — NOT one-row-per-user) ----------
create table public.market_regime (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  snapshot_date date not null,
  vix           numeric,
  fii_net       numeric,
  dii_net       numeric,
  new_highs     integer,
  new_lows      integer,
  pcr           numeric,       -- manual entry only, see nse-market-data skill
  regime_label  text,          -- 'Risk-On' | 'Neutral' | 'Risk-Off'
  notes         text default '',
  created_at    timestamptz not null default now(),
  unique (user_id, snapshot_date)
);
create index market_regime_user_date_idx on public.market_regime(user_id, snapshot_date desc);

-- ---------- Row Level Security: every table, same 4-policy pattern ----------
alter table public.trades        enable row level security;
alter table public.rules         enable row level security;
alter table public.capital       enable row level security;
alter table public.market_regime enable row level security;

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
