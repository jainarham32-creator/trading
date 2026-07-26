---
name: supabase-backend
description: Supabase schema, RLS, and auth conventions for the Trading Desk app (index.html). Use when touching login/signup, per-user data isolation, trades/rules/capital/market_regime tables, or adding any new per-user table.
---

# Supabase backend — Trading Desk

## Project shape
- Single static `index.html` (plus a Vercel serverless function in `api/`), no build step for the frontend. Deployed on Vercel, auto-deploy from GitHub `main` (`jainarham32-creator/trading`).
- This machine has no Node/npm/Vercel CLI/Supabase CLI. Schema changes are run by hand in the Supabase SQL Editor; there is no migration runner. `supabase/schema.sql` is the from-scratch baseline (do **not** re-run it against a project with real data); incremental changes to an existing project live in `supabase/migration_00N_*.sql` files (additive: `ALTER TABLE ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, safe to re-run).
- Supabase JS is loaded via the **UMD** CDN build, not ESM:
  ```html
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
  ```
  Reason: the app's `<script>` is a plain (non-module) block and every handler is wired via inline `onclick="fn()"`, which needs `fn` to be a real global. ESM (`type="module"`) would break that for every function. Keep using UMD unless the whole event-wiring style changes.

## The client variable is `sb`, not `supabase` — this is load-bearing
The UMD bundle attaches itself to `window.supabase` (the SDK namespace, exposing `createClient`). Declaring `const supabase = window.supabase.createClient(...)` at the top level of a classic script is an **illegal redeclaration** (`let`/`const` can't shadow an existing global the way `var` can) — it throws a `SyntaxError` that silently kills the *entire* script with no visible error in some tool contexts, and every function in the file ends up `undefined`. Hit this bug once already; the client is named `sb` specifically to avoid it. Never rename it back to `supabase`.

## Where things live in index.html
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `sb` (client), `session` — top of the main `<script>` block, right after the UMD `<script src>` tag.
- `#authgate` (login/signup panel) and `#app` (everything else) are sibling top-level divs, shown/hidden via `sb.auth.onAuthStateChange`.
- `signUp`/`signIn` are merged into one `submitAuth()` driven by `authMode` (`'signin'`/`'signup'`), plus `signOut()`.
- `loadAllData()` runs after every successful sign-in and fans out to `fetchTrades()`/`fetchRules()`/`fetchCapital()`/`fetchLatestRegime()`, then calls the render functions (`renderJournal`, `renderRules`, `renderSetupOptions`, `populateSetupDropdown`, `loadCapitalForm`, `renderExposure`).

## Schema reference
Full DDL: `supabase/schema.sql` (fresh-install baseline) + `supabase/migration_00N_*.sql` (002 setup/regime/sizing, 003 EMA breadth, 004 segment allocation + 5-day/volume breadth extras, 005 Index Future bucket + Nifty 500 EMA20 — what was actually run against the live project). Summary:

| Table                    | Key                   | Notes |
|--------------------------|-----------------------|-------|
| `trades`                 | `id uuid` (PK, server-generated) | One row per trade. `user_id` FK. `setup` (text, one of `rules.setup_options`), `market_cap` (text: `'Large Cap'\|'Mid Cap'\|'Small Cap'`, nullable). `segment` is one of `'Equity Cash'`/`'Equity Futures'`/`'Index Future'` (renamed from `'Equity'`/`'F&O - Futures'` this round; `'F&O - Options'`/`'Commodity'` removed entirely — confirmed no live trades used them before dropping) — each has its own capital bucket. |
| `rules`                  | `user_id uuid` (PK)   | One row per user. `setup_options` (jsonb array of strings), `setup_multipliers` (jsonb, `{name: multiplier}`) added alongside the original free-text playbook columns. |
| `capital`                | `user_id uuid` (PK)   | One row per user. Leverage caps (`lev_equity`/`lev_fno`/`lev_indexfut`) + 6 position-sizing multiplier columns (`mult_large_cap`/`mult_mid_cap`/`mult_small_cap`, `mult_risk_on`/`mult_neutral`/`mult_risk_off`) + 3 capital-allocation columns (`alloc_equity_pct`/`alloc_fno_pct`/`alloc_indexfut_pct`, default 50/30/20) — a trade's risk % is measured against its own segment's allocated slice (`segmentCapital()` in `index.html`), not 100% of total capital for every segment. The live project's `capital` row still has old `lev_comm`/`alloc_comm_pct` values sitting unused (Commodity segment removed, no destructive column drop) — `schema.sql`'s fresh-install baseline no longer includes them at all. |
| `market_regime`          | `id uuid` (PK) + `unique(user_id, snapshot_date)` | A date-keyed history. **Auto-saves** on every successful live fetch (tab-open + manual "Refresh from NSE") — this reverses an earlier deliberate no-auto-save decision, by explicit user request (see decisions log). `pcr` is auto-fetched (see `nse-market-data` skill); `notes` column is unused by the UI (removed) but left in place. `nifty500_close`/`nifty500_ema20` track the Nifty 500 index's own daily close and its incremental 20-EMA — one more factor in the Regime Score, seeded once via `scripts/backfill_nifty500_ema20.py` then rolled forward daily the same way `ema_state` is, just scoped to this table instead. Upsert with `onConflict:'user_id,snapshot_date'`. |
| `ema_state`               | `user_id uuid` (PK)   | One row per user holding a **jsonb map** of all ~500 NIFTY 500 symbols' `{ema50, ema200, lastClose, lastDate, recentCloses[6], recentVolumes[20], rsCloses[66]}` — not 500 rows, matches the `setup_options`-style jsonb-blob convention. `recentCloses`/`recentVolumes` feed the 5-day-move and volume-confirmed-move stats; `rsCloses` (added this round, ~3-month window) feeds the Sector Strength panel's RS Rating. Also the sole data source (via a client-side `emaStateCache`) for that panel — no new table needed there. |
| `market_breadth_history` | `(user_id, snapshot_date)` (PK) | Date-keyed, always auto-updates (no user click possible) — see `nse-market-data` skill for why it's a separate table from `market_regime` rather than shared columns (a *different* reason than `market_regime`'s own auto-save: this one never had a button, `market_regime` had one removed by request). Also holds `count_up20_5d`/`count_up30_5d`/`count_up4pct_vol`/`count_down4pct_vol` — the latter two's UI chart was removed by request this round, but the columns/computation are untouched (kept in case it comes back). Backfilled to ~4 years (1051 rows, 2022-06-29 to present) as of this round (was ~2 years) — `fetchBreadthHistory()`'s query `.limit()` (1500 as of this round) must stay comfortably above the row count or the extra history silently doesn't reach the charts (bit us once already); separately, Supabase's own project-level `db-max-rows` (default 1000) caps every response regardless of the client `.limit()`, so the charts currently show ~1000 of the 1051 rows — see `nse-market-data` skill. |

