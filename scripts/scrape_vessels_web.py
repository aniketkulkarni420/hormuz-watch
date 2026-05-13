#!/usr/bin/env python3
"""Public web vessel count scraper for Persian Gulf — fallback for AIS outage.

Loads public vessel-tracking map pages via headless Chromium and extracts vessel
counts from the rendered page. Cadence: every 4 hours (6 runs/day).

Sites attempted (in random order each run):
  1. MyShipTracking public area view
  2. VesselFinder public area view

This is best-effort. Sites may block requests (Cloudflare challenge, bot
checks); when that happens the scraper records the block and exits cleanly.
The dashboard's composite-signal mode degrades gracefully without this data.

ToS note: Both sites prohibit automated scraping in their Terms of Use. This
scraper is included because AISStream's free API is in an indefinite outage
and there is no free real-time AIS alternative for the Persian Gulf. Use is
at the operator's discretion and own risk.

KV output `vessel_count_scraped`:
  { fetchedAt, source, count, confidence, bbox_used, blocked }
"""

import os, sys, time, json, random, re
import requests

CF_ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
CF_API_TOKEN  = os.environ["CF_API_TOKEN"]
KV_NS         = os.environ["CF_KV_NAMESPACE_ID"]

BBOX_CENTER_LAT = 26.5
BBOX_CENTER_LNG = 56.5


def kv_put(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
                     data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
                     timeout=30)
    return r.status_code == 200


def load_page(url, label):
    """Open URL in headless Chromium, return rendered HTML or None if blocked."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(f"  playwright not installed — cannot run {label}")
        return None, "playwright-missing"

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
                viewport={"width": 1366, "height": 768},
                locale="en-US",
            )
            page = context.new_page()
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(4000)  # let JS render
                title = page.title()
                content = page.content()
                browser.close()

                # Detect common block/challenge pages
                lower_title = title.lower()
                if any(s in lower_title for s in ["just a moment", "checking your browser", "cloudflare", "attention required"]):
                    return None, "blocked"
                if "<title>captcha" in content.lower():
                    return None, "captcha"

                return content, "ok"
            except Exception as e:
                browser.close()
                return None, f"page-error: {str(e)[:80]}"
    except Exception as e:
        return None, f"launch-error: {str(e)[:80]}"


def try_myshiptracking():
    """MyShipTracking has lighter bot protection historically."""
    lat = BBOX_CENTER_LAT
    lng = BBOX_CENTER_LNG
    url = f"https://www.myshiptracking.com/?searcharea=mideast&lat={lat}&lng={lng}&zoom=8"
    print(f"  url: {url}")
    content, status = load_page(url, "myshiptracking")
    if status != "ok":
        print(f"  result: {status}")
        return {"source": "myshiptracking", "blocked": True, "reason": status, "count": None}

    # Try to find vessel count in the rendered HTML
    patterns = [
        r'(\d+)\s*(?:vessels|ships)\s*(?:in\s*(?:area|view|map))',
        r'"vessels"\s*:\s*(\d+)',
        r'"total"\s*:\s*(\d+)',
    ]
    count = None
    for pat in patterns:
        m = re.search(pat, content, re.IGNORECASE)
        if m:
            n = int(m.group(1))
            if 0 < n < 5000:
                count = n
                break

    if count is None:
        print("  no count pattern matched in rendered page")
        return {"source": "myshiptracking", "blocked": False, "count": None, "reason": "no-pattern-match"}

    print(f"  ✓ extracted {count} vessels")
    return {"source": "myshiptracking", "count": count, "confidence": "medium", "blocked": False}


def try_vesselfinder():
    """VesselFinder is Cloudflare-protected; may fail."""
    lat = BBOX_CENTER_LAT
    lng = BBOX_CENTER_LNG
    url = f"https://www.vesselfinder.com/?lat={lat}&lon={lng}&zoom=8"
    print(f"  url: {url}")
    content, status = load_page(url, "vesselfinder")
    if status != "ok":
        print(f"  result: {status}")
        return {"source": "vesselfinder", "blocked": True, "reason": status, "count": None}

    patterns = [
        r'"total"\s*:\s*(\d+)',
        r'"vessels"\s*:\s*\[((?:[^\[\]]|\[[^\]]*\])*)\]',
    ]
    count = None
    m = re.search(patterns[0], content)
    if m:
        n = int(m.group(1))
        if 0 < n < 5000:
            count = n
    if count is None:
        m2 = re.search(patterns[1], content)
        if m2:
            # crude — count commas between top-level entries
            inner = m2.group(1)
            count = inner.count("},{") + 1 if inner.strip() else 0
            if not (0 < count < 5000):
                count = None

    if count is None:
        return {"source": "vesselfinder", "blocked": False, "count": None, "reason": "no-pattern-match"}

    print(f"  ✓ extracted {count} vessels")
    return {"source": "vesselfinder", "count": count, "confidence": "medium", "blocked": False}


def main():
    print(f"=== vessel web scrape at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    sites = [("myshiptracking", try_myshiptracking), ("vesselfinder", try_vesselfinder)]
    random.shuffle(sites)

    result = None
    for name, fn in sites:
        print(f"\n--- {name} ---")
        # 5–30s polite delay before each attempt
        delay = random.uniform(5, 30)
        print(f"  delay before request: {delay:.1f}s")
        time.sleep(delay)
        try:
            r = fn()
        except Exception as e:
            print(f"  exception: {e}")
            r = {"source": name, "blocked": True, "count": None, "reason": f"exception: {str(e)[:80]}"}
        if r and r.get("count") and not r.get("blocked"):
            result = r
            break

    if not result:
        # Try to surface the last (failed) attempt for diagnostics
        result = r if r else {"source": "all_failed", "count": None, "blocked": True}

    result["fetchedAt"] = int(time.time())
    result["bbox_used"] = [BBOX_CENTER_LAT, BBOX_CENTER_LNG]

    ok = kv_put("vessel_count_scraped", json.dumps(result, separators=(",", ":")))
    if ok:
        print(f"\n✓ KV write OK · count={result.get('count')} · source={result.get('source')} · blocked={result.get('blocked')}")
    else:
        print("\n✗ KV write FAILED")
        sys.exit(1)


if __name__ == "__main__":
    sys.exit(main())
