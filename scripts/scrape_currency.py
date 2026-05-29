#!/usr/bin/env python3
"""Iranian Rial (IRR) + UAE Dirham (AED) FX scraper — capital flight proxy.

Rationale:
  Iran runs a dual exchange rate. The "black-market" / "free-market" rate
  (bonbast.com) reflects what Iranians actually pay for hard currency. Sharp
  black-market depreciation has historically preceded Iranian escalation by
  ~2-4 weeks.

  NOTE on the spread baseline (Batch D · 2026-05-14): the `official` field is
  open.er-api.com — a MID-MARKET AGGREGATE, not the CBI state-controlled rate.
  So `spread_pct` measures "black-market vs mid-market premium", NOT "black vs
  official". A true CBI-official comparison would show a much larger spread.
  See `spread_basis` in the output.

Sources (Playwright, browser-rendered):
  1. Yahoo Finance       — finance.yahoo.com/quote/IRR=X  (official USD/IRR)
  2. XE.com              — xe.com/currencyconverter ?From=USD&To=IRR (backup official)
  3. bonbast.com         — bonbast.com (black-market USD/IRR)
  4. Yahoo / XE for AED  — USD/AED (sanity check + companion FX)

Sanity bounds:
  IRR/USD: 30,000 - 5,000,000 (covers theoretical floor + deep-crisis ceiling;
           5M rial ≈ 500k toman leaves headroom above current ~600k-1M rial)
  AED/USD: 3.5 - 4.0 (pegged ≈ 3.6725)

Output to KV `currency_irr` (JSON):
  {
    fetchedAt: <unix_seconds>,
    official:     { usd_irr: 42000,  src: "yahoo" },
    blackMarket:  { usd_irr: 580000, src: "bonbast.com" },
    spread_pct:   1280,    // (black - official) / official * 100
    aed_usd:      3.67,
    sources_succeeded: 3,
    interpretation: "wide spread = capital flight / sanction pressure"
  }
"""

import os
import sys
import time
import json
import re
import requests

SITE_URL      = os.environ.get("SITE_URL", "https://hormuz-watch-2.pages.dev")
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN", "")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID", "")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"

IRR_MIN, IRR_MAX = 30_000, 5_000_000
AED_MIN, AED_MAX = 3.5, 4.0


def _to_float(s):
    if s is None:
        return None
    try:
        s = str(s).strip().replace(",", "").replace("٬", "")  # arabic thousands sep
        m = re.search(r"-?\d+(?:\.\d+)?", s)
        return float(m.group(0)) if m else None
    except Exception:
        return None


def sanity_irr(v):
    try:
        return v is not None and IRR_MIN <= float(v) <= IRR_MAX
    except Exception:
        return False


def sanity_aed(v):
    try:
        return v is not None and AED_MIN <= float(v) <= AED_MAX
    except Exception:
        return False


def fetch_page(p, url, label, wait_selector=None, wait_ms=4000):
    browser = None
    try:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=UA, viewport={"width": 1366, "height": 900}, locale="en-US",
        )
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=35000)
        if wait_selector:
            try:
                page.wait_for_selector(wait_selector, timeout=8000)
            except Exception:
                pass
        page.wait_for_timeout(wait_ms)
        title = page.title()
        html = page.content()
        browser.close()
        low = (title or "").lower()
        if any(s in low for s in ["just a moment", "checking your browser", "attention required"]):
            print(f"  [{label}] blocked (cloudflare/challenge)")
            return None
        return html
    except Exception as e:
        print(f"  [{label}] error: {str(e)[:160]}")
        try:
            if browser:
                browser.close()
        except Exception:
            pass
        return None


# ───── Source 1: Yahoo Finance — USD/IRR (official-ish) ─────
def scrape_yahoo_irr(p):
    url = "https://finance.yahoo.com/quote/IRR=X"
    html = fetch_page(p, url, "yahoo-irr", wait_ms=5000,
                      wait_selector='fin-streamer[data-symbol="IRR=X"]')
    if not html:
        return None
    for pat in [
        r'data-symbol="IRR=X"[^>]*data-field="regularMarketPrice"[^>]*value="([\d\.]+)"',
        r'data-symbol="IRR=X"[^>]*data-field="regularMarketPrice"[^>]*>\s*([\d,\.]+)',
        r'"regularMarketPrice"\s*:\s*\{?\s*"raw"\s*:\s*([\d\.]+)',
        r'"symbol":"IRR=X"[^}]*?"regularMarketPrice"[^}]*?"raw":([\d\.]+)',
    ]:
        m = re.search(pat, html)
        if m:
            v = _to_float(m.group(1))
            if sanity_irr(v):
                print(f"  YAHOO IRR: {v}")
                return v
    print("  YAHOO IRR: no value extracted")
    return None


