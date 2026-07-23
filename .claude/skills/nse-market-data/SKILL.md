---
name: nse-market-data
description: Which NSE public data endpoints actually work for the Trading Desk's Market Regime tab and EMA-breadth charts, which don't, and the regime/sizing/breadth formulas built on top of them. Use before touching api/regime.js, api/breadth.js, the Market Regime tab, or adding any new live market-data indicator.
---

# NSE market data — what's confirmed working

This research is expensive to redo (NSE's undocumented endpoints shift and its bot-protection is inconsistent) — check here before re-testing anything below.

## Confirmed working — `www.nseindia.com/api/*` family (tested 2026-07, from both a dev sandbox and live in Vercel production — both worked identically, so an earlier IP-blocking concern was unfounded)

| Data | Endpoint | Extraction |
|---|---|---|
| India VIX | `GET https://www.nseindia.com/api/allIndices` | Find the entry where `indexSymbol` (or `index`) `=== 'INDIA VIX'`, read `.last`. |
| FII/DII net flows | `GET https://www.nseindia.com/api/fiidiiTradeReact` | Array with one row per `category` (`'FII/FPI'`, `'DII'`), each with `netValue` (₹ crore, latest session), `date`. |
| New highs count | `GET https://www.nseindia.com/api/live-analysis-data-52weekhighstock` | Top-level `.high` field is a ready-made count — don't count the array. |
| New lows count | `GET https://www.nseindia.com/api/live-analysis-data-52weeklowstock` | Top-level `.low` field, same pattern. |

Note these are **52-week** high/low counts, an approximation of "new highs/lows" — not the same as a shorter (e.g. daily) new-high/low lookback shown in some screener tools.

Header used: `{'User-Agent': 'Mozilla/5.0 ... Chrome/124.0 Safari/537.36', 'Accept': 'application/json,*/*'}`. Oddly, `https://www.nseindia.com/` (the homepage) 403'd with the same headers, while these JSON API endpoints returned 200 directly — NSE's bot-protection is endpoint-specific, not blanket.

## Confirmed working — `archives.nseindia.com` family (a different, simpler static-file host — no session/cookie needed at all, just a `User-Agent` header)

| Data | Endpoint | Notes |
|---|---|---|
| NIFTY 500 constituent list | `GET https://archives.nseindia.com/content/indices/ind_nifty500list.csv` | CSV: `Company Name,Industry,Symbol,Series,ISIN Code`. Fetched once, converted to `nifty500.json` at repo root (Vercel serves it statically at `/nifty500.json`) — refreshed manually, not live, since NSE only rebalances this list quarterly. |
| Daily historical OHLC (bhavcopy) | `GET https://archives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv` | Full-market daily OHLC, one file per calendar day (~369KB). Columns include leading spaces after each comma (`SYMBOL, SERIES, DATE1, ...`) — always `.trim()` both header and cell values. `SERIES` must be filtered to `'EQ'` (equity) rows. 404s on weekends/holidays — treat as "not a trading day," not an error. Benchmarked ~0.5s/day fetch. |
| Participant-wise Open Interest (→ PCR) | `GET https://archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv` | Small (~1KB) end-of-day CSV: a title row, then a header row (some column names have **trailing whitespace before the comma** — trim!), then one row per `Client Type` (`Client`/`DII`/`FII`/`Pro`/`TOTAL`). `pcr = TOTAL['Option Index Put Long'] / TOTAL['Option Index Call Long']` (verified real example: 3945113/4697731 ≈ 0.84). The `FII` row's own Call/Put Long gives a free bonus `fiiOptionsPcr`. Same-day file may not be published yet — retry up to a few days back. |

## Confirmed NOT working — don't re-try without a new reason to

- `GET https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY` (the old guess for PCR) → **404 Not Found**. Superseded by the participant-OI derivation above — don't bother with option-chain again.
- `GET https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY` → 200 but body is 2 bytes (empty) — needs proper session cookies, unlike everything else here.
- `GET https://www.nseindia.com/api/liveEquity-derivatives?index=nse50_pe_ratio` → 500 Internal Server Error.

## Explicitly out of scope (not attempted)

"% up 20%/30% in 5 days" and "count up/down 4%+ on volume" (from the original reference screenshot) aren't implemented — only the 50/200-EMA breadth and new-highs/lows were built. Revisit only if asked; the bhavcopy data needed is already being fetched for EMA breadth, so these would reuse the same pipeline, just with different per-day math (% change over a 5-day window, volume comparison) rather than needing new data sources.

## `api/regime.js` — daily snapshot, always fresh, no persistent state

Pure read-only proxy (`api/regime.js` at repo root, Vercel auto-detects `api/*.js` as a zero-config Node function — no `vercel.json` needed), `module.exports = async (req,res)=>{...}` (CommonJS — avoids needing `"type":"module"` in `package.json`). Fetches VIX/FII-DII/highs-lows/PCR in parallel via `safeFetch`/`safeFetchCsv` helpers that never throw — a failed fetch becomes `{error: '...'}` for that field only. **Always returns HTTP 200**. Response shape:
```json
{ "fetchedAt": "...", "vix": 13.48, "vixError": null, "fiiNet": -2999.23, "diiNet": 2947.14, "fiiDiiDate": "23-Jul-2026", "fiiDiiError": null, "newHighs": 63, "newHighsError": null, "newLows": 55, "newLowsError": null, "pcr": 0.7866, "pcrDate": "23072026", "pcrError": null, "fiiOptionsPcr": 1.6772, "fiiOptionsPcrError": null }
```
`package.json` at repo root pins `engines.node: "24.x"` — **not 18.x**: Vercel rejected `"18.x"` outright on first deploy ("Found invalid or discontinued Node.js Version") and the build failed before the function ever went live. Global `fetch` is built into modern Node, so no dependencies are needed; Vercel's remote build runs `npm install` on its own servers (this dev machine still has no node/npm).

**Never** add Supabase credentials to this function or `api/breadth.js` below — both stay pure external-data proxies. Saving into Supabase always happens client-side in `index.html`, authenticated as the logged-in user, same RLS pattern as every other table (see `supabase-backend` skill).

**Verification note**: these functions cannot be tested locally (no node/vercel-dev on this machine) — always push alone first and curl/fetch the live URL to confirm real data before wiring any UI to depend on it. That workflow caught the Node-version build failure above before any UI work was wasted on top of a broken deploy.

## EMA-breadth architecture — why it's split into an offline backfill + a lightweight daily proxy

Computing a 50/200-day EMA per NIFTY 500 stock needs ~300 days of history *per symbol*. Fetching that live inside one HTTP request is not viable (≈300 sequential bhavcopy fetches × 0.5s ≈ 150s — far past any reasonable serverless timeout). So this is split in two:

1. **One-time backfill** (`scripts/backfill_ema.py`, run from a dev machine, not deployed): fetches ~300-320 trading days of bhavcopy, computes EMA50/EMA200 per symbol (seed = SMA of the first 50/200 closes, then the standard incremental formula `ema = close×k + prevEma×(1-k)`, `k = 2/(N+1)`), and derives the daily aggregate `% above 50 EMA` / `% above 200 EMA` for the trading days beyond the warm-up window. Output committed as `scripts/ema_backfill_<date>.json` — both for reproducibility and so it's fetchable from the deployed static site (`/scripts/ema_backfill_<date>.json`) to persist without inlining ~60KB of JSON into a browser console command.
2. **Persisting the backfill**: done via an already-authenticated browser session (never a stored password, never `service_role`) — `fetch('/scripts/ema_backfill_<date>.json')` then `sb.from('ema_state').upsert({user_id, state: data.emaState}, {onConflict:'user_id'})` and `sb.from('market_breadth_history').upsert(rows, {onConflict:'user_id,snapshot_date'})`.
3. **Ongoing update, `api/breadth.js`**: a lightweight proxy fetching only *one* day's bhavcopy (fast, safe inside a single request), returning `{date, closes: {SYMBOL: price}, error}`. All EMA math happens **client-side** in `updateBreadthIfNeeded()` (`index.html`), using the persisted `ema_state` from yesterday plus today's `closes` — no historical refetch needed for the daily increment.
4. **Trigger — tab-open, not cron**: `updateBreadthIfNeeded()` runs when the Market Regime tab is opened. It checks `market_breadth_history`'s latest `snapshot_date`; if already today, no-op (skips a redundant 369KB fetch). This is deliberate, not a workaround for missing infrastructure — a cron-invoked function would need either a `service_role` key or a stored user credential to write to Supabase, and this app never does either. If the day's bhavcopy isn't published yet (market still open, holiday), it degrades silently (a status line, never `alert()`).

**Verified**: forcing a stale date (deleting today's `market_breadth_history` row) and re-triggering recomputed the exact same `pct_above_50ema`/`pct_above_200ema` values as the original offline backfill for that date — strong evidence the incremental client-side formula matches the batch-computed one.

**Schema** (`ema_state`, `market_breadth_history` — see `supabase-backend` skill for full DDL): `ema_state` is deliberately **one row per user holding a jsonb map** of all ~500 symbols, not 500 rows — matches this app's "config lives as one row per user, jsonb for structured sub-data" pattern (same as `rules.setup_options`). `market_breadth_history` is its own table, not new columns on `market_regime`, because `market_regime` has a deliberate no-auto-save invariant (only writes on an explicit "Save Today's Snapshot" click) that auto-updating breadth would silently break.

## Charting — lightweight-charts (TradingView's open-source library)

`https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js`, loaded via `<script>` tag alongside the Supabase UMD one. Chart instances are created once per container and cached in `chartCache` (`getOrCreateChart()` in `index.html`) — re-renders call `.setData()` on the cached series, never recreate the chart, so zoom/pan state and canvas instances survive repeated tab visits. Mouse-wheel zoom + drag-pan work by default in this library, no extra config. Colors are read once from this app's CSS custom properties (`chartColor('--amber')` etc.) rather than hardcoded hex, so the chart palette stays in sync with the rest of the UI. Both `regimeHistory` and `breadthHistory` are queried newest-first for table display, so chart-feeding code reverses to ascending before `setData()`.

## Regime scoring (client-side, `computeRegimeScore()` in `index.html`)

v1 heuristic, documented in-code as provisional — not yet exposed as an editable-thresholds UI (only the *multipliers* it feeds into are user-editable, in the Capital panel):
- VIX `< 13` → +1, `> 25` → −2, `> 18` → −1
- FII net `> ₹1000cr` → +1, `< −₹1000cr` → −1
- `newHighs > newLows` → +1, `newLows > newHighs × 1.5` → −1
- PCR `> 1.2` → +1, `< 0.8` → −1 (now always auto-fetched via `liveRegime.pcr` — the manual input was removed)
- score `≥ 2` → `"Risk-On"`, `≤ −2` → `"Risk-Off"`, else `"Neutral"`

`market_regime` is keyed on `(user_id, snapshot_date)` with a unique constraint — `saveRegimeSnapshot()` upserts with `onConflict:'user_id,snapshot_date'`, so re-saving the same day overwrites rather than duplicating.

## Position-sizing formula (`suggestedRiskPct()` in `index.html`)

```
suggestedRiskPct(trade) = capital.riskPerTrade
  × (rules.setupMultipliers[trade.setup] ?? 1.0)
  × marketCapMult(trade.marketCap)     // capital.multLargeCap / multMidCap / multSmallCap, default 1.0 if unset
  × regimeMult(currentRegime.label)    // capital.multRiskOn / multNeutral / multRiskOff
```
Compared against `actualRiskPct(trade) = |entry − sl| × qty / capital.total × 100` (stop-distance risk, consistent with what "Max Risk per Trade %" already means — deliberately *not* notional exposure, which is what the separate Exposure-tab leverage-cap logic already covers). Flagged `OVERSIZED` if actual `> 1.5×` suggested, `undersized` if `< 0.5×`, else `OK` — rendered as a "Size" column in the Journal's open-positions table using the same `.flag`/`.warn`/`.ok` classes as the Exposure tab's `OVER CAP`. `currentRegime` comes from the last **saved** `market_regime` row (`fetchLatestRegime()`, loaded once in `loadAllData()`), not a live NSE call on every Journal render — verified legacy trades with no `market_cap` or an unrecognized `setup` degrade cleanly to `1.0` multipliers with no errors.
