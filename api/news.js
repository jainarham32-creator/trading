// api/news.js — server-side proxy for the Stocks tab's left panel: markets news (India +
// world) and a market-specific "buzz" feed. Same conventions as api/regime.js: pure read-only
// proxy, browser can't fetch these directly (CORS), never touches Supabase, always returns 200
// with a per-field error rather than failing the whole response.
//
// Source is a free, no-API-key RSS feed (verified live 2026-07): Google News RSS search
// (news.google.com/rss/search?q=...) — Google's own terms restrict this feed to "personal,
// non-commercial use... within a personal feed reader," which this is: each logged-in user
// reads their own copy of the same public feed, nothing resold or redistributed.
//
// The "trending" field used to be Google Trends' official Daily Trending Searches RSS
// (trends.google.com/trending/rss) — real, live, but generic (movies/sports/celebrities), not
// finance-specific. Replaced this round with a market-buzz *news* query (trending stocks, top
// gainers/losers, what's peaking/bottoming) — there is still no free finance-scoped search-
// volume API (the old unofficial dailytrends JSON endpoint is dead, 404s as of this round), so
// this reads as "what's being reported as trending in the market," not a raw search-interest
// number.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

async function safeFetchText(url) {
  try {
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { value: await r.text() };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Google News RSS items: <title>, <link>, <pubDate>, and a <source url="...">Name</source> tag.
function parseNewsItems(xml, limit) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) && items.length < limit) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    if (!title) continue;
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];
    items.push({
      title: decodeEntities(title.trim()),
      link: link ? link.trim() : null,
      source: source ? decodeEntities(source.trim()) : null,
      pubDate: pubDate ? pubDate.trim() : null,
    });
  }
  return items;
}

// Builds a Google News OR-query from the user's watchlist (e.g. "RELIANCE OR TCS stock") —
// only symbols that look like real tickers (letters/digits/&/- , max 20 chars) are kept, and
// the list is capped at 15 so the query string can't be abused to fetch something arbitrary.
function buildWatchlistQuery(raw) {
  if (!raw) return null;
  const symbols = String(raw).split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => /^[A-Z0-9&-]{1,20}$/.test(s))
    .slice(0, 15);
  if (!symbols.length) return null;
  return symbols.join(' OR ') + ' stock';
}

module.exports = async (req, res) => {
  const watchlistQuery = buildWatchlistQuery(req.query && req.query.watchlist);
  const [indiaXml, worldXml, trendXml, watchlistXml] = await Promise.all([
    safeFetchText('https://news.google.com/rss/search?q=indian%20stock%20market%20OR%20nifty%20OR%20sensex%20OR%20rbi&hl=en-IN&gl=IN&ceid=IN:en'),
    safeFetchText('https://news.google.com/rss/search?q=world%20markets%20OR%20global%20stocks%20OR%20federal%20reserve%20OR%20wall%20street&hl=en-US&gl=US&ceid=US:en'),
    safeFetchText('https://news.google.com/rss/search?q=trending%20stocks%20india%20OR%20top%20gainers%20today%20OR%20top%20losers%20today%20OR%20most%20searched%20stocks%20OR%20stock%20market%20buzz&hl=en-IN&gl=IN&ceid=IN:en'),
    watchlistQuery
      ? safeFetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(watchlistQuery)}&hl=en-IN&gl=IN&ceid=IN:en`)
      : Promise.resolve({ value: null, error: null }),
  ]);

  res.status(200).json({
    fetchedAt: new Date().toISOString(),
    indiaNews: indiaXml.value ? parseNewsItems(indiaXml.value, 12) : [],
    indiaNewsError: indiaXml.error ?? null,
    worldNews: worldXml.value ? parseNewsItems(worldXml.value, 12) : [],
    worldNewsError: worldXml.error ?? null,
    trending: trendXml.value ? parseNewsItems(trendXml.value, 10) : [],
    trendingError: trendXml.error ?? null,
    watchlistNews: watchlistXml.value ? parseNewsItems(watchlistXml.value, 15) : [],
    watchlistNewsError: watchlistQuery ? (watchlistXml.error ?? null) : null,
  });
};