# ───── Source 2: XE.com — USD/IRR (backup official) ─────
def scrape_xe_irr(p):
    url = "https://www.xe.com/currencyconverter/convert/?Amount=1&From=USD&To=IRR"
    html = fetch_page(p, url, "xe-irr", wait_ms=6000)
    if not html:
        return None
    for pat in [
        r'(\d{2,3}(?:,\d{3})+(?:\.\d+)?)\s*Iranian\s*Ria',
        r'1\s*US\s*Dollar[^<]{0,60}?=\s*([\d,\.]+)\s*Iran',
        r'data-cy="result-display"[^>]*>\s*([\d,\.]+)',
    ]:
        m = re.search(pat, html, re.I)
        if m:
            v = _to_float(m.group(1))
            if sanity_irr(v):
                print(f"  XE IRR: {v}")
                return v
    print("  XE IRR: no value extracted")
    return None


# ───── Source 3: bonbast.com — black-market USD/IRR ─────
def scrape_bonbast(p):
    url = "https://bonbast.com/"
    html = fetch_page(p, url, "bonbast", wait_ms=6000)
    if not html:
        return None
    # bonbast renders rial values directly; values typically in toman or rial
    # bonbast shows USD in toman by default (1 toman = 10 rial)
    for pat in [
        r'id="usd1"[^>]*>\s*([\d,\.]+)',
        r'"usd"\s*:\s*"?([\d,\.]+)"?',
        r'USD[^<]{0,60}?<[^>]*>\s*([\d,\.]+)\s*<',
    ]:
        m = re.search(pat, html, re.I)
        if m:
            v = _to_float(m.group(1))
            if v is None:
                continue
            # bonbast.com publishes the USD rate in TOMAN, always (1 toman =
            # 10 rial) → convert unconditionally. The old heuristic only
            # multiplied when v was in [10k,250k], so it SILENTLY STOPPED
            # converting above 250k toman — under-reporting the rate 10x
            # exactly during a crisis, when this signal matters most.
            # (Batch D · 2026-05-14)
            v = v * 10  # toman → rial
            if sanity_irr(v):
                print(f"  BONBAST IRR (black-market): {v}")
                return v
    print("  BONBAST: no value extracted")
    return None


# ───── Source 4: Yahoo AED ─────
def scrape_yahoo_aed(p):
    url = "https://finance.yahoo.com/quote/AED=X"
    html = fetch_page(p, url, "yahoo-aed", wait_ms=5000,
                      wait_selector='fin-streamer[data-symbol="AED=X"]')
    if not html:
        return None
    for pat in [
        r'data-symbol="AED=X"[^>]*data-field="regularMarketPrice"[^>]*value="([\d\.]+)"',
        r'data-symbol="AED=X"[^>]*data-field="regularMarketPrice"[^>]*>\s*([\d\.]+)',
        r'"symbol":"AED=X"[^}]*?"regularMarketPrice"[^}]*?"raw":([\d\.]+)',
    ]:
        m = re.search(pat, html)
        if m:
            v = _to_float(m.group(1))
            if sanity_aed(v):
                print(f"  YAHOO AED: {v}")
                return v
    print("  YAHOO AED: no value extracted")
    return None


def kv_put(key, value):
    if not (CF_ACCOUNT_ID and CF_API_TOKEN and KV_NS):
        print("  KV creds missing — cannot write")
        return False
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(
        url,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
        data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
        timeout=30,
    )
    return r.status_code == 200


