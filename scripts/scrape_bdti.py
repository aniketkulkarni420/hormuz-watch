#!/usr/bin/env python3
"""Best-effort weekly BDTI scraper — Playwright edition.

BDTI (Baltic Dirty Tanker Index) is published Fridays by the Baltic Exchange.
The official feed is paywalled. All practical free public sources require
browser rendering (Cloudflare challenge or JS-rendered pages), so this script
uses Playwright Chromium.

Source priority:
  1. Trading Economics — https://tradingeconomics.com/commodity/baltic
  2. Hellenic Shipping News — search BDTI, parse most recent tanker article
  3. Investing.com — fallback (heavy page, Cloudflare-protected)

Strategy: try each in order, accept first plausible value (400-5000 — the
current BDTI cycle has run high, e.g. ~3189).

On success: write KV `bdti_latest` (mirrors /api/bdti) AND POST to /api/bdti
if SNAPSHOT_TOKEN + SITE_URL are set.
"""

import os
import sys
import re
import time
import json
import requests

SNAPSHOT_TOKEN = os.environ.get("SNAPSHOT_TOKEN", "")
SITE_URL       = os.environ.get("SITE_URL", "https://hormuz-watch-2.pages.dev")
CF_ACCOUNT_ID  = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN   = os.environ.get("CF_API_TOKEN", "")
KV_NS          = os.environ.get("CF_KV_NAMESPACE_ID", "")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"

# BDTI sanity bounds — anything outside this range is almost certainly a misread.
# Current cycle has run high (~3189 in mid-2025), so 5000 ceiling is generous.
BDTI_MIN = 400
BDTI_MAX = 5000


