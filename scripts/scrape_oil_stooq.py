#!/usr/bin/env python3
"""Brent + WTI oil scraper — Yahoo Finance chart API + OPA cross-verify.

History:
  - 2026-05-15: built on Stooq CSV (CB.F/CL.F), cross-verified vs OPA demo.
  - 2026-06-10: STOOQ IS DEAD — both the quote-CSV endpoint (404) and the
    daily-CSV endpoint (JavaScript proof-of-work anti-bot wall) are gone for
    scripted access. Worse, the failure was INVISIBLE for 4.4 days: the
    script correctly exited 1, but the workflow piped through `tee` without
    pipefail, so every run reported success while writing nothing.
    Replaced Stooq with Yahoo Finance v8 chart API (BZ=F / CL=F) — the same
    endpoint functions/api/oil-history.js already uses, so one shared
    upstream, verified live (Brent 91.29 / WTI 88.16 on 2026-06-10).

Hardening rules adopted from that incident:
  1. Single-source beats stale: if Yahoo dies but OPA returns sane prices,
     WRITE ANYWAY at confidence "low" (honestly labelled) instead of letting
     the KV age out. Only a total (both-source) failure keeps last-good.
  2. A run that writes nothing must exit non-zero AND the workflow must use
     pipefail so the red X is actually visible to selfheal.

Writes `oil_scraped` (the /api/oil Tier 0 "tier0-xverified" input).
Sanity bounds: 30 <= Brent/WTI <= 250.
"""
import os
import sys
import time
import json
import re
import requests

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN", "")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID", "")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

OIL_MIN = 30.0
OIL_MAX = 250.0
MAX_AGE_MIN = 90  # if Stooq's stamped time is older than this, refuse to write


def sanity_ok(v):
    try:
        return v is not None and OIL_MIN <= float(v) <= OIL_MAX
    except Exception:
        return False


