#!/usr/bin/env python3
"""Scrape Brent, WTI, BDTI proxy, and tanker stocks via yfinance + push to Cloudflare KV.

Why this exists: Cloudflare Workers cannot directly reach Yahoo Finance from inside
their network (egress restrictions / auth tokens). GitHub Actions runs outside that
restriction. So we scrape on GHA, push to KV, and Cloudflare Pages Functions read
from KV at millisecond latency.

Symbols:
  BZ=F   ICE Brent crude front-month
  CL=F   NYMEX WTI crude front-month
  FRO    Frontline                — tanker
  STNG   Scorpio Tankers           — product/chem
  TNK    Teekay Tankers           — tanker
  DHT    DHT Holdings             — VLCC
  NAT    Nordic American Tankers  — Suezmax
  INSW   International Seaways    — tanker
"""

import os
import json
import time
import sys
import requests
import yfinance as yf

SYMBOLS = {
    "brent":  "BZ=F",
    "wti":    "CL=F",
    "fro":    "FRO",
    "stng":   "STNG",
    "tnk":    "TNK",
    "dht":    "DHT",
    "nat":    "NAT",
    "insw":   "INSW",
}

CF_ACCOUNT_ID  = os.environ.get("CF_ACCOUNT_ID")
CF_API_TOKEN   = os.environ.get("CF_API_TOKEN")
KV_NAMESPACE   = os.environ.get("CF_KV_NAMESPACE_ID")

if not all([CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE]):
    print("ERROR: Missing CF_ACCOUNT_ID / CF_API_TOKEN / CF_KV_NAMESPACE_ID env vars")
    sys.exit(1)


def fetch_quote(ticker_symbol: str) -> dict | None:
    """Use yfinance to grab latest quote. Returns dict with c (current), pc (prev close),
    d (change), dp (change %), h (high), l (low), o (open), t (unix timestamp)."""
    try:
        t = yf.Ticker(ticker_symbol)
        # fast_info is the cheapest call; falls back to history if needed
        info = t.fast_info
        last = float(info.get("lastPrice") or info.get("last_price") or 0)
        prev_close = float(info.get("previousClose") or info.get("previous_close") or 0)
        open_p = float(info.get("open") or 0)
        if last <= 0 or prev_close <= 0:
            # Fallback to 1-day history
            h = t.history(period="2d", interval="1m")
            if not h.empty:
                last = float(h["Close"].iloc[-1])
                prev_close = float(h["Close"].iloc[0])
        if last <= 0:
            return None
        d = last - prev_close if prev_close > 0 else 0
        dp = (d / prev_close * 100) if prev_close > 0 else 0
        return {
            "c":  round(last, 4),
            "pc": round(prev_close, 4),
            "d":  round(d, 4),
            "dp": round(dp, 4),
            "o":  round(open_p, 4),
            "h":  round(float(info.get("dayHigh") or info.get("day_high") or 0), 4),
            "l":  round(float(info.get("dayLow") or info.get("day_low") or 0), 4),
            "t":  int(time.time()),
        }
    except Exception as e:
        print(f"  {ticker_symbol}: fetch failed — {e}")
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
    print(f"=== Scraping {len(SYMBOLS)} symbols at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    results = {}
    for key, sym in SYMBOLS.items():
        q = fetch_quote(sym)
        if q:
            results[key] = q
            print(f"  ✓ {key:6s} ({sym:6s}): ${q['c']:>10.2f}  ({q['dp']:+.2f}%)")
        else:
            print(f"  ✗ {key:6s} ({sym:6s}): no data")
    if not results:
        print("ERROR: No symbols fetched. Aborting KV write.")
        sys.exit(1)
    # Wrap in a single KV value with metadata
    payload = {
        "fetchedAt": int(time.time()),
        "source": "github-actions/yfinance",
        "symbols": results,
    }
    body = json.dumps(payload, separators=(",", ":"))
    if put_kv("latest", body):
        print(f"✓ KV write OK ({len(body)} bytes)")
    else:
        print("✗ KV write failed")
        sys.exit(1)
    # Also write individual symbols for granular reads if needed later
    for key, q in results.items():
        put_kv(f"sym/{key}", json.dumps(q, separators=(",", ":")))
    print("Done.")


if __name__ == "__main__":
    main()
