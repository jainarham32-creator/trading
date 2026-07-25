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
| All-indices daily closing values | `GET https://archives.nseindia.com/content/indices/ind_close_all_DDMMYYYY.csv` | Simple CSV, no quoting: `Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield`, one row per NSE index. The literal `Nifty 500` row is the source for the Regime Score's index-level 20-EMA factor — verified real value 2026-07-24: `22913.3`. |
| Sector/thematic index constituent lists | `GET https://archives.nseindia.com/content/indices/ind_nifty<slug>list.csv` | Same shape/host as the NIFTY 500 list above. Confirmed working for 14 slugs (`auto`, `bank`, `psubank`, `realty`, `metal`, `energy`, `fmcg`, `it`, `media`, `commodities`, `consumption`, `cpse`, `oilgas`, `pharma`) — see the Sector Strength section below. Several other plausible slugs 404'd (`privatebank`, `infrastructure`, `housing`, `financialservices`) — don't assume every NSE sectoral index follows this exact naming pattern without testing first. |

## Confirmed NOT working — don't re-try without a new reason to

- `GET https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY` (the old guess for PCR) → **404 Not Found**. Superseded by the participant-OI derivation above — don't bother with option-chain again.
- `GET https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY` → 200 but body is 2 bytes (empty) — needs proper session cookies, unlike everything else here.
- `GET https://www.nseindia.com/api/liveEquity-derivatives?index=nse50_pe_ratio` → 500 Internal Server Error.

## Explicitly out of scope

Nothing from the original reference screenshot remains unbuilt — "% up 20%/30% in 5 days" and "up/down 4%+ on volume" were added in a later round (see the 5-day/volume section below), reusing the exact same bhavcopy pipeline as EMA breadth rather than a new data source.

## `api/regime.js` — daily snapshot, always fresh, no persistent state

Pure read-only proxy (`api/regime.js` at repo root, Vercel auto-detects `api/*.js` as a zero-config Node function — no `vercel.json` needed), `module.exports = async (req,res)=>{...}` (CommonJS — avoids needing `"type":"module"` in `package.json`). Fetches VIX/FII-DII/highs-lows/PCR in parallel via `safeFetch`/`safeFetchCsv` helpers that never throw — a failed fetch becomes `{error: '...'}` for that field only. **Always returns HTTP 200**. Response shape:
```json
{ "fetchedAt": "...", "vix": 13.48, "vixError": null, "fiiNet": -2999.23, "diiNet": 2947.14, "fiiDiiDate": "23-Jul-2026", "fiiDiiError": null, "newHighs": 63, "newHighsError": null, "newLows": 55, "newLowsError": null, "pcr": 0.7866, "pcrDate": "23072026", "pcrError": null, "fiiOptionsPcr": 1.6772, "fiiOptionsPcrError": null, "nifty500Close": 22913.3, "nifty500Date": "24072026", "nifty500Error": null }
```
`nifty500Close`/`nifty500Date` (added this round) come from the `ind_close_all` file above via the same `safeFetchCsv` walk-back helper already used for PCR — extracted by `parseIndexClose(text, 'Nifty 500')`, a small dedicated parser since this file's shape (simple CSV, no title row, no quoting) differs from the participant-OI file's.
`package.json` at repo root pins `engines.node: "24.x"` — **not 18.x**: Vercel rejected `"18.x"` outright on first deploy ("Found invalid or discontinued Node.js Version") and the build failed before the function ever went live. Global `fetch` is built into modern Node, so no dependencies are needed; Vercel's remote build runs `npm install` on its own servers (this dev machine still has no node/npm).

**Never** add Supabase credentials to this function or `api/breadth.js` below — both stay pure external-data proxies. Saving into Supabase always happens client-side in `index.html`, authenticated as the logged-in user, same RLS pattern as every other table (see `supabase-backend` skill).

**Verification note**: these functions cannot be tested locally (no node/vercel-dev on this machine) — always push alone first and curl/fetch the live URL to confirm real data before wiring any UI to depend on it. That workflow caught the Node-version build failure above before any UI work was wasted on top of a broken deploy.

## EMA-breadth architecture — why it's split into an offline backfill + a lightweight daily proxy

Computing a 50/200-day EMA per NIFTY 500 stock needs ~300 days of history *per symbol*. Fetching that live inside one HTTP request is not viable (≈300 sequential bhavcopy fetches × 0.5s ≈ 150s — far past any reasonable serverless timeout). So this is split in two:

