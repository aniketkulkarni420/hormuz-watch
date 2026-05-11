#!/usr/bin/env python3
"""Resilient oil + tanker stock scraper with 4-source fallback chain.

For each commodity (Brent, WTI), tries sources in order:
  1. Yahoo chart API (browser-like headers — most up-to-date when it works)
  2. Stooq CSV (works some days)
  3. FRED CSV (St Louis Fed — Brent only, very reliable)
  4. EIA API (our own key — always works, daily lag)

For tanker stocks, tries Yahoo chart API only (others don't have these tickers).
Script succeeds as long as Brent + WTI come back from any source.
"""

import os
import json
import time
import sys
import csv
from io import StringIO
import requests

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
S = requests.Session()
S.headers.update({
    "User-Agent": UA,
    "Accept": "application/json,text/csv,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Referer": "https://finance.yahoo.com/",
})

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID")
EIA_KEY       = os.environ.get("EIA_KEY", "")  # optional fallback

if not all([CF_ACCOUNT_ID, CF_API_TOKEN, KV_NS]):
    print("ERROR: Missing CF env vars"); sys.exit(1)


def _quote(c, pc, o=None, h=None, l=None, src="?", date=None):
    """Build standard quote dict."""
    d = c - pc if pc else 0
    dp = (d / pc * 100) if pc else 0
    return {
        "c": round(c, 4), "pc": round(pc, 4),
        "d": round(d, 4), "dp": round(dp, 4),
        "o": round(o or c, 4), "h": round(h or c, 4), "l": round(l or c, 4),
        "t": int(time.time()), "src": src, **({"date": date} if date else {})
    }


# ─── Yahoo chart API ───────────────────────────────────────
def yahoo_chart(ticker):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=2d&interval=1d"
    try:
        r = S.get(url, timeout=20)
        if r.status_code != 200:
            return None
        data = r.json()
        result = data.get("chart", {}).get("result")
        if not result: return None
        meta = result[0].get("meta", {})
        ind = result[0].get("indicators", {}).get("quote", [{}])[0]
        closes = ind.get("close", [])
        opens = ind.get("open", [])
        highs = ind.get("high", [])
        lows = ind.get("low", [])
        c = meta.get("regularMarketPrice") or (closes[-1] if closes else None)
        pc = meta.get("chartPreviousClose") or meta.get("previousClose")
        if not (c and pc and c > 0 and pc > 0): return None
        return _quote(c, pc, opens[-1] if opens else None,
                      highs[-1] if highs else meta.get("regularMarketDayHigh"),
                      lows[-1] if lows else meta.get("regularMarketDayLow"),
                      src="yahoo")
    except Exception as e:
        print(f"  yahoo {ticker} exception: {str(e)[:80]}")
        return None


# ─── Stooq CSV ─────────────────────────────────────────────
def stooq(sym):
    url = f"https://stooq.com/q/d/l/?s={sym}&i=d"
    try:
        r = S.get(url, timeout=20)
        if r.status_code != 200 or not r.text or "Date" not in r.text:
            return None
        rows = list(csv.DictReader(StringIO(r.text)))
        if len(rows) < 2: return None
        last = rows[-1]; prev = rows[-2]
        return _quote(float(last["Close"]), float(prev["Close"]),
                      float(last.get("Open") or last["Close"]),
                      float(last.get("High") or last["Close"]),
                      float(last.get("Low")  or last["Close"]),
                      src="stooq", date=last.get("Date"))
    except Exception:
        return None


# ─── FRED CSV (Brent only) ─────────────────────────────────
def fred(series_id):
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    try:
        r = S.get(url, timeout=20)
        if r.status_code != 200 or "DATE" not in r.text.upper(): return None
        lines = [l.strip() for l in r.text.strip().split("\n") if l.strip()]
        # find last 2 non-"." values
        vals = []
        for line in reversed(lines[1:]):
            parts = line.split(",")
            if len(parts) >= 2:
                try:
                    v = float(parts[1])
                    vals.append((parts[0], v))
                    if len(vals) >= 2: break
                except ValueError:
                    continue
        if len(vals) < 2: return None
        date_c, c = vals[0]; _, pc = vals[1]
        return _quote(c, pc, src="fred", date=date_c)
    except Exception:
        return None


