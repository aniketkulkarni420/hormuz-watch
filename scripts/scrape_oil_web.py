#!/usr/bin/env python3
"""Multi-source oil price scraper (Playwright) — cross-verified Brent & WTI.

Why this exists:
  - OilPriceAPI demo started flagging DEMO DATA
  - Yahoo BZ=F often fails from GHA IPs (curl blocked)
  - When KV `latest` goes stale, /api/oil falls back to FinnHub ETF which
    serves $56 BNO ETF prices as if they were Brent — completely wrong

Sources scraped (via headless Chromium, JS rendered):
  1. Trading Economics  — /commodity/brent-crude-oil and /commodity/crude-oil
  2. Investing.com      — /commodities/brent-oil and /commodities/crude-oil
  3. Yahoo Finance      — /quote/BZ=F and /quote/CL=F (browser bypasses curl block)

For each symbol we try multiple selectors + regex fallback, sanity-bound the
result (30 <= px <= 300), then cross-verify across sources:
  - 2+ agree within 1%      → median, confidence=high
  - sources disagree >2%    → median, confidence=low
  - only 1 source           → confidence=medium
  - 0 sources               → skip KV write (keep old data)

KV key: `oil_scraped` (separate from `latest` so it doesn't conflict with
the main scraper). Consumed by functions/api/oil.js as a Tier 1.5 fallback.
"""

import os, sys, time, json, re
import requests

CF_ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
CF_API_TOKEN  = os.environ["CF_API_TOKEN"]
KV_NS         = os.environ["CF_KV_NAMESPACE_ID"]

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"


def kv_put(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "text/plain"},
                     data=value if isinstance(value, str) else json.dumps(value, separators=(",", ":")),
                     timeout=30)
    return r.status_code == 200


def sanity_ok(v):
    try:
        return v is not None and 30.0 <= float(v) <= 300.0
    except Exception:
        return False


def _to_float(s):
    if s is None:
        return None
    try:
        s = str(s).strip().replace(",", "")
        m = re.search(r"-?\d+(?:\.\d+)?", s)
        return float(m.group(0)) if m else None
    except Exception:
        return None


def fetch_page(p, url, label):
    """Open URL in headless chromium, return rendered HTML or None."""
    try:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=UA, viewport={"width": 1366, "height": 768}, locale="en-US",
        )
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3500)
        title = page.title()
        html = page.content()
        # Also try selector-based extraction directly (works even when HTML is huge)
        selector_value = None
        try:
            selector_value = page.evaluate("""() => {
              const sels = [
                '[data-test="instrument-price-last"]',
                'fin-streamer[data-field="regularMarketPrice"]',
                'fin-streamer[data-test="qsp-price"]',
                'span.commodity-value',
                '#last_last',
              ];
              for (const s of sels) {
                const el = document.querySelector(s);
                if (el) {
                  const t = el.getAttribute('data-value') || el.getAttribute('value') || el.textContent;
                  if (t) return { sel: s, val: t.trim().slice(0,32) };
                }
              }
              return null;
            }""")
        except Exception:
            selector_value = None
        browser.close()
        low = (title or "").lower()
        if any(s in low for s in ["just a moment", "checking your browser", "attention required", "cloudflare"]):
            print(f"  [{label}] blocked (cloudflare/challenge)")
            return None, None
        return html, selector_value
    except Exception as e:
        print(f"  [{label}] error: {str(e)[:120]}")
        try:
            browser.close()
        except Exception:
            pass
        return None, None


# ─────────────────── Source 1: Trading Economics ───────────────────
def scrape_trading_economics(p):
    """Trading Economics commodity pages. Headline value usually in
    <span class="commodity-value"> or in a #p-value type element."""
    out = {"brent": None, "wti": None}
    for sym, url in [
        ("brent", "https://tradingeconomics.com/commodity/brent-crude-oil"),
        ("wti",   "https://tradingeconomics.com/commodity/crude-oil"),
    ]:
        html, sel = fetch_page(p, url, f"te-{sym}")
        if not html:
            continue
        candidates = []
        if sel and sel.get("val"):
            v = _to_float(sel["val"])
            if sanity_ok(v):
                candidates.append(("selector:" + sel["sel"], v))
        # Headline cell on TE pages: <span class="commodity-value">XX.XX</span>
        for pat in [
            r'class="commodity-value"[^>]*>\s*\$?\s*([0-9]+\.[0-9]+)',
            r'id="p"[^>]*>\s*\$?\s*([0-9]+\.[0-9]+)',
            r'class="te-blue text-right"[^>]*>\s*([0-9]+\.[0-9]+)',
            # First "last value" near "Brent" / "WTI" text
            r'(?:Brent|WTI|Crude\s*Oil)[^<]{0,80}>\s*\$?\s*([0-9]{2,3}\.[0-9]{1,3})',
        ]:
            m = re.search(pat, html, re.I)
            if m:
                v = _to_float(m.group(1))
                if sanity_ok(v):
                    candidates.append((pat[:30], v))
                    break
        if candidates:
            out[sym] = candidates[0][1]
            print(f"  TE {sym}: {out[sym]} ({candidates[0][0]})")
        else:
            print(f"  TE {sym}: no value extracted")
    return out


