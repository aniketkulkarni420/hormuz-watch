#!/usr/bin/env python3
"""Listen to AISStream for 90 seconds, capture vessel positions, detect gate crossings.

Each run reads previous state from KV (vesselState, transits24h, crossing_imos_24h), listens
for 90 seconds, updates state in-memory with any new positions, detects crossings against
previous longitude, then writes everything back. Designed for GHA's short-lived execution
model — no persistent connection needed.

Cumulative IMO tracking: we maintain a set of IMO numbers seen crossing the gate in the
last 24h in KV. On each scrape we load the existing set, merge new crossings, and prune
IMOs older than 24h. This prevents both double-counting and missed-scrape undercounting.

Why GHA instead of Cloudflare Worker: free-tier Workers get evicted from memory after idle
periods, breaking persistent WebSocket subscriptions. GHA runs short bursts every 5 minutes
and persists state in KV between runs.
"""
import asyncio
import json
import os
import sys
import time
import websockets
import requests

LISTEN_DURATION = 90          # seconds to listen each run (was 60 — more coverage per burst)
GATE_LNG = 56.45
GATE_LAT_MIN = 26.20
GATE_LAT_MAX = 26.70
CORRIDOR = {"latMin": 26.0, "latMax": 26.7, "lngMin": 55.5, "lngMax": 57.5}
STATE_TTL_MS = 30 * 60 * 1000
TRANSIT_WINDOW_MS = 24 * 3600 * 1000
BBOX = [[[24.0, 52.0], [28.5, 59.5]]]

CF_ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"].strip()
CF_API_TOKEN  = os.environ["CF_API_TOKEN"].strip()
KV_NS         = os.environ["CF_KV_NAMESPACE_ID"].strip()
# 2026-05-12 · trailing whitespace/newline in the GH secret causes AISStream to
# silently close the WebSocket after subscription. Strip aggressively + log
# length so future debug can catch this immediately.
_raw_ais_key = os.environ["AIS_KEY"]
AIS_KEY = _raw_ais_key.strip()
if len(AIS_KEY) != len(_raw_ais_key):
    print(f"  ⚠ AIS_KEY had {len(_raw_ais_key) - len(AIS_KEY)} char(s) of whitespace stripped "
          f"(raw len={len(_raw_ais_key)}, clean len={len(AIS_KEY)}). "
          f"This is the #1 cause of 'connection closes immediately after subscription'.")


def kv_get(key):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.get(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}"}, timeout=20)
    if r.status_code == 200:
        try: return json.loads(r.text)
        except Exception: return None
    return None


def kv_put(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
                     data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
                     timeout=30)
    return r.status_code == 200


def classify_ship_class(type_code, length_m):
    """Classify by AIS type + length. Returns canonical label."""
    if type_code is None:
        return "Unknown"
    try:
        t = int(type_code)
    except (TypeError, ValueError):
        return "Unknown"
    if 80 <= t <= 89:
        # Tanker — classify by length
        if length_m >= 300:    return "VLCC"
        elif length_m >= 270:  return "Suezmax"
        elif length_m >= 240:  return "Aframax"
        elif length_m >= 180:  return "Panamax tanker"
        elif length_m > 0:     return "Small tanker"
        else:                  return "Tanker"
    if 70 <= t <= 79:          return "Cargo"
    if 60 <= t <= 69:          return "Passenger"
    if t == 30 or t == 31 or t == 32:  return "Fishing"
    if 35 <= t <= 39:          return "Military"
    if 40 <= t <= 49:          return "High-speed"
    if t == 50 or t == 51 or t == 52: return "Service"
    if 90 <= t <= 99:          return "Other"
    return "Other"


def aggregate_state(state):
    """Compute typeBreakdown, currentInbound, currentOutbound from vessel state."""
    type_counts = {}
    inbound = 0
    outbound = 0
    for mmsi, v in state.items():
        label = classify_ship_class(v.get("type"), v.get("length_m", 0))
        type_counts[label] = type_counts.get(label, 0) + 1
        # Direction by heading: 250-320 = entering Persian Gulf (westbound/inbound)
        #                       70-140 = exiting toward Indian Ocean (eastbound/outbound)
        h = v.get("heading", 0) or 0
        cat = v.get("category", "")
        if cat == "transit":
            if 250 <= h <= 320: inbound += 1
            elif 70 <= h <= 140: outbound += 1
    return type_counts, inbound, outbound


def categorize(lat, lng, sog, heading):
    if sog < 0.5:
        return "anchored"
    if (CORRIDOR["latMin"] <= lat <= CORRIDOR["latMax"] and
        CORRIDOR["lngMin"] <= lng <= CORRIDOR["lngMax"] and sog >= 5 and
        ((250 <= heading <= 320) or (70 <= heading <= 140))):
        return "transit"
    return "approach"


