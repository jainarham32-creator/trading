// api/news.js — server-side news proxy for the Stocks tab. Same conventions as api/regime.js:
// pure read-only proxy (the browser can't fetch these feeds directly — CORS), never touches
// Supabase, always returns 200 with per-source errors instead of failing the whole response.
//
// SOURCES (verified live 2026-11): official RSS feeds wherever one still works —
//   Economic Times Markets + Stocks, Business Standard Markets, Mint Markets, CNBC TV18 Markets.
// Reuters has no public RSS any more and Moneycontrol's RSS has been frozen since 2024, so those
// two come through Google News' RSS search restricted with site:reuters.com / site:moneycontrol.com
// (flagged `viaGoogle` in the output). NSE corporate announcements were checked and left out: the
// feed's "title" is just a company name and the body a regulatory subject line, which carries no
// market-sentiment signal and would pollute the gauge.
// Google's terms limit its RSS to personal, non-commercial feed-reader use — which is what each
// logged-in user reading their own copy here is.
//
// PIPELINE: fetch all feeds in parallel → keep only the last 48h → drop duplicate stories (the
// same story from several outlets, matched on headline similarity, keeping the higher-quality
// source) → score every headline -1..+1 with a finance lexicon → weight by recency (12h
// half-life) and source quality → one 0-100 Fear & Greed gauge. The project has no LLM API
// configured, so scoring is a deterministic lexicon, not a model; scores are memoised by headline
// so a repeat request never re-scores the same text.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
};

const NEWS_CONFIG = {
  windowHours: 48,
  halfLifeHours: 12,
  neutralWeight: 0.3,   // headlines with no sentiment words still count, but pull the gauge less
  gaugeScale: 125,      // gauge = 50 + gaugeScale * weighted-mean-score (a mean of ±0.4 hits the ends)
  maxItems: 40,
  bands: [              // upper bound (inclusive) → label
    [24, 'Extreme Fear'], [44, 'Fear'], [55, 'Neutral'], [75, 'Greed'], [100, 'Extreme Greed'],
  ],
};

const GN = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
// Relevance filter for Google-News-sourced items (ET/BS/Mint/CNBC feeds are already market sections).
const MARKET_RE = /\b(sensex|nifty|stocks?|shares?|equit(?:y|ies)|market|markets|rbi|rupee|inr|ipo|fii|fpi|dii|bonds?|yields?|crude|oil|gold|earnings|profit|results|q[1-4]|sebi|banks?|rally|selloff|sell-off|fed|inflation|gdp|tariffs?|futures|options|dalal|bse|nse|mutual funds?|brokerage|target price)\b/i;
// Aggregator/forum pages that are not news.
const JUNK_RE = /forum discussion/i;

