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

// ---- Regime score v4 — MUST be kept in sync by hand with computeRegimeScore() and its
// factor functions in index.html if that formula ever changes again. ----
const REGIME_WEIGHTS = { vix: 20, breadth50: 15, breadth200: 15, pcr: 10, highsLows: 15, nifty500Ema20: 10, thrust: 15 };
function clamp01to100(v) { return Math.max(0, Math.min(100, v)); }
function vixFactor(vix) {
  if (vix == null || isNaN(vix)) return null;
  return clamp01to100(100 - (vix - 11) / (26 - 11) * 100);
}
function breadthFactor(pct) {
  if (pct == null || isNaN(pct)) return null;
  if (pct <= 20) return pct / 20 * 30;
  if (pct <= 50) return 30 + (pct - 20) / (50 - 20) * 20;
  if (pct <= 75) return 50 + (pct - 50) / (75 - 50) * 50;
  return 100 - (pct - 75) / (100 - 75) * 45;
}
function pcrFactor(pcr) {
  if (pcr == null || isNaN(pcr)) return null;
  if (pcr <= 0.6) return 0;
  if (pcr >= 1.5) return 100;
  return (pcr - 0.6) / (1.5 - 0.6) * 100;
}
function highsLowsFactor(newHighs, newLows) {
  if (newHighs == null || newLows == null || isNaN(newHighs) || isNaN(newLows)) return null;
  const total = newHighs + newLows;
  if (total === 0) return 50;
  return newHighs / total * 100;
}
function nifty500Ema20Factor(close, ema20) {
  if (close == null || ema20 == null || isNaN(close) || isNaN(ema20) || !ema20) return null;
  const pctDiff = (close - ema20) / ema20 * 100;
  return clamp01to100(50 + pctDiff / 3 * 50);
}
function marketThrustFactor(advances, declines) {
  if (advances == null || declines == null || isNaN(advances) || isNaN(declines)) return null;
  const total = advances + declines;
  if (!total) return null;
  return advances / total * 100;
}
function computeRegimeScore(s) {
  const factors = {
    vix: vixFactor(s.vix),
    breadth50: breadthFactor(s.pctAbove50Ema),
    breadth200: breadthFactor(s.pctAbove200Ema),
    pcr: pcrFactor(s.pcr),
    highsLows: highsLowsFactor(s.newHighs, s.newLows),
    nifty500Ema20: nifty500Ema20Factor(s.nifty500Close, s.nifty500Ema20),
    thrust: marketThrustFactor(s.thrustAdvances, s.thrustDeclines),
  };
  if (Object.keys(REGIME_WEIGHTS).some((k) => factors[k] == null)) return { score: null, label: null };
  const totalWeight = Object.values(REGIME_WEIGHTS).reduce((a, b) => a + b, 0);
  const weighted = Object.keys(REGIME_WEIGHTS).reduce((a, k) => a + factors[k] * REGIME_WEIGHTS[k], 0);
  const score = Math.round(weighted / totalWeight);
  let label = 'Neutral';
  if (score >= 65) label = 'Risk-On';
  else if (score <= 35) label = 'Risk-Off';
  return { score, label };
}
const NIFTY500_EMA20_K = 2 / 21;

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

  let advances = 0, declines = 0;
  if (resp.prevCloses) {
    Object.keys(resp.closes).forEach((sym) => {
      const prev = resp.prevCloses[sym];
      if (prev == null || !prev) return;
      const price = resp.closes[sym];
      if (price > prev) advances++;
      else if (price < prev) declines++;
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
      count_advances: advances, count_declines: declines,
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
          const { error: histErr } = await supabase.from('market_breadth_history').upsert(
            Object.assign({ user_id: userId, snapshot_date: bhav.date }, updated.breadthRow),
            { onConflict: 'user_id,snapshot_date' }
          );
          log.push(`${userId}: breadth updated for ${bhav.date}${emaErr ? ` (ema_state error: ${emaErr.message})` : ''}${histErr ? ` (history error: ${histErr.message})` : ''}`);
        } else {
          log.push(`${userId}: breadth update skipped (no matching symbols)`);
        }
      }

      const { data: freshBreadth } = await supabase.from('market_breadth_history').select('*').eq('user_id', userId).order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
      const { data: latestRegime } = await supabase.from('market_regime').select('*').eq('user_id', userId).order('snapshot_date', { ascending: false }).limit(1).maybeSingle();

      let nifty500Ema20Today = null;
      if (liveRegime.nifty500Close != null && latestRegime && latestRegime.nifty500_ema20 != null) {
        nifty500Ema20Today = liveRegime.nifty500Close * NIFTY500_EMA20_K + latestRegime.nifty500_ema20 * (1 - NIFTY500_EMA20_K);
      }
      const scored = computeRegimeScore({
        vix: liveRegime.vix ?? null,
        pcr: liveRegime.pcr ?? null,
        newHighs: freshBreadth ? freshBreadth.count_newhigh_n500 : null,
        newLows: freshBreadth ? freshBreadth.count_newlow_n500 : null,
        pctAbove50Ema: freshBreadth ? freshBreadth.pct_above_50ema : null,
        pctAbove200Ema: freshBreadth ? freshBreadth.pct_above_200ema : null,
        nifty500Close: liveRegime.nifty500Close ?? null,
        nifty500Ema20: nifty500Ema20Today,
        thrustAdvances: liveRegime.thrustAdvances ?? null,
        thrustDeclines: liveRegime.thrustDeclines ?? null,
      });

      const { error: regimeErr } = await supabase.from('market_regime').upsert({
        user_id: userId,
        snapshot_date: new Date().toISOString().slice(0, 10),
        vix: liveRegime.vix ?? null,
        fii_net: liveRegime.fiiNet ?? null,
        dii_net: liveRegime.diiNet ?? null,
        pcr: liveRegime.pcr ?? null,
        regime_label: scored.label,
        nifty500_close: liveRegime.nifty500Close ?? null,
        nifty500_ema20: nifty500Ema20Today,
      }, { onConflict: 'user_id,snapshot_date' });
      log.push(`${userId}: regime snapshot saved (${scored.label ?? 'no score'})${regimeErr ? ` — error: ${regimeErr.message}` : ''}`);
    } catch (e) {
      log.push(`${userId}: FAILED — ${e.message || e}`);
    }
  }

  res.status(200).json({ date: bhav.date, usersProcessed: usersData.users.length, log });
};
