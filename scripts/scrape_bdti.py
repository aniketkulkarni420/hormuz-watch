#!/usr/bin/env python3
"""BDTI 2-source web scraper (Playwright) — cross-verified.

Why this exists:
  - Previous scraper relied on text-pattern parsing of Trading Economics and
    Hellenic Shipping News articles. Both started returning empty for weeks,
    leaving /api/bdti stuck on stale `bdti_latest` (or env-var fallback).
  - This rewrite mirrors scripts/scrape_oil_web.py: independent sources,
    selector-first extraction with regex fallback, median + cross-verify with
    a confidence rating.

Sources (browser-rendered):
  1. Investing.com     — /indices/baltic-dirty-tanker
  2. Macrotrends       — /2519/baltic-dirty-tanker-index-bdti-historical-chart
                          (historical table — newest row first)

  Trading Economics is DROPPED (2026-05-13): the page
  /commodity/baltic-exchange-dirty-tanker-index returns
  "There is no data for this indicator or it is unavailable at the moment"
  and renders a generic commodities fallback table; `#p` then grabs the first
  fallback row (Crude Oil ~101) instead of BDTI. Verified via
  scripts/_discover_te_bdti.py on 2026-05-13. Re-enable only when TE restores
  the dedicated BDTI page (look for non-empty <h1> and `data-symbol="BDTI"`).

Sanity bounds: 100 <= BDTI <= 5000.
Cross-verify:
  - <=5%   spread → high       (2 sources agree closely)
  - 5-15%  spread → medium     (2 sources, modest disagreement)
  - >15%   spread → low        (2 sources, wide disagreement)
  - 1 src         → medium
  - 0 src         → keep existing KV, exit non-zero

Output:
  - POSTs to {SITE_URL}/api/bdti with X-Snapshot-Token (preferred path —
    Pages function writes KV `bdti_latest` and computes wow_pct).
  - Falls back to direct KV write if POST unavailable.
  - Manual admin form at /admin/bdti remains functional regardless.
"""

import os
import sys
import time
import json
import re
import requests

SNAPSHOT_TOKEN = os.environ.get("SNAPSHOT_TOKEN", "")
SITE_URL       = os.environ.get("SITE_URL", "https://hormuz-watch-2.pages.dev")
CF_ACCOUNT_ID  = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN   = os.environ.get("CF_API_TOKEN", "")
KV_NS          = os.environ.get("CF_KV_NAMESPACE_ID", "")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"

BDTI_MIN = 100
BDTI_MAX = 5000


def sanity_ok(v):
    try:
        return v is not None and BDTI_MIN <= float(v) <= BDTI_MAX
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