const FEEDS = [
  { name: 'Reuters',            weight: 1.00, viaGoogle: true,  url: GN('site:reuters.com (India stocks OR Sensex OR Nifty OR "Indian shares" OR "Indian rupee" OR "Reserve Bank of India" OR "India bond") when:2d') },
  { name: 'Economic Times',     weight: 0.95, viaGoogle: false, url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { name: 'Economic Times',     weight: 0.95, viaGoogle: false, url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms' },
  { name: 'Business Standard',  weight: 0.95, viaGoogle: false, url: 'https://www.business-standard.com/rss/markets-106.rss' },
  { name: 'Mint',               weight: 0.85, viaGoogle: false, url: 'https://www.livemint.com/rss/markets' },
  { name: 'CNBC TV18',          weight: 0.85, viaGoogle: false, url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml' },
  { name: 'Moneycontrol',       weight: 0.80, viaGoogle: true,  url: GN('site:moneycontrol.com (markets OR stocks OR Sensex OR Nifty) when:2d') },
];

// ---------- fetching / parsing ----------
async function fetchText(url, ms = 7000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { value: await r.text() };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : (e.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
function clean(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  const cdata = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) s = cdata[1];
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
}
function parseRss(xml) {
  const items = [];
  const re = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const title = clean(tag(b, 'title'));
    if (!title) continue;
    const link = clean(tag(b, 'link'));
    const t = Date.parse(clean(tag(b, 'pubDate')));
    items.push({ title, link: link || null, time: isNaN(t) ? null : t, gnSource: clean(tag(b, 'source')) || null });
  }
  return items;
}

// ---------- duplicate removal ----------
const STOP = new Set(['the','a','an','of','to','in','on','at','for','and','or','as','is','are','be','by','with','from','after','amid','over','this','that','its','it','has','have','will','says','say','said','new','today','live','updates','update']);
function sig(title) {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9% .]+/g, ' ').split(/\s+/)
      .filter(w => w.length > 1 && !STOP.has(w))
  );
}
function similar(a, b) {
  if (!a.size || !b.size) return false;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const jaccard = inter / (a.size + b.size - inter);
  const overlap = inter / Math.min(a.size, b.size);
  return jaccard >= 0.55 || (overlap >= 0.8 && inter >= 5);
}
function dedupe(items) {
  // best (highest source weight, then newest) first, so the survivor of a duplicate group is the best one
  const sorted = items.slice().sort((x, y) => (y.weight - x.weight) || ((y.time || 0) - (x.time || 0)));
  const kept = [];
  for (const it of sorted) {
    it._sig = it._sig || sig(it.title);
    if (!kept.some(k => similar(k._sig, it._sig))) kept.push(it);
  }
  return kept;
}