def main():
    dry_run = "--dry-run" in sys.argv
    mode = "DRY RUN" if dry_run else "LIVE"
    print(f"=== Currency (IRR + AED) scrape [{mode}] at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: playwright not installed")
        return 1

    official_irr = None
    official_src = None
    black_irr = None
    black_src = None
    aed_usd = None
    succeeded = 0

    # Free FX API — no auth, clean JSON. Faster + more reliable than Playwright scrapes.
    print("\n--- open.er-api.com (free FX API: free-market IRR + AED + SAR + OMR) ---")
    try:
        r = requests.get("https://open.er-api.com/v6/latest/USD", timeout=15, headers={"User-Agent": UA})
        if r.status_code == 200:
            d = r.json()
            rates = d.get("rates", {})
            irr_rate = rates.get("IRR")
            aed_rate = rates.get("AED")
            if irr_rate and sanity_irr(irr_rate):
                official_irr = float(irr_rate)
                # NOT the CBI official rate — open.er-api is a mid-market
                # aggregate. spread_pct below is therefore "black vs mid-market
                # premium", not "black vs official". (Batch D · 2026-05-14)
                official_src = "open.er-api.com (mid-market aggregate — NOT CBI official)"
                succeeded += 1
                print(f"  ✓ USD/IRR (mid-market aggregate): {official_irr:,.0f}")
            if aed_rate and sanity_aed(aed_rate):
                aed_usd = float(aed_rate)
                succeeded += 1
                print(f"  ✓ USD/AED: {aed_usd:.4f}")
            # Bonus: track Saudi Riyal + Omani Rial as additional Gulf currency context
            sar = rates.get("SAR"); omr = rates.get("OMR")
            if sar: print(f"  ✓ USD/SAR: {sar:.4f}")
            if omr: print(f"  ✓ USD/OMR: {omr:.4f}")
        else:
            print(f"  open.er-api HTTP {r.status_code}")
    except Exception as e:
        print(f"  open.er-api exception: {str(e)[:120]}")

    with sync_playwright() as p:
        print("\n--- bonbast (black-market USD/IRR — Iranian unofficial rate) ---")
        v = scrape_bonbast(p)
        if sanity_irr(v):
            black_irr, black_src = v, "bonbast.com"
            succeeded += 1

    spread_pct = None
    if official_irr and black_irr and official_irr > 0:
        spread_pct = round((black_irr - official_irr) / official_irr * 100.0, 1)

    # Bands recalibrated 2026-05-15.
    # `spread_pct` here is black-market (bonbast) vs mid-market aggregate
    # (open.er-api) — NOT black-vs-CBI. The mid-market aggregate tracks much
    # closer to the parallel market than CBI does, so the typical spread is
    # 10-60%, NOT the 200-1000% you'd see against the CBI official rate.
    # Old bands (>=500 extreme, >=200 wide, >=50 moderate, else narrow) were
    # calibrated for black-vs-CBI and labelled 46.5% as "stable", which is
    # wrong for this basis.
    interpretation = "insufficient data"
    if spread_pct is not None:
        if spread_pct >= 80:
            interpretation = "extreme spread — currency-crisis territory (run-on-rial)"
        elif spread_pct >= 40:
            interpretation = "wide spread — significant parallel-market dislocation"
        elif spread_pct >= 15:
            interpretation = "moderate spread — visible FX stress"
        else:
            interpretation = "narrow spread — mid-market and parallel aligned"
    elif official_irr or black_irr:
        interpretation = "partial data — only one IRR rate available"

    payload = {
        "fetchedAt": int(time.time()),
        "official":    {"usd_irr": official_irr, "src": official_src} if official_irr else None,
        "blackMarket": {"usd_irr": black_irr,    "src": black_src}    if black_irr    else None,
        "spread_pct":  spread_pct,
        # Honest label for what spread_pct actually measures (Batch D · 2026-05-14):
        # the `official` leg is a mid-market aggregate, not the CBI official rate.
        "spread_basis": "black-market (bonbast) vs mid-market aggregate (open.er-api) — NOT the CBI official rate",
        "aed_usd":     aed_usd,
        "sources_succeeded": succeeded,
        "interpretation": interpretation,
    }

    print("\n--- result ---")
    print(json.dumps(payload, indent=2))

    if succeeded == 0:
        print("\n✗ Zero sources succeeded — keeping existing KV (no write)")
        return 1

    # 2026-05-28 (Tier 1A): validate before overwriting good KV. Reject an
    # absurd spread (out of 0-150% band). No prior-read helper here, so
    # bounds-only — still catches the garbage class.
    try:
        from _validate import validate
        if spread_pct is not None:
            ok_v, why = validate("irr_spread_pct", spread_pct)
            if not ok_v:
                print(f"\n✗ Validation failed ({why}) — keeping existing KV (no write)")
                return 1
    except Exception as e:
        print(f"  warn: validation skipped: {e}")

    if dry_run:
        print("\nDRY RUN — would write currency_irr to KV")
        return 0

    ok = kv_put("currency_irr", json.dumps(payload, separators=(",", ":")))
    print(f"\n{'✓' if ok else '✗'} KV write: {'OK' if ok else 'FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    # Per-scraper health visibility for /api/diag + watchdog (Batch C · 2026-05-14)
    from _status import write_status
    _rc = main()
    write_status("currency", ok=(_rc == 0))
    sys.exit(_rc)