async def listen_and_capture(state, transits, crossing_imos):
    """Returns updated state, transits, crossing_imos, and message count.
    crossing_imos is a list of {imo, time} dicts for the 24h window.
    """
    msg_count = 0
    other_msgs = 0          # non-position, non-static messages (e.g. errors, status frames)
    error_samples = []      # first few non-routine messages — surface AISStream auth failures
    # Build quick-lookup set of already-seen IMOs this window (by mmsi as proxy for IMO here)
    existing_mmsi_crossings = {entry["mmsi"] for entry in crossing_imos if "mmsi" in entry}

    print(f"  AIS_KEY present: {bool(AIS_KEY)} (len {len(AIS_KEY) if AIS_KEY else 0})")
    # Sanity check · AISStream keys are 40 hex chars · anything else = paste error
    if len(AIS_KEY) != 40:
        print(f"  ⚠ AIS_KEY length is {len(AIS_KEY)} (expected 40). "
              f"Likely a paste error in GH secrets. Re-paste the raw 40-char key from aisstream.io/login.")
    print(f"  Connecting to AISStream WebSocket, bbox={BBOX}, listen={LISTEN_DURATION}s")

    connection_closed_early = False
    try:
        async with websockets.connect("wss://stream.aisstream.io/v0/stream", ping_interval=20) as ws:
            sub_payload = {
                "APIKey": AIS_KEY,
                "BoundingBoxes": BBOX,
                "FilterMessageTypes": ["PositionReport", "ShipStaticData"]
            }
            await ws.send(json.dumps(sub_payload))
            print(f"  Subscription sent. Listening...")
            end_time = time.time() + LISTEN_DURATION
            first_msg_logged = False
            while time.time() < end_time:
                remaining = end_time - time.time()
                if remaining <= 0:
                    break
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                try:
                    msg = json.loads(raw)
                except Exception:
                    if len(error_samples) < 3:
                        error_samples.append(f"non-JSON: {str(raw)[:200]}")
                    continue

                if not first_msg_logged:
                    print(f"  First message received: type={msg.get('MessageType','?')}, keys={list(msg.keys())[:6]}")
                    first_msg_logged = True

                msg_count += 1
                meta = msg.get("MetaData") or {}
                mmsi = meta.get("MMSI")
                if not mmsi:
                    other_msgs += 1
                    if len(error_samples) < 3:
                        sample = {k: v for k, v in msg.items() if k.lower() not in ("apikey", "api_key")}
                        error_samples.append(f"no-MMSI: {json.dumps(sample)[:250]}")
                    continue
                mmsi = str(mmsi)
                name = (meta.get("ShipName") or "").strip()
                mt = msg.get("MessageType")
                if mt == "ShipStaticData":
                    sd = (msg.get("Message") or {}).get("ShipStaticData") or {}
                    if mmsi in state:
                        if sd.get("Type"): state[mmsi]["type"] = sd["Type"]
                        if sd.get("Destination"): state[mmsi]["dest"] = sd["Destination"].strip()
                        bow = sd.get("ToBow", 0) or 0
                        stern = sd.get("ToStern", 0) or 0
                        if bow or stern:
                            state[mmsi]["length_m"] = bow + stern
                    continue
                if mt != "PositionReport":
                    continue
                pos = (msg.get("Message") or {}).get("PositionReport") or {}
                lat = meta.get("latitude"); lng = meta.get("longitude")
                if not (lat and lng) or (lat == 0 and lng == 0):
                    continue
                heading = pos.get("TrueHeading") or pos.get("Cog") or 0
                if heading >= 360: heading = pos.get("Cog") or 0
                sog = pos.get("Sog") or 0

                prev = state.get(mmsi)
                now_ms = int(time.time() * 1000)
                if prev and GATE_LAT_MIN <= lat <= GATE_LAT_MAX:
                    prev_side = "east" if prev["lng"] > GATE_LNG else "west"
                    curr_side = "east" if lng > GATE_LNG else "west"
                    if prev_side != curr_side:
                        crossing = {
                            "mmsi": mmsi,
                            "name": name or prev.get("name") or f"MMSI {mmsi}",
                            "dir": "eastbound" if curr_side == "east" else "westbound",
                            "time": now_ms,
                            "lat": lat, "lng": lng
                        }
                        transits.append(crossing)
                        if mmsi not in existing_mmsi_crossings:
                            crossing_imos.append({"mmsi": mmsi, "time": now_ms})
                            existing_mmsi_crossings.add(mmsi)

                state[mmsi] = {
                    **(prev or {}),
                    "lat": lat, "lng": lng, "sog": sog, "heading": heading,
                    "category": categorize(lat, lng, sog, heading),
                    "lastSeen": now_ms,
                    "name": name or (prev and prev.get("name")) or f"MMSI {mmsi}",
                }
    except (websockets.exceptions.ConnectionClosedError,
            websockets.exceptions.ConnectionClosed,
            asyncio.exceptions.IncompleteReadError) as e:
        # AISStream closes the WS without a close-frame when the API key is rejected.
        # Surface the actual cause so debug isn't guesswork next time.
        connection_closed_early = True
        print(f"  ✗ AISStream closed the WebSocket without a close-frame · {type(e).__name__}: {e}")
        print(f"    Most likely · AIS_KEY rejected (revoked / expired / trailing whitespace / "
              f"monthly bandwidth quota at https://aisstream.io/login).")
        print(f"    Less likely · AISStream service incident.")
        if len(error_samples) < 3:
            error_samples.append(f"ws-close: {type(e).__name__}: {str(e)[:150]}")

    # Diagnostics
    if msg_count == 0 and other_msgs == 0:
        if connection_closed_early:
            print(f"  ⚠ ZERO messages because WebSocket closed mid-subscription · see error above")
        else:
            print(f"  ⚠ ZERO messages received in {LISTEN_DURATION}s. Likely: (1) AIS_KEY rejected silently, "
                  f"(2) AISStream rate-limited, (3) no broadcasts in bbox (unlikely for Persian Gulf).")
    if other_msgs > 0:
        print(f"  ⚠ Received {other_msgs} non-position frames (possible errors). Samples:")
        for s in error_samples:
            print(f"     {s}")
    return state, transits, crossing_imos, msg_count


