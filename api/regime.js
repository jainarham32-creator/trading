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

function ddmmyyyy(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}${mm}${date.getFullYear()}`;
}

// Parses the small NSE "Participant wise Open Interest" CSV: a title row, then a real
// header row (some column names have trailing whitespace before the comma — must trim),
// then one row per participant type (Client/DII/FII/Pro/TOTAL).
function parseParticipantOiCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  const header = lines[1].split(',').map(h => h.trim());
  const rows = {};
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const type = cells[0].trim();
    const row = {};
    header.forEach((h, idx) => { row[h] = cells[idx]; });
    rows[type] = row;
  }
  return rows;
}

// EOD file — today's may not be published yet (market still open) or today's a holiday.
// Try today, then walk back a few days until one is found.
async function safeFetchCsv(urlForDate, extract) {
  for (let back = 0; back <= 3; back++) {
    const d = new Date();
    d.setDate(d.getDate() - back);
    const url = urlForDate(d);
    try {
      const r = await fetch(url, { headers: NSE_HEADERS });
      if (!r.ok) continue;
      const v = extract(await r.text(), d);
      if (v != null) return { value: v };
    } catch (e) { /* try an earlier date */ }
  }
  return { error: 'no recent file available' };
}

// Parses NSE's "all indices closing values" EOD file: a simple header + one row per index,
// no quoting. Used to read the Nifty 500 index's own closing level (for its 20-EMA in the
// Regime Score), since this is index-level data — separate from the per-stock bhavcopy
// already used for EMA breadth.
function parseIndexClose(text, indexName) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  const header = lines[0].split(',').map(h => h.trim());
  const nameI = header.indexOf('Index Name');
  const closeI = header.indexOf('Closing Index Value');
  if (nameI === -1 || closeI === -1) return null;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells[nameI] && cells[nameI].trim() === indexName) {
      const close = parseFloat(cells[closeI]);
      return isNaN(close) ? null : close;
    }
  }
  return null;
}

module.exports = async (req, res) => {
  const [vix, fiidii, pcr, nifty500] = await Promise.all([
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
    safeFetchCsv(
      d => `https://archives.nseindia.com/content/nsccl/fao_participant_oi_${ddmmyyyy(d)}.csv`,
      (text, d) => {
        const rows = parseParticipantOiCsv(text);
        const total = rows['TOTAL'];
        const fii = rows['FII'];
        if (!total) return null;
        const callLong = parseFloat(total['Option Index Call Long']);
        const putLong = parseFloat(total['Option Index Put Long']);
        if (!callLong) return null;
        const result = { pcr: putLong / callLong, date: ddmmyyyy(d) };
        if (fii) {
          const fCall = parseFloat(fii['Option Index Call Long']);
          const fPut = parseFloat(fii['Option Index Put Long']);
          if (fCall) result.fiiOptionsPcr = fPut / fCall;
        }
        return result;
      }
    ),
    safeFetchCsv(
      d => `https://archives.nseindia.com/content/indices/ind_close_all_${ddmmyyyy(d)}.csv`,
      (text, d) => {
        const close = parseIndexClose(text, 'Nifty 500');
        return close == null ? null : { close, date: ddmmyyyy(d) };
      }
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
    pcr: pcr.value ? pcr.value.pcr : null,
    pcrDate: pcr.value ? pcr.value.date : null,
    pcrError: pcr.error ?? null,
    fiiOptionsPcr: pcr.value ? (pcr.value.fiiOptionsPcr ?? null) : null,
    fiiOptionsPcrError: pcr.error ?? null,
    nifty500Close: nifty500.value ? nifty500.value.close : null,
    nifty500Date: nifty500.value ? nifty500.value.date : null,
    nifty500Error: nifty500.error ?? null,
  });
};
