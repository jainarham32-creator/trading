// api/constituents.js — official NSE / niftyindices.com index constituent lists, as JSON.
//   GET /api/constituents?index=nifty50  → { index, label, constituents:[{symbol,name,industry}] }
//   GET /api/constituents                → the catalog (id, label, group) for the Stocks tab dropdown
//
// Source: the same constituent CSVs NSE and niftyindices.com publish for each index (verified
// live 2026-11 — every index in the catalog returned a real list). Most live under
// archives.nseindia.com/content/indices/; a few newer thematic ones only exist on
// niftyindices.com/IndexConstituent/ (flagged `host: 'ni'`), and the function falls back to the
// other host if the first one fails.
// Caching: constituents only change at index reviews (typically semi-annually), so responses are
// cached at the CDN for 7 days (s-maxage) and served stale for a further day while revalidating —
// the files are NOT re-fetched on every page load. The client also keeps a 7-day localStorage copy.
// Read-only proxy, same conventions as the other api/*.js — never touches Supabase.

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
const NSE = 'https://archives.nseindia.com/content/indices/ind_';
const NI = 'https://www.niftyindices.com/IndexConstituent/ind_';

// id → { label, group, file, host }   (file is the part between "ind_" and ".csv")
const INDICES = {
  // Broad market
  nifty50:        { label: 'Nifty 50',            group: 'Broad market', file: 'nifty50list' },
  niftynext50:    { label: 'Nifty Next 50',       group: 'Broad market', file: 'niftynext50list' },
  nifty100:       { label: 'Nifty 100',           group: 'Broad market', file: 'nifty100list' },
  nifty200:       { label: 'Nifty 200',           group: 'Broad market', file: 'nifty200list' },
  nifty500:       { label: 'Nifty 500',           group: 'Broad market', file: 'nifty500list' },
  midcap50:       { label: 'Nifty Midcap 50',     group: 'Broad market', file: 'niftymidcap50list' },
  midcap100:      { label: 'Nifty Midcap 100',    group: 'Broad market', file: 'niftymidcap100list' },
  midcap150:      { label: 'Nifty Midcap 150',    group: 'Broad market', file: 'niftymidcap150list' },
  smallcap50:     { label: 'Nifty Smallcap 50',   group: 'Broad market', file: 'niftysmallcap50list' },
  smallcap100:    { label: 'Nifty Smallcap 100',  group: 'Broad market', file: 'niftysmallcap100list' },
  smallcap250:    { label: 'Nifty Smallcap 250',  group: 'Broad market', file: 'niftysmallcap250list' },
  microcap250:    { label: 'Nifty Microcap 250',  group: 'Broad market', file: 'niftymicrocap250_list' },
  largemidcap250: { label: 'Nifty LargeMidcap 250', group: 'Broad market', file: 'niftylargemidcap250list' },
  midsmallcap400: { label: 'Nifty MidSmallcap 400', group: 'Broad market', file: 'niftymidsmallcap400list' },
  totalmarket:    { label: 'Nifty Total Market',  group: 'Broad market', file: 'niftytotalmarket_list' },
  // Sectoral
  bank:           { label: 'Nifty Bank',               group: 'Sectoral', file: 'niftybanklist' },
  privatebank:    { label: 'Nifty Private Bank',       group: 'Sectoral', file: 'nifty_privatebanklist' },
  psubank:        { label: 'Nifty PSU Bank',           group: 'Sectoral', file: 'niftypsubanklist' },
  finserv:        { label: 'Nifty Financial Services', group: 'Sectoral', file: 'niftyfinancelist' },
  it:             { label: 'Nifty IT',                 group: 'Sectoral', file: 'niftyitlist' },
  pharma:         { label: 'Nifty Pharma',             group: 'Sectoral', file: 'niftypharmalist' },
  healthcare:     { label: 'Nifty Healthcare',         group: 'Sectoral', file: 'niftyhealthcarelist' },
  auto:           { label: 'Nifty Auto',               group: 'Sectoral', file: 'niftyautolist' },
  fmcg:           { label: 'Nifty FMCG',               group: 'Sectoral', file: 'niftyfmcglist' },
  metal:          { label: 'Nifty Metal',              group: 'Sectoral', file: 'niftymetallist' },
  realty:         { label: 'Nifty Realty',             group: 'Sectoral', file: 'niftyrealtylist' },
  energy:         { label: 'Nifty Energy',             group: 'Sectoral', file: 'niftyenergylist' },
  oilgas:         { label: 'Nifty Oil & Gas',          group: 'Sectoral', file: 'niftyoilgaslist' },
  media:          { label: 'Nifty Media',              group: 'Sectoral', file: 'niftymedialist' },
  consumerdurables:{ label: 'Nifty Consumer Durables', group: 'Sectoral', file: 'niftyconsumerdurableslist' },
  chemicals:      { label: 'Nifty Chemicals',          group: 'Sectoral', file: 'niftychemicals_list', host: 'ni' },
  // Thematic
  cpse:           { label: 'Nifty CPSE',                  group: 'Thematic', file: 'niftycpselist' },
  pse:            { label: 'Nifty PSE',                   group: 'Thematic', file: 'niftypselist' },
  infra:          { label: 'Nifty Infrastructure',        group: 'Thematic', file: 'niftyinfralist' },
  commodities:    { label: 'Nifty Commodities',           group: 'Thematic', file: 'niftycommoditieslist' },
  defence:        { label: 'Nifty India Defence',         group: 'Thematic', file: 'niftyindiadefence_list' },
  manufacturing:  { label: 'Nifty India Manufacturing',   group: 'Thematic', file: 'niftyindiamanufacturing_list' },
  capitalmarkets: { label: 'Nifty Capital Markets',       group: 'Thematic', file: 'niftycapitalmarkets_list', host: 'ni' },
  consumption:    { label: 'Nifty India Consumption',     group: 'Thematic', file: 'niftyconsumptionlist' },
  mnc:            { label: 'Nifty MNC',                   group: 'Thematic', file: 'niftymnclist' },
  housing:        { label: 'Nifty Housing',               group: 'Thematic', file: 'niftyhousing_list', host: 'ni' },
  ev:             { label: 'Nifty EV & New Age Automotive', group: 'Thematic', file: 'niftyev_newageautomotive_list', host: 'ni' },
  digital:        { label: 'Nifty India Digital',         group: 'Thematic', file: 'niftyindiadigital_list' },
  // SME
  sme:            { label: 'Nifty SME Emerge',            group: 'SME', file: 'niftysmelist' },
};

