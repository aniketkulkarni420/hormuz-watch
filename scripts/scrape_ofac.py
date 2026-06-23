#!/usr/bin/env python3
"""OFAC Recent Actions scraper — Iran/tanker/Hormuz sanctions activity.

Source: https://ofac.treasury.gov/recent-actions  (HTML, no RSS — feed 404s).
Each <a href="/recent-actions/YYYYMMDD">Title</a> = one action; date is in the URL.

We keep only actions whose title mentions Iran-tanker keywords.
KV key: `ofac_state`
  {
    fetchedAt: unix_seconds,
    iran_related_actions_30d: int,
    recent_actions: [{date, title, url}],     # most recent 10 Iran-related
    latest_action_date: "YYYY-MM-DD",
    total_actions_30d: int,
  }
"""
import os, sys, time, json, re
import requests
from datetime import datetime, timezone, timedelta

CF_ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
CF_API_TOKEN  = os.environ["CF_API_TOKEN"]
KV_NS         = os.environ["CF_KV_NAMESPACE_ID"]

OFAC_URL = "https://ofac.treasury.gov/recent-actions"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"

IRAN_KEYWORDS = re.compile(
    r"\b(iran|iranian|hormuz|tanker|vessel|irgc|irgcn|nioc|nitc|"
    r"oil\s*export|sanctions?\s*evasion|shadow\s*fleet|dark\s*fleet)\b",
    re.I,
)

ACTION_LINK_RE = re.compile(
    r'<a\s+href="(/recent-actions/(\d{8}))"[^>]*>([^<]+)</a>',
    re.I,
)

# Direction (2026-06-23): an OFAC "action" can be a DESIGNATION (escalatory —
# new sanctions/SDN listings) or a WAIVER/relief/delisting (de-escalatory). The
# old code lumped both into one count, so a wave of sanctions WAIVERS scored as
# rising sanctions PRESSURE — inverting the signal during a thaw. Classify each.
WAIVER_KEYWORDS = re.compile(
    r"\b(waiver|waive[ds]?|delist|de-list|removed?\s+from\s+the\s+sdn|"
    r"relief|authoriz\w*\s+(?:transactions?|activit)|general\s+licen[cs]e|"
    r"unblock\w*|lifted?|easing|rescind\w*|terminat\w*\s+sanctions?)\b",
    re.I,
)


def kv_put(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(
        url,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
        data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
        timeout=30,
    )
    return r.status_code == 200


def parse_date(yyyymmdd):
    try:
        return datetime.strptime(yyyymmdd, "%Y%m%d").replace(tzinfo=timezone.utc)
    except Exception:
        return None


from _status import write_status


def main():
    print(f"=== OFAC scrape at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    try:
        r = requests.get(OFAC_URL, headers={"User-Agent": UA}, timeout=30)
    except Exception as e:
        print(f"ERROR fetching OFAC: {e}")
        return 1
    if r.status_code != 200:
        print(f"ERROR HTTP {r.status_code}")
        return 1

    html = r.text
    matches = ACTION_LINK_RE.findall(html)
    print(f"  found {len(matches)} action links")

    # Floor check (Batch C · 2026-05-14): OFAC's recent-actions page always
    # lists *some* actions. Zero matches means the page markup changed and the
    # regex broke — NOT "no sanctions activity". Don't overwrite KV with a
    # 0-count payload (the verdict's OFAC trigger would then never fire).
    if not matches:
        print("  ✗ 0 action links parsed — page structure likely changed; preserving previous KV")
        write_status("ofac", ok=False, reason="zero_matches_regex_broke")
        return 1

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=30)

    all_actions = []
    iran_actions = []
    for href, yyyymmdd, title in matches:
        d = parse_date(yyyymmdd)
        if not d:
            continue
        is_waiver = bool(WAIVER_KEYWORDS.search(title))
        action = {
            "date": d.strftime("%Y-%m-%d"),
            "title": title.strip(),
            "url": f"https://ofac.treasury.gov{href}",
            "direction": "waiver" if is_waiver else "designation",
            "_dt": d,
        }
        all_actions.append(action)
        if IRAN_KEYWORDS.search(title):
            iran_actions.append(action)

    # Dedupe by URL (the page lists actions in sub-sections; some repeat)
    seen = set()
    iran_dedup = []
    for a in iran_actions:
        if a["url"] in seen:
            continue
        seen.add(a["url"])
        iran_dedup.append(a)
    iran_dedup.sort(key=lambda x: x["_dt"], reverse=True)

    actions_30d = [a for a in all_actions if a["_dt"] >= cutoff]
    iran_30d = [a for a in iran_dedup if a["_dt"] >= cutoff]

    # Split Iran 30d actions by direction (2026-06-23).
    iran_designations_30d = [a for a in iran_30d if a["direction"] == "designation"]
    iran_waivers_30d = [a for a in iran_30d if a["direction"] == "waiver"]
    # Latest DESIGNATION specifically — the verdict's 48h escalation trigger
    # must fire on a new designation, NOT on a waiver (a waiver is de-escalation).
    latest_designation = next((a for a in iran_dedup if a["direction"] == "designation"), None)

    latest_iran = iran_dedup[0] if iran_dedup else None

    print(f"  total actions parsed: {len(all_actions)}  (30d: {len(actions_30d)})")
    print(f"  iran-related 30d: {len(iran_30d)}  "
          f"(designations: {len(iran_designations_30d)} · waivers: {len(iran_waivers_30d)})")
    if latest_iran:
        print(f"  latest iran action: {latest_iran['date']} [{latest_iran['direction']}] — {latest_iran['title'][:70]}")

    payload = {
        "fetchedAt": int(time.time()),
        # Kept for back-compat (total Iran actions). NOTE: this counts BOTH
        # designations and waivers — consumers wanting escalation pressure
        # should use iran_designations_30d (net of waivers).
        "iran_related_actions_30d": len(iran_30d),
        # Direction-split (2026-06-23) — the fields the verdict now uses.
        "iran_designations_30d": len(iran_designations_30d),
        "iran_waivers_30d": len(iran_waivers_30d),
        "iran_net_designations_30d": len(iran_designations_30d) - len(iran_waivers_30d),
        "total_actions_30d": len(actions_30d),
        "recent_actions": [
            {"date": a["date"], "title": a["title"], "url": a["url"], "direction": a["direction"]}
            for a in iran_dedup[:10]
        ],
        # latest_action_date kept = latest of ANY direction (for the timeline card);
        # latest_designation_date drives the verdict's escalation trigger.
        "latest_action_date": latest_iran["date"] if latest_iran else None,
        "latest_designation_date": latest_designation["date"] if latest_designation else None,
        "source": "ofac.treasury.gov/recent-actions",
    }
    ok = kv_put("ofac_state", json.dumps(payload, separators=(",", ":")))
    print(f"  KV write: {'OK' if ok else 'FAILED'}")
    write_status("ofac", ok=ok, iran_30d=len(iran_30d),
                 designations=len(iran_designations_30d), waivers=len(iran_waivers_30d),
                 total_30d=len(actions_30d))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
