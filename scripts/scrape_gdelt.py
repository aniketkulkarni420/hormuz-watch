#!/usr/bin/env python3
"""GDELT 2.0 events feed — geopolitical tension proxy.

KV key: gdelt_state
Schedule: hourly.
"""
import os
import json
import time
import sys
from collections import Counter
import requests

CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID")
CF_API_TOKEN  = os.environ.get("CF_API_TOKEN")
KV_NS         = os.environ.get("CF_KV_NAMESPACE_ID")

if not all([CF_ACCOUNT_ID, CF_API_TOKEN, KV_NS]):
    print("ERROR: Missing CF env vars"); sys.exit(1)

QUERY = ('(Hormuz OR Iran OR "Strait of Hormuz" OR IRGCN) '
         'AND (tanker OR vessel OR oil OR attack OR sanctions)')
URL = ("https://api.gdeltproject.org/api/v2/doc/doc"
       f"?query={requests.utils.quote(QUERY)}"
       "&mode=ArtList&format=json&maxrecords=50&timespan=24h&sort=DateDesc")
# Tone histogram — bins articles by sentiment score [-100, +100]. Used to
# compute neg_tone_pct (share of articles with bin < 0) and avg_tone
# (count-weighted mean). ArtList alone doesn't return per-article tone in
# GDELT 2.0, hence the dedicated ToneChart call. (2026-05-18 — Batch G fix)
TONE_URL = ("https://api.gdeltproject.org/api/v2/doc/doc"
            f"?query={requests.utils.quote(QUERY)}"
            "&mode=ToneChart&format=json&timespan=24h")


def put_kv(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{KV_NS}/values/{key}"
    r = requests.put(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}",
                                   "Content-Type": "text/plain"},
                     data=value, timeout=30)
    return r.status_code == 200


def main():
    print(f"=== gdelt scrape {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} ===")
    def _fail(reason):
        # Real failure path (Batch C · 2026-05-14): flag it so /api/diag and
        # the watchdog see it, and DON'T touch gdelt_state — preserve the
        # previous value rather than clobbering it with a 0-count payload.
        # The old code exited 0 here (silent success on total failure).
        # 2026-05-22: diff-aware status (only writes on transition)
        try:
            from _status import write_status
            write_status("gdelt-scraper", ok=False, reason=reason)
        except Exception: pass
        sys.exit(1)

    # Retry-with-backoff (P1-7 · 2026-06-11): GDELT's doc API flakes for
    # hours at a time (8 consecutive red runs on 06-11, self-recovered).
    # 3 attempts at 0/20/40s absorbs the short wobbles; a real outage still
    # fails loudly after attempt 3 (feed keeps last-good either way).
    data = None
    last_err = "unknown"
    for attempt in range(1, 4):
        if attempt > 1:
            wait = 20 * (attempt - 1)
            print(f"  retry {attempt}/3 after {wait}s ...")
            time.sleep(wait)
        try:
            r = requests.get(URL, timeout=25,
                             headers={"User-Agent": "HormuzWatch-GDELT/1.0"})
        except Exception as e:
            print(f"GDELT request failed (attempt {attempt}): {e}")
            last_err = "request_exception"
            continue
        if r.status_code != 200:
            print(f"GDELT HTTP {r.status_code} (attempt {attempt}): {r.text[:200]}")
            last_err = f"http_{r.status_code}"
            continue
        try:
            data = r.json()
            break
        except Exception:
            # Empty/garbage body — transient error or genuine zero-results;
            # indistinguishable per GDELT docs. Retry, then fail loudly.
            print(f"GDELT JSON parse failed (attempt {attempt})")
            last_err = "json_parse_failed"
    if data is None:
        print("GDELT unusable after 3 attempts — preserving previous KV, flagging failure")
        _fail(last_err)

    articles = data.get("articles") or []
    count = len(articles)
    tones = []
    neg = 0
    sources = []
    locations = []

    for a in articles:
        # GDELT doc API returns tone as 'tone' in some shapes, or not — be defensive
        t = a.get("tone")
        try:
            if t is not None:
                tones.append(float(t))
                if float(t) < 0:
                    neg += 1
        except Exception:
            pass
        dom = a.get("domain") or a.get("sourcecountry") or ""
        if dom:
            sources.append(dom)
        loc = a.get("location") or ""
        if loc:
            locations.append(loc)

    avg_tone = round(sum(tones) / len(tones), 2) if tones else None
    neg_pct = round(neg / count * 100, 1) if count else 0
    top_sources = [{"domain": d, "count": c} for d, c in Counter(sources).most_common(5)]
    top_locations = [{"name": d, "count": c} for d, c in Counter(locations).most_common(5)]

    # ── Tone via ToneChart (2026-05-18 — Batch G shipped) ──────────────────
    # Separate call to the histogram endpoint. Soft-fail: if ToneChart is
    # unreachable, fall back to count-only mode (the prior behaviour).
    tone_avg = None
    tone_neg_pct = None
    tone_total = 0
    # ToneChart is slow — server-side it scans tens of thousands of articles
    # to build the histogram. Up to 3 tries, 60s each. 2026-05-18 fix after
    # first run timed out at 20s.
    for attempt in range(3):
        # Backoff between attempts — GDELT rate-limits aggressive callers
        # (saw HTTP 429 with 0-sleep retry). 0s, 8s, 25s.
        if attempt > 0:
            sleep_s = 8 * attempt + (attempt - 1) * 9
            print(f"  ToneChart: sleeping {sleep_s}s before retry…")
            time.sleep(sleep_s)
        try:
            tr = requests.get(TONE_URL, timeout=60,
                              headers={"User-Agent": "HormuzWatch-GDELT/1.0"})
            if tr.status_code != 200:
                print(f"  ToneChart attempt {attempt+1}: HTTP {tr.status_code}")
                continue
            tdata = tr.json()
            bins = tdata.get("tonechart") or []
            total = sum(int(b.get("count", 0)) for b in bins)
            neg = sum(int(b.get("count", 0)) for b in bins if int(b.get("bin", 0)) < 0)
            weighted = sum(int(b.get("bin", 0)) * int(b.get("count", 0)) for b in bins)
            tone_total = total
            if total > 0:
                tone_avg = round(weighted / total, 2)
                tone_neg_pct = round(neg / total * 100, 1)
                print(f"  ToneChart OK on attempt {attempt+1}: {total} articles binned")
                break
            else:
                print(f"  ToneChart attempt {attempt+1}: empty histogram")
        except Exception as e:
            print(f"  ToneChart attempt {attempt+1} failed: {str(e)[:120]}")
    if tone_avg is None:
        print("  ToneChart unavailable after 3 attempts — falling back to count-only")

    payload = {
        "fetchedAt": int(time.time()),
        "article_count_24h": count,
        "avg_tone": tone_avg,
        "neg_tone_pct": tone_neg_pct,
        "tone_available": tone_avg is not None,
        "tone_sample_size": tone_total,
        "top_sources": top_sources,
        "top_locations": top_locations,
        "source": "GDELT 2.0 Doc API (24h window) · ArtList + ToneChart",
        "query": QUERY,
    }
    body = json.dumps(payload, separators=(",", ":"))
    ok = put_kv("gdelt_state", body)
    # 2026-05-22: diff-aware status (only writes on transition)
    try:
        from _status import write_status
        write_status("gdelt-scraper", ok=bool(ok), article_count_24h=count)
    except Exception: pass
    print(f"  ✓ KV write OK · {count} articles · ToneChart: avg_tone={tone_avg} neg_tone_pct={tone_neg_pct} (sample {tone_total})")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
