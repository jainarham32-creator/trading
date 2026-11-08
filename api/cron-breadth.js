// api/cron-breadth.js — daily scheduled job (Vercel Cron, see vercel.json) that keeps
// market_breadth_history, ema_state, and market_regime current for every user, independent
// of whether anyone actually opens the app that day.
//
// This is the ONE place in the whole project that uses a Supabase service_role key — every
// other write happens client-side, authenticated as the logged-in user (see supabase-backend
// skill). service_role is required here specifically because a cron job has no user session
// to authenticate as, and this app duplicates market-wide breadth/regime data per user
// (rather than one shared row) — a deliberate earlier tradeoff specifically to avoid ever
// needing this key, revisited only now because genuinely day-independent updates aren't
// possible any other way. The key lives only as a server-side Vercel environment variable —
// never in this repo, never sent to the browser.
//
// Protected by CRON_SECRET: Vercel automatically sends `Authorization: Bearer $CRON_SECRET`
// on scheduled invocations when that env var is set, so this can't be triggered by anyone
// hitting the URL directly.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://xrvkzxqzfchcpudfyapt.supabase.co';
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

// ---- Regime score v5 — MUST be kept in sync by hand with REGIME_CONFIG / computeRegimeScore()
// in index.html if that formula ever changes. 4 components, 0-100:
//   % of Nifty 500 above 200 DMA (30%, as-is) · market thrust (25%, 5-day avg of adv/(adv+dec)*100)
//   · new highs vs lows (25%, 5-day avg of NH/(NH+NL)*100) · PCR (20%, 0.7→0, 1.0→50, 1.3→100,
//   capped at 70 above 1.6). ≥60 Risk-On, 40–59 Neutral, <40 Risk-Off. ----
const REGIME_CONFIG = {
  weights: { above200: 30, thrust: 25, highsLows: 25, pcr: 20 },
  thresholds: { riskOn: 60, riskOff: 40 },
  avgDays: 5,
  pcr: { zeroAt: 0.7, midAt: 1.0, fullAt: 1.3, crowdedAbove: 1.6, crowdedCap: 70 },
};
function clamp01to100(v) { return Math.max(0, Math.min(100, v)); }
function pcrScore(p) {
  if (p == null || isNaN(p)) return null;
  const c = REGIME_CONFIG.pcr;
  let s;
  if (p <= c.zeroAt) s = 0;
  else if (p <= c.midAt) s = (p - c.zeroAt) / (c.midAt - c.zeroAt) * 50;
  else if (p < c.fullAt) s = 50 + (p - c.midAt) / (c.fullAt - c.midAt) * 50;
  else s = 100;
  if (p > c.crowdedAbove) s = Math.min(s, c.crowdedCap);
  return s;
}
// rows are newest-first breadth rows (snake_case DB columns)
function avgRecent(rows, fn) {
  const vals = [];
  for (const r of rows) {
    const v = fn(r);
    if (v != null && !isNaN(v)) vals.push(v);
    if (vals.length >= REGIME_CONFIG.avgDays) break;
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
function computeRegimeScore(rows, pcr) {
  const W = REGIME_CONFIG.weights;
  const latest = rows[0] || null;
  const raw = {
    above200: latest ? latest.pct_above_200ema : null,
    thrust: avgRecent(rows, (r) => {
      if (r.count_advances == null || r.count_declines == null) return null;
      const t = r.count_advances + r.count_declines;
      return t ? r.count_advances / t * 100 : null;
    }),
    highsLows: avgRecent(rows, (r) => {
      if (r.count_newhigh_n500 == null || r.count_newlow_n500 == null) return null;
      const t = r.count_newhigh_n500 + r.count_newlow_n500;
      return t ? r.count_newhigh_n500 / t * 100 : 50;
    }),
    pcr: pcr == null ? null : pcr,
  };
  const s = {
    above200: raw.above200 == null ? null : clamp01to100(raw.above200),
    thrust: raw.thrust == null ? null : clamp01to100(raw.thrust),
    highsLows: raw.highsLows == null ? null : clamp01to100(raw.highsLows),
    pcr: pcrScore(raw.pcr),
  };
  if (Object.keys(W).some((k) => s[k] == null)) return { score: null, label: null };
  const total = Object.values(W).reduce((a, b) => a + b, 0);
  const score = Math.round(Object.keys(W).reduce((a, k) => a + s[k] * W[k] / total, 0));
  const label = score >= REGIME_CONFIG.thresholds.riskOn ? 'Risk-On' : (score >= REGIME_CONFIG.thresholds.riskOff ? 'Neutral' : 'Risk-Off');
  return { score, label };
}
// Upsert that survives a missing optional column (migration_008 not run yet): on a
// "column ... does not exist / schema cache" error, retry once without the optional columns.
async function upsertTolerant(supabase, table, row, onConflict, optionalCols) {
  let res = await supabase.from(table).upsert(row, { onConflict });
  if (res.error && /column|schema cache/i.test(res.error.message || '')) {
    const slim = Object.assign({}, row);
    optionalCols.forEach((c) => delete slim[c]);
    res = await supabase.from(table).upsert(slim, { onConflict });
  }
  return res.error;
}

// ---- Bhavcopy fetch — mirrors api/breadth.js's own parser (kept separate/duplicated rather
// than imported, since that file's default export is a request handler, not a reusable
// function; both are small and stable enough that duplication is lower-risk than refactoring
// a working, tested file). ----
function ddmmyyyy(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}${mm}${date.getFullYear()}`;
}
function parseClosesAndVolumes(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',').map((h) => h.trim());
  const symI = header.indexOf('SYMBOL');
  const seriesI = header.indexOf('SERIES');
  const closeI = header.indexOf('CLOSE_PRICE');
  const volI = header.indexOf('TTL_TRD_QNTY');
  const prevCloseI = header.indexOf('PREV_CLOSE');
  if (symI === -1 || seriesI === -1 || closeI === -1 || volI === -1) return null;
  const closes = {}, volumes = {}, prevCloses = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length <= volI) continue;
    const sym = cells[symI].trim();
    if (cells[seriesI].trim() !== 'EQ') continue;
    const price = parseFloat(cells[closeI].trim());
    const vol = parseFloat(cells[volI].trim());
    if (!isNaN(price)) closes[sym] = price;
    if (!isNaN(vol)) volumes[sym] = vol;
    if (prevCloseI !== -1) {
      const prev = parseFloat(cells[prevCloseI].trim());
      if (!isNaN(prev)) prevCloses[sym] = prev;
    }
  }
  return { closes, volumes, prevCloses };
}
async function fetchBhavcopy(date) {
  const url = `https://archives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy(date)}.csv`;
  try {
    const r = await fetch(url, { headers: NSE_HEADERS });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const parsed = parseClosesAndVolumes(await r.text());
    if (!parsed || !Object.keys(parsed.closes).length) return { error: 'unexpected response shape' };
    return { date: date.toISOString().slice(0, 10), closes: parsed.closes, volumes: parsed.volumes, prevCloses: parsed.prevCloses };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// One day's whole-universe EMA/breadth update, given prior ema_state.state — same math as
// updateBreadthIfNeeded() in index.html; keep the two in sync by hand if either changes.
function computeBreadthUpdate(resp, priorState) {
  const state = Object.assign({}, priorState);
  const k50 = 2 / 51, k200 = 2 / 201;
  let above50 = 0, above200 = 0, counted = 0;
  let up20_5d = 0, up30_5d = 0, up4pctVol = 0, down4pctVol = 0;
  let newHighN500 = 0, newLowN500 = 0;
  Object.keys(resp.closes).forEach((sym) => {
    const prior = state[sym];
    if (!prior || prior.ema50 == null || prior.ema200 == null) return;
    const price = resp.closes[sym];
    const vol = resp.volumes ? resp.volumes[sym] : null;
    const newEma50 = price * k50 + prior.ema50 * (1 - k50);
    const newEma200 = price * k200 + prior.ema200 * (1 - k200);

    const recentCloses = Array.isArray(prior.recentCloses) ? prior.recentCloses.slice() : [];
    if (recentCloses.length >= 6 && recentCloses[0]) {
      const pct5d = (price - recentCloses[0]) / recentCloses[0] * 100;
      if (pct5d >= 20) up20_5d++;
      if (pct5d >= 30) up30_5d++;
    }
    recentCloses.push(price);
    if (recentCloses.length > 6) recentCloses.shift();

    const recentVolumes = Array.isArray(prior.recentVolumes) ? prior.recentVolumes.slice() : [];
    if (recentVolumes.length >= 20 && vol != null && prior.lastClose) {
      const priorAvgVol = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
      const pct1d = (price - prior.lastClose) / prior.lastClose * 100;
      if (priorAvgVol && vol > priorAvgVol * 1.5) {
        if (pct1d >= 4) up4pctVol++;
        else if (pct1d <= -4) down4pctVol++;
      }
    }
    if (vol != null) {
      recentVolumes.push(vol);
      if (recentVolumes.length > 20) recentVolumes.shift();
    }

    const rsCloses = Array.isArray(prior.rsCloses) ? prior.rsCloses.slice() : [];
    rsCloses.push(price);
    if (rsCloses.length > 66) rsCloses.shift();

    const close252 = Array.isArray(prior.close252) ? prior.close252.slice() : [];
    if (close252.length === 252) {
      if (price > Math.max(...close252)) newHighN500++;
      else if (price < Math.min(...close252)) newLowN500++;
    }
    close252.push(price);
    if (close252.length > 252) close252.shift();

    state[sym] = { ema50: newEma50, ema200: newEma200, lastClose: price, lastDate: resp.date, recentCloses, recentVolumes, rsCloses, close252 };
    counted++;
    if (price > newEma50) above50++;
    if (price > newEma200) above200++;
  });

  let advances = 0, declines = 0, unchanged = 0;
  if (resp.prevCloses) {
    Object.keys(resp.closes).forEach((sym) => {
      const prev = resp.prevCloses[sym];
      if (prev == null || !prev) return;
      const price = resp.closes[sym];
      if (price > prev) advances++;
      else if (price < prev) declines++;
      else unchanged++;
    });
  }

  if (counted === 0) return null;
  return {
    state,
    breadthRow: {
      pct_above_50ema: +(above50 / counted * 100).toFixed(2),
      pct_above_200ema: +(above200 / counted * 100).toFixed(2),
      count_up20_5d: up20_5d, count_up30_5d: up30_5d,
      count_up4pct_vol: up4pctVol, count_down4pct_vol: down4pctVol,
      count_newhigh_n500: newHighN500, count_newlow_n500: newLowN500,
      count_advances: advances, count_declines: declines, count_unchanged: unchanged,
    },
  };
}

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
    return;
  }
  const supabase = createClient(SUPABASE_URL, serviceKey);
  const log = [];

  // NSE is shut on weekends — checked in IST, since this function's own clock is UTC.
  const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  if (nowIst.getDay() === 0 || nowIst.getDay() === 6) {
    res.status(200).json({ skipped: 'weekend', log });
    return;
  }

  const bhav = await fetchBhavcopy(new Date());
  if (bhav.error) {
    res.status(200).json({ skipped: `bhavcopy not available: ${bhav.error}`, log });
    return;
  }

  let liveRegime = {};
  try {
    const r = await fetch(`https://${req.headers.host}/api/regime`);
    liveRegime = await r.json();
  } catch (e) {
    log.push(`api/regime fetch failed: ${e.message || e}`);
  }

  const { data: usersData, error: usersErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (usersErr) {
    res.status(500).json({ error: `listUsers failed: ${usersErr.message}` });
    return;
  }

  for (const user of usersData.users) {
    const userId = user.id;
    try {
      const { data: stateRow } = await supabase.from('ema_state').select('state').eq('user_id', userId).maybeSingle();
      const priorState = stateRow ? stateRow.state : {};

      const { data: latestBreadth } = await supabase.from('market_breadth_history').select('snapshot_date').eq('user_id', userId).order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
      if (latestBreadth && latestBreadth.snapshot_date === bhav.date) {
        log.push(`${userId}: breadth already up to date (${bhav.date})`);
      } else {
        const updated = computeBreadthUpdate(bhav, priorState);
        if (updated) {
          const { error: emaErr } = await supabase.from('ema_state').upsert({ user_id: userId, state: updated.state }, { onConflict: 'user_id' });
          const histErr = await upsertTolerant(supabase, 'market_breadth_history',
            Object.assign({ user_id: userId, snapshot_date: bhav.date }, updated.breadthRow),
            'user_id,snapshot_date', ['count_unchanged']);
          log.push(`${userId}: breadth updated for ${bhav.date}${emaErr ? ` (ema_state error: ${emaErr.message})` : ''}${histErr ? ` (history error: ${histErr.message})` : ''}`);
        } else {
          log.push(`${userId}: breadth update skipped (no matching symbols)`);
        }
      }

      // newest-first stored breadth rows: the score's 5-day averages and the 200-DMA input all come from these
      const { data: recentBreadth } = await supabase.from('market_breadth_history').select('*').eq('user_id', userId).order('snapshot_date', { ascending: false }).limit(10);
      const scored = computeRegimeScore(recentBreadth || [], liveRegime.pcr ?? null);

      const regimeErr = await upsertTolerant(supabase, 'market_regime', {
        user_id: userId,
        snapshot_date: new Date().toISOString().slice(0, 10),
        vix: liveRegime.vix ?? null,
        pcr: liveRegime.pcr ?? null,
        regime_label: scored.label,
        regime_score: scored.score,
        nifty500_close: liveRegime.nifty500Close ?? null,
      }, 'user_id,snapshot_date', ['regime_score']);
      log.push(`${userId}: regime snapshot saved (${scored.label ?? 'no score'}${scored.score != null ? ' ' + scored.score : ''})${regimeErr ? ` — error: ${regimeErr.message}` : ''}`);
    } catch (e) {
      log.push(`${userId}: FAILED — ${e.message || e}`);
    }
  }

  res.status(200).json({ date: bhav.date, usersProcessed: usersData.users.length, log });
};