Trade `id`s are Postgres `gen_random_uuid()`, **not** `Date.now()` — client never invents an id for `trades`. When interpolating an id into an `onclick="..."` template string, it must be quoted (`onclick="deleteTrade('${t.id}')"`) since UUIDs contain hyphens that break unquoted JS.

## RLS — apply this exact pattern to any new per-user table
```sql
alter table public.<new_table> enable row level security;
create policy "<new_table>_select_own" on public.<new_table> for select using (auth.uid() = user_id);
create policy "<new_table>_insert_own" on public.<new_table> for insert with check (auth.uid() = user_id);
create policy "<new_table>_update_own" on public.<new_table> for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "<new_table>_delete_own" on public.<new_table> for delete using (auth.uid() = user_id);
```
Every table needs a `user_id uuid references auth.users(id) on delete cascade` column for this to work. Isolation is enforced server-side by RLS — never rely on client-side filtering alone for anything user-specific. Verified concretely: `fetchTrades()`/`fetchRegimeHistory()` etc. have **no** `.eq('user_id', ...)` filter at all (RLS does 100% of the filtering), and a raw `await sb.from('trades').select('*')` in the console only ever returns the logged-in user's own rows.

## Data access snippets (this app's exact style — plain functions, no try/catch, errors surfaced via `alert()`)
```js
// read (list)
const { data, error } = await sb.from('trades').select('*').order('created_at');

// read (one row per user)
const { data } = await sb.from('rules').select('*').eq('user_id', session.user.id).maybeSingle();

// insert and get the server-generated row back
const { data, error } = await sb.from('trades').insert(row).select().single();

// update
const { error } = await sb.from('trades').update({ status: 'closed' }).eq('id', id);

// upsert (one-row-per-user tables — new users have no row yet, so update() would silently no-op)
const { error } = await sb.from('rules').upsert({ user_id: session.user.id, ...payload }, { onConflict: 'user_id' });

// upsert keyed on a composite unique constraint (market_regime — history, not one-row-per-user)
const { error } = await sb.from('market_regime').upsert(row, { onConflict: 'user_id,snapshot_date' });

// delete
const { error } = await sb.from('trades').delete().eq('id', id);
```
Pattern for every mutator: check `error`, `alert()` and `return` if present, otherwise patch the in-memory JS object and call the relevant `render*()` — never re-fetch everything just to reflect one change. **Never spread a whole in-memory object into an upsert payload** if it now contains fields with no matching DB column (e.g. `rules.setupOptions`/`setupMultipliers` are camelCase JS-only conveniences — `saveRules()` builds an explicit `{user_id, ...ruleFieldsOnly}` payload rather than `{...rules}`, otherwise Supabase errors on the unknown camelCase keys).

