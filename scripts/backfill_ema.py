"""
One-time backfill for the Market Regime tab's EMA-breadth and 5-day/volume-move charts.

Fetches ~300+ trading days of NSE daily bhavcopy archives (one CSV per day,
https://archives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv),
and computes, per NIFTY 500 symbol:
  - 50-day and 200-day EMA (-> "% above 50/200 EMA" breadth)
  - a rolling 6-close window (-> "% up 20%/30% in 5 trading days")
  - a rolling 20-volume window (-> "up/down 4%+ on volume", volume > 1.5x its own
    trailing 20-day average, not just the price move alone)
for the trading days beyond each metric's warm-up window (EMA's 200-day warmup is the
long pole; by the time it's satisfied, the much shorter 5-day/20-day windows already are).

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
RECENT_CLOSES_WINDOW = 6    # need close from 5 trading days ago: hist[-6] vs hist[-1]
RECENT_VOLUMES_WINDOW = 20  # trailing 20-day average volume, excluding today
VOLUME_MULTIPLE = 1.5       # today's volume must exceed 1.5x its own 20-day average to count
TARGET_TRADING_DAYS = 320   # 200-day EMA warmup + ~120 days of real breadth output, with margin
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


def parse_closes_and_volumes(text, symbols):
    """Returns ({symbol: close_price}, {symbol: volume}) for SERIES == 'EQ' rows in the NIFTY 500 set."""
    lines = text.strip().split('\n')
    header = [h.strip() for h in lines[0].split(',')]
    sym_i = header.index('SYMBOL')
    series_i = header.index('SERIES')
    close_i = header.index('CLOSE_PRICE')
    vol_i = header.index('TTL_TRD_QNTY')
    closes, volumes = {}, {}
    for line in lines[1:]:
        cells = line.split(',')
        if len(cells) <= vol_i:
            continue
        sym = cells[sym_i].strip()
        series = cells[series_i].strip()
        if series == 'EQ' and sym in symbols:
            try:
                closes[sym] = float(cells[close_i].strip())
                volumes[sym] = float(cells[vol_i].strip())
            except ValueError:
                pass
    return closes, volumes


def main():
    symbols = load_nifty500_symbols()
    print(f'Loaded {len(symbols)} NIFTY 500 symbols.')

    today = datetime.date.today()
    daily_data = []  # list of (date_str, {symbol: close}, {symbol: volume})
    checked = 0
    d = today
    while len(daily_data) < TARGET_TRADING_DAYS and checked < MAX_CALENDAR_DAYS_BACK:
        checked += 1
        if d.weekday() < 5:  # Mon-Fri only; skip weekends without a network call
            text = fetch_day(d)
            if text:
                closes, volumes = parse_closes_and_volumes(text, symbols)
                if closes:
                    daily_data.append((d.isoformat(), closes, volumes))
                    if len(daily_data) % 25 == 0:
                        print(f'  {len(daily_data)} trading days collected (as of {d.isoformat()})...')
        d -= datetime.timedelta(days=1)

    daily_data.reverse()  # ascending by date now
    print(f'Collected {len(daily_data)} trading days, {checked} calendar days checked.')

    # Per-symbol rollforward: EMA50/200, a rolling close window, a rolling volume window
    ema50, ema200 = {}, {}
    close_history = {}   # symbol -> full list of closes seen so far (SMA seed + 5-day window)
    volume_history = {}  # symbol -> full list of volumes seen so far (20-day average window)
    k50 = 2 / (EMA50_PERIOD + 1)
    k200 = 2 / (EMA200_PERIOD + 1)

    breadth_history = []
    last_close, last_date = {}, None

    for date_str, closes, volumes in daily_data:
        above50 = above200 = counted = 0
        up20_5d = up30_5d = up4pct_vol = down4pct_vol = 0

        for sym, price in closes.items():
            hist = close_history.setdefault(sym, [])
            vol_hist = volume_history.setdefault(sym, [])
            hist.append(price)
            if sym in volumes:
                vol_hist.append(volumes[sym])

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

            # 5-day move: hist[-1] is today, hist[-6] is 5 trading days ago.
            # Thresholds are inclusive/cumulative (a 35% mover counts in both buckets),
            # matching how screener tools conventionally report "up X%+" counts.
            if len(hist) >= RECENT_CLOSES_WINDOW:
                base = hist[-RECENT_CLOSES_WINDOW]
                if base:
                    pct5d = (price - base) / base * 100
                    if pct5d >= 20:
                        up20_5d += 1
                    if pct5d >= 30:
                        up30_5d += 1

            # volume-confirmed 1-day move: needs 20 prior days plus today, i.e. length 21
            if len(vol_hist) >= RECENT_VOLUMES_WINDOW + 1 and len(hist) >= 2:
                prior_avg_vol = sum(vol_hist[-(RECENT_VOLUMES_WINDOW + 1):-1]) / RECENT_VOLUMES_WINDOW
                today_vol = vol_hist[-1]
                pct1d = (price - hist[-2]) / hist[-2] * 100 if hist[-2] else 0
                if prior_avg_vol and today_vol > prior_avg_vol * VOLUME_MULTIPLE:
                    if pct1d >= 4:
                        up4pct_vol += 1
                    elif pct1d <= -4:
                        down4pct_vol += 1

            # Only trim the volume window — it has no other use requiring an exact untouched
            # length. close_history must stay unbounded/untouched: EMA seeding above depends
            # on it reaching exactly EMA50_PERIOD/EMA200_PERIOD elements. The last 6 closes
            # for ema_state's output are sliced off at the very end instead, once, after
            # this loop is done growing.
            if len(vol_hist) > RECENT_VOLUMES_WINDOW:
                del vol_hist[0]

        last_close = closes
        last_date = date_str
        if counted >= 50:  # only record once enough symbols have EMAs seeded (the long pole)
            breadth_history.append({
                'date': date_str,
                'pctAbove50Ema': round(above50 / counted * 100, 2),
                'pctAbove200Ema': round(above200 / counted * 100, 2),
                'countUp20_5d': up20_5d,
                'countUp30_5d': up30_5d,
                'countUp4pctVol': up4pct_vol,
                'countDown4pctVol': down4pct_vol,
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
                'recentCloses': [round(c, 4) for c in close_history.get(sym, [])[-RECENT_CLOSES_WINDOW:]],
                'recentVolumes': volume_history.get(sym, [])[-RECENT_VOLUMES_WINDOW:],
            }

    print(f'Computed EMA state for {len(ema_state)} symbols.')
    print(f'Breadth history: {len(breadth_history)} days (from {breadth_history[0]["date"] if breadth_history else "n/a"} to {breadth_history[-1]["date"] if breadth_history else "n/a"}).')

    out_path = os.path.join(SCRIPT_DIR, f'ema_backfill_{today.isoformat()}.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({'emaState': ema_state, 'breadthHistory': breadth_history}, f, separators=(',', ':'))
    print(f'Written to {out_path}')


if __name__ == '__main__':
    main()
