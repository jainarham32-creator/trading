// api/news.js — server-side proxy for the Stocks tab's left panel: markets news (India +
// world) and Google's general trending-searches feed. Same conventions as api/regime.js:
// pure read-only proxy, browser can't fetch these directly (CORS), never touches Supabase,
// always returns 200 with a per-field error rather than failing the whole response.
//
// Sources are both free, no-API-key RSS feeds (verified live 2026-07):
// - Google News RSS search (news.google.com/rss/search?q=...) — Google's own terms restrict
//   this feed to "personal, non-commercial use... within a personal feed reader," which this
//   is: each logged-in user reads their own copy of the same public feed, nothing resold or
//   redistributed.
// - Google Trends' newer official "Daily Trending Searches" RSS (trends.google.com/trending/rss)
//   — general trending searches (movies, sports, etc.), NOT finance-specific. The old unofficial
//   dailytrends JSON API (trends.google.com/trends/api/dailytrends) is dead (404s as of this
//   round) — don't resurrect it without testing fresh first.

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

// Trending-searches RSS items: <title> (the search term itself) + <ht:approx_traffic>.
function parseTrendingItems(xml, limit) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) && items.length < limit) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    if (!title) continue;
    const traffic = (block.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/) || [])[1];
    items.push({ title: decodeEntities(title.trim()), traffic: traffic ? traffic.trim() : null });
  }
  return items;
}

module.exports = async (req, res) => {
  const [indiaXml, worldXml, trendXml] = await Promise.all([
    safeFetchText('https://news.google.com/rss/search?q=indian%20stock%20market%20OR%20nifty%20OR%20sensex%20OR%20rbi&hl=en-IN&gl=IN&ceid=IN:en'),
    safeFetchText('https://news.google.com/rss/search?q=world%20markets%20OR%20global%20stocks%20OR%20federal%20reserve%20OR%20wall%20street&hl=en-US&gl=US&ceid=US:en'),
    safeFetchText('https://trends.google.com/trending/rss?geo=IN'),
  ]);

  res.status(200).json({
    fetchedAt: new Date().toISOString(),
    indiaNews: indiaXml.value ? parseNewsItems(indiaXml.value, 12) : [],
    indiaNewsError: indiaXml.error ?? null,
    worldNews: worldXml.value ? parseNewsItems(worldXml.value, 12) : [],
    worldNewsError: worldXml.error ?? null,
    trending: trendXml.value ? parseTrendingItems(trendXml.value, 10) : [],
    trendingError: trendXml.error ?? null,
  });
};
