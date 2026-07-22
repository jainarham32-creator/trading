---
name: supabase-backend
description: Supabase schema, RLS, and auth conventions for the Trading Desk app (index.html). Use when touching login/signup, per-user data isolation, trades/rules/capital tables, or adding any new per-user table (e.g. a future market-regime dashboard).
---

# Supabase backend — Trading Desk

## Project shape
- Single static `index.html`, no build step, no framework. Deployed on Vercel, auto-deploy from GitHub `main` (`jainarham32-creator/trading`).
- This machine has no Node/npm/Vercel CLI/Supabase CLI. Schema changes are run by hand in the Supabase SQL Editor; there is no migration runner. `supabase/schema.sql` is the source of truth for the current schema, not necessarily append-only migrations — check it before assuming a table doesn't exist.
- Supabase JS is loaded via the **UMD** CDN build, not ESM:
  ```html
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
  ```
  Reason: the app's `<script>` is a plain (non-module) block and every handler is wired via inline `onclick="fn()"`, which needs `fn` to be a real global. ESM (`type="module"`) would break that for every function. Keep using UMD unless the whole event-wiring style changes.

## Where things live in index.html
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `supabase` (client), `session` — top of the main `<script>` block, right after the UMD `<script src>` tag.
- `#authgate` (login/signup panel) and `#app` (everything else) are sibling top-level divs, shown/hidden via `supabase.auth.onAuthStateChange`.
- `signUp`/`signIn` are merged into one `submitAuth()` driven by `authMode` (`'signin'`/`'signup'`), plus `signOut()`.
- `loadAllData()` runs after every successful sign-in and fans out to `fetchTrades()`/`fetchRules()`/`fetchCapital()`, then calls the existing render functions (`renderJournal`, `renderRules`, `loadCapitalForm`, `renderExposure`).

## Schema reference
Full DDL: `supabase/schema.sql`. Summary:

| Table     | Key                          | Notes |
|-----------|-------------------------------|-------|
| `trades`  | `id uuid` (PK, server-generated) | One row per trade. `user_id uuid` FK → `auth.users(id)`. |
| `rules`   | `user_id uuid` (PK)            | One row per user — the whole playbook as columns, not key-value. |
| `capital` | `user_id uuid` (PK)            | One row per user — capital + per-segment leverage caps. |

Trade `id`s are Postgres `gen_random_uuid()`, **not** `Date.now()` — client never invents an id for `trades`. When interpolating an id into an `onclick="..."` template string, it must be quoted (`onclick="deleteTrade('${t.id}')"`) since UUIDs contain hyphens that break unquoted JS.

## RLS — apply this exact pattern to any new per-user table
```sql
alter table public.<new_table> enable row level security;
create policy "<new_table>_select_own" on public.<new_table> for select using (auth.uid() = user_id);
create policy "<new_table>_insert_own" on public.<new_table> for insert with check (auth.uid() = user_id);
create policy "<new_table>_update_own" on public.<new_table> for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "<new_table>_delete_own" on public.<new_table> for delete using (auth.uid() = user_id);
```
Every table needs a `user_id uuid references auth.users(id) on delete cascade` column for this to work. Isolation is enforced server-side by RLS — never rely on client-side filtering alone for anything user-specific.

## Data access snippets (this app's exact style — plain functions, no try/catch, errors surfaced via `alert()`)
```js
// read (list)
const { data, error } = await supabase.from('trades').select('*').order('created_at');

// read (one row per user)
const { data } = await supabase.from('rules').select('*').eq('user_id', session.user.id).maybeSingle();

// insert and get the server-generated row back
const { data, error } = await supabase.from('trades').insert(row).select().single();

// update
const { error } = await supabase.from('trades').update({ status: 'closed' }).eq('id', id);

// upsert (one-row-per-user tables — new users have no row yet, so update() would silently no-op)
const { error } = await supabase.from('rules').upsert({ user_id: session.user.id, ...rules }, { onConflict: 'user_id' });

// delete
const { error } = await supabase.from('trades').delete().eq('id', id);
```
Pattern for every mutator: check `error`, `alert()` and `return` if present, otherwise patch the in-memory JS object and call the relevant `render*()` — never re-fetch everything just to reflect one change.

## Naming gotcha
JS objects use camelCase (`entryDate`, `levEquity`, `riskPerTrade`); Postgres columns are snake_case (`entry_date`, `lev_equity`, `risk_per_trade`). Supabase JS does **not** auto-convert case — every read maps snake_case→camelCase and every write maps camelCase→snake_case by hand at the call site (see `fetchTrades`/`fetchRules`/`fetchCapital`/`addTrade`/`saveCapital` in `index.html` for the exact mapping already in place).

## Decisions log
- Open signup (not invite-only), email+password auth (not magic link) — real login/signup screen replaces the earlier "passcode lock" idea entirely.
- Full per-user data isolation via RLS, not just client-side filtering.
- No data migration was done from the old localStorage version — Supabase started empty.
- `SUPABASE_URL`/`SUPABASE_ANON_KEY` are embedded directly in `index.html` client code — this is intentional and safe; the anon key is meant to be public, RLS is what actually protects data. **Never** put the `service_role` key anywhere in this repo or client code.
- "Confirm email" setting and the Auth Site URL (should point at the deployed Vercel URL, not localhost) are configured in the Supabase dashboard (Authentication → Providers / URL Configuration) — not in code, so check there if signup/login redirects misbehave.
