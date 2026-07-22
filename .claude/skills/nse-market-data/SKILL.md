---
name: nse-market-data
description: Which NSE public data endpoints actually work for the Trading Desk's Market Regime tab, which don't, and the regime/sizing formulas built on top of them. Use before touching api/regime.js, the Market Regime tab, or adding any new live market-data indicator.
---

# NSE market data — what's confirmed working

This research is expensive to redo (NSE's undocumented endpoints shift and its bot-protection is inconsistent) — check here before re-testing anything below.

## Confirmed working (tested 2026-07, from both a dev sandbox and live in Vercel production — both worked identically, so the earlier IP-blocking concern was unfounded)

| Data | Endpoint | Extraction |
|---|---|---|
| India VIX | `GET https://www.nseindia.com/api/allIndices` | Find the entry where `indexSymbol` (or `index`) `=== 'INDIA VIX'`, read `.last`. |
| FII/DII net flows | `GET https://www.nseindia.com/api/fiidiiTradeReact` | Array with one row per `category` (`'FII/FPI'`, `'DII'`), each with `netValue` (₹ crore, latest session), `date`. |
| New highs count | `GET https://www.nseindia.com/api/live-analysis-data-52weekhighstock` | Top-level `.high` field is a ready-made count — don't count the array. |
| New lows count | `GET https://www.nseindia.com/api/live-analysis-data-52weeklowstock` | Top-level `.low` field, same pattern. |

Note these are **52-week** high/low counts, an approximation of "new highs/lows" — not the same as a shorter (e.g. daily) new-high/low lookback shown in some screener tools.

Header used: `{'User-Agent': 'Mozilla/5.0 ... Chrome/124.0 Safari/537.36', 'Accept': 'application/json,*/*'}`. Oddly, `https://www.nseindia.com/` (the homepage) 403'd with the same headers, while these JSON API endpoints returned 200 directly — NSE's bot-protection is endpoint-specific, not blanket.

## Confirmed NOT working — don't re-try without a new reason to

- `GET https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY` (the usual PCR source) → **404 Not Found**.
- `GET https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY` → 200 but body is 2 bytes (empty array/object) — endpoint exists but needs something else (likely proper session cookies, unlike the endpoints above).
- `GET https://www.nseindia.com/api/liveEquity-derivatives?index=nse50_pe_ratio` → 500 Internal Server Error.
- **Decision**: PCR is a manual-entry-only field (`market_regime.pcr`, `#regime-pcr` input) for now. If revisiting, try the cookie-priming dance (GET the homepage first, carry `Set-Cookie` into the API call) even though the confirmed-working endpoints above didn't need it — option-chain data may be more heavily guarded.

## Explicitly out of scope (not attempted)

Screenshot-driven asks like "% of stocks above 20/50/200 EMA," "% up 20%/30% in 5 days," "count up/down 4%+ on volume" need bulk per-stock historical OHLC across ~1600+ NSE symbols (e.g. from NSE's daily Bhavcopy CSV archives) plus real computation — a genuinely bigger data-engineering task, not a single endpoint. Documented here as a real Phase 2, not forgotten, not attempted.

## `api/regime.js`

Pure read-only proxy (`api/regime.js` at repo root, Vercel auto-detects `api/*.js` as a zero-config Node function — no `vercel.json` needed), `module.exports = async (req,res)=>{...}` (CommonJS — avoids needing `"type":"module"` in `package.json`). Fetches all 4 confirmed endpoints in parallel via a `safeFetch(url, extractFn)` helper that never throws — a failed fetch or unexpected shape becomes `{error: '...'}` for that field only. **Always returns HTTP 200**; a single NSE endpoint failing shows up as a `vixError`/`fiiDiiError`/`newHighsError`/`newLowsError` field, never a 500 for the whole response. Response shape:
```json
{ "fetchedAt": "...", "vix": 13.29, "vixError": null, "fiiNet": -819.2, "diiNet": -418.26, "fiiDiiDate": "22-Jul-2026", "fiiDiiError": null, "newHighs": 80, "newHighsError": null, "newLows": 57, "newLowsError": null }
```
`package.json` at repo root pins `engines.node: "24.x"` — **not 18.x**: Vercel rejected `"18.x"` outright on first deploy ("Found invalid or discontinued Node.js Version") and the build failed before the function ever went live. Global `fetch` is built into modern Node, so no dependencies are needed regardless of exact version; Vercel's remote build runs `npm install` on its own servers (this dev machine still has no node/npm).

**Never** add Supabase credentials to this function — it stays a pure external-data proxy. Saving a snapshot into `market_regime` happens client-side in `index.html`, authenticated as the logged-in user, same RLS pattern as every other table (see `supabase-backend` skill).

**Verification note**: this function cannot be tested locally (no node/vercel-dev on this machine) — always push it alone first and curl/fetch the live `https://<deployed-domain>/api/regime` URL to confirm real data before wiring any UI to depend on it. That workflow caught the Node-version build failure above before any UI work was wasted on top of a broken deploy.

## Regime scoring (client-side, `computeRegimeScore()` in `index.html`)

v1 heuristic, documented in-code as provisional — not yet exposed as an editable-thresholds UI (only the *multipliers* it feeds into are user-editable, in the Capital panel):
- VIX `< 13` → +1, `> 25` → −2, `> 18` → −1
- FII net `> ₹1000cr` → +1, `< −₹1000cr` → −1
- `newHighs > newLows` → +1, `newLows > newHighs × 1.5` → −1
- PCR (only counted if the user filled it in manually) `> 1.2` → +1, `< 0.8` → −1
- score `≥ 2` → `"Risk-On"`, `≤ −2` → `"Risk-Off"`, else `"Neutral"`

`market_regime` is keyed on `(user_id, snapshot_date)` with a unique constraint — `saveRegimeSnapshot()` upserts with `onConflict:'user_id,snapshot_date'`, so re-saving the same day overwrites rather than duplicating (verified: two saves same day → still exactly one row). `fetchRegimeHistory()` also prefills the PCR/notes inputs from today's row if one already exists, so revisiting the tab later the same day doesn't clobber what's already saved.

## Position-sizing formula (`suggestedRiskPct()` in `index.html`)

```
suggestedRiskPct(trade) = capital.riskPerTrade
  × (rules.setupMultipliers[trade.setup] ?? 1.0)
  × marketCapMult(trade.marketCap)     // capital.multLargeCap / multMidCap / multSmallCap, default 1.0 if unset
  × regimeMult(currentRegime.label)    // capital.multRiskOn / multNeutral / multRiskOff
```
Compared against `actualRiskPct(trade) = |entry − sl| × qty / capital.total × 100` (stop-distance risk, consistent with what "Max Risk per Trade %" already means — deliberately *not* notional exposure, which is what the separate Exposure-tab leverage-cap logic already covers). Flagged `OVERSIZED` if actual `> 1.5×` suggested, `undersized` if `< 0.5×`, else `OK` — rendered as a "Size" column in the Journal's open-positions table using the same `.flag`/`.warn`/`.ok` classes as the Exposure tab's `OVER CAP`. `currentRegime` comes from the last **saved** `market_regime` row (`fetchLatestRegime()`, loaded once in `loadAllData()`), not a live NSE call on every Journal render — verified legacy trades with no `market_cap` or an unrecognized `setup` degrade cleanly to `1.0` multipliers with no errors.
