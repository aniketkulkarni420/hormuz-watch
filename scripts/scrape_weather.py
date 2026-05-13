#!/usr/bin/env python3
"""OpenWeather Persian Gulf — wind / visibility / shipping conditions.

KV key: weather_state
Schedule: hourly.
Requires OPENWEATHER_KEY secret. Exits 0 cleanly if missing (no failure).
"""
import os
import json
import time
import sys
import requests

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID")
OW_KEY        = os.environ.get("OPENWEATHER_KEY", "").strip()

if not all([CF_ACCOUNT_ID, CF_API_TOKEN, KV_NS]):
    print("ERROR: Missing CF env vars"); sys.exit(1)

if not OW_KEY:
    print("OPENWEATHER_KEY missing — skipping")
    sys.exit(0)

POINTS = [
    ("Hormuz Center", 26.5, 56.5),
    ("Fujairah",      25.2, 56.3),
    ("Khor Fakkan",   25.3, 56.4),
    ("Bandar Abbas",  27.2, 56.3),
]

MS_TO_KNOTS = 1.94384


def put_kv(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}",
                                   "Content-Type": "text/plain"},
                     data=value, timeout=30)
    return r.status_code == 200


def fetch_point(name, lat, lng):
    url = (f"https://api.openweathermap.org/data/2.5/weather"
           f"?lat={lat}&lon={lng}&appid={OW_KEY}&units=metric")
    try:
        r = requests.get(url, timeout=20)
        if r.status_code != 200:
            print(f"  {name}: HTTP {r.status_code}")
            return None
        d = r.json()
        wind_ms = (d.get("wind") or {}).get("speed") or 0
        wind_knots = round(wind_ms * MS_TO_KNOTS, 1)
        vis_m = d.get("visibility")  # meters, max 10000
        vis_km = round(vis_m / 1000, 1) if vis_m is not None else None
        weather = ((d.get("weather") or [{}])[0]).get("main") or ""
        desc = ((d.get("weather") or [{}])[0]).get("description") or ""
        return {
            "name": name, "lat": lat, "lng": lng,
            "windKnots": wind_knots,
            "visibilityKm": vis_km,
            "weather": weather, "desc": desc,
            "tempC": (d.get("main") or {}).get("temp"),
        }
    except Exception as e:
        print(f"  {name}: exception {e}")
        return None


def main():
    print(f"=== weather scrape {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    conditions = []
    for name, lat, lng in POINTS:
        c = fetch_point(name, lat, lng)
        if c:
            conditions.append(c)
        time.sleep(0.3)

    if not conditions:
        print("All weather fetches failed")
        sys.exit(0)

    wind_max = max((c["windKnots"] for c in conditions if c.get("windKnots") is not None), default=0)
    vis_vals = [c["visibilityKm"] for c in conditions if c.get("visibilityKm") is not None]
    vis_min = min(vis_vals) if vis_vals else None
    rough = (wind_max > 25) or (vis_min is not None and vis_min < 5)

    payload = {
        "fetchedAt": int(time.time()),
        "conditions": conditions,
        "roughConditions": bool(rough),
        "windMaxKnots": wind_max,
        "visibilityMinKm": vis_min,
        "source": "OpenWeather Current Weather API (4 Hormuz points)",
    }
    body = json.dumps(payload, separators=(",", ":"))
    ok = put_kv("weather_state", body)
    status_body = json.dumps({
        "fetchedAt": int(time.time()),
        "ok": bool(ok),
        "windMaxKnots": wind_max,
        "rough": bool(rough),
        "job": "weather-scraper",
    }, separators=(",", ":"))
    put_kv("scrape_status_weather", status_body)
    print(f"  ✓ KV write OK · max wind {wind_max}kn, min vis {vis_min}km, rough={rough}")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
