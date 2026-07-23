"""
One-time backfill for the Market Regime tab's EMA-breadth charts.

Fetches ~300+ trading days of NSE daily bhavcopy archives (one CSV per day,
https://archives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv),
computes a 50-day and 200-day EMA per NIFTY 500 symbol, and derives the daily
aggregate "% of NIFTY 500 above 50 EMA" / "% above 200 EMA" for the trading
days beyond the warm-up window.

This is NOT run automatically or on a schedule — see .claude/skills/nse-market-data/SKILL.md
for why (no service_role key, ever; ongoing updates happen client-side via api/breadth.js).
Re-run this only if ema_state/market_breadth_history ever need reseeding from scratch.

Output: scripts/ema_backfill_<date>.json — {"emaState": {...}, "breadthHistory": [...]}
The app never reads this file directly; a human (or Claude, driving an authenticated
browser session) loads it and upserts into Supabase by hand. See the plan/skill docs.
"""
import json
import urllib.request
import urllib.error
import datetime
import os

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
}

EMA50_PERIOD = 50
EMA200_PERIOD = 200
TARGET_TRADING_DAYS = 320   # 200-day warmup + ~120 days of real breadth output, with margin
MAX_CALENDAR_DAYS_BACK = 480

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)


def ddmmyyyy(d):
    return d.strftime('%d%m%Y')


def load_nifty500_symbols():
    with open(os.path.join(REPO_ROOT, 'nifty500.json'), encoding='utf-8') as f:
        return {row['symbol'] for row in json.load(f)}


def fetch_day(d):
    url = f'https://archives.nseindia.com/products/content/sec_bhavdata_full_{ddmmyyyy(d)}.csv'
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        return resp.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError:
        return None
    except Exception as e:
        print(f'  fetch failed for {d}: {e!r}')
        return None


def parse_closes(text, symbols):
    """Returns {symbol: close_price} for rows where SERIES == 'EQ' and symbol is in the NIFTY 500 set."""
    lines = text.strip().split('\n')
    header = [h.strip() for h in lines[0].split(',')]
    sym_i = header.index('SYMBOL')
    series_i = header.index('SERIES')
    close_i = header.index('CLOSE_PRICE')
    out = {}
    for line in lines[1:]:
        cells = line.split(',')
        if len(cells) <= close_i:
            continue
        sym = cells[sym_i].strip()
        series = cells[series_i].strip()
        if series == 'EQ' and sym in symbols:
            try:
                out[sym] = float(cells[close_i].strip())
            except ValueError:
                pass
    return out


def main():
    symbols = load_nifty500_symbols()
    print(f'Loaded {len(symbols)} NIFTY 500 symbols.')

    today = datetime.date.today()
    daily_closes = []  # list of (date_str, {symbol: close})
    checked = 0
    d = today
    while len(daily_closes) < TARGET_TRADING_DAYS and checked < MAX_CALENDAR_DAYS_BACK:
        checked += 1
        if d.weekday() < 5:  # Mon-Fri only; skip weekends without a network call
            text = fetch_day(d)
            if text:
                closes = parse_closes(text, symbols)
                if closes:
                    daily_closes.append((d.isoformat(), closes))
                    if len(daily_closes) % 25 == 0:
                        print(f'  {len(daily_closes)} trading days collected (as of {d.isoformat()})...')
        d -= datetime.timedelta(days=1)

    daily_closes.reverse()  # ascending by date now
    print(f'Collected {len(daily_closes)} trading days, {checked} calendar days checked.')

    # Per-symbol EMA rollforward
    ema50 = {}
    ema200 = {}
    close_history = {}  # symbol -> list of closes seen so far, for SMA seeding
    k50 = 2 / (EMA50_PERIOD + 1)
    k200 = 2 / (EMA200_PERIOD + 1)

    breadth_history = []
    last_close = {}
    last_date = None

    for date_str, closes in daily_closes:
        above50 = 0
        above200 = 0
        counted = 0
        for sym, price in closes.items():
            hist = close_history.setdefault(sym, [])
            hist.append(price)

            if sym not in ema50:
                if len(hist) == EMA50_PERIOD:
                    ema50[sym] = sum(hist) / EMA50_PERIOD
            else:
                ema50[sym] = price * k50 + ema50[sym] * (1 - k50)

            if sym not in ema200:
                if len(hist) == EMA200_PERIOD:
                    ema200[sym] = sum(hist) / EMA200_PERIOD
            else:
                ema200[sym] = price * k200 + ema200[sym] * (1 - k200)

            if sym in ema50 and sym in ema200:
                counted += 1
                if price > ema50[sym]:
                    above50 += 1
                if price > ema200[sym]:
                    above200 += 1

        last_close = closes
        last_date = date_str
        if counted >= 50:  # only record once enough symbols have both EMAs seeded
            breadth_history.append({
                'date': date_str,
                'pctAbove50Ema': round(above50 / counted * 100, 2),
                'pctAbove200Ema': round(above200 / counted * 100, 2),
                'symbolsCounted': counted,
            })

    ema_state = {}
    for sym in ema50:
        if sym in ema200:
            ema_state[sym] = {
                'ema50': round(ema50[sym], 4),
                'ema200': round(ema200[sym], 4),
                'lastClose': last_close.get(sym),
                'lastDate': last_date,
            }

    print(f'Computed EMA state for {len(ema_state)} symbols.')
    print(f'Breadth history: {len(breadth_history)} days (from {breadth_history[0]["date"] if breadth_history else "n/a"} to {breadth_history[-1]["date"] if breadth_history else "n/a"}).')

    out_path = os.path.join(SCRIPT_DIR, f'ema_backfill_{today.isoformat()}.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({'emaState': ema_state, 'breadthHistory': breadth_history}, f, separators=(',', ':'))
    print(f'Written to {out_path}')


if __name__ == '__main__':
    main()
