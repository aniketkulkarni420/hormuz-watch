#!/usr/bin/env python3
"""News headlines aggregator — Hormuz/Iran/tanker pulse.

Pulls 4-5 free RSS feeds, filters items by a Hormuz-relevant keyword list,
scores by keyword count, sorts newest-first, caps at 20.

Sources (all free RSS, no auth):
  1. Al Jazeera (all)         — https://www.aljazeera.com/xml/rss/all.xml
  2. BBC World · Middle East  — http://feeds.bbci.co.uk/news/world/middle_east/rss.xml
  3. Hellenic Shipping News   — https://www.hellenicshippingnews.com/feed/
  4. Times of Israel          — https://www.timesofisrael.com/feed/
  5. Tehran Times             — https://www.tehrantimes.com/rss   (state perspective)

Writes KV `news_headlines`:
  {
    "fetchedAt": unix_seconds,
    "headlines": [ {title, link, source, published, score}, ... ],
    "count": int,
    "sources_succeeded": int,
    "top_keywords": [["iran", 9], ["hormuz", 4], ["tanker", 3]]
  }

Stdlib XML parsing — no bs4 / feedparser dependency.
"""

import os
import sys
import time
import json
import re
import email.utils
import xml.etree.ElementTree as ET
import urllib.request
import urllib.error

import requests  # only for KV PUT — already in workflow deps

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN", "")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID", "")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"

FEEDS = [
    ("Al Jazeera",              "https://www.aljazeera.com/xml/rss/all.xml"),
    ("BBC Middle East",         "http://feeds.bbci.co.uk/news/world/middle_east/rss.xml"),
    ("Hellenic Shipping News",  "https://www.hellenicshippingnews.com/feed/"),
    ("Times of Israel",         "https://www.timesofisrael.com/feed/"),
    ("Tehran Times",            "https://www.tehrantimes.com/rss"),
]

KEYWORDS = [
    "hormuz", "iran", "tanker", "strait", "persian gulf", "irgcn", "fujairah",
    "bandar abbas", "opec", "sanctions", "oil supply", "crude oil", "shipping",
    "naval", "irans", "iranian", "gulf",
]


def fetch_feed(url, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.5"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _text(el):
    if el is None:
        return ""
    # Strip HTML tags from description/content
    t = "".join(el.itertext()) if list(el) else (el.text or "")
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t or "")).strip()


