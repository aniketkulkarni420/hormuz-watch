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
    """Write status only when {ok} CHANGES (e.g. ok→fail or fail→ok).

    2026-05-22: rewritten to read-then-diff so the steady-state "every run
    succeeded" case writes ZERO KV puts. KV reads are 100k/day free; writes
    are 1k/day free. Pre-refactor each scraper wrote scrape_status_X every
    run = ~500 KV writes/day across all scrapers. Now: writes only on
    transitions, ~5-10 writes/day combined.

    The watchdog and /api/diag still see fresh state because the prior write
    survives in KV until the next transition. `fetchedAt` is stamped at
    transition time, NOT every run — callers needing "last successful run"
    should look at the scrape's primary KV key (which still updates), not
    the status key.

    Always returns True for callers that gate on the return value.
    """
    if requests is None:
        return True
    acct = os.environ.get("CF_ACCOUNT_ID")
    token = os.environ.get("CF_API_TOKEN")
    ns = os.environ.get("CF_KV_NAMESPACE_ID")
    if not all([acct, token, ns]):
        print("  warn: write_status skipped — CF env vars missing")
        return True
    key = f"scrape_status_{job}"
    new_ok = bool(ok)

    # Read prior status — diff against new value
    try:
        r = requests.get(
            f"https://api.cloudflare.com/client/v4/accounts/{acct}"
            f"/storage/kv/namespaces/{ns}/values/{key}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15)
        if r.status_code == 200:
            try:
                prev = json.loads(r.text)
                if prev.get("ok") is new_ok:
                    # No transition — skip the write.
                    print(f"  write_status: no change for {job} (ok={new_ok}) — skipped")
                    return True
            except Exception:
                pass   # Unparseable old payload: fall through and write.
    except Exception as e:
        print(f"  warn: write_status read failed: {e} — writing anyway")

    payload = {"ok": new_ok, "fetchedAt": int(time.time()), "job": job}
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
        print(f"  write_status: TRANSITION for {job} -> ok={new_ok}")
        return True
    except Exception as e:
        print(f"  warn: write_status {key} failed: {e}")
        return False
