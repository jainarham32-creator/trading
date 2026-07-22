-- Trading Desk — migration 002: setup taxonomy, market regime, position sizing
-- Run once in the Supabase SQL Editor. Additive only — safe against existing data.

alter table public.trades
  add column if not exists market_cap text;  -- 'Large Cap' | 'Mid Cap' | 'Small Cap', nullable

alter table public.rules
  add column if not exists setup_options jsonb not null
    default '["Cup & Handle","Rectangle Breakout","Multiyear Resistance","Head & Shoulders","Macro Thesis"]'::jsonb,
  add column if not exists setup_multipliers jsonb not null default '{}'::jsonb;

alter table public.capital
  add column if not exists mult_large_cap numeric not null default 1.0,
  add column if not exists mult_mid_cap   numeric not null default 0.8,
  add column if not exists mult_small_cap numeric not null default 0.5,
  add column if not exists mult_risk_on   numeric not null default 1.2,
  add column if not exists mult_neutral   numeric not null default 1.0,
  add column if not exists mult_risk_off  numeric not null default 0.6;

create table if not exists public.market_regime (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  snapshot_date date not null,
  vix           numeric,
  fii_net       numeric,
  dii_net       numeric,
  new_highs     integer,
  new_lows      integer,
  pcr           numeric,       -- manual entry only (NSE option-chain endpoint isn't reliably fetchable, see nse-market-data skill)
  regime_label  text,          -- 'Risk-On' | 'Neutral' | 'Risk-Off', computed client-side at save time
  notes         text default '',
  created_at    timestamptz not null default now(),
  unique (user_id, snapshot_date)
);
create index if not exists market_regime_user_date_idx on public.market_regime(user_id, snapshot_date desc);

alter table public.market_regime enable row level security;

create policy "market_regime_select_own" on public.market_regime
  for select using (auth.uid() = user_id);
create policy "market_regime_insert_own" on public.market_regime
  for insert with check (auth.uid() = user_id);
create policy "market_regime_update_own" on public.market_regime
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "market_regime_delete_own" on public.market_regime
  for delete using (auth.uid() = user_id);
