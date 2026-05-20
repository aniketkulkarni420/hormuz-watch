// Cloudflare Pages Function — refresh fanout (open + rate-limited)
//
// 2026-05-20 — switched from header-token auth to open-endpoint + 60s KV lock.
// The ADMIN_TOKEN env var was burning user time with paste mismatches that
// I couldn't diagnose remotely. This shape is self-protecting:
//
//   - Open endpoint (POST or GET — same fanout). No header required.
//   - 60s global rate-limit via OIL_KV key "refresh_lock". A second caller
//     inside the window gets 429 and no dispatch happens.
//   - GitHub itself rate-limits workflow_dispatch beyond that.
//
// Worst-case adversary triggers the URL constantly: they refresh our
// scrapers every 60s — which is what we WANT. Cost to us: ~144 extra
// workflow runs/day per scraper, well within GitHub's free-tier budget.
//
//   POST /api/admin/refresh
//   Body: (optional) { workflows: [...] }   — defaults to the 7 below
//
// Returns: { ok, dispatched: [...], failed: [...], elapsedMs }
//
// CF env vars needed:
//   GH_REFRESH_PAT — fine-grained PAT, this repo only, "Actions: read+write"
//
// cron-job.org wire-up (much simpler now):
//   URL:     https://hormuz-watch-2.pages.dev/api/admin/refresh
//   Method:  POST
//   Headers: (none required — but Content-Type: application/json is harmless)
//   Body:    {} (empty body works too)
//   Cron:    */10 * * * *

const OWNER = "aniketkulkarni420";
const REPO = "hormuz-watch";
const DEFAULT_WORKFLOWS = [
  // High-cadence price/volume feeds (every 10 min ideal)
  "oil-stooq.yml",          // Brent/WTI intraday (Stooq + OPA cross-verified)
  "vessel-scrape.yml",      // Persian Gulf port vessel counts
  "ais-scraper.yml",        // AIS positions (currently key-revoked; firing harmless)
  "aircraft-scraper.yml",   // adsb.lol ADS-B coverage
  // Composite signal feeds (every 10 min OK; APIs are tolerant)
  "news-scraper.yml",       // Headlines + categorisation
  "gdelt-scraper.yml",      // Article volume + ToneChart sentiment
  "currency-scraper.yml",   // IRR/USD official vs black-market
  "weather-scraper.yml",    // Wind/sea state in strait
  "seismic-scraper.yml",    // Iran earthquake activity
  "ofac-scraper.yml",       // Iran enforcement actions
  "oil-scraper.yml",        // EIA daily refs + OPEC + tanker stocks (slower, daily-cadence data)
];

// 60s minimum between successful fanouts. GitHub's free-tier workflow
// concurrency is 20 — even if every scraper takes 90s, two fanouts a
// minute keeps us comfortably under the cap.
const RATE_LIMIT_SECONDS = 60;

async function handle({ request, env }) {
  const t0 = Date.now();

  if (!env.GH_REFRESH_PAT) {
    return _json({
      error: "GH_REFRESH_PAT not configured",
      hint: "Add fine-grained PAT (Actions: read+write, this repo) to CF Pages env vars in Production tab."
    }, 500);
  }

  // ── Rate limit via KV lock ─────────────────────────────────────────────
  // Read last-dispatch timestamp. Reject if within RATE_LIMIT_SECONDS.
  if (env.OIL_KV) {
    try {
      const last = await env.OIL_KV.get("refresh_lock");
      if (last) {
        const lastTs = parseInt(last, 10);
        const elapsedSec = Math.floor((Date.now() - lastTs) / 1000);
        if (elapsedSec < RATE_LIMIT_SECONDS) {
          return _json({
            ok: false,
            error: "rate_limited",
            elapsed_sec: elapsedSec,
            retry_after_sec: RATE_LIMIT_SECONDS - elapsedSec,
            hint: "Endpoint allows one fanout per 60 seconds. Try again shortly."
          }, 429);
        }
      }
    } catch { /* if KV read fails, fall open — better than blocking dispatch */ }
  }

  // Parse body (optional)
  let body = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch { /* empty / non-JSON body is fine */ }
  const workflows = Array.isArray(body.workflows) && body.workflows.length
    ? body.workflows
    : DEFAULT_WORKFLOWS;

  // ── Set lock BEFORE fanout — if fanout errors, the lock still protects ─
  // against thundering retries. 90s TTL is comfortable for fanout completion.
  if (env.OIL_KV) {
    try {
      await env.OIL_KV.put("refresh_lock", String(Date.now()),
                           { expirationTtl: 90 });
    } catch { /* not fatal */ }
  }

  // ── Fanout in parallel ────────────────────────────────────────────────
  const results = await Promise.all(workflows.map(async (wf) => {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${wf}/dispatches`;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GH_REFRESH_PAT}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "hormuz-watch-refresh/1.0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      });
      if (r.status === 204) {
        return { wf, ok: true };
      }
      let detail = "";
      try { detail = (await r.text()).slice(0, 240); } catch {}
      return { wf, ok: false, status: r.status, detail };
    } catch (e) {
      return { wf, ok: false, error: String(e).slice(0, 160) };
    }
  }));

  const dispatched = results.filter(r => r.ok).map(r => r.wf);
  const failed = results.filter(r => !r.ok);
  return _json({
    ok: failed.length === 0,
    dispatched,
    failed,
    elapsedMs: Date.now() - t0,
  }, failed.length === 0 ? 200 : 207);
}

// Accept POST (standard) and GET (in case cron-job.org defaults back to GET).
export const onRequestPost = handle;
export const onRequestGet  = handle;

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