## Naming gotcha
JS objects use camelCase (`entryDate`, `levEquity`, `riskPerTrade`, `multLargeCap`); Postgres columns are snake_case (`entry_date`, `lev_equity`, `risk_per_trade`, `mult_large_cap`). Supabase JS does **not** auto-convert case — every read maps snake_case→camelCase and every write maps camelCase→snake_case by hand at the call site (see `fetchTrades`/`fetchRules`/`fetchCapital`/`fetchLatestRegime`/`addTrade`/`saveCapital` in `index.html` for the exact mapping already in place).

## Decisions log
- Open signup (not invite-only), email+password auth (not magic link) — real login/signup screen replaces the earlier "passcode lock" idea entirely.
- Full per-user data isolation via RLS, not just client-side filtering.
- `SUPABASE_URL`/`SUPABASE_ANON_KEY` are embedded directly in `index.html` client code — this is intentional and safe; the anon key is meant to be public, RLS is what actually protects data. **Never** put the `service_role` key anywhere in this repo or client code — including `api/regime.js`, which is a pure external-data proxy and never touches Supabase at all (snapshot saves happen client-side, authenticated as the user, same as every other table).
- `market_regime` and `market_breadth_history` both break the "one row per user" pattern (date-keyed histories) and both now auto-save — but for *different* reasons, worth keeping distinct: `market_breadth_history` never had a manual-save button (the "Save Today's Snapshot" concept doesn't apply — a cron-free tab-open trigger is the only way it can ever update, see `nse-market-data` skill). `market_regime` *did* have a manual "Save Today's Snapshot" button originally, by deliberate design — that was later **reversed** because the user explicitly didn't want a daily manual click. Don't assume "auto-save" always means "no button was ever possible" — check which case a table is before changing either.
- "Confirm email" setting and the Auth Site URL (should point at the deployed Vercel URL, not localhost) are configured in the Supabase dashboard (Authentication → Providers / URL Configuration) — not in code, so check there if signup/login redirects misbehave. This bit the user directly once: a password-reset email linked to `localhost` before the Site URL was fixed, and even after fixing it the app had no UI to actually complete a `PASSWORD_RECOVERY` session by setting a new password — both are now fixed (`#recoverygate` in `index.html`), but it's a reminder to actually click through auth flows end-to-end, not just assume Supabase's defaults work with this app's UI.
- `Index Future` got its own capital-allocation/leverage bucket (`alloc_indexfut_pct`/`lev_indexfut`) rather than sharing F&O's — explicit user choice, since index futures (NIFTY/BANKNIFTY/etc.) carry different margin/notional characteristics than single-stock F&O and the user wanted them tracked separately in Exposure/sizing, not just tagged differently.
- Segments simplified from 5 to 3 (`Equity Cash`/`Equity Futures`/`Index Future`) by explicit request — `F&O - Options` and `Commodity` removed entirely, not just hidden, after confirming live `trades` had zero rows using either (checked before dropping, not after). Existing rows were data-migrated (`'Equity'→'Equity Cash'`, `'F&O - Futures'→'Equity Futures'`), not left to silently stop matching. The old `lev_comm`/`alloc_comm_pct` columns were **not** dropped from the live table (avoids a destructive migration for near-zero benefit) — they just stopped being read/written by the client and were removed from `schema.sql`'s fresh-install baseline.
- See `nse-market-data` skill for everything about `api/regime.js`/`api/breadth.js`, live market-data endpoints, the regime-scoring formula, the EMA-breadth backfill architecture, the Sector Strength panel, and the position-sizing formula.
