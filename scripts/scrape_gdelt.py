#!/usr/bin/env python3
"""GDELT 2.0 events feed — geopolitical tension proxy.

KV key: gdelt_state
Schedule: hourly.
"""
import os
import json
import time
import sys
from collections import Counter
import requests

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID")

if not all([CF_ACCOUNT_ID, CF_API_TOKEN, KV_NS]):
    print("ERROR: Missing CF env vars"); sys.exit(1)

QUERY = ('(Hormuz OR Iran OR "Strait of Hormuz" OR IRGCN) '
         'AND (tanker OR vessel OR oil OR attack OR sanctions)')
URL = ("https://api.gdeltproject.org/api/v2/doc/doc"
       f"?query={requests.utils.quote(QUERY)}"
       "&mode=ArtList&format=json&maxrecords=50&timespan=24h&sort=DateDesc")


def put_kv(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}",
                                   "Content-Type": "text/plain"},
                     data=value, timeout=30)
    return r.status_code == 200


def main():
    print(f"=== gdelt scrape {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    try:
        r = requests.get(URL, timeout=25,
                         headers={"User-Agent": "HormuzWatch-GDELT/1.0"})
    except Exception as e:
        print(f"GDELT request failed: {e}")
        sys.exit(0)
    if r.status_code != 200:
        print(f"GDELT HTTP {r.status_code}: {r.text[:200]}")
        sys.exit(0)

    try:
        data = r.json()
    except Exception:
        print("GDELT JSON parse failed (often empty body when no articles)")
        data = {}

    articles = data.get("articles") or []
    count = len(articles)
    tones = []
    neg = 0
    sources = []
    locations = []

    for a in articles:
        # GDELT doc API returns tone as 'tone' in some shapes, or not — be defensive
        t = a.get("tone")
        try:
            if t is not None:
                tones.append(float(t))
                if float(t) < 0:
                    neg += 1
        except Exception:
            pass
        dom = a.get("domain") or a.get("sourcecountry") or ""
        if dom:
            sources.append(dom)
        loc = a.get("location") or ""
        if loc:
            locations.append(loc)

    avg_tone = round(sum(tones) / len(tones), 2) if tones else None
    neg_pct = round(neg / count * 100, 1) if count else 0
    top_sources = [{"domain": d, "count": c} for d, c in Counter(sources).most_common(5)]
    top_locations = [{"name": d, "count": c} for d, c in Counter(locations).most_common(5)]

    payload = {
        "fetchedAt": int(time.time()),
        "article_count_24h": count,
        "avg_tone": avg_tone,
        "neg_tone_pct": neg_pct,
        "top_sources": top_sources,
        "top_locations": top_locations,
        "source": "GDELT 2.0 Doc API (24h window)",
        "query": QUERY,
    }
    body = json.dumps(payload, separators=(",", ":"))
    ok = put_kv("gdelt_state", body)
    status_body = json.dumps({
        "fetchedAt": int(time.time()),
        "ok": bool(ok),
        "article_count_24h": count,
        "job": "gdelt-scraper",
    }, separators=(",", ":"))
    put_kv("scrape_status_gdelt", status_body)
    print(f"  ✓ KV write OK · {count} articles, neg_pct={neg_pct}, avg_tone={avg_tone}")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
