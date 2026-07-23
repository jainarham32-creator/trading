-- Trading Desk — migration 003: EMA-breadth infrastructure
-- Run once in the Supabase SQL Editor. Additive only — safe against existing data.

create table if not exists public.ema_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  state      jsonb not null default '{}'::jsonb,  -- { "RELIANCE": {"ema50":.., "ema200":.., "lastClose":.., "lastDate":".."}, ... }
  updated_at timestamptz not null default now()
);

create table if not exists public.market_breadth_history (
  user_id          uuid not null references auth.users(id) on delete cascade,
  snapshot_date    date not null,
  pct_above_50ema  numeric,
  pct_above_200ema numeric,
  updated_at       timestamptz not null default now(),
  primary key (user_id, snapshot_date)
);
create index if not exists market_breadth_history_user_date_idx on public.market_breadth_history(user_id, snapshot_date desc);

alter table public.ema_state             enable row level security;
alter table public.market_breadth_history enable row level security;

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
