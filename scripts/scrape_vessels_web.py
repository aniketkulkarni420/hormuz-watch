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
    ("Khark Island","port-of-khark-island-in-ir-iran",                   "IRKHK"),  # Iran's main crude export terminal
    # 2026-05-29 hardening — added 3 strait-proximate ports for coverage +
    # resilience. With the anomaly guard below, a wrong/404 LOCODE just adds 0
    # and won't drag the total down (the guard rejects a sudden drop). More
    # ports = the total survives any single port page breaking.
    ("Khasab",      "port-of-khasab-in-om-oman",                         "OMKHS"),  # inside the strait
    ("Sohar",       "port-of-sohar-in-om-oman",                          "OMSOH"),
    ("Sharjah",     "port-of-sharjah-in-ae-united-arab-emirates",        "AESHJ"),
]

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"


def kv_put(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
                     data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
                     timeout=30)
    return r.status_code == 200


def kv_get(key):
    """Read a KV value (for last-good comparison). Returns dict/None."""
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    try:
        r = requests.get(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}"}, timeout=15)
        if r.status_code == 200:
            return json.loads(r.text)
    except Exception:
        pass
    return None


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
    "Offshore/Service": re.compile(r"(?:offshore|supply|tug|fishing|patrol|research|sar|crew\s*boat|anchor\s*handling|pilot|landing\s*craft|hopper|dredger|dredg)", re.I),
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
    """Extract in-port / arrivals / expected counts + a vessel-type sample.

    REWRITTEN 2026-05-29 — VesselFinder migrated to JS-rendered tables whose
    rows no longer carry `/vessels/details/` links (vessel names are paywalled
    behind a "Basic/Premium" lock icon). The old link-based parser silently
    returned 0 rows on the new markup. Two robust signals survive the redesign:

      1. AUTHORITATIVE COUNTS in the page text/meta, independent of row markup:
           "Ships in port: 59"
           "26 vessels have arrived within the past 24 hours and 2 ships are
            expected to arrive"
         These are the true totals (the rendered tables only sample ~10 rows).

      2. TYPE COMPOSITION from the rendered rows: each row has
           <div class="named-subtitle">Chemical/Oil Products Tanker</div>
         inside <table class="...ships-in-range...">, with the section
         identifiable by its <th> headers (Arrival / Departure / Last report /
         ETA). NOTE: this is a SAMPLE (<=~10 rows/section), not the full port —
         flagged via `types_sampled` so downstream can scale, not mislead.

    Falls back to the legacy `/vessels/details/` link parser if the new
    `ships-in-range` tables are absent (so we degrade gracefully either way).
    """
    if not html:
        return None

    txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))

    def _num(pat):
        m = re.search(pat, txt, re.I)
        return int(m.group(1)) if m else None

    # ── (1) Authoritative counts from page text ──────────────────────────────
    inport_auth   = _num(r"Ships in port:\s*(\d+)")
    arrivals_auth = _num(r"(\d+)\s+vessels?\s+have\s+arrived\s+within\s+the\s+past\s+24\s+hours")
    expected_auth = _num(r"(\d+)\s+ships?\s+are\s+expected\s+to\s+arrive")

    # ── (2) Type composition from rendered rows (sample) ─────────────────────
    types = {}
    def bump(b): types[b] = types.get(b, 0) + 1

    def _section_of(thtml):
        heads = " | ".join(
            re.sub("<[^>]+>", " ", h).lower()
            for h in re.findall(r"<th[^>]*>(.*?)</th>", thtml, re.S | re.I)
        )
        if "departure" in heads:                     return "departures"
        if "arrival" in heads:                       return "arrivals"
        if "last report" in heads:                   return "inport"
        if "eta" in heads or "time to go" in heads:  return "expected"
        return None

    SUB = re.compile(r'class="named-subtitle"[^>]*>\s*([^<]+?)\s*<', re.I)
    tables = re.findall(
        r'<table[^>]*class="[^"]*ships-in-range[^"]*"[^>]*>(.*?)</table>',
        html, re.S | re.I,
    )
    section_rows = {"arrivals": 0, "departures": 0, "expected": 0, "inport": 0}
    inport_sample_types = []
    for t in tables:
        sec = _section_of(t)
        tb = re.search(r"<tbody[^>]*>(.*?)</tbody>", t, re.S | re.I)
        body = tb.group(1) if tb else t
        subs = SUB.findall(body)
        if sec:
            section_rows[sec] = max(section_rows[sec], len(subs))
        if sec == "inport":
            inport_sample_types = subs
    # Prefer the in-port table for composition; fall back to whatever rows exist.
    sample = inport_sample_types or SUB.findall(html)
    for raw in sample:
        bump(_classify_type(raw))
    types_sampled = bool(tables)

    # ── Resolve counts: authoritative text wins; row counts are the floor ────
    inport     = inport_auth   if inport_auth   is not None else section_rows["inport"]
    arrivals   = arrivals_auth if arrivals_auth is not None else section_rows["arrivals"]
    expected   = expected_auth if expected_auth is not None else section_rows["expected"]
    departures = section_rows["departures"]   # no text statement; row floor (<=~10)

    total = inport or arrivals or 0

    # ── Legacy fallback: pre-2026-05-29 linked-row markup ────────────────────
    if total == 0 and not tables:
        unique_vessels = set(re.findall(r"/vessels/details/[^\"']+", html))
        if unique_vessels:
            for rm in re.finditer(r"<tr\b(.*?)(?=<tr\b|$)", html, re.S | re.I):
                row = rm.group(0)
                if "/vessels/details/" not in row:
                    continue
                text = re.sub(r"\s+", " ", re.sub("<[^>]+>", " ", row))
                bump(_classify_type(text))
            total = len(unique_vessels)
            types_sampled = False

    if total == 0 and sum(types.values()) == 0:
        return None

    return {
        "arrivals":       arrivals,
        "departures":     departures,
        "expected_24h":   expected,
        "inport":         inport,
        "unique_vessels": inport,          # legacy field name kept for callers
        "total":          total,           # authoritative in-port count
        "types":          types,           # composition SAMPLE (see types_sampled)
        "types_sampled":  types_sampled,
        "types_sample_n": sum(types.values()),
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
    # 2026-05-29 REWORK: in-port `total` is now the authoritative page-text
    # count ("Ships in port: N") summed across ports. `byType` is only a
    # ~10-row-per-port SAMPLE, so we must NOT anchor the headline to sum(types)
    # anymore (that would shrink the real total to the sample size — the old
    # bug in reverse). Headline = authoritative total; types power a SCALED
    # composition estimate instead.
    types_sum = sum(by_type.values()) if by_type else 0
    reconciled_total = total_all

    # Scaled tanker estimate: apply the sampled tanker share to the authoritative
    # total. Honest approximation, flagged `_est` — the sample (in-port rows) is
    # assumed roughly representative. Better than reporting the raw sample (which
    # would read e.g. "4 tankers" against 200 vessels in port).
    tanker_share = (by_type.get("Tanker", 0) / types_sum) if types_sum else None
    tanker_estimate = round(reconciled_total * tanker_share) if tanker_share is not None else None

    result = {
        "fetchedAt": int(time.time()),
        "totals": {
            "arrivals": total_arrivals,      # authoritative 24h arrivals (flow proxy)
            "departures": total_departures,  # row floor (<=~10/port), not authoritative
            "all": reconciled_total,         # authoritative in-port count
            "all_legacy_max": total_all,
            "expected_24h": expected_24h_total,
        },
        "byType": by_type,                   # SAMPLE composition (see byType_sampled)
        "byType_sampled": True,
        "byType_sample_n": types_sum,
        "tanker_estimate": tanker_estimate,  # scaled to authoritative total
        "perSite": per_site,
        "sites_succeeded": sites_succeeded,
        "confidence": confidence,
        "blocked": sites_succeeded == 0,
    }

    # ── HARDENING (2026-05-29): don't overwrite a good total with a degraded
    # one. Three guards, in order:
    #   1. bounds — total must be 0-500 (catches parse garbage)
    #   2. min-source — if NO site succeeded, never write (keep last-good)
    #   3. anomaly — if the new total dropped >40% vs the last good value, a
    #      port page likely broke (added 0) rather than traffic actually
    #      collapsing. Keep last-good instead of showing a false drop.
    prev = kv_get("vessel_count_scraped") or {}
    prev_total = (prev.get("totals") or {}).get("all")
    reject = None
    try:
        from _validate import in_bounds, anomaly_ok
        if not in_bounds("vessel_total", reconciled_total):
            reject = f"total {reconciled_total} out of bounds 0-500"
        elif sites_succeeded == 0:
            reject = "no site succeeded"
        elif prev_total and reconciled_total < prev_total and not anomaly_ok(prev_total, reconciled_total, max_pct=40):
            # Guard DROPS only (a port page breaking → adds 0). A RISE is allowed:
            # it's either real traffic or the 2026-05-29 parser fix stepping the
            # baseline up to authoritative counts. (Was symmetric — would have
            # rejected the methodology step-up and frozen the stale undercount.)
            reject = f"total dropped >40% ({prev_total} -> {reconciled_total}) — likely a broken port, not real"
    except Exception as e:
        print(f"  warn: vessel validation skipped: {e}")

    if reject:
        print(f"\n✗ Rejecting write: {reject}")
        print(f"  Keeping last-good vessel total ({prev_total}). Integrity ledger flags if persistent.")
        return

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