// Quote-aware CSV line splitter (company names can contain commas inside quotes).
function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
function parseConstituents(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return null;
  const header = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const si = header.indexOf('symbol'), ni = header.indexOf('company name'), ii = header.indexOf('industry');
  if (si === -1) return null;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    if (c[si]) rows.push({ symbol: c[si], name: ni === -1 ? '' : c[ni], industry: ii === -1 ? '' : c[ii] });
  }
  return rows.length ? rows : null;
}
async function fetchCsv(url) {
  try {
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) return null;
    return parseConstituents(await r.text());
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  const id = req.query && req.query.index;
  if (!id) {
    res.setHeader('Cache-Control', 'public, s-maxage=86400');
    res.status(200).json({ catalog: Object.keys(INDICES).map(k => ({ id: k, label: INDICES[k].label, group: INDICES[k].group })) });
    return;
  }
  const idx = INDICES[id];
  if (!idx) { res.status(200).json({ index: id, error: 'unknown index', constituents: null }); return; }

  const first = idx.host === 'ni' ? NI : NSE;
  const second = idx.host === 'ni' ? NSE : NI;
  const rows = (await fetchCsv(`${first}${idx.file}.csv`)) || (await fetchCsv(`${second}${idx.file}.csv`));
  if (!rows) { res.status(200).json({ index: id, label: idx.label, error: 'constituent list unavailable', constituents: null }); return; }

  res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=86400');
  res.status(200).json({ index: id, label: idx.label, group: idx.group, fetchedAt: new Date().toISOString(), count: rows.length, constituents: rows });
};
