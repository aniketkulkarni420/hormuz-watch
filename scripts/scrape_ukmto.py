#!/usr/bin/env python3
"""UKMTO maritime incidents scraper — the real conflict-event feed.

Why (2026-06-10): the dashboard's incidents metric was a hardcoded 58 (killed
same day — provably a frozen snapshot of this very dataset) and the verdict
engine had NO conflict-state input; it said NORMAL during missile exchanges.

Source: the Royal Navy JSON API that feeds ukmto.org itself —
  https://sccd.royalnavy.mod.uk/api/ukmto/all
Plain requests + browser UA works (no headless needed). Returns the full
incident list: incidentNumber, utcDateOfIncident, incidentTypeName (Attack /
Suspicious Activity / Advisory / Irregular Activity...), incidentTypeLevel,
exact lat/lon, place ("Strait of Hormuz"), vesselName/Type, otherDetails.

Region split: Hormuz bbox (lat 23-28.5, lon 54-60) OR place keywords; Red Sea
bbox (lat 11-21, lon 32-45) OR keywords. Everything else = "other".

Writes KV `ukmto_state`:
  { fetchedAt, total_reports, counts:{incidents_7d, incidents_30d, attacks_30d,
    hormuz_30d, hormuz_7d, redsea_30d}, latest_attack_ts, latest:[<=15 newest
    {id, type, level, ts, date, lat, lon, place, vessel, summary, region}] }

Guards: zero-parse keeps last-good + exits non-zero (pipefail in workflow);
bounds: count must be 1..2000.
"""
import os, sys, time, json, re
import requests

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN", "")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID", "")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
API = "https://sccd.royalnavy.mod.uk/api/ukmto/all"

HORMUZ_KW = re.compile(r"hormuz|sohar|khasab|fujairah|bandar|musandam|khor fakkan|persian gulf|arabian gulf|qeshm|larak|jask", re.I)
REDSEA_KW = re.compile(r"yemen|balhaf|aden|hodeidah|mokha|red sea|bab.el.mandeb|djibouti", re.I)


def classify_region(lat, lon, place):
    p = place or ""
    if lat is not None and lon is not None:
        if 23.0 <= lat <= 28.5 and 54.0 <= lon <= 60.0:
            return "hormuz"
        if 11.0 <= lat <= 21.0 and 32.0 <= lon <= 45.0:
            return "redsea"
    if HORMUZ_KW.search(p):
        return "hormuz"
    if REDSEA_KW.search(p):
        return "redsea"
    return "other"


def parse_ts(iso):
    if not iso:
        return None
    try:
        return int(time.mktime(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))) - time.timezone
    except Exception:
        return None


def fetch_api():
    r = requests.get(API, timeout=25, headers={
        "User-Agent": UA, "Accept": "application/json",
        "Origin": "https://www.ukmto.org", "Referer": "https://www.ukmto.org/",
    })
    if not r.ok:
        print(f"  API HTTP {r.status_code}")
        return None
    data = r.json()
    if not isinstance(data, list):
        print(f"  API returned {type(data).__name__}, expected list")
        return None
    out = []
    for it in data:
        ts = parse_ts(it.get("utcDateOfIncident") or it.get("utcDateCreated"))
        lat, lon = it.get("locationLatitude"), it.get("locationLongitude")
        place = it.get("place") or ""
        out.append({
            "id":     it.get("incidentNumber"),
            "type":   (it.get("incidentTypeName") or "Unknown").strip(),
            "level":  it.get("incidentTypeLevel"),
            "ts":     ts,
            "date":   (it.get("utcDateOfIncident") or "")[:10],
            "lat":    round(lat, 4) if isinstance(lat, (int, float)) else None,
            "lon":    round(lon, 4) if isinstance(lon, (int, float)) else None,
            "place":  place[:60],
            "vessel": (it.get("vesselName") or "")[:40],
            "summary": re.sub(r"\s+", " ", (it.get("otherDetails") or ""))[:240],
            "region": classify_region(lat, lon, place + " " + (it.get("otherDetails") or "")[:200]),
        })
    out.sort(key=lambda e: -(e["ts"] or 0))
    return out


def kv_put(key, value):
    if not (CF_ACCOUNT_ID and CF_API_TOKEN and KV_NS):
        print("  CF env vars missing — cannot write KV")
        return False
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
                     data=value, timeout=30)
    return r.status_code == 200


def main():
    dry = "--dry-run" in sys.argv
    print(f"=== UKMTO scrape [{'DRY' if dry else 'LIVE'}] at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    try:
        entries = fetch_api()
    except Exception as e:
        print(f"  ✗ API fetch failed: {str(e)[:200]}")
        entries = None
    if not entries:
        print("  ✗ no incidents from API — keeping last-good KV, exiting non-zero")
        return 1
    if not (1 <= len(entries) <= 2000):
        print(f"  ✗ count {len(entries)} out of bounds 1-2000 — keeping last-good")
        return 1

    now = int(time.time())
    d7, d30 = now - 7 * 86400, now - 30 * 86400
    def cnt(pred):
        return sum(1 for e in entries if (e["ts"] or 0) and pred(e))
    counts = {
        "incidents_7d":  cnt(lambda e: e["ts"] >= d7),
        "incidents_30d": cnt(lambda e: e["ts"] >= d30),
        "attacks_30d":   cnt(lambda e: e["ts"] >= d30 and "attack" in e["type"].lower()),
        "hormuz_30d":    cnt(lambda e: e["ts"] >= d30 and e["region"] == "hormuz"),
        "hormuz_7d":     cnt(lambda e: e["ts"] >= d7 and e["region"] == "hormuz"),
        "redsea_30d":    cnt(lambda e: e["ts"] >= d30 and e["region"] == "redsea"),
    }
    latest_attack_ts = max((e["ts"] or 0 for e in entries if "attack" in e["type"].lower()), default=0) or None
    out = {
        "fetchedAt": now,
        "total_reports": len(entries),
        "counts": counts,
        "latest_attack_ts": latest_attack_ts,
        "latest": entries[:15],
        "source": "Royal Navy UKMTO API (sccd.royalnavy.mod.uk/api/ukmto/all)",
    }
    print(f"  {len(entries)} incidents · counts={counts} · latest_attack_ts={latest_attack_ts}")
    for e in entries[:5]:
        print(f"    [{e['date']}] {e['type']} #{e['id']} · {e['region']} · {e['place'][:40]}")
    if dry:
        return 0
    ok = kv_put("ukmto_state", json.dumps(out, separators=(",", ":")))
    print(f"{'✓' if ok else '✗'} KV write {'OK' if ok else 'FAILED'} (key=ukmto_state)")
    return 0 if ok else 1


if __name__ == "__main__":
    from _status import write_status
    _rc = 1
    try:
        _rc = main()
    finally:
        try:
            write_status("ukmto", ok=(_rc == 0))
        except Exception:
            pass
    sys.exit(_rc)
