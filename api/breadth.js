// api/breadth.js — server-side NSE proxy for the *ongoing* EMA-breadth + 5D-move +
// volume-move update. Fetches only ONE day's bhavcopy (fast, safe inside a single request,
// now returning both close price AND volume per symbol) — the one-time historical backfill
// needed ~300 sequential fetches and was run offline instead (see scripts/backfill_ema.py
// and .claude/skills/nse-market-data/SKILL.md). Read-only: never touches Supabase, never
// sees a service_role key — all math + persistence happens client-side, authenticated as
// the logged-in user, same as every other table in this app. Always returns 200 — a
// not-yet-published day (market still open, holiday) is an `error`, never a 500.

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

function ddmmyyyy(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}${mm}${date.getFullYear()}`;
}

function parseClosesAndVolumes(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',').map(h => h.trim());
  const symI = header.indexOf('SYMBOL');
  const seriesI = header.indexOf('SERIES');
  const closeI = header.indexOf('CLOSE_PRICE');
  const volI = header.indexOf('TTL_TRD_QNTY');
  const prevCloseI = header.indexOf('PREV_CLOSE');
  if (symI === -1 || seriesI === -1 || closeI === -1 || volI === -1) return null;
  const closes = {};
  const volumes = {};
  const prevCloses = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length <= volI) continue;
    const sym = cells[symI].trim();
    const series = cells[seriesI].trim();
    if (series !== 'EQ') continue;
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

module.exports = async (req, res) => {
  let date;
  if (req.query && req.query.date) {
    date = new Date(req.query.date);
    if (isNaN(date.getTime())) date = new Date();
  } else {
    date = new Date();
  }

  const url = `https://archives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy(date)}.csv`;
  try {
    const r = await fetch(url, { headers: NSE_HEADERS });
    if (!r.ok) {
      res.status(200).json({ date: date.toISOString().slice(0, 10), closes: null, volumes: null, error: `HTTP ${r.status} (not published yet?)` });
      return;
    }
    const parsed = parseClosesAndVolumes(await r.text());
    if (!parsed || Object.keys(parsed.closes).length === 0) {
      res.status(200).json({ date: date.toISOString().slice(0, 10), closes: null, volumes: null, prevCloses: null, error: 'unexpected response shape' });
      return;
    }
    res.status(200).json({ date: date.toISOString().slice(0, 10), closes: parsed.closes, volumes: parsed.volumes, prevCloses: parsed.prevCloses, error: null });
  } catch (e) {
    res.status(200).json({ date: date.toISOString().slice(0, 10), closes: null, volumes: null, error: e.message || String(e) });
  }
};
