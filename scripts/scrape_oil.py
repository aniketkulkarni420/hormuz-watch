#!/usr/bin/env python3
"""Scrape Brent, WTI, and tanker stocks. Push to Cloudflare KV.

Strategy (resilient against Yahoo rate-limiting GHA IPs):
  - Commodities (Brent, WTI): direct Stooq CSV — works reliably from GitHub Actions.
  - Stocks (tanker plays): yfinance with retry + delay + browser-like headers.
"""

import os
import json
import time
import sys
import csv
from io import StringIO
import requests

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
)
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"})

CF_ACCOUNT_ID  = os.environ.get("CF_ACCOUNT_ID")
CF_API_TOKEN   = os.environ.get("CF_API_TOKEN")
KV_NAMESPACE   = os.environ.get("CF_KV_NAMESPACE_ID")

if not all([CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE]):
    print("ERROR: Missing CF_ACCOUNT_ID / CF_API_TOKEN / CF_KV_NAMESPACE_ID env vars")
    sys.exit(1)


# ── Commodity fetch via Stooq (no auth, no rate limit issues from GHA) ──
def fetch_stooq(stooq_symbol: str) -> dict | None:
    """stooq_symbol like 'cb.f' (Brent) or 'cl.f' (WTI)."""
    url = f"https://stooq.com/q/d/l/?s={stooq_symbol}&i=d"
    try:
        r = SESSION.get(url, timeout=20)
        if r.status_code != 200:
            print(f"  stooq {stooq_symbol}: HTTP {r.status_code}")
            return None
        rows = list(csv.DictReader(StringIO(r.text)))
        if len(rows) < 2:
            print(f"  stooq {stooq_symbol}: only {len(rows)} rows")
            return None
        last = rows[-1]
        prev = rows[-2]
        c = float(last["Close"])
        pc = float(prev["Close"])
        h = float(last.get("High") or last["Close"])
        l = float(last.get("Low") or last["Close"])
        o = float(last.get("Open") or last["Close"])
        d = c - pc
        dp = (d / pc * 100) if pc else 0
        return {
            "c": round(c, 4), "pc": round(pc, 4),
            "d": round(d, 4), "dp": round(dp, 4),
            "o": round(o, 4), "h": round(h, 4), "l": round(l, 4),
            "t": int(time.time()),
            "src": "stooq",
            "date": last.get("Date")
        }
    except Exception as e:
        print(f"  stooq {stooq_symbol} exception: {e}")
        return None


# ── Stock fetch via yfinance (with retry + delay) ──
def fetch_yfinance(ticker: str, attempt: int = 0) -> dict | None:
    """yfinance with backoff. Rate-limit retries up to 3 times."""
    try:
        import yfinance as yf
        t = yf.Ticker(ticker)
        h = t.history(period="2d", interval="1d", auto_adjust=False)
        if h.empty or len(h) < 1:
            return None
        last_row = h.iloc[-1]
        c = float(last_row["Close"])
        if c <= 0:
            return None
        if len(h) >= 2:
            prev_row = h.iloc[-2]
            pc = float(prev_row["Close"])
        else:
            pc = float(last_row["Open"]) if last_row["Open"] > 0 else c
        d = c - pc
        dp = (d / pc * 100) if pc else 0
        return {
            "c": round(c, 4), "pc": round(pc, 4),
            "d": round(d, 4), "dp": round(dp, 4),
            "o": round(float(last_row.get("Open") or c), 4),
            "h": round(float(last_row.get("High") or c), 4),
            "l": round(float(last_row.get("Low") or c), 4),
            "t": int(time.time()),
            "src": "yfinance"
        }
    except Exception as e:
        msg = str(e)
        if ("Too Many Requests" in msg or "429" in msg) and attempt < 3:
            wait = 5 * (2 ** attempt)
            print(f"  yfinance {ticker} rate-limited, retry in {wait}s")
            time.sleep(wait)
            return fetch_yfinance(ticker, attempt + 1)
        print(f"  yfinance {ticker} failed: {msg[:100]}")
        return None


def put_kv(key: str, value: str) -> bool:
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NAMESPACE}/values/{key}"
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "text/plain",
    }
    r = requests.put(url, headers=headers, data=value, timeout=30)
    if r.status_code != 200:
        print(f"  KV PUT {key} failed: {r.status_code} {r.text[:120]}")
        return False
    return True


def main():
    print(f"=== Scraping at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    results = {}
    # Commodities via Stooq
    for key, sym in [("brent", "cb.f"), ("wti", "cl.f")]:
        q = fetch_stooq(sym)
        if q:
            results[key] = q
            print(f"  ✓ {key:6s} (stooq {sym:5s}): ${q['c']:>10.2f}  ({q['dp']:+.2f}%)  [{q.get('date')}]")
        else:
            print(f"  ✗ {key:6s} (stooq {sym:5s}): no data")

    # Stocks via yfinance (with small delay between each to avoid burst)
    for key, sym in [("fro","FRO"), ("stng","STNG"), ("tnk","TNK"),
                     ("dht","DHT"), ("nat","NAT"), ("insw","INSW")]:
        q = fetch_yfinance(sym)
        if q:
            results[key] = q
            print(f"  ✓ {key:6s} ({sym:6s}): ${q['c']:>10.2f}  ({q['dp']:+.2f}%)")
        else:
            print(f"  ✗ {key:6s} ({sym:6s}): no data")
        time.sleep(2)  # be polite to Yahoo

    if not results:
        print("ERROR: No symbols fetched. Aborting KV write.")
        sys.exit(1)

    payload = {
        "fetchedAt": int(time.time()),
        "source": "github-actions",
        "symbols": results,
    }
    body = json.dumps(payload, separators=(",", ":"))
    if put_kv("latest", body):
        print(f"✓ KV write OK ({len(body)} bytes, {len(results)} symbols)")
    else:
        print("✗ KV write failed")
        sys.exit(1)
    print("Done.")


if __name__ == "__main__":
    main()
