"""
One-time seed for the NIFTY 500 index's own 20-EMA, used by the Regime Score's
"where is the index relative to its 20-EMA" factor (see .claude/skills/nse-market-data/SKILL.md).

Unlike scripts/backfill_ema.py (which tracks ~500 individual stocks and needs a 200-day
warm-up), this tracks a single series — the Nifty 500 index's own daily closing value —
so a 20-day warm-up is enough. Source: NSE's daily "all indices closing values" file
(archives.nseindia.com/content/indices/ind_close_all_DDMMYYYY.csv), the same file
api/regime.js reads live for today's close.

Not run automatically — see nse-market-data skill for why (no service_role key, ever;
the daily incremental update happens client-side in autoSaveRegimeSnapshot()). Re-run only
if market_regime's nifty500_ema20 ever needs reseeding from scratch.

Output: scripts/nifty500_ema20_<date>.json — {"date":..., "close":..., "ema20":...}
A human (or Claude, driving an authenticated browser session) loads this and merges the
seed into the most recent market_regime row(s) by hand.
"""
import json
import urllib.request
import urllib.error
import datetime
import os

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
}

EMA_PERIOD = 20
TARGET_TRADING_DAYS = 30  # 20-day warmup + a few extra days of real output, with margin
MAX_CALENDAR_DAYS_BACK = 60
INDEX_NAME = 'Nifty 500'

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def ddmmyyyy(d):
    return d.strftime('%d%m%Y')


def fetch_day(d):
    url = f'https://archives.nseindia.com/content/indices/ind_close_all_{ddmmyyyy(d)}.csv'
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        return resp.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError:
        return None
    except Exception as e:
        print(f'  fetch failed for {d}: {e!r}')
        return None


def parse_index_close(text, index_name):
    lines = text.strip().split('\n')
    header = [h.strip() for h in lines[0].split(',')]
    name_i = header.index('Index Name')
    close_i = header.index('Closing Index Value')
    for line in lines[1:]:
        cells = line.split(',')
        if len(cells) <= close_i:
            continue
        if cells[name_i].strip() == index_name:
            try:
                return float(cells[close_i].strip())
            except ValueError:
                return None
    return None


def main():
    today = datetime.date.today()
    daily = []  # list of (date_str, close), ascending
    checked = 0
    d = today
    while len(daily) < TARGET_TRADING_DAYS and checked < MAX_CALENDAR_DAYS_BACK:
        checked += 1
        if d.weekday() < 5:
            text = fetch_day(d)
            if text:
                close = parse_index_close(text, INDEX_NAME)
                if close is not None:
                    daily.append((d.isoformat(), close))
        d -= datetime.timedelta(days=1)
    daily.reverse()
    print(f'Collected {len(daily)} trading days, {checked} calendar days checked.')

    if len(daily) < EMA_PERIOD:
        print(f'Not enough days to seed a {EMA_PERIOD}-day EMA. Aborting.')
        return

    k = 2 / (EMA_PERIOD + 1)
    closes = [c for _, c in daily]
    ema = sum(closes[:EMA_PERIOD]) / EMA_PERIOD
    last_date, last_close = daily[EMA_PERIOD - 1]
    for date_str, close in daily[EMA_PERIOD:]:
        ema = close * k + ema * (1 - k)
        last_date, last_close = date_str, close

    out = {'date': last_date, 'close': round(last_close, 4), 'ema20': round(ema, 4)}
    print(f'Seeded EMA20 as of {last_date}: close={last_close}, ema20={ema:.4f}')

    out_path = os.path.join(SCRIPT_DIR, f'nifty500_ema20_{today.isoformat()}.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'Written to {out_path}')


if __name__ == '__main__':
    main()
