"""Shared scraper status writer (Batch C · 2026-05-14).

Every scraper should call write_status() on both success and failure so
/api/diag — and therefore the watchdog — can see per-scraper health, not
just feed staleness. This catches the silent-failure class the audit
flagged: a scraper that runs, writes an empty/garbage payload, and exits 0,
leaving a "fresh" but useless feed that the staleness check happily passes.

Best-effort: write_status() never raises. A status-write failure must never
fail the scraper itself.

Import works because Python puts the running script's directory (scripts/)
on sys.path[0], and the workflows all invoke `python scripts/scrape_*.py`.
"""
import os
import json
import time

try:
    import requests
except Exception:  # pragma: no cover — requests is always installed in CI
    requests = None


def write_status(job, ok, **extra):
    """Write {ok, fetchedAt, job, ...extra} to KV key scrape_status_<job>.

    `job` is the short job name (e.g. "news-scraper"); the KV key becomes
    scrape_status_news-scraper. Returns True on a successful KV PUT, else
    False — but callers should ignore the return value (best-effort).
    """
    if requests is None:
        return False
    acct = os.environ.get("CF_ACCOUNT_ID")
    token = os.environ.get("CF_API_TOKEN")
    ns = os.environ.get("CF_KV_NAMESPACE_ID")
    if not all([acct, token, ns]):
        print("  warn: write_status skipped — CF env vars missing")
        return False
    key = f"scrape_status_{job}"
    payload = {"ok": bool(ok), "fetchedAt": int(time.time()), "job": job}
    payload.update(extra)
    body = json.dumps(payload, separators=(",", ":"))
    try:
        r = requests.put(
            f"https://api.cloudflare.com/client/v4/accounts/{acct}"
            f"/storage/kv/namespaces/{ns}/values/{key}",
            headers={"Authorization": f"Bearer {token}",
                     "Content-Type": "text/plain"},
            data=body, timeout=20)
        if r.status_code != 200:
            print(f"  warn: write_status {key} -> HTTP {r.status_code}")
            return False
        return True
    except Exception as e:
        print(f"  warn: write_status {key} failed: {e}")
        return False