def open_browser_page(url, wait_ms=4000, wait_selector=None):
    """Load URL via Playwright. Returns (html, title, status). status in {ok, blocked, error}."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None, None, "playwright-missing"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=UA, viewport={"width": 1366, "height": 900}, locale="en-US",
            )
            page = context.new_page()
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=35000)
                if wait_selector:
                    try:
                        page.wait_for_selector(wait_selector, timeout=8000)
                    except Exception:
                        pass
                page.wait_for_timeout(wait_ms)
                title = page.title()
                html = page.content()
                browser.close()
                low = (title or "").lower()
                if any(s in low for s in ["just a moment", "checking your browser", "attention required"]):
                    return html, title, "blocked"
                return html, title, "ok"
            except Exception as e:
                browser.close()
                return None, None, f"error: {str(e)[:120]}"
    except Exception as e:
        return None, None, f"launch: {str(e)[:120]}"


def _strip_html(html):
    text = re.sub(r"<script[^>]*>.*?</script>", " ", html or "", flags=re.S | re.I)
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text)


def _valid(v):
    try:
        n = float(v)
    except Exception:
        return None
    return n if (BDTI_MIN <= n <= BDTI_MAX) else None


def trading_economics():
    """Trading Economics commodity page renders the BDTI headline value in JS."""
    url = "https://tradingeconomics.com/commodity/baltic"
    print(f"  GET {url}")
    html, title, status = open_browser_page(url, wait_ms=5000)
    if status != "ok" or not html:
        print(f"  trading-economics status={status}")
        return None
    # First try structured price markup, then fall back to raw-text patterns.
    structured_patterns = [
        r'class="[^"]*commodity-value[^"]*"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        r'id="p"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        r'data-symbol="[^"]*BDTI[^"]*"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
    ]
    for pat in structured_patterns:
        m = re.search(pat, html, flags=re.I)
        if m:
            v = _valid(m.group(1).replace(",", ""))
            if v is not None:
                snippet = m.group(0)[:120]
                print(f"  trading-economics structured match: {v}")
                return {"value": v, "source": "trading-economics", "url": url, "matched": snippet}

    text = _strip_html(html)
    text_patterns = [
        r"BDTI[^0-9]{0,200}(\d{3,4}(?:\.\d{1,2})?)",
        r"Baltic Dirty Tanker[^0-9]{0,200}(\d{3,4}(?:\.\d{1,2})?)",
        r"Dirty Tanker[^0-9]{0,200}(\d{3,4}(?:\.\d{1,2})?)",
    ]
    for pat in text_patterns:
        for m in re.finditer(pat, text, flags=re.I):
            v = _valid(m.group(1))
            if v is not None:
                snip = text[max(0, m.start() - 30):m.end() + 30]
                print(f"  trading-economics text match: {v} via {pat[:40]}")
                return {"value": v, "source": "trading-economics", "url": url, "matched": snip}
    print("  trading-economics: no BDTI value matched")
    return None


def hellenic_shipping_news():
    """Search HSN, open up to 3 recent tanker articles, parse BDTI."""
    search_url = "https://www.hellenicshippingnews.com/?s=BDTI"
    print(f"  GET {search_url}")
    html, title, status = open_browser_page(search_url, wait_ms=3500)
    if status != "ok" or not html:
        print(f"  hsn search status={status}")
        return None
    article_urls = re.findall(r'<h[23][^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>', html)
    # De-dup while preserving order
    seen = set()
    article_urls = [u for u in article_urls if not (u in seen or seen.add(u))]
    print(f"  hsn found {len(article_urls)} candidate articles")

    text_patterns = [
        r"BDTI[\)\s,.]+(?:at|of|was|=|stood at|rose to|fell to|reached|increased to|decreased to|jumped to|slipped to|edged up to|edged down to)?\s*(\d{3,4}(?:\.\d{1,2})?)",
        r"Baltic Dirty Tanker Index[^0-9]{0,80}(\d{3,4}(?:\.\d{1,2})?)",
        r"\(BDTI\)\s+(?:at|of|was|stood at|reached)?\s*(\d{3,4}(?:\.\d{1,2})?)",
    ]
    for art_url in article_urls[:3]:
        ah, _, astatus = open_browser_page(art_url, wait_ms=2000)
        if astatus != "ok" or not ah:
            print(f"  hsn article {astatus}: {art_url[:80]}")
            continue
        text = _strip_html(ah)
        for pat in text_patterns:
            for m in re.finditer(pat, text, flags=re.I):
                v = _valid(m.group(1))
                if v is not None:
                    snip = text[max(0, m.start() - 30):m.end() + 30]
                    print(f"  hsn matched {v} via {pat[:40]}")
                    return {"value": v, "source": "hellenic-shipping-news", "url": art_url, "matched": snip}
    print("  hsn: no BDTI value matched in recent articles")
    return None


def investing_com():
    """Investing.com BDTI page — heavy & Cloudflare-protected, give it more time."""
    url = "https://www.investing.com/indices/baltic-exchange-dirty-tanker"
    print(f"  GET {url}")
    html, title, status = open_browser_page(url, wait_ms=8000,
                                            wait_selector='[data-test="instrument-price-last"]')
    if status != "ok" or not html:
        print(f"  investing status={status}")
        return None
    patterns = [
        r'data-test="instrument-price-last"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        r'class="[^"]*last-price[^"]*"[^>]*>\s*(\d{3,4}(?:[\.,]\d{1,2})?)',
        r'"last"\s*:\s*"?(\d{3,4}(?:\.\d{1,2})?)',
        r'instrumentPrice[^0-9]{0,40}(\d{3,4}(?:\.\d{1,2})?)',
    ]
    for pat in patterns:
        m = re.search(pat, html, flags=re.I)
        if m:
            v = _valid(m.group(1).replace(",", ""))
            if v is not None:
                snippet = m.group(0)[:120]
                print(f"  investing matched: {v}")
                return {"value": v, "source": "investing.com", "url": url, "matched": snippet}
    print("  investing: no BDTI value matched")
    return None


def kv_put(key, value):
    if not (CF_ACCOUNT_ID and CF_API_TOKEN and KV_NS):
        return False
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
                     data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
                     timeout=30)
    return r.status_code == 200


def post_bdti(data):
    """POST scraped value to /api/bdti (preferred path — Pages function writes KV)."""
    if not SNAPSHOT_TOKEN:
        print("  SNAPSHOT_TOKEN missing — skipping POST /api/bdti")
        return False
    try:
        r = requests.post(
            f"{SITE_URL}/api/bdti",
            headers={
                "X-Snapshot-Token": SNAPSHOT_TOKEN,
                "Content-Type": "application/json",
            },
            json={
                "value": data["value"],
                "source": data["source"],
                "url": data.get("url"),
                "matched": data.get("matched"),
            },
            timeout=20,
        )
        if r.ok:
            print(f"  POST /api/bdti OK: {r.text[:160]}")
            return True
        print(f"  POST /api/bdti {r.status_code}: {r.text[:200]}")
        return False
    except Exception as e:
        print(f"  POST error: {e}")
        return False


def main():
    dry_run = "--dry-run" in sys.argv
    mode = "DRY RUN" if dry_run else "LIVE"
    print(f"=== BDTI scrape [{mode}] at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    sources = [
        ("trading-economics",      trading_economics),
        ("hellenic-shipping-news", hellenic_shipping_news),
        ("investing.com",          investing_com),
    ]
    for name, fn in sources:
        print(f"\n--- Trying {name} ---")
        try:
            result = fn()
        except Exception as e:
            print(f"  {name} crashed: {e}")
            result = None
        if not result:
            continue
        print(f"\nGot BDTI = {result['value']} from {result['source']}")
        if dry_run:
            print(f"DRY RUN — found BDTI from {result['source']}: {result['value']}")
            return 0

        # Direct KV write for traceability (source URL + matched snippet)
        payload = {
            "value": result["value"],
            "source": result["source"],
            "url": result.get("url"),
            "matched": result.get("matched"),
            "ts": int(time.time()),
            "asOf": time.strftime("%Y-%m-%d", time.gmtime()),
        }
        kv_ok = kv_put("bdti_latest", json.dumps(payload, separators=(",", ":")))
        print(f"  KV bdti_latest write: {'OK' if kv_ok else 'SKIPPED/FAILED'}")

        # Also POST to /api/bdti (idempotent — Pages function may overwrite KV)
        post_ok = post_bdti(result)
        if kv_ok or post_ok:
            print("Updated successfully")
            return 0
        print("All update paths failed but value was found")
        return 1

    if dry_run:
        print("\nDRY RUN — no sources returned a value")
        return 1
    print("\nAll BDTI sources failed. /admin/bdti remains as manual fallback.")
    print("  Watchdog will alert if BDTI ages past 9 days.")
    return 0  # Don't fail the workflow — manual fallback is expected


if __name__ == "__main__":
    sys.exit(main())