def fetch_page(p, url, label, wait_selector=None, wait_ms=4000):
    """Open URL in headless chromium. Returns (html, selector_value)."""
    browser = None
    try:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=UA, viewport={"width": 1366, "height": 900}, locale="en-US",
        )
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=35000)
        if wait_selector:
            try:
                page.wait_for_selector(wait_selector, timeout=8000)
            except Exception:
                pass
        page.wait_for_timeout(wait_ms)
        title = page.title()
        html = page.content()
        selector_value = None
        try:
            selector_value = page.evaluate("""() => {
              const sels = [
                '[data-test="instrument-price-last"]',
                'span.commodity-value',
                '[data-symbol="BDTI"]',
                '#p',
                '#last_last',
                'span.historical_data_table_value',
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
        print(f"  [{label}] error: {str(e)[:160]}")
        try:
            if browser:
                browser.close()
        except Exception:
            pass
        return None, None


# ─────────────────── Source 1: Trading Economics ───────────────────
def scrape_trading_economics(p):
    url = "https://tradingeconomics.com/commodity/baltic-exchange-dirty-tanker-index"
    html, sel = fetch_page(p, url, "te", wait_ms=5000)
    if not html:
        return None
    candidates = []
    if sel and sel.get("val"):
        v = _to_float(sel["val"])
        if sanity_ok(v):
            candidates.append(("selector:" + sel["sel"], v))
    for pat in [
        r'id="p"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        r'class="[^"]*commodity-value[^"]*"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        r'data-symbol="[^"]*BDTI[^"]*"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        r'class="te-blue text-right"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        r'(?:Baltic\s*Dirty\s*Tanker|BDTI)[^<]{0,200}?(\d{3,4}(?:\.\d{1,2})?)',
    ]:
        m = re.search(pat, html, re.I)
        if m:
            v = _to_float(m.group(1))
            if sanity_ok(v):
                candidates.append((pat[:40], v))
                break
    if candidates:
        print(f"  TE: {candidates[0][1]} ({candidates[0][0]})")
        return candidates[0][1]
    print("  TE: no value extracted")
    return None


# ─────────────────── Source 2: Investing.com ───────────────────
def scrape_investing(p):
    url = "https://www.investing.com/indices/baltic-dirty-tanker"
    html, sel = fetch_page(p, url, "inv", wait_ms=7000,
                           wait_selector='[data-test="instrument-price-last"]')
    if not html:
        return None
    candidates = []
    if sel and sel.get("val"):
        v = _to_float(sel["val"])
        if sanity_ok(v):
            candidates.append(("selector:" + sel["sel"], v))
    for pat in [
        r'data-test="instrument-price-last"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        r'"last"\s*:\s*"?(\d{3,4}(?:\.\d{1,2})?)"?',
        r'id="last_last"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        r'class="[^"]*last-price[^"]*"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
    ]:
        m = re.search(pat, html, re.I)
        if m:
            v = _to_float(m.group(1))
            if sanity_ok(v):
                candidates.append((pat[:40], v))
                break
    if candidates:
        print(f"  INV: {candidates[0][1]} ({candidates[0][0]})")
        return candidates[0][1]
    print("  INV: no value extracted")
    return None


# ─────────────────── Source 3: Macrotrends ───────────────────
def scrape_macrotrends(p):
    """Macrotrends historical chart page — most recent value at top of table."""
    url = "https://www.macrotrends.net/2519/baltic-dirty-tanker-index-bdti-historical-chart"
    html, sel = fetch_page(p, url, "mt", wait_ms=5000)
    if not html:
        return None
    candidates = []
    if sel and sel.get("val"):
        v = _to_float(sel["val"])
        if sanity_ok(v):
            candidates.append(("selector:" + sel["sel"], v))
    # Macrotrends historical tables typically render row-per-date with the
    # most recent date first. Try to grab the first numeric cell after the
    # first date-like row.
    for pat in [
        r'<span[^>]*class="[^"]*historical_data_table_value[^"]*"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        # date cell followed by value cell — first row
        r'<td[^>]*>\s*\d{4}-\d{2}-\d{2}\s*</td>\s*<td[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        r'<td[^>]*>\s*[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s*</td>\s*<td[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        # JSON blob with "value" or "y" first entry
        r'"y"\s*:\s*(\d{3,4}(?:\.\d{1,2})?)',
        # Headline number near "Baltic Dirty Tanker"
        r'(?:Baltic\s*Dirty\s*Tanker|BDTI)[^<]{0,300}?(\d{3,4}(?:\.\d{1,2})?)',
    ]:
        m = re.search(pat, html, re.I)
        if m:
            v = _to_float(m.group(1))
            if sanity_ok(v):
                candidates.append((pat[:40], v))
                break
    if candidates:
        print(f"  MT: {candidates[0][1]} ({candidates[0][0]})")
        return candidates[0][1]
    print("  MT: no value extracted")
    return None


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
    if spread_pct <= 5.0:
        return median, mn, mx, "high"
    if spread_pct <= 15.0:
        return median, mn, mx, "medium"
    return median, mn, mx, "low"


def kv_put(key, value):
    if not (CF_ACCOUNT_ID and CF_API_TOKEN and KV_NS):
        return False
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
                     data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
                     timeout=30)
    return r.status_code == 200


def post_bdti(payload):
    if not SNAPSHOT_TOKEN:
        print("  SNAPSHOT_TOKEN missing — skipping POST /api/bdti")
        return False
    try:
        r = requests.post(
            f"{SITE_URL}/api/bdti",
            headers={"X-Snapshot-Token": SNAPSHOT_TOKEN, "Content-Type": "application/json"},
            json=payload, timeout=25,
        )
        if r.ok:
            print(f"  POST /api/bdti OK: {r.text[:200]}")
            return True
        print(f"  POST /api/bdti {r.status_code}: {r.text[:240]}")
        return False
    except Exception as e:
        print(f"  POST error: {e}")
        return False


def main():
    dry_run = "--dry-run" in sys.argv
    mode = "DRY RUN" if dry_run else "LIVE"
    print(f"=== BDTI 2-source web scrape [{mode}] at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: playwright not installed")
        return 1

    per_source = {}
    with sync_playwright() as p:
        for fn, key in [
            # (scrape_trading_economics, "trading-economics"),  # disabled 2026-05-13: #p selector returns wrong element
            (scrape_investing,         "investing.com"),
            (scrape_macrotrends,       "macrotrends"),
        ]:
            print(f"\n--- {key} ---")
            try:
                per_source[key] = fn(p)
            except Exception as e:
                print(f"  ! {key} crashed: {str(e)[:200]}")
                per_source[key] = None

    good = [(k, v) for k, v in per_source.items() if sanity_ok(v)]
    median, mn, mx, conf = cross_verify([v for _, v in good])
    sources_used = [k for k, _ in good]

    print(f"\n--- result ---")
    print(f"  per-source: {per_source}")
    print(f"  median={median}  min={mn}  max={mx}  confidence={conf}  sources={sources_used}")

    if median is None:
        print("\n✗ Zero sources succeeded — keeping existing KV (no write)")
        print("  /admin/bdti remains as manual fallback.")
        return 1

    value_rounded = round(median, 1)
    as_of = time.strftime("%Y-%m-%d", time.gmtime())

    if dry_run:
        print(f"\nDRY RUN — would update BDTI={value_rounded} confidence={conf} sources={sources_used}")
        return 0

    payload = {
        "value": value_rounded,
        "source": "web-scrape-2-source",
        "asOf": as_of,
        "confidence": conf,
        "sources": sources_used,
        "min": round(mn, 1) if mn is not None else None,
        "max": round(mx, 1) if mx is not None else None,
    }

    post_ok = post_bdti(payload)
    if not post_ok:
        # Fallback: direct KV write so we don't lose the value
        kv_payload = {
            **payload,
            "ts": int(time.time()),
        }
        kv_ok = kv_put("bdti_latest", json.dumps(kv_payload, separators=(",", ":")))
        print(f"  Fallback KV write: {'OK' if kv_ok else 'FAILED'}")
        if not kv_ok:
            return 1

    print(f"\n✓ Updated BDTI = {value_rounded}  confidence={conf}  sources={sources_used}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
