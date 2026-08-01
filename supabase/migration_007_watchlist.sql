-- Migration 007: watchlist table (Stocks tab's "My Watchlist" panel)
-- Run once in the Supabase SQL Editor. Additive — safe to re-run (IF NOT EXISTS everywhere).

create table if not exists public.watchlist (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  symbols    jsonb not null default '[]'::jsonb,  -- ["RELIANCE","TCS",...] — one row per user, jsonb array
  updated_at timestamptz not null default now()
);

alter table public.watchlist enable row level security;

create policy "watchlist_select_own" on public.watchlist
  for select using (auth.uid() = user_id);
create policy "watchlist_insert_own" on public.watchlist
  for insert with check (auth.uid() = user_id);
create policy "watchlist_update_own" on public.watchlist
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "watchlist_delete_own" on public.watchlist
  for delete using (auth.uid() = user_id);