1. **One-time backfill** (`scripts/backfill_ema.py`, run from a dev machine, not deployed): fetches trading-day bhavcopy going back `TARGET_TRADING_DAYS` (700 as of this round, up from an original 320 — NSE archives confirmed retained at least 3 years back via a spot-check), computes EMA50/EMA200 per symbol (seed = SMA of the first 50/200 closes, then the standard incremental formula `ema = close×k + prevEma×(1-k)`, `k = 2/(N+1)`), and derives the daily aggregate `% above 50 EMA` / `% above 200 EMA` for the trading days beyond the warm-up window (~501 days of real output as of the 700-day re-run, spanning 2024-08-08 to present). Output committed as `scripts/ema_backfill_<date>.json` — both for reproducibility and so it's fetchable from the deployed static site (`/scripts/ema_backfill_<date>.json`) to persist without inlining the JSON into a browser console command. **Gotcha**: `fetchBreadthHistory()`'s Supabase query has its own `.limit(N)` independent of how many rows actually exist — raising the backfill's depth without also raising this limit (750 as of this round) silently truncates the extra history right back out of the charts. Re-running this script re-upserts `market_breadth_history` in chunks (Supabase upsert payloads get unwieldy past a few hundred rows) — `onConflict:'user_id,snapshot_date'` means older rows are added, not duplicated, alongside whatever the daily incremental proxy has already written for recent dates.
2. **Persisting the backfill**: done via an already-authenticated browser session (never a stored password, never `service_role`) — `fetch('/scripts/ema_backfill_<date>.json')` then `sb.from('ema_state').upsert({user_id, state: data.emaState}, {onConflict:'user_id'})` and `sb.from('market_breadth_history').upsert(rows, {onConflict:'user_id,snapshot_date'})`.
3. **Ongoing update, `api/breadth.js`**: a lightweight proxy fetching only *one* day's bhavcopy (fast, safe inside a single request), returning `{date, closes: {SYMBOL: price}, volumes: {SYMBOL: qty}, error}` (extended later to also carry volume — see the 5-day/volume section below). All math happens **client-side** in `updateBreadthIfNeeded()` (`index.html`), using the persisted `ema_state` from yesterday plus today's `closes`/`volumes` — no historical refetch needed for the daily increment.
4. **Trigger — tab-open, not cron**: `updateBreadthIfNeeded()` runs when the Market Regime tab is opened, called from `onTabShown()` (also fired once right after login for whichever tab starts active — Market Regime is now the default landing tab, and its data-loading was originally only wired to the tab-*click* handler, which silently never fired on first load; fixed by extracting the shared logic into `onTabShown()` and calling it once post-login too). It checks `market_breadth_history`'s latest `snapshot_date`; if already today, no-op (skips a redundant 369KB fetch). This is deliberate, not a workaround for missing infrastructure — a cron-invoked function would need either a `service_role` key or a stored user credential to write to Supabase, and this app never does either. If the day's bhavcopy isn't published yet (market still open, holiday), it degrades silently (a status line, never `alert()`).

**Verified**: forcing a stale date (deleting today's `market_breadth_history` row) and re-triggering recomputed the exact same `pct_above_50ema`/`pct_above_200ema` values as the original offline backfill for that date — strong evidence the incremental client-side formula matches the batch-computed one. **Gotcha hit while verifying the 5-day/volume extension**: deleting only the `market_breadth_history` row and re-triggering *without* also rewinding `ema_state` replays the *same* day against itself (state's `lastDate` was already that day), which correctly reproduces the EMA %s (they're barely perturbed) but silently zeroes the 1-day-move-dependent counts (`pct1d` becomes 0 since `prior.lastClose` is already today's own close) — not a code bug, just means this specific test technique only validates EMA, not the move-based stats. Validate those with synthetic hand-computed inputs instead (known base price + 5-day-ago close + volume vs. a known 20-day average), not by replaying an already-persisted day.

**Schema** (`ema_state`, `market_breadth_history` — see `supabase-backend` skill for full DDL): `ema_state` is deliberately **one row per user holding a jsonb map** of all ~500 symbols, not 500 rows — matches this app's "config lives as one row per user, jsonb for structured sub-data" pattern (same as `rules.setup_options`). `market_breadth_history` is its own table, not new columns on `market_regime`, because it needs to auto-update with literally no click possible, which is a different (and stronger) reason than why `market_regime` *also* now auto-saves (that one had a button, removed by request — see `supabase-backend` skill's decisions log).

## 5-day-move and volume-confirmed-move stats (extends the EMA-breadth pipeline above, not a new one)

Both reuse the exact same single-day `closes`/`volumes` payload from `api/breadth.js` and the same `ema_state.state[symbol]` jsonb blob — just with two extra rolling arrays per symbol, `recentCloses` (max 6) and `recentVolumes` (max 20), maintained client-side in `updateBreadthIfNeeded()` (`index.html`) and by `scripts/backfill_ema.py` for the historical backfill.

