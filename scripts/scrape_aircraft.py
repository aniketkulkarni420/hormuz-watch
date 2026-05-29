#!/usr/bin/env python3
"""ADS-B scraper for Persian Gulf airspace.

2026-05-18 — Switched primary feed from OpenSky to adsb.lol after discovering
GHA's shared IP range gets aggressively throttled by OpenSky's anonymous tier
(local tests returned 17 aircraft; GHA runs were seeing 4). adsb.lol is a
free public ADS-B aggregator with no auth and no rate limits, returning a
richer payload (~50 fields including type code, category, squawk).

Order: adsb.lol primary → OpenSky fallback if adsb.lol fails.
KV key: aircraft_state
"""
import os
import json
import time
import sys
import requests

UA = "Mozilla/5.0 (HormuzWatch-Aircraft-Scraper/2.0)"

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID")

if not all([CF_ACCOUNT_ID, CF_API_TOKEN, KV_NS]):
    print("ERROR: Missing CF env vars"); sys.exit(1)

# adsb.lol — bbox-by-radius: lat, lon, dist (nm). 250nm covers Persian Gulf
# from Hormuz centre out to Kuwait / Salalah.
ADSB_LOL_URL = "https://api.adsb.lol/v2/lat/25.5/lon/56.5/dist/250"
# OpenSky fallback — same bbox, anonymous tier (heavily throttled on GHA IPs).
OPENSKY_URL = "https://opensky-network.org/api/states/all?lamin=23&lomin=51&lamax=29&lomax=60"

# NATO / coalition military callsign prefixes.
# IMPORTANT (Batch D · 2026-05-14): these are predominantly US/NATO tactical
# callsigns. Iranian / IRGC aircraft rarely broadcast ADS-B at all, so
# `militaryCount` is a COALITION-POSTURE proxy — a rising count signals US/
# allied build-up, NOT Iranian or regional military activity. Read it that way.
MIL_PREFIXES = ("CNV", "RCH", "KING", "HOG", "BTR", "SHELL", "EYE", "TIGER",
                "GLEX", "PAT", "BLUE", "REACH", "JAKE", "BOXER", "MAGMA",
                "SNAKE", "TRAIN", "VENUS", "HAVOC", "RANGER", "PYTHON",
                # 2026-05-18 — expanded after adsb.lol revealed more callsign
                # patterns in the Gulf: US Navy, RAF, French AdlA tactical
                "NAVY", "RAFAIR", "ASCOT", "DUKE", "AWACS", "FORCE",
                "GAUNT", "HKY", "TACOMA")

# Specific military aircraft ICAO type codes (transponder-broadcast "t" field
# on adsb.lol). Used as a second classifier — callsign + type union.
MIL_TYPES = {
    # US tactical
    "E3CF", "E3TF", "E737", "E767",       # AWACS variants
    "P8",   "P3",                          # Maritime patrol
    "C17",  "C5",   "C130", "C40", "KC135", "KC46", "KC30", "KC10",  # Heavy lift / tanker
    "F15",  "F16",  "F18",  "F35", "F22", # Fighters
    "B1",   "B52",  "B2",                  # Bombers
    "MQ9",  "MQ4",  "RQ4",                 # UAVs (Reaper, Triton, Global Hawk)
    "E2",   "EA18",                        # Carrier-deck early warning / EW
    # NATO / European
    "TYPH", "RFAL", "A400",                # Eurofighter, Rafale, A400M
}


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


def classify_type(t):
    """ICAO type code → military? Used as a second classifier."""
    if not t:
        return False
    return t.strip().upper() in MIL_TYPES


def fetch_adsb_lol():
    """adsb.lol — free, no auth, no rate limit. Returns list of normalised
    state dicts: {icao, cs, country, lat, lng, alt_ft, on_ground, velocity,
    type_code}. Or None on hard failure."""
    try:
        r = requests.get(ADSB_LOL_URL, headers={"User-Agent": UA}, timeout=25)
    except Exception as e:
        print(f"  adsb.lol exception: {e}")
        return None
    if r.status_code != 200:
        print(f"  adsb.lol HTTP {r.status_code}")
        return None
    try:
        data = r.json()
    except Exception as e:
        print(f"  adsb.lol JSON parse failed: {e}")
        return None
    ac = data.get("ac") or []
    out = []
    for a in ac:
        try:
            lat = a.get("lat")
            lon = a.get("lon")
            if lat is None or lon is None:
                continue
            alt = a.get("alt_baro")
            on_ground = (alt == "ground") or (a.get("category") in ("C1", "C2", "C3"))
            alt_ft = 0 if on_ground else (int(alt) if isinstance(alt, (int, float)) else 0)
            out.append({
                "icao": a.get("hex") or "",
                "cs":   (a.get("flight") or "").strip(),
                "country": "",   # adsb.lol doesn't expose origin country; left blank
                "lat": lat,
                "lng": lon,
                "alt_ft": alt_ft,
                "on_ground": on_ground,
                "velocity": a.get("gs"),  # ground speed kt
                "type_code": (a.get("t") or "").strip().upper(),
            })
        except Exception:
            continue
    return out