def parse_pubdate(s):
    if not s:
        return None
    s = s.strip()
    try:
        dt = email.utils.parsedate_to_datetime(s)
        if dt:
            return int(dt.timestamp())
    except Exception:
        pass
    # ISO fallback (Atom feeds use <updated>2026-05-13T15:42:00Z</updated>)
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})", s)
    if m:
        try:
            return int(time.mktime(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S"))) - time.timezone
        except Exception:
            pass
    return None


def iso_from_unix(ts):
    if not ts:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def parse_items(xml_bytes, source_name):
    items = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        print(f"  [{source_name}] XML parse error: {e}")
        return items

    # RSS 2.0: <rss><channel><item>...
    # Atom: <feed><entry>...
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    elements = list(root.iter("item")) + list(root.iter("{http://www.w3.org/2005/Atom}entry"))
    for it in elements:
        title = _text(it.find("title")) or _text(it.find("{http://www.w3.org/2005/Atom}title"))
        link_el = it.find("link")
        link = ""
        if link_el is not None:
            link = (link_el.text or link_el.get("href") or "").strip()
        if not link:
            atom_link = it.find("{http://www.w3.org/2005/Atom}link")
            if atom_link is not None:
                link = (atom_link.get("href") or atom_link.text or "").strip()
        desc = (_text(it.find("description"))
                or _text(it.find("{http://www.w3.org/2005/Atom}summary"))
                or _text(it.find("{http://www.w3.org/2005/Atom}content")))
        pub = (_text(it.find("pubDate"))
               or _text(it.find("{http://www.w3.org/2005/Atom}updated"))
               or _text(it.find("{http://www.w3.org/2005/Atom}published"))
               or _text(it.find("{http://purl.org/dc/elements/1.1/}date")))
        ts = parse_pubdate(pub)
        if not title or not link:
            continue
        items.append({
            "title": title[:280],
            "link": link[:500],
            "source": source_name,
            "description": desc[:600],
            "published_ts": ts,
            "published": iso_from_unix(ts),
        })
    return items


def score_item(item):
    blob = ((item.get("title") or "") + " " + (item.get("description") or "")).lower()
    hits = []
    for kw in KEYWORDS:
        if kw in blob:
            hits.append(kw)
    return len(hits), hits


def kv_put(key, value):
    if not (CF_ACCOUNT_ID and CF_API_TOKEN and KV_NS):
        print("  CF_* env missing — cannot write KV")
        return False
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
                     data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
                     timeout=30)
    return r.status_code == 200


def main():
    print(f"=== news scrape at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    all_items = []
    succeeded = 0
    per_source_count = {}
    for name, url in FEEDS:
        print(f"\n--- {name} ---")
        try:
            xml = fetch_feed(url)
            items = parse_items(xml, name)
            print(f"  fetched {len(items)} items")
            per_source_count[name] = len(items)
            if items:
                succeeded += 1
            all_items.extend(items)
        except urllib.error.HTTPError as e:
            print(f"  HTTP {e.code}: {url}")
            per_source_count[name] = 0
        except Exception as e:
            print(f"  error: {str(e)[:180]}")
            per_source_count[name] = 0

    # Filter by keywords + score
    filtered = []
    keyword_counter = {}
    seen_urls = set()
    for it in all_items:
        score, hits = score_item(it)
        if score == 0:
            continue
        if it["link"] in seen_urls:
            continue
        seen_urls.add(it["link"])
        for kw in hits:
            keyword_counter[kw] = keyword_counter.get(kw, 0) + 1
        it["score"] = score
        # Drop bulky description from output (kept for scoring only)
        it.pop("description", None)
        filtered.append(it)

    # Sort: newest first (None timestamps go last), then score desc as tiebreak
    filtered.sort(key=lambda x: (-(x["published_ts"] or 0), -x["score"]))

    # Cap at 20
    top20 = filtered[:20]

    # 24h count
    now_ts = int(time.time())
    cutoff = now_ts - 24 * 3600
    count_24h = sum(1 for x in filtered if (x["published_ts"] or 0) >= cutoff)

    # Top 3 keywords overall
    top_keywords = sorted(keyword_counter.items(), key=lambda kv: -kv[1])[:3]

    print(f"\n--- aggregate ---")
    print(f"  sources_succeeded: {succeeded}/{len(FEEDS)}")
    print(f"  per_source_raw: {per_source_count}")
    print(f"  filtered_matches: {len(filtered)}  (last 24h: {count_24h})")
    print(f"  top keywords: {top_keywords}")
    if top20:
        print(f"  top 5 headlines:")
        for h in top20[:5]:
            print(f"    [{h['source']} · score={h['score']}] {h['title'][:90]}")

    out = {
        "fetchedAt": now_ts,
        "headlines": [{
            "title": h["title"],
            "link": h["link"],
            "source": h["source"],
            "published": h["published"],
            "score": h["score"],
        } for h in top20],
        "count": len(top20),
        "count_24h": count_24h,
        "sources_succeeded": succeeded,
        "sources_total": len(FEEDS),
        "top_keywords": [[k, v] for k, v in top_keywords],
        "per_source_raw": per_source_count,
    }

    ok = kv_put("news_headlines", json.dumps(out, separators=(",", ":")))
    print(f"\n{'✓' if ok else '✗'} KV write {'OK' if ok else 'FAILED'}  (key=news_headlines)")
    if not ok:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
