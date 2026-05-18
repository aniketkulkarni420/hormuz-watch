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

# Per-site port URL patterns. VesselFinder uses UN_LOCODE.
#
# MyShipTracking ports: DEFERRED 2026-05-13. MST uses /ports/port-of-NAME-in-CC-COUNTRY-id-NNN
# URLs whose numeric IDs are not exposed by any public search endpoint we could find
# (autocomplete/searchresult endpoints 404 from script context; `?searchresult=` query
# string is silently ignored and returns the alphabetical first page; country filters
# don't paginate). Slug guesses without IDs 404. Until IDs are sourced (manual via
# browser network tab, or a paid MST API key), MST is left in PORTS as best-effort and
# expected to return "no-data"/blocked — VesselFinder is the working source.
PORTS = [
    # (display_name, mst_slug_GUESS, vf_locode)
    ("Fujairah",    "port-of-fujairah-in-ae-united-arab-emirates",       "AEFJR"),
    ("Khor Fakkan", "port-of-khor-fakkan-in-ae-united-arab-emirates",    "AEKLF"),
    ("Jebel Ali",   "port-of-jebel-ali-in-ae-united-arab-emirates",      "AEJEA"),
    ("Ras Tanura",  "port-of-ras-tanura-in-sa-saudi-arabia",             "SARTA"),
    ("Bandar Abbas","port-of-bandar-abbas-in-ir-iran",                   "IRBND"),
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


VESSEL_TYPE_BUCKETS = {
    "Tanker":         re.compile(r"(?:crude\s*oil\s*tanker|oil\s*products?\s*tanker|chemical\s*tanker|lng\s*tanker|lpg\s*tanker|tanker|oil\/chem|prod\.?\s*tanker|crude/oil)", re.I),
    "Bulk Carrier":   re.compile(r"(?:bulk\s*carrier|bulker|ore\s*carrier|self\s*discharging\s*bulk)", re.I),
    "Container Ship": re.compile(r"(?:container\s*ship|container)", re.I),
    "Cargo":          re.compile(r"(?:general\s*cargo|cargo\s*ship|ro-?ro|vehicles?\s*carrier|car\s*carrier|reefer|refrigerated|deck\s*cargo)", re.I),
    "Passenger":      re.compile(r"(?:passenger|cruise|ferry)", re.I),
    "Offshore/Service": re.compile(r"(?:offshore|supply|tug|fishing|patrol|research|sar|crew\s*boat|anchor\s*handling|pilot)", re.I),
}


def _classify_type(raw):
    """Map a raw vessel-type string to a top-level bucket."""
    if not raw:
        return "Other"
    s = raw.strip()
    for bucket, pat in VESSEL_TYPE_BUCKETS.items():
        if pat.search(s):
            return bucket
    return "Other"


def parse_vf_port(html):
    """Extract arrivals + departures + vessel types from VesselFinder port page.

    VF port pages render two main tables: 'Arrivals (last 24h)' and
    'Departures (last 24h)' plus 'Expected Arrivals'. Each row carries a
    vessel-type column. We pull rows from each table separately and count
    types across all rows.
    """
    if not html:
        return None

    types = {}

    def bump(bucket):
        types[bucket] = types.get(bucket, 0) + 1

    # Vessel link counter (deduped) — keeps the legacy `unique_vessels` field meaningful.
    vessel_links = re.findall(r'/vessels/details/[^"\']+', html)
    unique_vessels = set(vessel_links)

    # ---- Section splitter ----
    # VesselFinder labels sections with h2/h3 (and sometimes a div header). Split
    # the document into named segments so we can attribute rows to arrivals vs
    # departures vs expected.
    # Section detection (2026-05-18 — VesselFinder restructured tabs).
    # Modern VF uses tab labels like `>Arrivals` / `>Departures` / `>Expected`
    # / `>In Port` plus legacy "arrivals (last 24h)" / "recent arrivals".
    # Match either form so we don't miss segments and silently fall back to
    # the no-section path (which fills `types` but leaves arrivals/dep at 0).
    section_pat = re.compile(
        r"(?:"
        r"arrivals?\s*\(?\s*last\s*24h?\s*\)?"          # "arrivals (last 24h)"
        r"|recent\s*arrivals?"                            # "recent arrivals"
        r"|departures?\s*\(?\s*last\s*24h?\s*\)?"        # "departures (last 24h)"
        r"|recent\s*departures?"                          # "recent departures"
        r"|expected\s*arrivals?"                          # "expected arrivals"
        r"|in\s*port"                                     # "in port"
        r"|>\s*(?P<tab>Arrivals|Departures|Expected|In\s*Port)\s*<"  # modern tab labels
        r")",
        re.I,
    )
    cursor = 0
    segments = []
    for m in section_pat.finditer(html):
        if segments:
            segments[-1] = (segments[-1][0], html[segments[-1][1]:m.start()])
        label = m.group(0).lower()  # full match — covers both legacy + tab forms
        if "departure" in label:
            tag = "departures"
        elif "expected" in label:
            tag = "expected"
        elif "in port" in label:
            tag = "inport"
        else:
            tag = "arrivals"
        segments.append((tag, m.end()))
    # Close last segment
    if segments and isinstance(segments[-1][1], int):
        segments[-1] = (segments[-1][0], html[segments[-1][1]:])

    counts = {"arrivals": 0, "departures": 0, "expected": 0, "inport": 0}

    # ---- Row extractor: split on <tr opens. ----
    # 2026-05-18: VF's table HTML has open <tr> tags without explicit </tr>
    # closes (implicit-close, valid HTML5). Old `<tr>...</tr>` greedy match
    # found only 4 rows out of 24 on Bandar Abbas. Strategy: split on `<tr`
    # opens, each chunk up to the next `<tr` is the row body.
    def _iter_rows(text):
        opens = [m.start() for m in re.finditer(r'<tr\b', text, re.I)]
        for i, start in enumerate(opens):
            end = opens[i+1] if i+1 < len(opens) else len(text)
            yield text[start:end]
    # Shim so the rest of this function can keep using rm.group("row") API.
    class _RowMatch:
        def __init__(self, s): self._s = s
        def group(self, k): return self._s
    row_pat = type("P", (), {"finditer": staticmethod(lambda body: (_RowMatch(s) for s in _iter_rows(body)))})()
    # Common VF type cell patterns (class names have changed over time)
    type_cell_pats = [
        re.compile(r'<td[^>]*class="[^"]*(?:aiv-vty|vty|vessel-type|type-col)[^"]*"[^>]*>\s*([^<]+?)\s*<', re.I),
        re.compile(r'<td[^>]*data-type="([^"]+)"', re.I),
        re.compile(r'<span[^>]*class="[^"]*(?:vty|vessel-type)[^"]*"[^>]*>\s*([^<]+?)\s*<', re.I),
    ]

    def extract_row_type(row_html):
        for pat in type_cell_pats:
            m = pat.search(row_html)
            if m:
                return m.group(1).strip()
        # Fallback: look for keyword in the row text
        text = re.sub(r"<[^>]+>", " ", row_html)
        text = re.sub(r"\s+", " ", text)
        for bucket, pat in VESSEL_TYPE_BUCKETS.items():
            if pat.search(text):
                return bucket
        return None

    # Type counts must be deduplicated per UNIQUE vessel — otherwise a vessel
    # that appears in both 'arrivals' and 'departures' (or expected/inport)
    # gets counted twice in `types`, which is why types-sum diverged from
    # the headline vessel total (185 vs 148). One vessel = one type, total. (2026-05-15)
    seen_typed = set()
    vessel_row_pat = re.compile(r'/vessels/details/([^"\']+)', re.I)
    counted_in_section = False
    for tag, body in segments:
        if not isinstance(body, str):
            continue
        section_rows = 0
        for rm in row_pat.finditer(body):
            row = rm.group("row")
            if "/vessels/details/" not in row and "/vessels/" not in row:
                continue
            section_rows += 1
            counted_in_section = True
            vmatch = vessel_row_pat.search(row)
            vkey = vmatch.group(1) if vmatch else None
            # If we already counted this vessel's type in another section, skip.
            if vkey and vkey in seen_typed:
                continue
            if vkey:
                seen_typed.add(vkey)
            raw_type = extract_row_type(row)
            bump(_classify_type(raw_type))
        if tag in counts:
            counts[tag] += section_rows

    # Fallback if section labels missed: count all vessel-link rows once each.
    if not counted_in_section:
        for rm in row_pat.finditer(html):
            row = rm.group("row")
            if "/vessels/details/" not in row:
                continue
            vmatch = vessel_row_pat.search(row)
            vkey = vmatch.group(1) if vmatch else None
            if vkey and vkey in seen_typed:
                continue
            if vkey:
                seen_typed.add(vkey)
            raw_type = extract_row_type(row)
            bump(_classify_type(raw_type))

    # Heuristic explicit-count fallbacks (still useful when tables didn't parse)
    if counts["arrivals"] == 0:
        m_arr = re.search(r'(?:recent|last)\s*arrivals?[^0-9]{0,50}(\d+)', html, re.I)
        if m_arr:
            counts["arrivals"] = int(m_arr.group(1))
    if counts["departures"] == 0:
        m_dep = re.search(r'(?:recent|last)\s*departures?[^0-9]{0,50}(\d+)', html, re.I)
        if m_dep:
            counts["departures"] = int(m_dep.group(1))
    if counts["expected"] == 0:
        m_exp = re.search(r'expected\s*arrivals?[^0-9]{0,50}(\d+)', html, re.I)
        if m_exp:
            counts["expected"] = int(m_exp.group(1))

    # Headline `total` must match sum(types). `unique_vessels` is the de-duped
    # vessel-link set — same dedup basis as `types` (one type per vessel).
    # Fall back to arrivals+departures only when no vessel links parsed (e.g.
    # the page rendered just text counts). The old `max(unique, arr+dep)`
    # could exceed unique_vessels when a vessel was listed in both sections,
    # producing the headline-vs-types-sum drift (148 vs 185). (2026-05-15)
    total = len(unique_vessels) or (counts["arrivals"] + counts["departures"])
    if total == 0 and sum(types.values()) == 0:
        return None

    return {
        "arrivals":       counts["arrivals"],
        "departures":     counts["departures"],
        "expected_24h":   counts["expected"],
        # In-port count = unique vessels visible on the static page. The
        # arrivals/departures/expected tabs are JS-loaded by VF and not in
        # the static HTML, so they typically return 0 here. (2026-05-18)
        "inport":         counts["inport"],
        "unique_vessels": len(unique_vessels),
        "total":          total,
        "types":          types,
    }


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

    # ---- Roll up vessel types across all ports of the richest site ----
    # Prefer vesselfinder (the parser that emits types). Sum types across ports.
    by_type = {}
    expected_24h_total = 0
    vf = per_site.get("vesselfinder")
    if vf:
        for port_name, info in vf.get("perPort", {}).items():
            data = info.get("data") if isinstance(info, dict) else None
            if not data:
                continue
            for k, v in (data.get("types") or {}).items():
                by_type[k] = by_type.get(k, 0) + int(v or 0)
            expected_24h_total += int(data.get("expected_24h") or 0)

    # Reconcile headline total with sum(byType) — both must agree, otherwise the
    # dashboard shows "148 vessels · types sum 185" and readers lose trust.
    # Per-port dedup is in place (one vessel = one type), but `total_all` uses
    # max(unique_vessels per port) while `by_type` sums per-port types. They
    # diverge by rows where the vessel-link parse failed (no vkey → not added
    # to unique_vessels but type still bumped). Anchor public total to sum(types)
    # whenever type data is available; fall back to total_all otherwise.
    # (Phase-2 fix, 2026-05-17 — see /audit "types sum vs total" row.)
    types_sum = sum(by_type.values()) if by_type else 0
    reconciled_total = types_sum if types_sum > 0 else total_all

    result = {
        "fetchedAt": int(time.time()),
        "totals": {
            "arrivals": total_arrivals,
            "departures": total_departures,
            "all": reconciled_total,
            "all_legacy_max": total_all,    # kept for audit; not used by UI
            "expected_24h": expected_24h_total,
        },
        "byType": by_type,
        "perSite": per_site,
        "sites_succeeded": sites_succeeded,
        "confidence": confidence,
        "blocked": sites_succeeded == 0,
    }

    ok = kv_put("vessel_count_scraped", json.dumps(result, separators=(",", ":")))
    print(f"\n{'✓' if ok else '✗'} KV write {'OK' if ok else 'FAILED'}")
    print(f"  Aggregate: arrivals={total_arrivals} departures={total_departures} total={reconciled_total} (types_sum={types_sum} legacy_max={total_all}) confidence={confidence}")

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
    write_status("vessels_web", ok=(_rc == 0))
    sys.exit(_rc)