def fetch_opensky():
    """OpenSky fallback. State vector layout per their docs."""
    try:
        r = requests.get(OPENSKY_URL, headers={"User-Agent": UA}, timeout=25)
    except Exception as e:
        print(f"  OpenSky exception: {e}")
        return None
    if r.status_code != 200:
        print(f"  OpenSky HTTP {r.status_code}")
        return None
    try:
        data = r.json()
    except Exception as e:
        print(f"  OpenSky JSON parse failed: {e}")
        return None
    states = data.get("states") or []
    out = []
    for s in states:
        try:
            lat, lng = s[6], s[5]
            if lat is None or lng is None:
                continue
            alt_m = s[7] or 0
            out.append({
                "icao": s[0] or "",
                "cs":   (s[1] or "").strip(),
                "country": s[2] or "",
                "lat": lat,
                "lng": lng,
                "alt_ft": alt_m * 3.281,
                "on_ground": bool(s[8]),
                "velocity": s[9],
                "type_code": "",
            })
        except Exception:
            continue
    return out


def main():
    print(f"=== aircraft scrape {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")

    # Try adsb.lol first (no auth, no rate limit) → fall back to OpenSky.
    states = fetch_adsb_lol()
    source = "adsb.lol"
    if not states:
        print("  adsb.lol returned no data — falling back to OpenSky")
        states = fetch_opensky()
        source = "opensky"
    if not states:
        print("  Both ADS-B sources failed — flagging degraded")
        # 2026-05-22: diff-aware status (only writes on transition)
        try:
            from _status import write_status
            write_status("aircraft-scraper", ok=False, reason="both_sources_failed")
        except Exception: pass
        sys.exit(0)

    print(f"  fetched {len(states)} aircraft states via {source}")

    count = 0
    mil = 0
    com = 0
    bands = {"low": 0, "mid": 0, "high": 0}
    mil_callsigns = []
    positions = []

    for st in states:
        try:
            cs = st["cs"]
            lat = st["lat"]
            lng = st["lng"]
            alt_ft = st["alt_ft"]
            on_ground = st["on_ground"]
            type_code = st["type_code"]

            count += 1

            if on_ground or alt_ft < 1000:
                bands["low"] += 1
            elif alt_ft < 30000:
                bands["mid"] += 1
            else:
                bands["high"] += 1

            # Military classifier: callsign OR ICAO type code matches.
            is_mil = classify_callsign(cs) or classify_type(type_code)
            if is_mil:
                mil += 1
                if cs and cs not in mil_callsigns:
                    mil_callsigns.append(cs)
            else:
                com += 1

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
        "source": ("adsb.lol public aggregator (250nm centred 25.5N 56.5E)"
                   if source == "adsb.lol"
                   else "OpenSky Network ADS-B (anonymous tier — GHA IP throttled)"),
        "bbox": ({"centre_lat": 25.5, "centre_lon": 56.5, "radius_nm": 250}
                 if source == "adsb.lol"
                 else {"lamin": 23, "lomin": 51, "lamax": 29, "lomax": 60}),
    }

    # 2026-05-28 (Tier 1A): sanity-bound the count before writing. ADS-B
    # parse glitches or a bbox change could yield an absurd count; reject
    # out-of-band (0-300) rather than overwriting a good prior value.
    try:
        from _validate import in_bounds
        if not in_bounds("aircraft_count", count):
            print(f"  ✗ aircraft count {count} out of bounds — keeping prior KV (no write)")
            from _status import write_status
            write_status("aircraft-scraper", ok=False, reason="count_out_of_bounds", count=count)
            sys.exit(0)
    except Exception as e:
        print(f"  warn: validation skipped: {e}")

    body = json.dumps(payload, separators=(",", ":"))
    ok = put_kv("aircraft_state", body)

    # 2026-05-22: diff-aware status — writes only when ok-state changes
    try:
        from _status import write_status
        write_status("aircraft-scraper", ok=bool(ok and count >= 0),
                     count=count, militaryCount=mil)
    except Exception: pass

    print(f"  ✓ KV write OK ({len(body)}B) · {count} aircraft, {mil} military")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
