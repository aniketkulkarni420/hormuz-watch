#!/usr/bin/env python3
"""oilprice.com niche blends — Iran Heavy discount + Murban bypass premium.

Why (2026-06-10, user-approved): two Hormuz signals nobody serves free:
  - Iran Heavy vs Brent DISCOUNT — how hard sanctions bite Iranian crude pricing
  - Murban vs Brent PREMIUM — Murban loads at Fujairah, OUTSIDE the strait;
    a widening premium = the market paying to avoid Hormuz transit risk
We do NOT take Brent/WTI from here (our Yahoo+OPA cross-verify is better).

Source markup (static HTML, no challenge as of 2026-06-10):
  <tr data-name='Iran-Heavy' ...>
    <td class='last_price' data-price='87.55'>87.55</td>
    <td class='change_down ...'>-4.11</td><td ...>-4.48%...</td>
    <td class='last_updated' data-stamp='1780981200'>(1-day Delay)</td>
Quotes are DELAYED (~1 day) — we store each blend's own data-stamp and compute
spreads against oilprice's OWN Brent row (same staleness) so the spread is
apples-to-apples, never against our live cross-verified Brent.

Writes KV `oilprice_blends`:
  { fetchedAt, blends: {brent|iran_heavy|murban: {price, change, change_pct,
    stamp, stamp_age_h}}, iran_heavy_discount, murban_premium }

Guards: bounds 30-250 per price, stamp must be <7d old, missing rows -> keep
last-good + exit non-zero (pipefail in workflow).
"""
import os, sys, time, json, re
import requests

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN", "")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID", "")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
URL = "https://oilprice.com/oil-price-charts/"

# data-name on oilprice.com -> our key
BLENDS = {"Brent-Crude": "brent", "Iran-Heavy": "iran_heavy", "Murban": "murban"}


def parse_blend_row(html, data_name):
    """Extract {price, change, change_pct, stamp} for one data-name row."""
    m = re.search(r"data-name='" + re.escape(data_name) + r"'.*?data-stamp='(\d+)'", html, re.S)
    row = None
    rm = re.search(r"data-name='" + re.escape(data_name) + r"'(.{0,1500}?)</tr>", html, re.S)
    if rm:
        row = rm.group(1)
    if not row:
        return None
    pm = re.search(r"data-price='([\d.]+)'", row)
    if not pm:
        return None
    price = float(pm.group(1))
    chm = re.search(r"class='change_(?:down|up)[^']*'>([+\-]?[\d.]+)<", row)
    pcm = re.search(r"class='change_(?:down|up)_percent[^']*'>([+\-]?[\d.]+)%", row)
    sm = re.search(r"data-stamp='(\d+)'", row)
    stamp = int(sm.group(1)) if sm else None
    return {
        "price": price,
        "change": float(chm.group(1)) if chm else None,
        "change_pct": float(pcm.group(1)) if pcm else None,
        "stamp": stamp,
        "stamp_age_h": round((time.time() - stamp) / 3600, 1) if stamp else None,
    }


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
    print(f"=== oilprice blends [{'DRY' if dry else 'LIVE'}] at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    try:
        r = requests.get(URL, headers={"User-Agent": UA}, timeout=25)
        if not r.ok:
            print(f"  ✗ HTTP {r.status_code}")
            return 1
        html = r.text
    except Exception as e:
        print(f"  ✗ fetch failed: {str(e)[:160]}")
        return 1

    out = {}
    for dn, key in BLENDS.items():
        b = parse_blend_row(html, dn)
        if not b:
            print(f"  {key}: row not found / unparsable")
            continue
        if not (30.0 <= b["price"] <= 250.0):
            print(f"  {key}: price {b['price']} out of bounds — dropping")
            continue
        if b["stamp_age_h"] is not None and b["stamp_age_h"] > 7 * 24:
            print(f"  {key}: quote {b['stamp_age_h']}h old (>7d) — dropping")
            continue
        out[key] = b
        print(f"  {key}: {b['price']}  Δ{b['change']} ({b['change_pct']}%)  quote-age {b['stamp_age_h']}h")

    # Both target blends AND the same-source Brent leg are required — the
    # spreads are the product, the levels are just context.
    if not ("brent" in out and ("iran_heavy" in out or "murban" in out)):
        print("  ✗ required rows missing — keeping last-good KV, exiting non-zero")
        return 1

    payload = {
        "fetchedAt": int(time.time()),
        "blends": out,
        # Spreads vs oilprice's OWN Brent (same delay) — apples-to-apples.
        "iran_heavy_discount": round(out["brent"]["price"] - out["iran_heavy"]["price"], 2) if "iran_heavy" in out else None,
        "murban_premium":      round(out["murban"]["price"] - out["brent"]["price"], 2) if "murban" in out else None,
        "source": "oilprice.com oil-price-charts (delayed quotes; per-blend stamps)",
    }
    print(f"  iran_heavy_discount={payload['iran_heavy_discount']}  murban_premium={payload['murban_premium']}")
    if dry:
        return 0
    ok = kv_put("oilprice_blends", json.dumps(payload, separators=(",", ":")))
    print(f"{'✓' if ok else '✗'} KV write {'OK' if ok else 'FAILED'} (key=oilprice_blends)")
    return 0 if ok else 1


if __name__ == "__main__":
    from _status import write_status
    _rc = 1
    try:
        _rc = main()
    finally:
        try:
            write_status("oilprice_blends", ok=(_rc == 0))
        except Exception:
            pass
    sys.exit(_rc)
