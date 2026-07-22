# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

This repo is a single self-contained file: [index.html](index.html). It is a "Trading Desk" web app for logging trades, defining a personal trading playbook, and tracking capital/leverage exposure, backed by Supabase (Postgres + Auth) for storage and login. There is no build system, no package manager, no local server, and no test suite — all HTML/CSS/JS lives inline in that one file; the only other files are `supabase/schema.sql` (DB schema + RLS, run by hand in the Supabase SQL Editor) and `.claude/skills/supabase-backend/SKILL.md` (Supabase/RLS/auth conventions for this repo — read that before touching auth or adding a new table).

Deployed on Vercel, auto-deploying from `main` on `github.com/jainarham32-creator/trading`.

## Running / previewing

There is nothing to build or install. Open `index.html` directly in a browser, or serve the directory with any static file server (e.g. `npx serve .` or `python -m http.server`) if `file://` restrictions become an issue (note: this machine has no Node/npm/Vercel/Supabase CLI installed). There are no lint or test commands configured for this repo. Schema changes are applied by running SQL directly in the Supabase dashboard's SQL Editor — there is no migration runner.

## Architecture

Auth and storage are Supabase. The Supabase JS SDK is loaded via the **UMD** CDN build (not ESM), since the script is a plain non-module block and every handler is wired via inline `onclick="fn()"`, which requires `fn` to be a real global — see `.claude/skills/supabase-backend/SKILL.md` for why this matters if changing that.

Top-level layout is two sibling divs toggled by `supabase.auth.onAuthStateChange`: `#authgate` (email+password login/signup form) and `#app` (the actual tool, hidden until a session exists). Within `#app`, it's a single-page, tab-based UI with three views toggled by `.tab`/`.view` elements (`view-journal`, `view-rules`, `view-exposure`) — switching tabs just adds/removes an `active` class, no routing.

State lives in three Supabase tables, each scoped to the logged-in user via Row Level Security (`auth.uid() = user_id` on select/insert/update/delete — see `supabase/schema.sql`):
- `trades` — one row per trade (the journal), server-generated UUID `id`
- `rules` — one row per user, the whole playbook as columns (not key-value)
- `capital` — one row per user, total capital + per-segment leverage caps

`loadAllData()` runs after every successful sign-in, fetching all three tables in parallel (`fetchTrades`/`fetchRules`/`fetchCapital`) into the in-memory `trades`/`rules`/`capital` JS objects before the first render. On sign-out, those are reset to empty defaults in memory (not just hidden), so a second account logging in on the same tab never briefly sees stale data.

Each view has a corresponding render function that rebuilds its DOM from the in-memory state on every change (no framework, no virtual DOM):
- `renderJournal()` — renders open positions, closed trades, and the stats grid (win rate, expectancy) from the `trades` array. Also computes `pnl()` and `rMultiple()` per trade.
- `renderRules()` — renders the playbook textareas from `ruleFields` (a fixed list of rule categories: sizing, stops, trailing, targets, leverage, setups, checklist, non-negotiables).
- `renderExposure()` — recomputes segment-level notional exposure from open trades and compares it against the leverage caps in `capital`, flagging segments that are `OVER CAP`.

Data flow: a UI action (`addTrade`, `closeTradePrompt`, `deleteTrade`, `saveRules`, `saveCapital`) is now `async`, hits Supabase directly (insert/update/delete/upsert), then patches the in-memory object and calls the relevant `render*()` — no framework reactivity, every mutator manually re-renders. `rules`/`capital` writes use `upsert` (not `update`), since a new user has no row yet. JS objects are camelCase (`entryDate`, `levEquity`); Postgres columns are snake_case (`entry_date`, `lev_equity`) — there's no auto-mapping, every call site translates by hand (see the skill file for the exact mappings already in place).

Trade `segment` values (`Equity`, `F&O - Futures`, `F&O - Options`, `Commodity`) drive both the color-coded `.pill` styling (`segClass()`) and which leverage cap in `capital` applies to a trade in the exposure view.

`SUPABASE_URL`/`SUPABASE_ANON_KEY` are embedded directly in `index.html` — intentional, since the anon key is meant to be public and RLS is what actually enforces per-user isolation. The `service_role` key must never appear anywhere in this repo.
