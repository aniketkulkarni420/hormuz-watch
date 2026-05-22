#!/usr/bin/env python3
"""USGS earthquake feed for Iran + Gulf region.

KV key: seismic_state
Schedule: hourly.
"""
import os
import json
import time
import sys
from datetime import datetime, timedelta
import requests

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID")

if not all([CF_ACCOUNT_ID, CF_API_TOKEN, KV_NS]):
    print("ERROR: Missing CF env vars"); sys.exit(1)


# Major port lat/lng for proximity detection (~250 km radius)
PORTS = [
    ("Bandar Abbas", 27.18, 56.27),
    ("Fujairah",     25.12, 56.34),
    ("Khor Fakkan",  25.34, 56.36),
    ("Jask",         25.65, 57.78),
    ("Doha",         25.29, 51.53),
    ("Dubai",        25.27, 55.30),
    ("Kharg Island", 29.25, 50.32),
    ("Basra",        30.50, 47.82),
]


def put_kv(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}",
                                   "Content-Type": "text/plain"},
                     data=value, timeout=30)
    return r.status_code == 200


def haversine_km(lat1, lng1, lat2, lng2):
    from math import radians, cos, sin, asin, sqrt
    R = 6371.0
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return 2 * R * asin(sqrt(a))


def main():
    print(f"=== seismic scrape {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    starttime = (datetime.utcnow() - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S")
    url = ("https://earthquake.usgs.gov/fdsnws/event/1/query"
           "?format=geojson&minlatitude=24&maxlatitude=40"
           "&minlongitude=44&maxlongitude=63&minmagnitude=4"
           f"&starttime={starttime}")
    try:
        r = requests.get(url, timeout=25)
    except Exception as e:
        print(f"USGS request failed: {e}")
        sys.exit(0)
    if r.status_code != 200:
        print(f"USGS HTTP {r.status_code}")
        sys.exit(0)

    try:
        gj = r.json()
    except Exception as e:
        print(f"USGS JSON parse: {e}")
        sys.exit(0)

    features = gj.get("features") or []
    count = len(features)
    max_mag = 0.0
    latest_ts = 0
    events_near_ports = []
    biggest = []

    for f in features:
        props = f.get("properties") or {}
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or [None, None]
        mag = props.get("mag") or 0
        place = props.get("place") or ""
        t_ms = props.get("time") or 0
        ts = int(t_ms / 1000) if t_ms else 0
        if mag and mag > max_mag:
            max_mag = mag
        if ts > latest_ts:
            latest_ts = ts
        lng, lat = coords[0], coords[1]
        # Proximity check
        if lat is not None and lng is not None:
            for name, plat, plng in PORTS:
                if haversine_km(lat, lng, plat, plng) <= 250:
                    events_near_ports.append({
                        "place": place, "mag": mag, "ts": ts,
                        "nearPort": name
                    })
                    break
        biggest.append({"mag": mag, "place": place, "ts": ts,
                        "lat": lat, "lng": lng})

    biggest.sort(key=lambda x: x["mag"] or 0, reverse=True)
    biggest = biggest[:5]

    payload = {
        "fetchedAt": int(time.time()),
        "count_7d": count,
        "max_mag": round(max_mag, 2),
        "latest_event_ts": latest_ts,
        "events_near_ports": events_near_ports[:10],
        "biggest": biggest,
        "source": "USGS FDSN earthquake API (mag 4+, 7d window)",
    }
    body = json.dumps(payload, separators=(",", ":"))
    ok = put_kv("seismic_state", body)
    # 2026-05-22: diff-aware status (only writes on transition)
    try:
        from _status import write_status
        write_status("seismic-scraper", ok=bool(ok), count_7d=count)
    except Exception: pass
    print(f"  ✓ KV write OK · {count} events, max mag {max_mag}")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
