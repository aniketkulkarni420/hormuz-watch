#!/usr/bin/env python3
"""Resilient oil + tanker stock scraper — dual-track architecture.

LIVE PRICE TRACK (5-min fresh):
  1. OilPriceAPI demo — unauthenticated, 20 req/hr, Brent + WTI, ~5-min lag
  2. Yahoo chart API (BZ=F / CL=F) — browser-like headers, works when rate limits allow
  3. Stooq CSV (equities fine; commodity CSV unreliable but kept as fallback)

OFFICIAL REFERENCE TRACK (daily EIA spot, explicit publish date):
  4. EIA v2 API (RBRTE / RWTC) — authoritative, 5-7 day lag
  5. FRED CSV (DCOILBRENTEU / DCOILWTICO) — same underlying data, slightly different timing

Results stored as:
  symbols.brent        → live estimate (most recent source)
  symbols.wti          → live estimate
  symbols.brent_official → EIA/FRED daily spot with publish date (always fetched)
  symbols.wti_official   → same for WTI

Frontend displays both: live estimate with freshness + official EIA spot with "as of <date>".
Difference between them is itself a signal for analysts.
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


def _quote(c, pc, o=None, h=None, l=None, src="?", date=None, updated_at=None):
    """Build standard quote dict."""
    d = c - pc if pc else 0
    dp = (d / pc * 100) if pc else 0
    q = {
        "c": round(c, 4), "pc": round(pc, 4),
        "d": round(d, 4), "dp": round(dp, 4),
        "o": round(o or c, 4), "h": round(h or c, 4), "l": round(l or c, 4),
        "t": int(time.time()), "src": src, **({"date": date} if date else {})
    }
    if updated_at:
        q["updatedAt"] = updated_at
    return q


# ─── OilPriceAPI demo (no auth, 20/hr, Brent + WTI, 5-min fresh) ────────────
def oilpriceapi_demo():
    """Returns (brent_quote, wti_quote) or (None, None) on failure.
    Uses the unauthenticated /v1/demo/prices endpoint.
    change_24h in the response is a percentage value (e.g. -0.45 = -0.45%).
    """
    url = "https://api.oilpriceapi.com/v1/demo/prices"
    try:
        r = requests.get(url, timeout=15, headers={"User-Agent": UA})
        if r.status_code != 200:
            print(f"  oilpriceapi_demo HTTP {r.status_code}")
            return None, None
        data = r.json()
        prices = data.get("data", {}).get("prices", [])
        meta   = data.get("data", {}).get("meta", {})
        demo_mode = meta.get("demo_mode", False)
        b_raw = next((p for p in prices if p.get("code") == "BRENT_CRUDE_USD"), None)
        w_raw = next((p for p in prices if p.get("code") == "WTI_USD"), None)
        if not b_raw or not w_raw:
            print("  oilpriceapi_demo: missing Brent or WTI in payload")
            return None, None

        def build(raw, sym):
            c  = float(raw["price"])
            dp = float(raw.get("change_24h", 0))   # already a percentage
            d  = round(c * dp / 100, 4)
            pc = round(c - d, 4)
            return _quote(c, pc, src="oilpriceapi-demo" + ("-demodata" if demo_mode else ""),
                          updated_at=raw.get("updated_at"))

        b = build(b_raw, "BRENT_CRUDE_USD")
        w = build(w_raw, "WTI_USD")
        flag = " [DEMO DATA]" if demo_mode else ""
        print(f"  ✓ brent  via oilpriceapi-demo{flag}: ${b['c']:>8.2f} ({b['dp']:+.2f}%)")
        print(f"  ✓ wti    via oilpriceapi-demo{flag}: ${w['c']:>8.2f} ({w['dp']:+.2f}%)")
        return b, w
    except Exception as e:
        print(f"  oilpriceapi_demo exception: {str(e)[:120]}")
        return None, None


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


SANITY_RANGES = {
    "brent":          (30, 300),   # $/bbl — hard outer bounds
    "wti":            (20, 290),
    "brent_official": (30, 300),
    "wti_official":   (20, 290),
}

def sanity_check(sym, q):
    """Returns True if price is within plausible range."""
    if not q or not isinstance(q.get("c"), (int, float)):
        return False
    lo, hi = SANITY_RANGES.get(sym, (0, 99999))
    if not (lo <= q["c"] <= hi):
        print(f"  SANITY FAIL {sym}: ${q['c']:.2f} outside [{lo}, {hi}] — discarding")
        return False
    return True


def cross_verify(results):
    """Compare live estimate vs official reference. Log divergence > 15%.
    HARD FAIL: if divergence > 50%, remove the live entry entirely (only keep official)."""
    b_live = results.get("brent", {}).get("c")
    b_off  = results.get("brent_official", {}).get("c")
    if b_live and b_off and b_off > 0:
        pct_diff = abs(b_live - b_off) / b_off * 100
        results["brent_divergence_pct"] = round(pct_diff, 2)
        if pct_diff > 50:
            print(f"  HARD FAIL: brent live ${b_live:.2f} vs official ${b_off:.2f} = {pct_diff:.1f}% gap — refusing to write live source")
            results.pop("brent", None)
            results["brent_live_suspect"] = True
        elif pct_diff > 15:
            print(f"  WARN: Brent live ${b_live:.2f} vs official ${b_off:.2f} = {pct_diff:.1f}% gap — possible demo data")
            results["brent_live_suspect"] = True
        else:
            results["brent_live_suspect"] = False

    w_live = results.get("wti", {}).get("c")
    w_off  = results.get("wti_official", {}).get("c")
    if w_live and w_off and w_off > 0:
        pct_diff_w = abs(w_live - w_off) / w_off * 100
        results["wti_divergence_pct"] = round(pct_diff_w, 2)
        if pct_diff_w > 50:
            print(f"  HARD FAIL: wti live ${w_live:.2f} vs official ${w_off:.2f} = {pct_diff_w:.1f}% gap — refusing to write live source")
            results.pop("wti", None)
            results["wti_live_suspect"] = True
        elif pct_diff_w > 15:
            print(f"  WARN: WTI live ${w_live:.2f} vs official ${w_off:.2f} = {pct_diff_w:.1f}% gap — possible demo data")
            results["wti_live_suspect"] = True
        else:
            results["wti_live_suspect"] = False
    return results


def fetch_commodity(name, yahoo_sym, fred_id, eia_sym):
    """Try each source in order. Stooq commodity CSVs (cb.f, cl.f) have been
    broken since 2021 — omitted here. Stooq is still used for equities/ETFs
    via fetch_stock(). Chain: yahoo → fred → eia."""
    for fn_name, fn in [
        ("yahoo", lambda: yahoo_chart(yahoo_sym)),
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


def get_kv(key):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    try:
        r = requests.get(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}"}, timeout=15)
        if r.status_code == 200:
            return json.loads(r.text)
    except Exception:
        pass
    return None


def maybe_snapshot(last_snapshot_ts):
    """Call /api/record if >55 min since last snapshot. FORCE_SNAPSHOT=1 bypasses guard."""
    SNAPSHOT_TOKEN = os.environ.get("SNAPSHOT_TOKEN", "")
    SITE_URL = os.environ.get("SITE_URL", "https://hormuz-watch-7cd.pages.dev")
    if not SNAPSHOT_TOKEN:
        print("  SNAPSHOT_TOKEN not set — skipping D1 snapshot")
        return
    now = int(time.time())
    force = os.environ.get("FORCE_SNAPSHOT") == "1"
    if force:
        print("  FORCE_SNAPSHOT=1 set — bypassing 55-min guard")
    elif last_snapshot_ts and (now - last_snapshot_ts) < 3300:  # 55 min
        print(f"  D1 snapshot: skipping (last was {(now - last_snapshot_ts) // 60}m ago)")
        return
    try:
        r = requests.post(
            SITE_URL + "/api/record",
            headers={"X-Snapshot-Token": SNAPSHOT_TOKEN, "Content-Type": "application/json"},
            json={"source": "gha-oil-cron"},
            timeout=30
        )
        print(f"  D1 snapshot: {'✓' if r.ok else '✗'} HTTP {r.status_code}")
        if r.ok:
            put_kv("last_snapshot_ts", str(now))
    except Exception as e:
        print(f"  D1 snapshot error: {e}")


def main():
    print(f"=== {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    results = {}

    # Read last D1 snapshot timestamp from KV before fetching (need it later)
    try:
        last_snap_raw = get_kv("last_snapshot_ts")
        last_snapshot_ts = int(last_snap_raw) if last_snap_raw else None
    except Exception:
        last_snapshot_ts = None

    # ── LIVE PRICE TRACK ──────────────────────────────────────────────────────
    # Try OilPriceAPI demo first (unauthenticated, 5-min fresh). If it fails,
    # fall back to Yahoo (BZ=F / CL=F futures) → existing chain.
    b_live, w_live = oilpriceapi_demo()

    if b_live and w_live:
        if sanity_check("brent", b_live): results["brent"] = b_live
        else: print("  ✗ brent  live failed sanity check — discarded")
        if sanity_check("wti", w_live):   results["wti"]   = w_live
        else: print("  ✗ wti    live failed sanity check — discarded")
    else:
        print("  oilpriceapi_demo failed — falling back to Yahoo chain")
        brent = fetch_commodity("brent", "BZ=F", None, None)  # skip EIA/FRED — those are official track
        if brent and sanity_check("brent", brent):
            results["brent"] = brent
            print(f"  ✓ brent  via {brent['src']:10s}: ${brent['c']:>8.2f} ({brent['dp']:+.2f}%)")
        else:
            print("  ✗ brent  live track all failed")

        wti = fetch_commodity("wti", "CL=F", None, None)
        if wti and sanity_check("wti", wti):
            results["wti"] = wti
            print(f"  ✓ wti    via {wti['src']:10s}: ${wti['c']:>8.2f} ({wti['dp']:+.2f}%)")
        else:
            print("  ✗ wti    live track all failed")

    # ── OFFICIAL REFERENCE TRACK ──────────────────────────────────────────────
    # Always fetch EIA/FRED daily spot regardless of live track status.
    # These have an explicit publish date — shown in frontend as "EIA spot · as of <date>".
    print("  -- official reference (EIA/FRED daily) --")
    brent_off = eia("RBRTE") or fred("DCOILBRENTEU")
    if brent_off and sanity_check("brent_official", brent_off):
        results["brent_official"] = brent_off
        print(f"  ✓ brent_official via {brent_off['src']:12s}: ${brent_off['c']:>8.2f} (as of {brent_off.get('date','?')})")
    else:
        print("  ✗ brent_official EIA + FRED both failed")

    wti_off = eia("RWTC") or fred("DCOILWTICO")
    if wti_off and sanity_check("wti_official", wti_off):
        results["wti_official"] = wti_off
        print(f"  ✓ wti_official   via {wti_off['src']:12s}: ${wti_off['c']:>8.2f} (as of {wti_off.get('date','?')})")
    else:
        print("  ✗ wti_official   EIA + FRED both failed")

    # ── Cross-verify live vs official Brent ───────────────────────────────────
    results = cross_verify(results)

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
    # KV "latest" shape:
    #   { fetchedAt: unix_seconds, source: "github-actions",
    #     symbols: { brent: {c,pc,d,dp,o,h,l,t,src,updatedAt?}, wti: {...},
    #                brent_official: {c,pc,d,dp,t,src,date}, wti_official: {...},
    #                brent_live_suspect: bool, brent_divergence_pct: float,
    #                wti_live_suspect: bool, wti_divergence_pct: float,
    #                fro: {...}, stng: {...}, ... },
    #   }
    ok = put_kv("latest", body)
    # P8 — surface scrape status so /health can show it without opening the Actions tab
    status_body = json.dumps({
        "fetchedAt": int(time.time()),
        "ok": bool(ok and results),
        "symbolCount": len(results),
        "job": "data-refresh",
    }, separators=(",", ":"))
    try:
        put_kv("scrape_status_oil", status_body)
    except Exception as e:
        print(f"warn: scrape_status_oil write failed: {e}")
    if not ok:
        sys.exit(1)
    print(f"✓ KV write OK ({len(body)}B, {len(results)} symbols)")

    # ── D1 hourly snapshot (GHA-driven, replaces Claude scheduled task) ───────
    maybe_snapshot(last_snapshot_ts)


if __name__ == "__main__":
    main()
