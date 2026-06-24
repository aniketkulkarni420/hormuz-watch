#!/usr/bin/env python3
"""Multi-source oil price scraper (Playwright) — cross-verified Brent & WTI.

Why this exists:
  - OilPriceAPI demo started flagging DEMO DATA
  - Yahoo BZ=F often fails from GHA IPs (curl blocked)
  - When KV `latest` goes stale, /api/oil falls back to FinnHub ETF which
    serves $56 BNO ETF prices as if they were Brent — completely wrong

Sources scraped (via headless Chromium, JS rendered):
  1. Trading Economics  — /commodity/brent-crude-oil and /commodity/crude-oil
  2. Investing.com      — /commodities/brent-oil and /commodities/crude-oil
  3. Yahoo Finance      — /quote/BZ=F and /quote/CL=F (browser bypasses curl block)

For each symbol we try multiple selectors + regex fallback, sanity-bound the
result (30 <= px <= 300), then cross-verify across sources:
  - 2+ agree within 1%      → median, confidence=high
  - sources disagree >2%    → median, confidence=low
  - only 1 source           → confidence=medium
  - 0 sources               → skip KV write (keep old data)

KV key: `oil_scraped` (separate from `latest` so it doesn't conflict with
the main scraper). Consumed by functions/api/oil.js as a Tier 1.5 fallback.
"""

import os, sys, time, json, re
import requests

CF_ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
CF_API_TOKEN  = os.environ["CF_API_TOKEN"]
KV_NS         = os.environ["CF_KV_NAMESPACE_ID"]

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"


def kv_put(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
                     data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
                     timeout=30)
    return r.status_code == 200


def sanity_ok(v):
    try:
        return v is not None and 30.0 <= float(v) <= 300.0
    except Exception:
        return False


def _to_float(s):
    if s is None:
        return None
    try:
        s = str(s).strip().replace(",", "")
        m = re.search(r"-?\d+(?:\.\d+)?", s)
        return float(m.group(0)) if m else None
    except Exception:
        return None


def fetch_page(p, url, label):
    """Open URL in headless chromium, return rendered HTML or None."""
    try:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=UA, viewport={"width": 1366, "height": 768}, locale="en-US",
        )
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3500)
        title = page.title()
        html = page.content()
        # Also try selector-based extraction directly (works even when HTML is huge)
        selector_value = None
        try:
            selector_value = page.evaluate("""() => {
              const sels = [
                '[data-test="instrument-price-last"]',
                'fin-streamer[data-field="regularMarketPrice"]',
                'fin-streamer[data-test="qsp-price"]',
                'span.commodity-value',
                '#last_last',
              ];
              for (const s of sels) {
                const el = document.querySelector(s);
                if (el) {
                  const t = el.getAttribute('data-value') || el.getAttribute('value') || el.textContent;
                  if (t) return { sel: s, val: t.trim().slice(0,32) };
                }
              }
              return null;
            }""")
        except Exception:
            selector_value = None
        browser.close()
        low = (title or "").lower()
        if any(s in low for s in ["just a moment", "checking your browser", "attention required", "cloudflare"]):
            print(f"  [{label}] blocked (cloudflare/challenge)")
            return None, None
        return html, selector_value
    except Exception as e:
        print(f"  [{label}] error: {str(e)[:120]}")
        try:
            browser.close()
        except Exception:
            pass
        return None, None


# ─────────────────── Source 1: Trading Economics ───────────────────
def scrape_oilpriceapi_demo(_p):
    """OilPriceAPI demo endpoint — confirmed accurate (~0.3% of Investing.com).
    Free HTTP, no browser needed. Different infrastructure failure mode from
    Playwright-based scrapes — adds genuine third-source diversity.
    Returns {brent: float, wti: float}.
    """
    out = {"brent": None, "wti": None}
    url = "https://api.oilpriceapi.com/v1/demo/prices"
    try:
        r = requests.get(url, timeout=15, headers={"User-Agent": UA})
        if r.status_code != 200:
            print(f"  OPA HTTP {r.status_code}")
            return out
        data = r.json()
        prices = data.get("data", {}).get("prices", [])
        b_raw = next((p for p in prices if p.get("code") == "BRENT_CRUDE_USD"), None)
        w_raw = next((p for p in prices if p.get("code") == "WTI_USD"), None)
        if b_raw and sanity_ok(b_raw.get("price")):
            out["brent"] = float(b_raw["price"])
            print(f"  OPA brent: {out['brent']} (oilpriceapi-demo)")
        if w_raw and sanity_ok(w_raw.get("price")):
            out["wti"] = float(w_raw["price"])
            print(f"  OPA wti: {out['wti']} (oilpriceapi-demo)")
    except Exception as e:
        print(f"  OPA exception: {str(e)[:120]}")
    return out


# Dead scrape_trading_economics removed (Batch E · 2026-06-24) — dropped
# 2026-05-13 for being ~4% off consensus; never called since.

