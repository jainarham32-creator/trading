// TEMPORARY debug version — verifying the raw shape of NSE's equity-stockIndices endpoint
// for the NIFTY TOTAL MARKET (750-stock) universe before building the real aggregation.
// See .claude/skills/nse-market-data/SKILL.md once finalized.
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json,*/*',
};

module.exports = async (req, res) => {
  try {
    const idx = (req.query && req.query.index) || 'NIFTY 50';
    const url = `https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(idx)}`;
    // Some NSE endpoints 404/403 without a session cookie first established by hitting the
    // homepage (unlike allIndices/fiidiiTradeReact/etc., which work with headers alone).
    const homeResp = await fetch('https://www.nseindia.com/', { headers: NSE_HEADERS });
    const rawCookies = typeof homeResp.headers.getSetCookie === 'function'
      ? homeResp.headers.getSetCookie()
      : (homeResp.headers.get('set-cookie') || '').split(/,(?=[^;]+?=)/);
    const cookie = rawCookies.map(c => c.split(';')[0]).join('; ');
    const r = await fetch(url, { headers: { ...NSE_HEADERS, Cookie: cookie, Referer: 'https://www.nseindia.com/' } });
    if (!r.ok) {
      res.status(200).json({ error: `HTTP ${r.status}`, urlTried: url, homeStatus: homeResp.status, cookieLen: cookie.length });
      return;
    }
    const j = await r.json();
    const data = Array.isArray(j.data) ? j.data : [];
    res.status(200).json({
      totalCount: data.length,
      topLevelKeys: Object.keys(j),
      firstItem: data[0] || null,
      secondItem: data[1] || null,
    });
  } catch (e) {
    res.status(200).json({ error: e.message || String(e) });
  }
};
