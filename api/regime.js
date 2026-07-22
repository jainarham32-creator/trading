// api/regime.js — server-side NSE proxy. The browser can't call NSE directly (CORS +
// bot-protection), so this Vercel serverless function fetches on its behalf. Read-only:
// never touches Supabase, never sees a service_role key (see nse-market-data skill).
// Always returns 200 — one endpoint failing surfaces as a per-field *Error, not a 500.

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json,*/*',
};

async function safeFetch(url, extract) {
  try {
    const r = await fetch(url, { headers: NSE_HEADERS });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const v = extract(await r.json());
    return v == null ? { error: 'unexpected response shape' } : { value: v };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

module.exports = async (req, res) => {
  const [vix, fiidii, highs, lows] = await Promise.all([
    safeFetch('https://www.nseindia.com/api/allIndices', j => {
      const row = (j.data || []).find(x => x.indexSymbol === 'INDIA VIX' || x.index === 'INDIA VIX');
      return row ? parseFloat(row.last) : null;
    }),
    safeFetch('https://www.nseindia.com/api/fiidiiTradeReact', j => {
      const arr = Array.isArray(j) ? j : [];
      const fii = arr.find(x => x.category === 'FII/FPI');
      const dii = arr.find(x => x.category === 'DII');
      if (!fii && !dii) return null;
      return {
        date: (fii || dii).date,
        fiiNet: fii ? parseFloat(fii.netValue) : null,
        diiNet: dii ? parseFloat(dii.netValue) : null,
      };
    }),
    safeFetch('https://www.nseindia.com/api/live-analysis-data-52weekhighstock', j =>
      typeof j.high === 'number' ? j.high : null
    ),
    safeFetch('https://www.nseindia.com/api/live-analysis-data-52weeklowstock', j =>
      typeof j.low === 'number' ? j.low : null
    ),
  ]);

  res.status(200).json({
    fetchedAt: new Date().toISOString(),
    vix: vix.value ?? null,
    vixError: vix.error ?? null,
    fiiNet: fiidii.value ? fiidii.value.fiiNet : null,
    diiNet: fiidii.value ? fiidii.value.diiNet : null,
    fiiDiiDate: fiidii.value ? fiidii.value.date : null,
    fiiDiiError: fiidii.error ?? null,
    newHighs: highs.value ?? null,
    newHighsError: highs.error ?? null,
    newLows: lows.value ?? null,
    newLowsError: lows.error ?? null,
  });
};