def prune(state, transits, crossing_imos):
    now_ms = int(time.time() * 1000)
    transits = [t for t in transits if (now_ms - t["time"]) < TRANSIT_WINDOW_MS]
    crossing_imos = [c for c in crossing_imos if (now_ms - c["time"]) < TRANSIT_WINDOW_MS]
    state = {m: v for m, v in state.items() if (now_ms - v.get("lastSeen", 0)) < STATE_TTL_MS}
    return state, transits, crossing_imos


def main():
    print(f"=== AIS scrape at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    # Load previous state
    prev_blob = kv_get("ais_state") or {}
    state = prev_blob.get("vesselState") or {}
    transits = prev_blob.get("transits24h") or []
    crossing_imos = prev_blob.get("crossing_imos_24h") or []
    print(f"  Loaded: {len(state)} vessels, {len(transits)} transits in last 24h, {len(crossing_imos)} unique IMOs crossing")
    # Listen + capture
    state, transits, crossing_imos, msg_count = asyncio.run(listen_and_capture(state, transits, crossing_imos))
    # Prune
    state, transits, crossing_imos = prune(state, transits, crossing_imos)
    # Categorize counts
    cats = {"transit": 0, "anchored": 0, "approach": 0}
    for v in state.values():
        c = v.get("category")
        if c in cats: cats[c] += 1
    east = sum(1 for t in transits if t["dir"] == "eastbound")
    west = sum(1 for t in transits if t["dir"] == "westbound")
    # Real-time aggregate: ship class breakdown + directional snapshot from current state
    type_counts, inbound_now, outbound_now = aggregate_state(state)
    # Write back
    payload = {
        "fetchedAt": int(time.time()),
        "vesselState": state,
        "transits24h": transits,
        "crossing_imos_24h": crossing_imos,
        "typeBreakdown": type_counts,          # { "VLCC": 5, "Suezmax": 3, ... }
        "currentInbound": inbound_now,         # snapshot count, not 24h
        "currentOutbound": outbound_now,
        "summary": {
            "transits24h": len(transits),
            "uniqueImos24h": len(crossing_imos),
            "eastbound24h": east,
            "westbound24h": west,
            "categories": cats,
            "vesselCount": len(state),
            "lastListenSec": LISTEN_DURATION,
            "messagesProcessed": msg_count,
            "typeBreakdown": type_counts,
            "currentInbound": inbound_now,
            "currentOutbound": outbound_now,
        }
    }
    body = json.dumps(payload, separators=(",", ":"))
    # KV "ais_state" shape:
    #   { fetchedAt: unix_seconds, lastListenSec: int, messagesProcessed: int,
    #     vesselCount: int, transits24h: int, eastbound24h: int, westbound24h: int,
    #     categories: {transit: int, anchored: int, approach: int},
    #     crossing_imos_24h: [str], hasState: bool,
    #     typeBreakdown: { "VLCC": int, "Suezmax": int, "Aframax": int,
    #                      "Panamax tanker": int, "Small tanker": int, "Tanker": int,
    #                      "Cargo": int, "Passenger": int, "Fishing": int,
    #                      "Military": int, "High-speed": int, "Service": int,
    #                      "Other": int, "Unknown": int },
    #     currentInbound: int (transit vessels heading 250-320, westbound),
    #     currentOutbound: int (transit vessels heading 70-140, eastbound) }
    ok = kv_put("ais_state", body)
    # P8 — surface scrape status for /health
    try:
        status_body = json.dumps({
            "fetchedAt": int(time.time()),
            "ok": bool(ok and msg_count > 0),
            "messageCount": msg_count,
            "vesselCount": len(state),
            "job": "vessel-sync",
        }, separators=(",", ":"))
        kv_put("scrape_status_ais", status_body)
    except Exception as e:
        print(f"  warn: scrape_status_ais write failed: {e}")
    if not ok:
        print("  KV write FAILED"); sys.exit(1)
    print(f"  ✓ KV write OK ({len(body)} bytes, {msg_count} messages, {len(state)} vessels, {len(transits)} transits, {len(crossing_imos)} unique IMOs, cats={cats})")


if __name__ == "__main__":
    main()
