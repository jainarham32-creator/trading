// api/mcap.js — market capitalisation in ₹ crore for a list of NSE symbols.
//   GET /api/mcap?symbols=RELIANCE,TCS,INFY   (max 300 per call)  → { mcap: { RELIANCE: 1791699, ... }, missing:[...] }
//
// SOURCE: Yahoo Finance's quote API (NSE tickers as SYMBOL.NS) — an UNOFFICIAL, undocumented
// endpoint. It is here because it is the only source that returned real per-stock market cap:
// NSE's own quote API needs a browser session (403 from servers) and none of NSE/BSE/AMFI's bulk
// files carry market cap in a scriptable form (all checked). Yahoo needs a cookie + "crumb" token
// first (fetched below and reused while the function instance is warm). Because it is unofficial
// it can change or block without notice — when it does, this returns an empty map plus an `error`
// and the Stocks tab simply shows "—" in the Market Cap column instead of breaking.
// Market cap is shares × price, so it moves with the price; responses are cached at the CDN for
// 6 hours, which is plenty for a "how big is this company" column.
// Read-only proxy — never touches Supabase.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_SYMBOLS = 300;
const BATCH = 80;

let session = null; // { cookie, crumb, at } — reused across warm invocations
async function getSession() {
  if (session && Date.now() - session.at < 50 * 60 * 1000) return session;
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const raw = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie') || ''];
  const cookie = raw.map(c => String(c).split(';')[0]).filter(Boolean).join('; ');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.includes('<')) throw new Error('could not obtain Yahoo crumb');
  session = { cookie, crumb, at: Date.now() };
  return session;
}

async function quoteBatch(symbols, s) {
  const list = symbols.map(x => encodeURIComponent(x + '.NS')).join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${list}&crumb=${encodeURIComponent(s.crumb)}&fields=marketCap`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: s.cookie } });
  if (r.status === 401 || r.status === 403) { session = null; throw new Error('Yahoo rejected the session (HTTP ' + r.status + ')'); }
  if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);
  const j = await r.json();
  return (j.quoteResponse && j.quoteResponse.result) || [];
}

// Yahoo sometimes returns a quote with a price but no marketCap (seen on Vercel's IPs for a few
// large caps, e.g. RELIANCE/TCS, while the same call works elsewhere). For those, ask the
// quoteSummary "price" module (separate backend), then fall back to shares × price.
async function summaryCap(sym, s) {
  for (const host of ['query2', 'query1']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym + '.NS')}?modules=price,defaultKeyStatistics&crumb=${encodeURIComponent(s.crumb)}`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: s.cookie } });
      if (!r.ok) continue;
      const j = await r.json();
      const res0 = j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
      if (!res0) continue;
      const mc = res0.price && res0.price.marketCap && res0.price.marketCap.raw;
      if (mc > 0) return mc;
      const sh = res0.defaultKeyStatistics && res0.defaultKeyStatistics.sharesOutstanding && res0.defaultKeyStatistics.sharesOutstanding.raw;
      const px = res0.price && res0.price.regularMarketPrice && res0.price.regularMarketPrice.raw;
      if (sh > 0 && px > 0) return sh * px;
    } catch (e) { /* try next host */ }
  }
  return null;
}

module.exports = async (req, res) => {
  const wanted = String((req.query && req.query.symbols) || '')
    .split(',').map(s => s.trim().toUpperCase())
    .filter(s => /^[A-Z0-9&-]{1,20}$/.test(s))
    .slice(0, MAX_SYMBOLS);
  if (!wanted.length) { res.status(200).json({ mcap: {}, missing: [], error: 'no valid symbols' }); return; }

  const mcap = {};
  let error = null;
  try {
    const s = await getSession();
    const batches = [];
    for (let i = 0; i < wanted.length; i += BATCH) batches.push(wanted.slice(i, i + BATCH));
    const results = await Promise.all(batches.map(b => quoteBatch(b, s).catch(e => { error = e.message || String(e); return []; })));
    const flat = results.flat();
    flat.forEach(q => {
      const sym = String(q.symbol || '').replace(/\.NS$/, '');
      if (sym && q.marketCap > 0) mcap[sym] = Math.round(q.marketCap / 1e7); // ₹ → ₹ crore (1 Cr = 1e7)
    });
    // Second pass for quotes that came back without a marketCap (capped so a bad day can't fan out).
    const gaps = wanted.filter(x => mcap[x] == null).slice(0, 40);
    if (req.query && req.query.debug && gaps.length) {
      const g = gaps[0];
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(g + '.NS')}?modules=price,defaultKeyStatistics&crumb=${encodeURIComponent(s.crumb)}`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: s.cookie } });
      const t = await r.text();
      const q0 = flat.find(q => q.symbol === g + '.NS');
      res.status(200).json({ gap: g, status: r.status, body: t.slice(0, 600), quote: q0 });
      return;
    }
    await Promise.all(gaps.map(async sym => {
      const mc = await summaryCap(sym, s);
      if (mc) mcap[sym] = Math.round(mc / 1e7);
    }));
  } catch (e) {
    error = e.message || String(e);
  }
  const missing = wanted.filter(s => mcap[s] == null);
  if (!error || Object.keys(mcap).length) res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  res.status(200).json({ fetchedAt: new Date().toISOString(), source: 'Yahoo Finance (unofficial)', mcap, missing, error });
};