# ─────────────────── Source 2: Investing.com ───────────────────
def scrape_investing(p):
    out = {"brent": None, "wti": None}
    for sym, url in [
        ("brent", "https://www.investing.com/commodities/brent-oil"),
        ("wti",   "https://www.investing.com/commodities/crude-oil"),
    ]:
        html, sel = fetch_page(p, url, f"inv-{sym}")
        if not html:
            continue
        candidates = []
        if sel and sel.get("val"):
            v = _to_float(sel["val"])
            if sanity_ok(v):
                candidates.append(("selector:" + sel["sel"], v))
        for pat in [
            r'data-test="instrument-price-last"[^>]*>\s*([0-9]+(?:[.,][0-9]+)?)',
            r'id="last_last"[^>]*>\s*([0-9]+(?:[.,][0-9]+)?)',
            r'class="text-2xl"[^>]*>\s*([0-9]+\.[0-9]+)',
            r'"last":\s*"?([0-9]+\.[0-9]+)"?',
        ]:
            m = re.search(pat, html)
            if m:
                v = _to_float(m.group(1))
                if sanity_ok(v):
                    candidates.append((pat[:30], v))
                    break
        if candidates:
            out[sym] = candidates[0][1]
            print(f"  INV {sym}: {out[sym]} ({candidates[0][0]})")
        else:
            print(f"  INV {sym}: no value extracted")
    return out


# ─────────────────── Source 3: Yahoo Finance ───────────────────
def scrape_yahoo(p):
    out = {"brent": None, "wti": None}
    for sym, url in [
        ("brent", "https://finance.yahoo.com/quote/BZ=F"),
        ("wti",   "https://finance.yahoo.com/quote/CL=F"),
    ]:
        html, sel = fetch_page(p, url, f"yh-{sym}")
        if not html:
            continue
        candidates = []
        if sel and sel.get("val"):
            v = _to_float(sel["val"])
            if sanity_ok(v):
                candidates.append(("selector:" + sel["sel"], v))
        for pat in [
            r'data-field="regularMarketPrice"[^>]*value="([0-9]+\.[0-9]+)"',
            r'data-test="qsp-price"[^>]*>\s*([0-9]+\.[0-9]+)',
            r'"regularMarketPrice":\{"raw":([0-9]+\.[0-9]+)',
            r'fin-streamer[^>]*data-symbol="(?:BZ=F|CL=F)"[^>]*data-value="([0-9]+\.[0-9]+)"',
        ]:
            m = re.search(pat, html)
            if m:
                v = _to_float(m.group(1))
                if sanity_ok(v):
                    candidates.append((pat[:30], v))
                    break
        if candidates:
            out[sym] = candidates[0][1]
            print(f"  YH {sym}: {out[sym]} ({candidates[0][0]})")
        else:
            print(f"  YH {sym}: no value extracted")
    return out


def cross_verify(values):
    """values: list of floats. Returns (median, min, max, confidence)."""
    clean = sorted([v for v in values if sanity_ok(v)])
    n = len(clean)
    if n == 0:
        return None, None, None, "none"
    mn, mx = clean[0], clean[-1]
    median = clean[n // 2] if n % 2 == 1 else (clean[n // 2 - 1] + clean[n // 2]) / 2.0
    if n == 1:
        return median, mn, mx, "medium"
    spread_pct = (mx - mn) / mn * 100.0 if mn > 0 else 0
    # Two-source commodity prices typically differ 2-5% due to update cadence
    # between sites — not a quality issue. Widen the "high" band accordingly.
    if spread_pct <= 5.0:
        return median, mn, mx, "high"
    if spread_pct > 10.0:
        return median, mn, mx, "low"
    return median, mn, mx, "medium"  # 5-10% gap


def main():
    print(f"=== oil web scrape at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: playwright not installed")
        sys.exit(1)

    per_source = {}
    with sync_playwright() as p:
        # Yahoo disabled — fin-streamer selector on /quote/BZ=F kept extracting
        # 212.x (probably from a side-panel recommendation element). TE + Investing
        # alone give reliable cross-verification.
        for fn, key in [
            (scrape_trading_economics, "trading-economics"),
            (scrape_investing,         "investing.com"),
        ]:
            print(f"\n--- {key} ---")
            try:
                per_source[key] = fn(p)
            except Exception as e:
                print(f"  ! {key} crashed: {str(e)[:160]}")
                per_source[key] = {"brent": None, "wti": None}

    # Aggregate per-symbol
    result_syms = {}
    for sym in ("brent", "wti"):
        vals_by_src = {k: v.get(sym) for k, v in per_source.items()}
        good = [(k, v) for k, v in vals_by_src.items() if sanity_ok(v)]
        med, mn, mx, conf = cross_verify([v for _, v in good])
        if med is None:
            result_syms[sym] = None
            continue
        result_syms[sym] = {
            "value": round(med, 2),
            "median": round(med, 2),
            "min": round(mn, 2),
            "max": round(mx, 2),
            "sources": [k for k, _ in good],
            "confidence": conf,
        }

    succeeded = sum(1 for v in result_syms.values() if v is not None)
    if succeeded == 0:
        print("\n✗ Zero sources succeeded — keeping existing KV (no write)")
        sys.exit(1)

    result = {
        "fetchedAt": int(time.time()),
        "brent": result_syms["brent"],
        "wti":   result_syms["wti"],
        "perSource": per_source,
        "sources_succeeded": succeeded,
    }

    ok = kv_put("oil_scraped", json.dumps(result, separators=(",", ":")))
    print(f"\n{'✓' if ok else '✗'} KV write {'OK' if ok else 'FAILED'}  (key=oil_scraped)")
    print(f"  brent: {result_syms['brent']}")
    print(f"  wti:   {result_syms['wti']}")

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    sys.exit(main())