# ─── EIA API (always works) ────────────────────────────────
def eia(series):
    if not EIA_KEY: return None
    url = (f"https://api.eia.gov/v2/petroleum/pri/spt/data/"
           f"?api_key={EIA_KEY}&frequency=daily&data%5B0%5D=value"
           f"&facets%5Bseries%5D%5B%5D={series}&sort%5B0%5D%5Bcolumn%5D=period"
           f"&sort%5B0%5D%5Bdirection%5D=desc&offset=0&length=5")
    try:
        r = S.get(url, timeout=20)
        if r.status_code != 200: return None
        data = r.json().get("response", {}).get("data", [])
        valid = [d for d in data if d.get("value")]
        if len(valid) < 2: return None
        c = float(valid[0]["value"]); pc = float(valid[1]["value"])
        return _quote(c, pc, src="eia-daily", date=valid[0].get("period"))
    except Exception:
        return None


def fetch_commodity(name, yahoo_sym, stooq_sym, fred_id, eia_sym):
    """Try each source in order. First success wins."""
    for fn_name, fn in [
        ("yahoo", lambda: yahoo_chart(yahoo_sym)),
        ("stooq", lambda: stooq(stooq_sym)),
        ("fred",  lambda: fred(fred_id) if fred_id else None),
        ("eia",   lambda: eia(eia_sym)),
    ]:
        try:
            q = fn()
            if q and q["c"] > 0:
                return q
        except Exception:
            continue
        time.sleep(1)
    return None


def fetch_stock(ticker):
    """Stocks: try Yahoo, then Stooq with .us suffix."""
    q = yahoo_chart(ticker)
    if q: return q
    time.sleep(1)
    return stooq(f"{ticker.lower()}.us")


def put_kv(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
                     data=value, timeout=30)
    if r.status_code != 200:
        print(f"  KV PUT {key} failed: {r.status_code} {r.text[:120]}")
        return False
    return True


def main():
    print(f"=== {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    results = {}

    # Commodities (4-source fallback)
    brent = fetch_commodity("brent", "BZ=F", "cb.f", "DCOILBRENTEU", "RBRTE")
    if brent: results["brent"] = brent; print(f"  ✓ brent  via {brent['src']:10s}: ${brent['c']:>8.2f} ({brent['dp']:+.2f}%)")
    else:     print(f"  ✗ brent  all sources failed")

    wti = fetch_commodity("wti", "CL=F", "cl.f", "DCOILWTICO", "RWTC")
    if wti: results["wti"] = wti; print(f"  ✓ wti    via {wti['src']:10s}: ${wti['c']:>8.2f} ({wti['dp']:+.2f}%)")
    else:   print(f"  ✗ wti    all sources failed")

    # Stocks (Yahoo → Stooq)
    for key, sym in [("fro","FRO"),("stng","STNG"),("tnk","TNK"),("dht","DHT"),("nat","NAT"),("insw","INSW")]:
        time.sleep(1.5)
        q = fetch_stock(sym)
        if q: results[key] = q; print(f"  ✓ {key:6s} via {q['src']:10s}: ${q['c']:>8.2f} ({q['dp']:+.2f}%)")
        else: print(f"  ✗ {key:6s} both sources failed")

    if not results:
        print("ERROR: nothing fetched"); sys.exit(1)

    payload = {"fetchedAt": int(time.time()), "source": "github-actions", "symbols": results}
    body = json.dumps(payload, separators=(",", ":"))
    if not put_kv("latest", body):
        sys.exit(1)
    print(f"✓ KV write OK ({len(body)}B, {len(results)} symbols)")


if __name__ == "__main__":
    main()
