#!/usr/bin/env python3
"""IMF PortWatch — daily Strait of Hormuz transit calls (chokepoint6).

THE missing measurement (2026-06-12): true strait transits per day, by vessel
class, from IMF+Oxford (UN Global Platform AIS). Free open ArcGIS API, no key.
Verified live: latest Jun 7 = 2 transits (1 tanker) vs pre-war baseline 83.9
(45.8 tankers) — the blockade quantified at 2.4% of normal.

Cadence: PortWatch updates weekly (Tuesdays) with daily granularity → data is
LAGGED ~5-10 days. Surfaced with explicit as-of labels; feeds the verdict
engine's transits slot (the slot has been honestly empty since the in-port
inversion was removed) with lag noted.

Writes KV `portwatch_state`:
  { fetchedAt, as_of, latest: {date,total,tanker,cargo}, avg7: {total,tanker},
    prewar_baseline: {total,tanker},  # computed live from Jan1-Feb26 window
    pct_of_prewar, series: [last 14 {date,total,tanker}] }

Guards: bounds 0-500/day, empty result keeps last-good + exit 1 (pipefail).
"""
import os, sys, time, json
import requests

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN", "")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID", "")

BASE = ("https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/"
        "Daily_Chokepoints_Data/FeatureServer/0/query")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def q(params):
    p = {"f": "json", "where": "portid='chokepoint6'"}
    p.update(params)
    r = requests.get(BASE, params=p, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    d = r.json()
    if "error" in d:
        raise RuntimeError(str(d["error"])[:160])
    return d


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
    print(f"=== PortWatch Hormuz [{'DRY' if dry else 'LIVE'}] at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    try:
        recent = q({"outFields": "date,n_total,n_tanker,n_cargo",
                    "orderByFields": "date DESC", "resultRecordCount": 14})
        feats = recent.get("features") or []
    except Exception as e:
        print(f"  ✗ recent query failed: {str(e)[:160]}")
        return 1
    if not feats:
        print("  ✗ zero records — keeping last-good KV")
        return 1

    series = []
    for f in feats:
        a = f["attributes"]
        t = a.get("n_total")
        if t is None or not (0 <= t <= 500):
            continue
        series.append({"date": str(a.get("date"))[:10],
                       "total": t, "tanker": a.get("n_tanker"), "cargo": a.get("n_cargo")})
    if not series:
        print("  ✗ all records failed bounds — keeping last-good KV")
        return 1
    latest = series[0]
    avg7_t = round(sum(s["total"] for s in series[:7]) / min(7, len(series)), 1)
    avg7_k = round(sum((s["tanker"] or 0) for s in series[:7]) / min(7, len(series)), 1)

    # Pre-war baseline, computed live (fixed window: Jan 1 – Feb 26, 2026)
    base_t, base_k = 83.9, 45.8   # fallback = values verified 2026-06-12
    try:
        st = q({"where": "portid='chokepoint6' AND date >= '2026-01-01' AND date < '2026-02-27'",
                "outStatistics": json.dumps([
                    {"statisticType": "avg", "onStatisticField": "n_total", "outStatisticFieldName": "avg_total"},
                    {"statisticType": "avg", "onStatisticField": "n_tanker", "outStatisticFieldName": "avg_tanker"}])})
        a = (st.get("features") or [{}])[0].get("attributes", {})
        if a.get("avg_total"):
            base_t = round(a["avg_total"], 1)
            base_k = round(a.get("avg_tanker") or base_k, 1)
    except Exception as e:
        print(f"  warn: baseline query failed, using cached baseline: {str(e)[:100]}")

    pct = round(avg7_t / base_t * 100, 1) if base_t else None
    out = {
        "fetchedAt": int(time.time()),
        "as_of": latest["date"],
        "latest": latest,
        "avg7": {"total": avg7_t, "tanker": avg7_k},
        "prewar_baseline": {"total": base_t, "tanker": base_k},
        "pct_of_prewar": pct,
        "series": series,
        "source": "IMF PortWatch chokepoint6 (UN Global Platform AIS) · weekly update, daily granularity",
    }
    print(f"  as_of {latest['date']} · latest {latest['total']} ({latest['tanker']} tankers) · "
          f"7d-avg {avg7_t} · pre-war {base_t} · {pct}% of pre-war")
    if dry:
        return 0
    ok = kv_put("portwatch_state", json.dumps(out, separators=(",", ":")))
    print(f"{'✓' if ok else '✗'} KV write {'OK' if ok else 'FAILED'} (key=portwatch_state)")
    return 0 if ok else 1


if __name__ == "__main__":
    from _status import write_status
    _rc = 1
    try:
        _rc = main()
    finally:
        try:
            write_status("portwatch", ok=(_rc == 0))
        except Exception:
            pass
    sys.exit(_rc)
