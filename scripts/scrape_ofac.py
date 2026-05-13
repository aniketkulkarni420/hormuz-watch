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

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=30)

    all_actions = []
    iran_actions = []
    for href, yyyymmdd, title in matches:
        d = parse_date(yyyymmdd)
        if not d:
            continue
        action = {
            "date": d.strftime("%Y-%m-%d"),
            "title": title.strip(),
            "url": f"https://ofac.treasury.gov{href}",
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

    latest_iran = iran_dedup[0] if iran_dedup else None

    print(f"  total actions parsed: {len(all_actions)}  (30d: {len(actions_30d)})")
    print(f"  iran-related: {len(iran_dedup)}  (30d: {len(iran_30d)})")
    if latest_iran:
        print(f"  latest iran action: {latest_iran['date']} — {latest_iran['title'][:80]}")

    payload = {
        "fetchedAt": int(time.time()),
        "iran_related_actions_30d": len(iran_30d),
        "total_actions_30d": len(actions_30d),
        "recent_actions": [
            {"date": a["date"], "title": a["title"], "url": a["url"]}
            for a in iran_dedup[:10]
        ],
        "latest_action_date": latest_iran["date"] if latest_iran else None,
        "source": "ofac.treasury.gov/recent-actions",
    }
    ok = kv_put("ofac_state", json.dumps(payload, separators=(",", ":")))
    print(f"  KV write: {'OK' if ok else 'FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
