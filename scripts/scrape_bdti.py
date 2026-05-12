#!/usr/bin/env python3
"""Best-effort weekly BDTI scraper.

BDTI (Baltic Dirty Tanker Index) is published Fridays by the Baltic Exchange.
The official feed is paywalled. This script tries several free public sources:

  1. Hellenic Shipping News — searches for "BDTI" mentions in recent tanker articles
  2. Shipping News (alt domains) — fallback HTML scraping
  3. Investing.com (best-effort, often Cloudflare-blocked)

Strategy: try each, take the first plausible value (BDTI typically 400-2500).
On success: POST to /api/bdti with SNAPSHOT_TOKEN.
On total failure: log warning (watchdog will catch staleness > 9 days).

The /admin/bdti form remains as the reliable manual fallback.
"""

import os
import sys
import re
import time
import json
import requests

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}

SNAPSHOT_TOKEN = os.environ.get("SNAPSHOT_TOKEN", "")
SITE_URL = os.environ.get("SITE_URL", "https://hormuz-watch-7cd.pages.dev")

# BDTI sanity bounds — anything outside this range is almost certainly a misread
BDTI_MIN = 400
BDTI_MAX = 2500


def hellenic_shipping_news():
    """Hellenic Shipping News publishes tanker market updates 2-3x weekly.
    Pattern: 'BDTI ... XXX' or 'Baltic Dirty Tanker Index of XXX' or 'BDTI at XXX'.
    """
    url = "https://www.hellenicshippingnews.com/?s=BDTI"
    try:
        r = requests.get(url, headers=HEADERS, timeout=20)
        if r.status_code != 200:
            print(f"  hsn HTTP {r.status_code}")
            return None
        # Find article links from search results
        article_urls = re.findall(r'<h[23][^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>', r.text)
        # Try most recent 3 results (search is reverse-chronological)
        for art_url in article_urls[:3]:
            try:
                ar = requests.get(art_url, headers=HEADERS, timeout=15)
                if ar.status_code != 200:
                    continue
                # Strip HTML
                text = re.sub(r'<[^>]+>', ' ', ar.text)
                text = re.sub(r'\s+', ' ', text)
                # Look for BDTI value patterns
                patterns = [
                    r'BDTI[)\s,.]+(?:at|of|was|=|stood at|rose to|fell to|reached)?\s*(\d{3,4}(?:\.\d{1,2})?)',
                    r'Baltic Dirty Tanker Index[^0-9]{1,40}(\d{3,4}(?:\.\d{1,2})?)',
                    r'\(BDTI\)\s+(?:at|of|was)?\s*(\d{3,4}(?:\.\d{1,2})?)',
                ]
                for pat in patterns:
                    matches = re.findall(pat, text, flags=re.IGNORECASE)
                    for m in matches:
                        val = float(m)
                        if BDTI_MIN <= val <= BDTI_MAX:
                            print(f"  ✓ hsn matched ${val:.1f} via pattern: {pat[:40]}...")
                            return {"value": val, "source": "hellenic-shipping-news", "url": art_url}
            except Exception as e:
                print(f"  hsn article parse: {str(e)[:80]}")
                continue
        print("  hsn: no BDTI value matched in recent articles")
        return None
    except Exception as e:
        print(f"  hsn exception: {str(e)[:120]}")
        return None


def investing_com():
    """Investing.com page — usually Cloudflare-protected, try anyway."""
    url = "https://www.investing.com/indices/baltic-exchange-dirty-tanker"
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        if r.status_code != 200:
            print(f"  investing HTTP {r.status_code}")
            return None
        # Look for last-price meta or JSON-LD
        match = re.search(r'"last"\s*:\s*"?(\d{3,4}(?:\.\d{1,2})?)', r.text)
        if match:
            val = float(match.group(1))
            if BDTI_MIN <= val <= BDTI_MAX:
                print(f"  ✓ investing matched ${val:.1f}")
                return {"value": val, "source": "investing.com", "url": url}
        return None
    except Exception as e:
        print(f"  investing exception: {str(e)[:80]}")
        return None


def post_bdti(data):
    """POST scraped value to /api/bdti."""
    if not SNAPSHOT_TOKEN:
        print("  SNAPSHOT_TOKEN missing — skipping POST")
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
            },
            timeout=20,
        )
        if r.ok:
            print(f"  ✓ POST /api/bdti: {r.json()}")
            return True
        print(f"  ✗ POST /api/bdti {r.status_code}: {r.text[:200]}")
        return False
    except Exception as e:
        print(f"  POST error: {e}")
        return False


def main():
    print(f"=== BDTI scrape at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    sources = [
        ("hellenic-shipping-news", hellenic_shipping_news),
        ("investing.com",          investing_com),
    ]
    for name, fn in sources:
        print(f"\n--- Trying {name} ---")
        result = fn()
        if result:
            print(f"\n✓ Got BDTI = {result['value']} from {result['source']}")
            ok = post_bdti(result)
            if ok:
                print("✓ Updated successfully")
                return 0
            else:
                print("⚠ POST failed but value was found — continuing to next source")
    print("\n✗ All BDTI sources failed. /admin/bdti remains as manual fallback.")
    print("  Watchdog will alert if BDTI ages past 9 days.")
    return 0  # Don't fail the workflow — manual fallback is expected


if __name__ == "__main__":
    sys.exit(main())