- **`countUp20_5d` / `countUp30_5d`** — % movers over the last 5 trading days. `recentCloses[0]` (5 trading days ago) vs. today's close: `pct5d = (price - recentCloses[0]) / recentCloses[0] * 100`. A symbol only counts once `recentCloses` has reached its full 6 elements (today + 5 priors). Thresholds are **cumulative, not mutually exclusive** — a stock up 35% counts in *both* `countUp20_5d` and `countUp30_5d`, matching how screener tools conventionally report "up X%+" counts (deliberate design, not a bug if the two numbers look like they "overlap").
- **`countUp4pctVol` / `countDown4pctVol`** — 1-day price move of ≥±4% **and** that day's volume > 1.5× (`VOLUME_MULTIPLE`) its own trailing 20-day average (`recentVolumes`, excluding today). Price alone is deliberately not enough — this is a volume-*confirmed* move, matching the user's explicit requirement that these two counts require "elevated volume too," not just a raw percentage screener. `recentVolumes` needs to already hold 20 prior entries (i.e. this stat has a longer warm-up than the 5-day-move one) before a symbol can qualify.
- Both stats source volume from the bhavcopy's `TTL_TRD_QNTY` column — `api/breadth.js`'s `parseClosesAndVolumes()` and `backfill_ema.py`'s `parse_closes_and_volumes()` both extract it alongside `CLOSE_PRICE` (previously only price was parsed; extending this required no new data source, just reading one more existing column).
- Rendered as two more paired histogram charts in Market Regime's main column (`#chart-move-5d`, `#chart-move-vol`), same visual pattern as the pre-existing New-Highs/New-Lows pairing, fed from `market_breadth_history`'s 4 new integer columns (see `supabase-backend` skill for the DDL).

## Charting — lightweight-charts (TradingView's open-source library)

`https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js`, loaded via `<script>` tag alongside the Supabase UMD one. Chart instances are created once per container and cached in `chartCache` (`getOrCreateChart()` in `index.html`) — re-renders call `.setData()` on the cached series, never recreate the chart, so zoom/pan state and canvas instances survive repeated tab visits. Mouse-wheel zoom + drag-pan work by default in this library, no extra config. Colors are read once from this app's CSS custom properties (`chartColor('--amber')` etc.) rather than hardcoded hex, so the chart palette stays in sync with the rest of the UI. Both `regimeHistory` and `breadthHistory` are queried newest-first for table display, so chart-feeding code reverses to ascending before `setData()`.

## Regime scoring v2 (client-side, `computeRegimeScore()` in `index.html`)

Rewritten this round from a small +1/-1 integer heuristic to 5 factors, each scored 0–100 and weighted equally (20%), averaged into one composite:

| Factor | Bands → score |
|---|---|
| VIX | `<14`→100 · `14–20`→66 · `20–25`→33 · `>25`→0 |
| % NIFTY 500 above 50 EMA | `<20`→0 · `20–50`→60 · `50–70`→100 · `>70`→40 (overbought — a caution flag, not an all-clear) |
| PCR | `≤0.8`→0, `≥1.2`→100, straight-line interpolation between |
| New Highs vs Lows | `newHighs > newLows`→100 · `newLows > 1.5×newHighs`→0 · else→50 |
| NIFTY 500 vs. its own 20 EMA (new, see below) | above→100 · 0 to −2% below→50 · more than −2% below→0 |

`score ≥ 65 → "Risk-On"`, `≤ 35 → "Risk-Off"`, else `"Neutral"` — same 3-bucket label everywhere else in the app (`.pos`/`.neg` coloring, `regimeMult()` lookups, `market_regime.regime_label`) is unchanged. **Any single missing factor makes the whole score `null`** (rendered as "Scoring…", never a partial average) — this matters because the 5 inputs come from two independent async chains (`liveRegime` from `/api/regime` in one shot; `breadthHistory[0].pctAbove50Ema` from the separate breadth pipeline) with no ordering guarantee. `maybeAutoSaveRegime()` gates the actual save the same way, plus a `regimeAutoSavedForDate` flag so it only fires once per day regardless of which of `fetchRegimeLive()` / `afterBreadthUpdate()` resolves last.

`market_regime` is keyed on `(user_id, snapshot_date)` with a unique constraint — `autoSaveRegimeSnapshot()` upserts with `onConflict:'user_id,snapshot_date'`, so re-saving the same day overwrites rather than duplicating.

### NIFTY 500's own 20-EMA — a single-series variant of the EMA-breadth pattern

