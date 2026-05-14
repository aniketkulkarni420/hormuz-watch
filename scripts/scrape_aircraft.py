#!/usr/bin/env python3
"""OpenSky Network ADS-B scraper for Persian Gulf airspace.

Path D composite signal coverage — replaces missing AIS data.

Anonymous tier: 100 req/day. Schedule every 15 min = 96/day (under limit).
Bbox: 23..29 lat, 51..60 lng (covers Persian Gulf + Strait of Hormuz airspace).

KV key: aircraft_state
"""
import os
import json
import time
import sys
import requests

UA = "Mozilla/5.0 (HormuzWatch-Aircraft-Scraper/1.0)"

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID")

if not all([CF_ACCOUNT_ID, CF_API_TOKEN, KV_NS]):
    print("ERROR: Missing CF env vars"); sys.exit(1)

OPENSKY_URL = "https://opensky-network.org/api/states/all?lamin=23&lomin=51&lamax=29&lomax=60"

# NATO / coalition military callsign prefixes.
# IMPORTANT (Batch D · 2026-05-14): these are predominantly US/NATO tactical
# callsigns. Iranian / IRGC aircraft rarely broadcast ADS-B at all, so
# `militaryCount` is a COALITION-POSTURE proxy — a rising count signals US/
# allied build-up, NOT Iranian or regional military activity. Read it that way.
MIL_PREFIXES = ("CNV", "RCH", "KING", "HOG", "BTR", "SHELL", "EYE", "TIGER",
                "GLEX", "PAT", "BLUE", "REACH", "JAKE", "BOXER", "MAGMA",
                "SNAKE", "TRAIN", "VENUS", "HAVOC", "RANGER", "PYTHON")


def put_kv(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}",
                                   "Content-Type": "text/plain"},
                     data=value, timeout=30)
    if r.status_code != 200:
        print(f"  KV PUT {key} failed: {r.status_code} {r.text[:120]}")
        return False
    return True


def get_kv(key):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    try:
        r = requests.get(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}"}, timeout=15)
        if r.status_code == 200:
            return json.loads(r.text)
    except Exception:
        pass
    return None


def classify_callsign(cs):
    if not cs:
        return False
    cs = cs.strip().upper()
    return any(cs.startswith(p) for p in MIL_PREFIXES)


def main():
    print(f"=== aircraft scrape {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")

    try:
        r = requests.get(OPENSKY_URL, headers={"User-Agent": UA}, timeout=25)
    except Exception as e:
        print(f"OpenSky request failed: {e}")
        sys.exit(0)

    if r.status_code != 200:
        print(f"OpenSky HTTP {r.status_code}: {r.text[:200]}")
        # write status with empty payload so dashboard shows "feed degraded"
        status_body = json.dumps({"fetchedAt": int(time.time()), "ok": False,
                                  "job": "aircraft-scraper",
                                  "httpStatus": r.status_code}, separators=(",", ":"))
        put_kv("scrape_status_aircraft", status_body)
        sys.exit(0)

    try:
        data = r.json()
    except Exception as e:
        print(f"OpenSky JSON parse failed: {e}")
        sys.exit(0)

    states = data.get("states") or []
    print(f"  fetched {len(states)} aircraft states")

    count = 0
    mil = 0
    com = 0
    bands = {"low": 0, "mid": 0, "high": 0}
    callsigns = []
    mil_callsigns = []
    positions = []  # per-aircraft lat/lng for the map's Aircraft layer

    # OpenSky state vector indexes:
    # 0 icao24, 1 callsign, 2 origin_country, 5 lng, 6 lat, 7 baro_alt,
    # 8 on_ground, 9 velocity, ...
    for s in states:
        try:
            icao = s[0]
            cs   = (s[1] or "").strip()
            country = s[2] or ""
            lng = s[5]
            lat = s[6]
            alt_m = s[7]  # meters
            on_ground = bool(s[8])
            velocity = s[9]

            if lat is None or lng is None:
                continue

            count += 1
            callsigns.append(cs)

            alt_ft = (alt_m or 0) * 3.281
            if on_ground or alt_ft < 1000:
                bands["low"] += 1
            elif alt_ft < 30000:
                bands["mid"] += 1
            else:
                bands["high"] += 1

            is_mil = classify_callsign(cs)
            if is_mil:
                mil += 1
                if cs not in mil_callsigns:
                    mil_callsigns.append(cs)
            else:
                com += 1

            # Position for the map layer — skip on-ground noise, cap list size
            if not on_ground and len(positions) < 80:
                positions.append({
                    "lat": round(lat, 3),
                    "lng": round(lng, 3),
                    "cs": cs or "",
                    "mil": is_mil,
                })
        except Exception:
            continue

    # 24h movement delta via prev KV
    prev = get_kv("aircraft_state")
    movement_24h = None
    if prev and isinstance(prev, dict):
        prev_count = prev.get("count")
        if isinstance(prev_count, (int, float)):
            movement_24h = count - int(prev_count)

    payload = {
        "fetchedAt": int(time.time()),
        "count": count,
        "militaryCount": mil,
        "militaryNote": "NATO/coalition ADS-B callsigns only — coalition-posture proxy, not Iranian/regional military activity",
        "commercialCount": com,
        "byAltitude": bands,
        "movement24h": movement_24h,
        "positions": positions,
        "callsigns": mil_callsigns[:40],
        "source": "OpenSky Network ADS-B (anonymous tier)",
        "bbox": {"lamin": 23, "lomin": 51, "lamax": 29, "lomax": 60},
    }

    body = json.dumps(payload, separators=(",", ":"))
    ok = put_kv("aircraft_state", body)

    status_body = json.dumps({
        "fetchedAt": int(time.time()),
        "ok": bool(ok and count >= 0),
        "count": count,
        "militaryCount": mil,
        "job": "aircraft-scraper",
    }, separators=(",", ":"))
    put_kv("scrape_status_aircraft", status_body)

    print(f"  ✓ KV write OK ({len(body)}B) · {count} aircraft, {mil} military")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