// ---------- sentiment lexicon (finance headlines) ----------
// +ve = greed / risk-on language, -ve = fear / risk-off language. Phrases are matched before
// single words; a negator directly before a word flips it ("fails to rally" ≈ negative).
const LEX = {
  // strong positive
  'record high': 1.6, 'all-time high': 1.6, 'all time high': 1.6, 'surges': 1.5, 'surge': 1.5, 'soars': 1.5, 'soar': 1.5,
  'rallies': 1.3, 'rally': 1.3, 'jumps': 1.2, 'jump': 1.2, 'skyrockets': 1.6, 'booming': 1.3, 'bull run': 1.4, 'bullish': 1.2,
  // positive
  'gains': 0.9, 'gain': 0.9, 'gained': 0.9, 'rises': 0.8, 'rise': 0.8, 'rose': 0.8, 'climbs': 0.9, 'climb': 0.9, 'advances': 0.7,
  'rebounds': 1.0, 'rebound': 1.0, 'recovers': 0.9, 'recovery': 0.8, 'upbeat': 1.0, 'optimism': 1.0, 'optimistic': 1.0,
  'strong': 0.7, 'stronger': 0.7, 'robust': 0.8, 'boost': 0.8, 'boosts': 0.8, 'beats': 0.9, 'beat': 0.8, 'outperform': 0.9,
  'upgrade': 0.9, 'upgrades': 0.9, 'inflows': 0.9, 'inflow': 0.9, 'buying': 0.6, 'fii buying': 1.0, 'rate cut': 0.9, 'rate cuts': 0.9,
  'growth': 0.5, 'profit rises': 1.0, 'profit jumps': 1.2, 'higher': 0.4, 'green': 0.5, 'positive': 0.6, 'eases': 0.5, 'easing': 0.5,
  'hopes': 0.5, 'bets': 0.3, 'support': 0.4, 'breakout': 0.9, 'buy': 0.5, 'top gainers': 0.8, 'resilient': 0.8, 'cheers': 0.8,
  // strong negative
  'crash': -1.7, 'crashes': -1.7, 'plunge': -1.5, 'plunges': -1.5, 'tumbles': -1.4, 'tumble': -1.4, 'slumps': -1.4, 'slump': -1.4,
  'collapse': -1.6, 'collapses': -1.6, 'sell-off': -1.4, 'selloff': -1.4, 'bloodbath': -1.8, 'panic': -1.5, 'turmoil': -1.3,
  'bearish': -1.2, 'recession': -1.4, 'default': -1.2, 'crisis': -1.4, 'meltdown': -1.7, 'wipes out': -1.4,
  // negative
  'falls': -0.9, 'fall': -0.9, 'fell': -0.9, 'drops': -0.9, 'drop': -0.9, 'dropped': -0.9, 'slides': -0.9, 'slide': -0.9,
  'declines': -0.8, 'decline': -0.8, 'sinks': -1.0, 'dips': -0.6, 'dip': -0.6, 'slips': -0.7, 'slip': -0.7, 'weak': -0.8,
  'weaker': -0.8, 'weakness': -0.8, 'loss': -0.8, 'losses': -0.8, 'loses': -0.8, 'downgrade': -0.9, 'downgrades': -0.9,
  'outflows': -0.9, 'outflow': -0.9, 'selling': -0.7, 'fii selling': -1.1, 'sells off': -1.2, 'rate hike': -0.9, 'rate hikes': -0.9,
  'fear': -1.0, 'fears': -1.0, 'worry': -0.8, 'worries': -0.8, 'concern': -0.6, 'concerns': -0.6, 'risk': -0.4, 'risks': -0.4,
  'uncertainty': -0.7, 'volatile': -0.5, 'volatility': -0.4, 'tariff': -0.7, 'tariffs': -0.7, 'sanctions': -0.7, 'war': -1.0,
  'conflict': -0.8, 'tensions': -0.8, 'inflation': -0.5, 'probe': -0.6, 'fraud': -1.2, 'ban': -0.7, 'misses': -0.9, 'miss': -0.8,
  'lower': -0.4, 'red': -0.5, 'negative': -0.6, 'cuts': -0.4, 'slowdown': -0.9, 'shortfall': -0.8, 'top losers': -0.8, 'sell': -0.5,
  'lowest': -0.7, 'worst': -1.0, 'pressure': -0.6, 'hurt': -0.7, 'hit': -0.4, 'trouble': -0.8,
};
const NEGATORS = new Set(['not', 'no', 'never', 'fails', 'fail', 'without', 'unlikely', "isn't", "doesn't", "won't", 'halts', 'ends', 'stops']);
const lexMax = Math.max(...Object.keys(LEX).map(k => k.split(' ').length));