def fetch_yahoo(symbol, label):
    """Yahoo Finance v8 chart API for a futures symbol (BZ=F / CL=F).
    Same upstream as functions/api/oil-history.js. Returns dict or None."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d"
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=20)
        if not r.ok:
            print(f"  {label}: HTTP {r.status_code}")
            return None
        meta = (r.json().get("chart", {}).get("result") or [{}])[0].get("meta", {})
        close = meta.get("regularMarketPrice")
        if not sanity_ok(close):
            print(f"  {label}: price {close} missing or out of sanity bounds")
            return None
        close = float(close)
        # Freshness: marketTime must be within the last 4 days (covers weekends).
        mkt_ts = meta.get("regularMarketTime")
        if mkt_ts and (time.time() - mkt_ts) > 4 * 86400:
            print(f"  {label}: marketTime {mkt_ts} older than 4 days — rejecting as stale")
            return None
        prev = meta.get("chartPreviousClose")
        prev = float(prev) if sanity_ok(prev) else None
        change    = (close - prev) if prev is not None else None
        changePct = (change / prev * 100.0) if (change is not None and prev) else None
        stamp = time.strftime("%Y-%m-%d %H:%M", time.gmtime(mkt_ts)) if mkt_ts else None
        print(f"  {label}: {close}  (prevClose {prev}, change "
              f"{('%+.2f' % change) if change is not None else 'n/a'}, stamp {stamp} UTC)")
        return {
            "close": close, "open": prev, "high": None, "low": None,
            "change": change, "changePct": changePct,
            "stampUtc": mkt_ts, "stampStr": stamp,
        }
    except Exception as e:
        print(f"  {label}: error {str(e)[:160]}")
        return None


def fetch_opa_demo():
    """OilPriceAPI demo endpoint — free, public, live. Returns {brent, wti} floats or None.
    Used as cross-verify alongside Stooq. Different infrastructure failure mode than
    Stooq's CSV — genuine source diversity in a single scraper run.
    """
    out = {"brent": None, "wti": None}
    url = "https://api.oilpriceapi.com/v1/demo/prices"
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=15)
        if not r.ok:
            print(f"  OPA: HTTP {r.status_code}")
            return out
        data = r.json()
        prices = data.get("data", {}).get("prices", [])
        b_raw = next((p for p in prices if p.get("code") == "BRENT_CRUDE_USD"), None)
        w_raw = next((p for p in prices if p.get("code") == "WTI_USD"), None)
        if b_raw and sanity_ok(b_raw.get("price")):
            out["brent"] = float(b_raw["price"])
        if w_raw and sanity_ok(w_raw.get("price")):
            out["wti"] = float(w_raw["price"])
        print(f"  OPA: brent={out['brent']}  wti={out['wti']}")
    except Exception as e:
        print(f"  OPA: error {str(e)[:160]}")
    return out


def kv_put(key, value):
    if not (CF_ACCOUNT_ID and CF_API_TOKEN and KV_NS):
        print("  CF env vars missing — cannot write KV")
        return False
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(
        url,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
        data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
        timeout=30,
    )
    return r.status_code == 200


def main():
    dry_run = "--dry-run" in sys.argv
    mode = "DRY RUN" if dry_run else "LIVE"
    print(f"=== Oil scrape · Yahoo [{mode}] at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")

    brent = fetch_yahoo("BZ=F", "Brent BZ=F")
    wti   = fetch_yahoo("CL=F", "WTI   CL=F")
    opa   = fetch_opa_demo()

    # ── Degraded path (2026-06-10): Yahoo dead but OPA alive → write OPA at
    # "low" confidence instead of letting the KV age out. The 4.4-day-stale
    # incident proved fresh-with-honest-confidence beats stale-and-silent.
    if not (brent and wti):
        if opa.get("brent") and opa.get("wti"):
            print("\n⚠ Yahoo unusable — degrading to OPA-only write (confidence=low).")
            brent = {"close": opa["brent"], "open": None, "high": None, "low": None,
                     "change": None, "changePct": None, "stampUtc": None, "stampStr": "opa-only"}
            wti   = {"close": opa["wti"],   "open": None, "high": None, "low": None,
                     "change": None, "changePct": None, "stampUtc": None, "stampStr": "opa-only"}
            opa = {"brent": None, "wti": None}  # no self-cross-verification
        else:
            print("\n✗ Neither Yahoo nor OPA returned usable Brent + WTI — keeping existing KV (no write).")
            return 1

    # ── Cross-verify Yahoo vs OPA demo ──────────────────────────────────────
    # Confidence ladder:
    #   high   = both sources alive AND brent within ~1%
    #   medium = both alive but disagreement > 1% (still write — Yahoo leads)
    #   low    = only one of the two alive (still write)
    def _pct_diff(a, b):
        if not (a and b): return None
        return abs(a - b) / ((a + b) / 2.0) * 100.0

    brent_pct_diff = _pct_diff(brent["close"], opa.get("brent"))
    wti_pct_diff   = _pct_diff(wti["close"],   opa.get("wti"))
    sources_alive  = 1 + (1 if (opa.get("brent") or opa.get("wti")) else 0)

    if sources_alive == 1:
        confidence = "low"
        agree_note = "single-source"
    elif brent_pct_diff is not None and brent_pct_diff <= 1.0:
        confidence = "high"
        agree_note = f"agree(brent d={brent_pct_diff:.2f}%)"
    else:
        confidence = "medium"
        agree_note = f"disagree(brent d={brent_pct_diff:.2f}%)" if brent_pct_diff is not None else "no-brent-cross"

    print(f"\n  cross-verify: confidence={confidence} · {agree_note} · sources_alive={sources_alive}")

    # Build the oil_scraped payload in the shape /api/oil's Tier 0 expects
    # (matches scripts/scrape_oil_web.py:result_syms). Stooq remains the
    # authoritative value; OPA is recorded in `sources` + `cross_verify` for
    # transparency.
    def sym(v, opa_val, key):
        srcs = ["yahoo" if v.get("stampStr") != "opa-only" else "oilpriceapi-demo"]
        if opa_val: srcs.append("oilpriceapi-demo")
        mn = min([x for x in [v["close"], opa_val] if x is not None])
        mx = max([x for x in [v["close"], opa_val] if x is not None])
        return {
            "value": round(v["close"], 2),
            "median": round(v["close"], 2),
            "min": round(mn, 2),
            "max": round(mx, 2),
            "sources": srcs,
            "confidence": confidence,
            "change": round(v["change"], 3) if v.get("change") is not None else None,
            "changePct": round(v["changePct"], 4) if v.get("changePct") is not None else None,
            "open": v.get("open"), "high": v.get("high"), "low": v.get("low"),
            "stamp": v.get("stampStr"),
            "opa_value": round(opa_val, 2) if opa_val else None,
        }

    payload = {
        "fetchedAt": int(time.time()),
        "brent": sym(brent, opa.get("brent"), "brent"),
        "wti":   sym(wti,   opa.get("wti"),   "wti"),
        "sources_succeeded": sources_alive,
        "cross_verify": {
            "brent_pct_diff": round(brent_pct_diff, 3) if brent_pct_diff is not None else None,
            "wti_pct_diff":   round(wti_pct_diff,   3) if wti_pct_diff   is not None else None,
            "note": agree_note,
        },
        "scraper": "scrape_oil_stooq",
    }

    if dry_run:
        print("\nDRY RUN — payload preview:")
        print(json.dumps(payload, indent=2))
        return 0

    ok = kv_put("oil_scraped", json.dumps(payload, separators=(",", ":")))
    print(f"\n{'✓' if ok else '✗'} KV write {'OK' if ok else 'FAILED'} (key=oil_scraped) "
          f"brent={payload['brent']['value']} wti={payload['wti']['value']} "
          f"spread={round(payload['brent']['value'] - payload['wti']['value'], 2)}")
    return 0 if ok else 1


if __name__ == "__main__":
    from _status import write_status
    _rc = 1
    try:
        _rc = main()
    finally:
        write_status("oil_stooq", ok=(_rc == 0))
    sys.exit(_rc)
