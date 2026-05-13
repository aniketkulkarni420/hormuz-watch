#!/usr/bin/env python3
"""Public web vessel count scraper for Persian Gulf — fallback for AIS outage.

Strategy: target per-port HTML pages which contain arrivals/departures tables,
rather than the homepage canvas-map (data in JS state, fragile to extract).

Targets:
  MyShipTracking port pages — https://www.myshiptracking.com/ports/<slug>
  VesselFinder port pages   — https://www.vesselfinder.com/ports/<UN_LOCODE>

Gulf ports tracked:
  Fujairah (UAE)         — major bunker port, Hormuz exit
  Khor Fakkan (UAE)      — secondary UAE port
  Jebel Ali (UAE/Dubai)  — global container hub
  Ras Tanura (Saudi)     — Saudi crude export hub
  Bandar Abbas (Iran)    — Iran's main port

Per port: count recent arrivals and recent departures (HTML table rows).
Aggregate = sum across ports = Hormuz-area traffic proxy.

This is best-effort. Sites may block (Cloudflare challenge); when that happens
the scraper records the block and exits cleanly. Composite signals on the
dashboard carry analytical weight without this data.

KV output `vessel_count_scraped`:
  { fetchedAt, totals: { arrivals, departures, all }, perPort: {...},
    perSite: { myshiptracking: {...}, vesselfinder: {...} },
    confidence, sites_succeeded: int }
"""

import os, sys, time, json, random, re
import requests

CF_ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
CF_API_TOKEN  = os.environ["CF_API_TOKEN"]
KV_NS         = os.environ["CF_KV_NAMESPACE_ID"]

# Per-site port URL patterns. MyShipTracking uses port-slug URLs, VesselFinder
# uses UN_LOCODE. These are public discovery URLs — same as opening in browser.
PORTS = [
    # (display_name, mst_slug, vf_locode)
    ("Fujairah",    "fujairah-ae-002",        "AEFJR"),
    ("Khor Fakkan", "khor-fakkan-ae-003",     "AEKLF"),
    ("Jebel Ali",   "jebel-ali-ae-jea",       "AEJEA"),
    ("Ras Tanura",  "ras-tanura-sa-rta",      "SARTA"),
    ("Bandar Abbas","bandar-abbas-ir-bnd",    "IRBND"),
]

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"


def kv_put(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
                     data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
                     timeout=30)
    return r.status_code == 200


