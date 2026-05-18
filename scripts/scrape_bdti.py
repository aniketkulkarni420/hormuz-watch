#!/usr/bin/env python3
"""BDTI scraper — single source: StockQ. Plain HTTP, no browser.

History (2026-05-14):
  - The old multi-source scraper paired investing.com (frozen at 1107 since
    31-Mar) with a loose macrotrends regex (813). Their 36% disagreement
    produced a noise-"median" of 960, which a manual 3063 entry — actually the
    BDI, the wrong index — then diffed against to show a +219% "WoW".
  - StockQ (en.stockq.org/index/BDTI.php) carries a clean, dated, daily BDTI
    quote and is plain HTML — no Playwright needed. Verified against the live
    page on 2026-05-14: 2429.00, asOf 2026-05-13.
  - Per explicit instruction, StockQ is the ONLY source. No cross-verify, no
    browser. If StockQ itself goes stale or unreachable we keep the last good
    KV value and exit non-zero so /api/diag + the watchdog flag it.

Design rules from this session's audit:
  - Propagate StockQ's OWN quote date as `asOf` — never stamp today's date on
    a value whose freshness we have not confirmed.
  - Reject the value if that date is older than MAX_SOURCE_AGE_DAYS — a frozen
    source must never read as "current".
  - Sanity bounds: 100 <= BDTI <= 5000.

Output:
  - POSTs to {SITE_URL}/api/bdti with X-Snapshot-Token (the Pages function
    writes KV `bdti_latest` and computes a history-based wow_pct).
  - Falls back to a direct KV write if the POST is unavailable.
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

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

STOCKQ_URL = "https://en.stockq.org/index/BDTI.php"

BDTI_MIN = 100
BDTI_MAX = 5000
MAX_SOURCE_AGE_DAYS = 5    # BDTI publishes business days; >5d stale = reject (daily cron now)


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


def _mmdd_to_iso(mmdd):
    """'05/13' -> '2026-05-13'. Assumes current year; rolls back a year if that
    would put the date more than 2 days in the future (year-boundary guard)."""
    try:
        mm, dd = mmdd.strip().split("/")[:2]
        mm, dd = int(mm), int(dd)
        now = time.gmtime()
        for yr in (now.tm_year, now.tm_year - 1):
            try:
                t = time.strptime(f"{yr:04d}-{mm:02d}-{dd:02d}", "%Y-%m-%d")
            except ValueError:
                continue
            if time.mktime(t) - time.mktime(now) <= 2 * 86400:
                return f"{yr:04d}-{mm:02d}-{dd:02d}"
        return None
    except Exception:
        return None


def _iso_age_days(iso):
    """Whole days between an ISO date and now (UTC). None if unparseable."""
    try:
        t = time.strptime(iso, "%Y-%m-%d")
        return (time.time() - time.mktime(t)) / 86400.0
    except Exception:
        return None


def scrape_stockq():
    """en.stockq.org/index/BDTI.php — plain HTML. The quote row is uniquely
    anchored by the 'local' header cell immediately before the value:
      ... High Open YTD local <VALUE> <CHANGE> <CHANGE%> - - - <YTD%> <MM/DD>
    Returns (value, asOf_iso, history_list) or (None, None, [])."""
    try:
        r = requests.get(STOCKQ_URL, headers={"User-Agent": UA}, timeout=25)
        if not r.ok:
            print(f"  StockQ: HTTP {r.status_code}")
            return None, None, []
        html = r.text
    except Exception as e:
        print(f"  StockQ: request error {str(e)[:140]}")
        return None, None, []

    if "Baltic Dirty Tanker" not in html:
        print("  StockQ: 'Baltic Dirty Tanker' page marker not found")
        return None, None, []

    # Strip tags across the whole page — the quote table sits well past the
    # title/breadcrumb occurrences of the heading, so window-by-heading is
    # unreliable.
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text)

    m = re.search(
        r"\blocal\s+([\d,]+\.\d{2})\s+-?[\d,]+\.\d{2}\s+-?[\d.]+%"
        r"(?:\s+\S+){3}\s+-?[\d.]+%\s+(\d{1,2}/\d{1,2})",
        text,
    )
    value = date_iso = None
    if m:
        value = _to_float(m.group(1))
        date_iso = _mmdd_to_iso(m.group(2))
    else:
        # Looser fallback: first decimal value after the 'local' header, then
        # the first MM/DD that closely follows it.
        mv = re.search(r"\blocal\s+([\d,]+\.\d{2})", text)
        if mv:
            value = _to_float(mv.group(1))
            md = re.search(r"\b(\d{1,2}/\d{1,2})\b", text[mv.end():mv.end() + 120])
            if md:
                date_iso = _mmdd_to_iso(md.group(1))

    if not sanity_ok(value):
        print(f"  StockQ: no sane value extracted (got {value})")
        return None, None, []

    # Daily history table — StockQ renders ~20 recent rows as
    # "YYYY/MM/DD  VALUE  CHANGE%". Capturing these lets /api/bdti compute a
    # real week-over-week immediately instead of waiting for the bdti_history
    # KV array to accumulate one scrape at a time.
    history = []
    for y, mo, d, hv in re.findall(
        r"(\d{4})/(\d{2})/(\d{2})\s+([\d,]+\.\d{2})\s+-?[\d.]+\s*%", text
    ):
        fv = _to_float(hv)
        if sanity_ok(fv):
            history.append({"asOf": f"{y}-{mo}-{d}", "value": fv})

    print(f"  StockQ: {value}  asOf={date_iso or 'unknown'}  "
          f"(+{len(history)} history rows)")
    return value, date_iso, history


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
    print(f"=== BDTI scrape · StockQ [{mode}] at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")

    value, as_of, history = scrape_stockq()

    if not sanity_ok(value):
        print("\n✗ StockQ returned no usable value — keeping existing KV (no write)")
        print("  /admin/bdti remains as manual fallback.")
        return 1

    # asOf: prefer StockQ's own quote date. Fall back to today ONLY if StockQ
    # somehow served a value without a parseable date.
    if not as_of:
        as_of = time.strftime("%Y-%m-%d", time.gmtime())
        print(f"  ⚠ StockQ value had no parseable date — stamping today ({as_of})")

    # Staleness gate: a frozen source must never read as "current".
    age = _iso_age_days(as_of)
    if age is not None and age > MAX_SOURCE_AGE_DAYS:
        print(f"\n✗ StockQ quote date {as_of} is {age:.0f}d stale (> {MAX_SOURCE_AGE_DAYS}d) "
              f"— refusing to write a stale value as current. Keeping existing KV.")
        return 1

    value_rounded = round(value, 1)

    if dry_run:
        print(f"\nDRY RUN — would update BDTI={value_rounded} asOf={as_of}")
        return 0

    payload = {
        "value": value_rounded,
        "source": "stockq",
        "asOf": as_of,
        # Single trusted source — honest confidence, not over-claimed as "high".
        "confidence": "medium",
        "sources": ["stockq"],
    }
    # Ship StockQ's recent daily series so /api/bdti can compute a real
    # week-over-week immediately (entry closest to 7 days prior).
    if history:
        payload["history"] = history

    post_ok = post_bdti(payload)
    if not post_ok:
        kv_payload = {**payload, "ts": int(time.time())}
        kv_ok = kv_put("bdti_latest", json.dumps(kv_payload, separators=(",", ":")))
        print(f"  Fallback KV write: {'OK' if kv_ok else 'FAILED'}")
        if not kv_ok:
            return 1

    print(f"\n✓ Updated BDTI = {value_rounded}  asOf={as_of}  source=stockq")
    return 0


if __name__ == "__main__":
    # Per-scraper health visibility for /api/diag + watchdog (Batch C · 2026-05-14)
    from _status import write_status
    _rc = main()
    write_status("bdti", ok=(_rc == 0))
    sys.exit(_rc)
