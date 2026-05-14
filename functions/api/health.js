// Cloudflare Pages Function — PUBLIC health endpoint for external monitoring.
//
//   GET /api/health   — no token. Returns HEALTHY / DEGRADED.
//
// Why this exists (Batch C · 2026-05-14):
// /api/diag is token-gated and the in-repo watchdog is itself a GitHub Actions
// scheduled workflow — so when GHA throttles/stops scheduled runs (which it
// did, silently, for ~9 h), the watchdog stops too and nothing notices.
// This endpoint is the hook for an EXTERNAL monitor (UptimeRobot etc.) that
// lives outside GitHub Actions. Point an uptime monitor at it:
//   - keyword monitor: alert when the word "HEALTHY" is ABSENT, or
//   - plain HTTP monitor: a DEGRADED state returns HTTP 503.
//
// The headline check is "all scrapers stopped": if even the freshest of all
// monitored feeds is older than ALL_STOPPED_MIN, the whole pipeline halted.

// Per-feed staleness limits (minutes) — must track each scraper's cron cadence
// + headroom for GitHub Actions scheduled-run delay. Mirrors diag.js.
const MAX_AGE_MIN = {
  latest: 60,            // oil scraper · every 15 min
  oil_scraped: 60,       // oil web scraper · every 15 min
  verdict_latest: 60,    // record.js via data-refresh · every 15 min
  weather_state: 45,     // every 10 min
  aircraft_state: 60,    // every 15 min
  currency_irr: 150,     // hourly
  news_headlines: 90,    // every 30 min
  seismic_state: 150,    // hourly
};

// If the FRESHEST feed across the board is older than this, every scheduled
// scraper has stopped — the exact GHA-throttling failure mode.
const ALL_STOPPED_MIN = 90;

export async function onRequestGet({ env }) {
  if (!env.OIL_KV) return respond({ status: "DEGRADED", reason: "KV binding missing" }, 503);

  const now = Math.floor(Date.now() / 1000);
  const feeds = {};
  let freshestMin = Infinity;

  for (const key of Object.keys(MAX_AGE_MIN)) {
    try {
      const raw = await env.OIL_KV.get(key);
      if (!raw) { feeds[key] = { ok: false, reason: "missing" }; continue; }
      const data = JSON.parse(raw);
      const fetchedAt = data.fetchedAt || data.ts || null;
      if (!fetchedAt) { feeds[key] = { ok: false, reason: "no timestamp" }; continue; }
      const ageMin = Math.round((now - fetchedAt) / 60);
      const stale = ageMin > MAX_AGE_MIN[key];
      feeds[key] = { ok: !stale, ageMin, stale };
      if (ageMin < freshestMin) freshestMin = ageMin;
    } catch (e) {
      feeds[key] = { ok: false, reason: String(e).slice(0, 80) };
    }
  }

  const staleFeeds = Object.entries(feeds)
    .filter(([, v]) => v.stale || v.ok === false)
    .map(([k, v]) => `${k}:${v.ageMin != null ? v.ageMin + "m" : (v.reason || "?")}`);

  const allScrapersStopped = freshestMin !== Infinity && freshestMin > ALL_STOPPED_MIN;
  const noData = freshestMin === Infinity;
  const healthy = !allScrapersStopped && !noData && staleFeeds.length === 0;

  const body = {
    status: healthy ? "HEALTHY" : "DEGRADED",
    ts: now,
    freshestFeedMin: freshestMin === Infinity ? null : freshestMin,
    allScrapersStopped,
    staleFeeds,
    feeds,
    // Human note surfaces the headline failure mode for whoever reads the alert
    note: allScrapersStopped
      ? "All scheduled scrapers appear stopped — likely GitHub Actions schedule throttling. Manually dispatch the workflows."
      : noData
        ? "No feed data in KV at all."
        : healthy ? "All monitored feeds fresh." : "One or more feeds stale.",
  };
  return respond(body, healthy ? 200 : 503);
}

function respond(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
    },
  });
}