function scoreHeadline(title) {
  const words = title.toLowerCase().replace(/[‘’]/g, "'").match(/[a-z0-9%'\-]+/g) || [];
  let raw = 0, hits = 0;
  for (let i = 0; i < words.length; i++) {
    let matched = 0, val = 0;
    for (let n = Math.min(lexMax, words.length - i); n >= 1; n--) {
      const phrase = words.slice(i, i + n).join(' ');
      if (LEX[phrase] !== undefined) { matched = n; val = LEX[phrase]; break; }
    }
    if (!matched) continue;
    const prev = words[i - 1];
    if (prev && NEGATORS.has(prev)) val = -val * 0.8;
    raw += val; hits++;
    i += matched - 1;
  }
  if (!hits) return 0;
  return Math.max(-1, Math.min(1, raw / (Math.abs(raw) + 1.5)));
}
const scoreCache = new Map(); // title → score; survives warm invocations so a headline is scored once
function cachedScore(title) {
  if (scoreCache.has(title)) return scoreCache.get(title);
  const s = scoreHeadline(title);
  if (scoreCache.size > 5000) scoreCache.clear();
  scoreCache.set(title, s);
  return s;
}
function bandFor(v) {
  for (const [hi, label] of NEWS_CONFIG.bands) if (v <= hi) return label;
  return 'Extreme Greed';
}
function sentimentTag(score) {
  if (score >= 0.15) return 'greed';
  if (score <= -0.15) return 'fear';
  return 'neutral';
}

// ---------- watchlist (per-stock) news — unchanged feature, Google News query ----------
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
  const now = Date.now();
  const cutoff = now - NEWS_CONFIG.windowHours * 3600 * 1000;
  const watchlistQuery = buildWatchlistQuery(req.query && req.query.watchlist);

  const [feedResults, wlRes] = await Promise.all([
    Promise.all(FEEDS.map(f => fetchText(f.url))),
    watchlistQuery ? fetchText(GN(watchlistQuery)) : Promise.resolve({ value: null }),
  ]);

  const sources = [];
  let all = [];
  FEEDS.forEach((f, i) => {
    const r = feedResults[i];
    if (r.error) { sources.push({ name: f.name, ok: false, error: r.error }); return; }
    const parsed = parseRss(r.value);
    let kept = 0;
    parsed.forEach(p => {
      if (!p.time || p.time < cutoff || p.time > now + 3600 * 1000) return; // last 48h only (and no future-dated junk)
      // Google News appends " - Outlet" to the title; strip it so duplicates match across sources
      let title = p.title;
      if (f.viaGoogle && p.gnSource && title.endsWith(' - ' + p.gnSource)) title = title.slice(0, -(p.gnSource.length + 3));
      // Google-sourced feeds are keyword searches, so they can return off-topic stories; keep only market-relevant headlines.
      if (f.viaGoogle && !MARKET_RE.test(title)) return;
      if (JUNK_RE.test(title)) return;
      all.push({ title, link: p.link, time: p.time, source: f.name, weight: f.weight, viaGoogle: f.viaGoogle });
      kept++;
    });
    sources.push({ name: f.name, ok: true, count: kept });
  });

  const unique = dedupe(all).sort((a, b) => b.time - a.time);

  // score + weight
  let num = 0, den = 0;
  const items = unique.map(it => {
    const score = cachedScore(it.title);
    const ageH = (now - it.time) / 3600000;
    const w = Math.pow(0.5, ageH / NEWS_CONFIG.halfLifeHours) * it.weight * (score === 0 ? NEWS_CONFIG.neutralWeight : 1);
    num += score * w; den += w;
    return { title: it.title, link: it.link, source: it.source, viaGoogle: it.viaGoogle, pubDate: new Date(it.time).toISOString(), score: +score.toFixed(2), tag: sentimentTag(score) };
  });
  const mean = den ? num / den : 0;
  const gaugeValue = Math.round(Math.max(0, Math.min(100, 50 + NEWS_CONFIG.gaugeScale * mean)));

  // optional watchlist news (kept simple: newest headlines for the user's symbols)
  let watchlistNews = [];
  let watchlistNewsError = null;
  if (watchlistQuery) {
    if (wlRes.error) watchlistNewsError = wlRes.error;
    else watchlistNews = parseRss(wlRes.value).slice(0, 15).map(p => ({
      title: p.gnSource && p.title.endsWith(' - ' + p.gnSource) ? p.title.slice(0, -(p.gnSource.length + 3)) : p.title,
      link: p.link, source: p.gnSource, pubDate: p.time ? new Date(p.time).toISOString() : null,
    }));
  }

  // 5 minutes at the CDN edge — a shared cache, so repeat refreshes don't re-fetch every feed
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.status(200).json({
    fetchedAt: new Date(now).toISOString(),
    windowHours: NEWS_CONFIG.windowHours,
    method: 'finance-lexicon',
    gauge: { value: gaugeValue, label: bandFor(gaugeValue), meanScore: +mean.toFixed(3), headlines: items.length },
    config: { halfLifeHours: NEWS_CONFIG.halfLifeHours, windowHours: NEWS_CONFIG.windowHours, bands: NEWS_CONFIG.bands },
    sources,
    items: items.slice(0, NEWS_CONFIG.maxItems),
    watchlistNews,
    watchlistNewsError,
  });
};