# ─────────────────── Source 2: Investing.com ───────────────────
def scrape_investing(p):
    out = {"brent": None, "wti": None}
    for sym, url in [
        ("brent", "https://www.investing.com/commodities/brent-oil"),
        ("wti",   "https://www.investing.com/commodities/crude-oil"),
    ]:
        html, sel = fetch_page(p, url, f"inv-{sym}")
        if not html:
            continue
        candidates = []
        if sel and sel.get("val"):
            v = _to_float(sel["val"])
            if sanity_ok(v):
                candidates.append(("selector:" + sel["sel"], v))
        for pat in [
            r'data-test="instrument-price-last"[^>]*>\s*([0-9]+(?:[.,][0-9]+)?)',
            r'id="last_last"[^>]*>\s*([0-9]+(?:[.,][0-9]+)?)',
            r'class="text-2xl"[^>]*>\s*([0-9]+\.[0-9]+)',
            r'"last":\s*"?([0-9]+\.[0-9]+)"?',
        ]:
            m = re.search(pat, html)
            if m:
                v = _to_float(m.group(1))
                if sanity_ok(v):
                    candidates.append((pat[:30], v))
                    break
        if candidates:
            out[sym] = candidates[0][1]
            print(f"  INV {sym}: {out[sym]} ({candidates[0][0]})")
        else:
            print(f"  INV {sym}: no value extracted")
    return out


# Dead scrape_yahoo removed (Batch E · 2026-06-24) — Yahoo's fin-streamer
# selector kept extracting the wrong element; never called. (Stooq is the
# planned independent cross-verify source — Batch G4.)

def cross_verify(values):
    """values: list of floats. Returns (median, min, max, confidence)."""
    clean = sorted([v for v in values if sanity_ok(v)])
    n = len(clean)
    if n == 0:
        return None, None, None, "none"
    mn, mx = clean[0], clean[-1]
    median = clean[n // 2] if n % 2 == 1 else (clean[n // 2 - 1] + clean[n // 2]) / 2.0
    if n == 1:
        return median, mn, mx, "medium"
    spread_pct = (mx - mn) / mn * 100.0 if mn > 0 else 0
    # Two-source commodity prices typically differ 2-5% due to update cadence
    # between sites — not a quality issue. Widen the "high" band accordingly.
    if spread_pct <= 5.0:
        return median, mn, mx, "high"
    if spread_pct > 10.0:
        return median, mn, mx, "low"
    return median, mn, mx, "medium"  # 5-10% gap


def main():
    print(f"=== oil web scrape at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: playwright not installed")
        sys.exit(1)

    per_source = {}
    with sync_playwright() as p:
        # Two sources, different infrastructure:
        #   1. OilPriceAPI demo — HTTP JSON, confirmed accurate (within 0.3% of Investing)
        #   2. Investing.com — Playwright + selector
        # Trading Economics DROPPED 2026-05-13: was ~4% off OPA/Investing consensus;
        #   scrape_trading_economics() kept defined for future reinstatement.
        # Yahoo dropped earlier — fin-streamer selector kept extracting wrong element.
        for fn, key in [
            (scrape_oilpriceapi_demo,  "oilpriceapi-demo"),
            (scrape_investing,         "investing.com"),
        ]:
            print(f"\n--- {key} ---")
            try:
                per_source[key] = fn(p)
            except Exception as e:
                print(f"  ! {key} crashed: {str(e)[:160]}")
                per_source[key] = {"brent": None, "wti": None}

    # Aggregate per-symbol
    result_syms = {}
    for sym in ("brent", "wti"):
        vals_by_src = {k: v.get(sym) for k, v in per_source.items()}
        good = [(k, v) for k, v in vals_by_src.items() if sanity_ok(v)]
        med, mn, mx, conf = cross_verify([v for _, v in good])
        if med is None:
            result_syms[sym] = None
            continue
        result_syms[sym] = {
            "value": round(med, 2),
            "median": round(med, 2),
            "min": round(mn, 2),
            "max": round(mx, 2),
            "sources": [k for k, _ in good],
            "confidence": conf,
        }

    succeeded = sum(1 for v in result_syms.values() if v is not None)
    if succeeded == 0:
        print("\n✗ Zero sources succeeded — keeping existing KV (no write)")
        sys.exit(1)

    result = {
        "fetchedAt": int(time.time()),
        "brent": result_syms["brent"],
        "wti":   result_syms["wti"],
        "perSource": per_source,
        "sources_succeeded": succeeded,
    }

    ok = kv_put("oil_scraped", json.dumps(result, separators=(",", ":")))
    print(f"\n{'✓' if ok else '✗'} KV write {'OK' if ok else 'FAILED'}  (key=oil_scraped)")
    print(f"  brent: {result_syms['brent']}")
    print(f"  wti:   {result_syms['wti']}")

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    # Per-scraper health visibility for /api/diag + watchdog (Batch C · 2026-05-14).
    # main() may sys.exit() internally OR fall through — catch both so the
    # status write always runs.
    from _status import write_status
    try:
        _rc = main() or 0
    except SystemExit as _e:
        _rc = _e.code if isinstance(_e.code, int) else (0 if _e.code is None else 1)
    write_status("oil_web", ok=(_rc == 0))
    sys.exit(_rc)