Unlike the other 4 factors (all either already-tracked breadth or single-fetch live data), "is the index above its own trend" needed new state: `market_regime.nifty500_close`/`nifty500_ema20`, seeded once via `scripts/backfill_nifty500_ema20.py` (fetches ~30 days of `ind_close_all`, seeds via SMA-then-incremental, `k=2/21` — the same shape as `backfill_ema.py` but one series instead of 500, so only a 20-day warm-up not 200) and persisted the same way (authenticated browser session, never `service_role`). Ongoing: `computeNifty500Ema20Today()` in `index.html` rolls `currentRegime.nifty500Ema20` (yesterday's saved value) forward using today's `liveRegime.nifty500Close` — same incremental-EMA math as `ema_state`, just scoped to `market_regime` instead of a dedicated table, since it's one number per day rather than a per-symbol map.

## Sector Strength panel (Market Regime page, right column)

Ranked horizontal bars showing % of each sector's constituents trading above their 200-day EMA — modeled on a third-party screener's reference layout the user shared, not an NSE-published metric itself. **Zero new serverless calls or DB writes** — a pure client-side aggregation:
- `sectors.json` (repo root, same manually-refreshed convention as `nifty500.json`): `{sectorName: [symbols]}` for **14 confirmed** NSE sector/thematic indices (see the endpoints table above for the slugs and which ones 404'd). Fetched once per page load, cached in `sectorsData`.
- `emaStateCache` (module-level in `index.html`, new this round): the `ema_state.state` blob is fetched by `updateBreadthIfNeeded()` anyway to do the daily EMA roll-forward — previously discarded after use, now kept around so `renderSectorStrength()` doesn't need its own Supabase round-trip. `afterBreadthUpdate()` (a wrapper added this round covering every one of `updateBreadthIfNeeded()`'s exit paths — weekend, error, already-current, or a real update) lazily fetches `ema_state` if `emaStateCache` is still `null` (e.g. today was already up to date before this page load), so the panel doesn't stay stuck on "Loading…" just because no recompute happened this visit.
- For each sector, counts `lastClose > ema200` over constituents *present in `emaStateCache`* — any sector symbol outside the NIFTY 500 EMA-tracked universe (e.g. `PSB`, `DBCORP` — small/micro caps some sector indices include that the 500-stock backfill doesn't track) is silently skipped from that sector's denominator, same "don't fabricate data for untracked symbols" rule as everywhere else.
- Rendered as plain HTML/CSS bars (`.sector-bar-row`/`.sector-bar-track`/`.sector-bar-fill`), not `lightweight-charts` — that library is built for time-series, not ranked categorical bars. Color bands (`≥60%` green, `35–59%` amber, `<35%` red) are this app's own choice for the visual style, not copied from any specific source.

## Position-sizing formula (`suggestedRiskPct()` in `index.html`)

```
suggestedRiskPct(trade) = capital.riskPerTrade
  × (rules.setupMultipliers[trade.setup] ?? 1.0)
  × marketCapMult(trade.marketCap)     // capital.multLargeCap / multMidCap / multSmallCap, default 1.0 if unset
  × regimeMult(currentRegime.label)    // capital.multRiskOn / multNeutral / multRiskOff
```
Compared against `actualRiskPct(trade) = |entry − sl| × qty / segmentCapital(trade.segment) × 100` (stop-distance risk, consistent with what "Max Risk per Trade %" already means — deliberately *not* notional exposure, which is what the separate Exposure-tab leverage-cap logic already covers). `segmentCapital(segment) = capital.total × (allocPct[segment] / 100)`, where `allocPct` comes from `capital.allocEquityPct`/`allocFnoPct`/`allocIndexfutPct`/`allocCommPct` (default 50/30/20/20) — **not** `capital.total` directly. `'Index Future'` (added this round for NIFTY/BANKNIFTY/etc. futures — distinct margin/notional profile from single-stock F&O) gets its own bucket rather than sharing F&O's, by explicit user choice. This replaced an earlier version that divided every segment's risk by 100% of total capital regardless of segment, which made F&O trades look disproportionately huge (a real sizing bug, not a display issue) since F&O was effectively being compared against capital it doesn't actually have sole claim to. The fix can make numbers look *more* extreme for a genuinely over-concentrated segment — that's intentional, an honest number rather than a suppressed one. Same `segmentCapital()` helper backs the Exposure tab's leverage-used calculation, so the two views stay consistent. Flagged `OVERSIZED` if actual `> 1.5×` suggested, `undersized` if `< 0.5×`, else `OK` — rendered as a "Size" column in the Journal's open-positions table using the same `.flag`/`.warn`/`.ok` classes as the Exposure tab's `OVER CAP`. `currentRegime` comes from the last **saved** `market_regime` row (`fetchLatestRegime()`, loaded once in `loadAllData()`), not a live NSE call on every Journal render — verified legacy trades with no `market_cap` or an unrecognized `setup` degrade cleanly to `1.0` multipliers with no errors.
