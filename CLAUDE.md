# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

The frontend is a single self-contained file: [index.html](index.html). It is a "Trading Desk" web app for logging trades, defining a personal trading playbook, tracking capital/leverage exposure, reading a live market-regime dashboard, and getting a position-sizing sanity check — backed by Supabase (Postgres + Auth) for storage/login and one Vercel serverless function (`api/regime.js`) for live market data. There is no build system for the frontend, no test suite — all HTML/CSS/JS lives inline in `index.html`. Other files: `supabase/schema.sql` (fresh-install DB baseline) + `supabase/migration_*.sql` (incremental, additive changes actually run against the live project — run by hand in the Supabase SQL Editor), `package.json` (pins `engines.node` for Vercel's build of `api/regime.js` — no dependencies), and two skills: `.claude/skills/supabase-backend/SKILL.md` (Supabase/RLS/auth conventions — read before touching auth or adding a table) and `.claude/skills/nse-market-data/SKILL.md` (which NSE endpoints actually work, the regime-scoring heuristic, the position-sizing formula — read before touching `api/regime.js` or the Market Regime tab).

Deployed on Vercel, auto-deploying from `main` on `github.com/jainarham32-creator/trading`.

## Running / previewing

Nothing to build for the frontend. Open `index.html` directly in a browser, or serve the directory with any static file server (e.g. `python -m http.server`) if `file://` restrictions become an issue — note the Market Regime tab's live fetch (`/api/regime`) only works when deployed on Vercel, since that route is a serverless function with no local equivalent on this machine (no node/npm/Vercel CLI installed). There are no lint or test commands configured for this repo. Schema changes are applied by running SQL directly in the Supabase dashboard's SQL Editor — there is no migration runner. Any change to `api/regime.js` should be pushed and curl/fetch-tested against the live deployed URL before building UI on top of it — it can't be verified locally.

## Architecture

Auth and storage are Supabase. The Supabase JS SDK is loaded via the **UMD** CDN build (not ESM), since the script is a plain non-module block and every handler is wired via inline `onclick="fn()"`, which requires `fn` to be a real global — see `.claude/skills/supabase-backend/SKILL.md` for why this matters if changing that. The client variable is named `sb`, not `supabase` — the UMD bundle itself claims `window.supabase`, so `const supabase = ...` at top level is an illegal redeclaration that silently breaks the entire script.

Top-level layout is two sibling divs toggled by `sb.auth.onAuthStateChange`: `#authgate` (email+password login/signup form) and `#app` (the actual tool, hidden until a session exists). Within `#app`, it's a single-page, tab-based UI with four views toggled by `.tab`/`.view` elements (`view-journal`, `view-rules`, `view-exposure`, `view-regime`) — switching tabs just adds/removes an `active` class, no routing.

State lives in four Supabase tables, each scoped to the logged-in user via Row Level Security (`auth.uid() = user_id` on select/insert/update/delete — see `supabase/schema.sql`):
- `trades` — one row per trade (the journal), server-generated UUID `id`; includes `setup` (from an editable dropdown, see `rules.setup_options`) and `market_cap` (`Large Cap`/`Mid Cap`/`Small Cap`, fixed enum)
- `rules` — one row per user, the whole playbook as columns (not key-value), plus `setup_options`/`setup_multipliers` (jsonb) driving the Journal's setup dropdown and its per-setup sizing multiplier
- `capital` — one row per user, total capital + per-segment leverage caps + 6 position-sizing multiplier columns (market-cap × regime)
- `market_regime` — the only table that *isn't* one-row-per-user: a `(user_id, snapshot_date)`-keyed history of daily market-condition snapshots, written only when the user clicks "Save Today's Snapshot" (no cron/auto-save)

`loadAllData()` runs after every successful sign-in, fetching all four tables in parallel (`fetchTrades`/`fetchRules`/`fetchCapital`/`fetchLatestRegime`) into in-memory JS objects before the first render. On sign-out, those reset to empty defaults in memory (not just hidden), so a second account logging in on the same tab never briefly sees stale data.

Each view has a corresponding render function that rebuilds its DOM from the in-memory state on every change (no framework, no virtual DOM):
- `renderJournal()` — open positions, closed trades, stats grid, and a per-trade **Size** flag (`OVERSIZED`/`undersized`/`OK`) comparing `actualRiskPct()` against `suggestedRiskPct()` (setup × market-cap × regime multipliers, see `nse-market-data` skill for the formula).
- `renderRules()` / `renderSetupOptions()` — playbook textareas, plus an editable list of setup names + per-setup multipliers (`addSetupOptionRow`/`removeSetupOptionRow`/`saveSetupOptions`) that also feeds `populateSetupDropdown()` for the trade form's Setup select.
- `renderExposure()` — segment-level notional exposure vs. leverage caps, flagging `OVER CAP`.
- `renderRegimeTab()` / `renderRegimeHistory()` — live-fetched tiles (VIX, FII/DII net, new highs/lows) from `/api/regime`, a manual PCR input (not auto-fetchable, see skill), `computeRegimeScore()` for a Risk-On/Neutral/Risk-Off read, and a plain history table of saved snapshots.

Data flow: a UI action is `async`, hits Supabase directly (insert/update/delete/upsert), then patches the in-memory object and calls the relevant `render*()` — no framework reactivity. `rules`/`capital` writes use `upsert` (one-row-per-user, new users have no row yet); `market_regime` upserts on `onConflict:'user_id,snapshot_date'` so re-saving the same day overwrites rather than duplicating. JS objects are camelCase; Postgres columns are snake_case — no auto-mapping, every call site translates by hand (see `supabase-backend` skill for the exact mappings). **`saveRules()` builds an explicit payload of only the free-text rule fields** rather than spreading the whole `rules` object — `rules` also holds `setupOptions`/`setupMultipliers` (camelCase, no matching DB column), and spreading it would send Supabase invalid keys.

Trade `segment` values (`Equity`, `F&O - Futures`, `F&O - Options`, `Commodity`) drive both the color-coded `.pill` styling (`segClass()`) and which leverage cap in `capital` applies in the exposure view. Trade `market_cap` and `setup` separately drive the position-sizing suggestion in the Journal.

`SUPABASE_URL`/`SUPABASE_ANON_KEY` are embedded directly in `index.html` — intentional, since the anon key is meant to be public and RLS is what actually enforces per-user isolation. The `service_role` key must never appear anywhere in this repo, including `api/regime.js` — that function is a pure read-only NSE proxy (browser can't call NSE directly: CORS + bot-protection) and never touches Supabase at all; saving a snapshot happens client-side, authenticated as the user, same as every other table.