def open_browser_page(url, label):
    """Load URL via Playwright. Returns (html, status). status in {ok, blocked, error}."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None, "playwright-missing"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=UA, viewport={"width": 1366, "height": 768}, locale="en-US",
            )
            page = context.new_page()
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(3500)
                title = page.title()
                html = page.content()
                # Try also reading any global JS state that may hold vessel arrays
                # (only used by some extractors below)
                js_state = None
                try:
                    js_state = page.evaluate("""() => {
                        const candidates = ['__INITIAL_STATE__', '__NUXT__', 'app', 'state', 'store', 'vessels', 'vesselsData', 'shipsList'];
                        const out = {};
                        for (const k of candidates) {
                            if (window[k] !== undefined) {
                                try { out[k] = JSON.parse(JSON.stringify(window[k])).slice ? null : null; } catch(e){}
                            }
                        }
                        return Object.keys(out);
                    }""")
                except Exception:
                    pass
                browser.close()
                low = title.lower()
                if any(s in low for s in ["just a moment", "checking your browser", "cloudflare", "attention required"]):
                    return None, "blocked"
                return {"html": html, "title": title, "js_state_keys": js_state}, "ok"
            except Exception as e:
                browser.close()
                return None, f"error: {str(e)[:80]}"
    except Exception as e:
        return None, f"launch: {str(e)[:80]}"


# ─── MyShipTracking port page parsers ─────────────────────────────────────
def parse_mst_port(html):
    """Extract arrivals + departures counts from MyShipTracking port page.
    Their port pages have <table> elements with arrivals/departures rows.
    Pattern: look for table rows containing vessel names + ETA/ATA columns.
    """
    if not html:
        return None
    # MST typically shows tables with class 'table-arrivals' and 'table-departures'
    # or generic <table> with rows containing vessel data
    # Count <tr> rows in main vessel tables, excluding header rows
    arrivals = 0
    departures = 0

    # Heuristic 1: count rows with vessel detail links
    vessel_links = re.findall(r'/vessels/[^"\']+', html)
    unique_vessels = set(vessel_links)

    # Heuristic 2: look for explicit count strings
    m_arr = re.search(r'(\d+)\s*(?:arrivals?|expected\s*arrivals?)', html, re.IGNORECASE)
    if m_arr: arrivals = int(m_arr.group(1))

    m_dep = re.search(r'(\d+)\s*(?:departures?|recent\s*departures?)', html, re.IGNORECASE)
    if m_dep: departures = int(m_dep.group(1))

    total = max(len(unique_vessels), arrivals + departures)
    if total == 0:
        return None
    return {"arrivals": arrivals, "departures": departures, "unique_vessels": len(unique_vessels), "total": total}


def parse_vf_port(html):
    """Extract arrivals + departures from VesselFinder port page."""
    if not html:
        return None
    # VF port pages list "Recent Arrivals" and "Expected Arrivals" tables
    arrivals = 0
    departures = 0

    # Count vessel links
    vessel_links = re.findall(r'/vessels/details/[^"\']+', html)
    unique_vessels = set(vessel_links)

    m_arr = re.search(r'(?:recent|last)\s*arrivals?[^0-9]{0,50}(\d+)', html, re.IGNORECASE)
    if m_arr: arrivals = int(m_arr.group(1))
    m_dep = re.search(r'(?:recent|last)\s*departures?[^0-9]{0,50}(\d+)', html, re.IGNORECASE)
    if m_dep: departures = int(m_dep.group(1))

    total = max(len(unique_vessels), arrivals + departures)
    if total == 0:
        return None
    return {"arrivals": arrivals, "departures": departures, "unique_vessels": len(unique_vessels), "total": total}


def scrape_site(site, ports):
    """Iterate over ports for one site, return per-port results + totals."""
    per_port = {}
    sum_arrivals = 0
    sum_departures = 0
    sum_total = 0
    successful = 0

    for name, mst_slug, vf_locode in ports:
        # Polite delay between ports
        delay = random.uniform(4, 10)
        time.sleep(delay)

        if site == "myshiptracking":
            url = f"https://www.myshiptracking.com/ports/{mst_slug}"
            page, status = open_browser_page(url, f"mst-{name}")
            if status != "ok" or not page:
                per_port[name] = {"status": status, "data": None}
                print(f"  {name}: {status}")
                continue
            data = parse_mst_port(page["html"])
        else:  # vesselfinder
            url = f"https://www.vesselfinder.com/ports/{vf_locode}"
            page, status = open_browser_page(url, f"vf-{name}")
            if status != "ok" or not page:
                per_port[name] = {"status": status, "data": None}
                print(f"  {name}: {status}")
                continue
            data = parse_vf_port(page["html"])

        if data:
            per_port[name] = {"status": "ok", "data": data, "url": url}
            sum_arrivals += data["arrivals"]
            sum_departures += data["departures"]
            sum_total += data["total"]
            successful += 1
            print(f"  ✓ {name}: arrivals={data['arrivals']} departures={data['departures']} total={data['total']}")
        else:
            per_port[name] = {"status": "no-data", "data": None}
            print(f"  {name}: page loaded but no vessel data extracted")

    return {
        "site": site,
        "ports_succeeded": successful,
        "ports_tried": len(ports),
        "totals": {"arrivals": sum_arrivals, "departures": sum_departures, "total": sum_total},
        "perPort": per_port,
    }


def main():
    print(f"=== vessel web scrape at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    print(f"Scraping {len(PORTS)} Gulf ports across 2 sites")

    # Randomize site order each run
    sites = ["myshiptracking", "vesselfinder"]
    random.shuffle(sites)

    per_site = {}
    for site in sites:
        print(f"\n--- {site} ---")
        per_site[site] = scrape_site(site, PORTS)

    # Aggregate across sites — take the max (sites partly overlap; max approximates union)
    total_arrivals = max(s["totals"]["arrivals"] for s in per_site.values())
    total_departures = max(s["totals"]["departures"] for s in per_site.values())
    total_all = max(s["totals"]["total"] for s in per_site.values())
    sites_succeeded = sum(1 for s in per_site.values() if s["ports_succeeded"] > 0)

    confidence = "high" if sites_succeeded == 2 else "medium" if sites_succeeded == 1 else "none"

    result = {
        "fetchedAt": int(time.time()),
        "totals": {"arrivals": total_arrivals, "departures": total_departures, "all": total_all},
        "perSite": per_site,
        "sites_succeeded": sites_succeeded,
        "confidence": confidence,
        "blocked": sites_succeeded == 0,
    }

    ok = kv_put("vessel_count_scraped", json.dumps(result, separators=(",", ":")))
    print(f"\n{'✓' if ok else '✗'} KV write {'OK' if ok else 'FAILED'}")
    print(f"  Aggregate: arrivals={total_arrivals} departures={total_departures} total={total_all} confidence={confidence}")

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    sys.exit(main())
