// Cloudflare Pages Function — full-system diagnostic dump.
// Token-gated. Returns freshness/preview for every KV feed + D1 last snapshot.
//
// Usage: curl -H "X-Snapshot-Token: $SNAPSHOT_TOKEN" https://.../api/diag
//   (?token= query also accepted for back-compat, but it leaks to logs — prefer the header)
import { safeEqual } from "../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  const token = request.headers.get("X-Snapshot-Token") || new URL(request.url).searchParams.get("token");
  if (!safeEqual(token, env.SNAPSHOT_TOKEN)) return new Response("forbidden", { status: 403 });

  const now = Math.floor(Date.now() / 1000);
  const out = { ts: now, feeds: {} };

  // KV reads — for each key, return age + small payload preview
  // bdti_latest has a different "stale" threshold (weekly publish vs continuous)
  // ais_last_success_ts + ais_last_recovery_ts are excluded from staleness rules — they're
  // markers, not feeds. Surfaced separately below.
  const kvKeys = ["latest", "oil_scraped", "ais_state", "vessel_count_scraped", "scrape_status_oil", "scrape_status_ais", "scrape_status_aircraft", "scrape_status_seismic", "scrape_status_gdelt", "scrape_status_weather", "scrape_status_news", "scrape_status_ofac", "scrape_status_currency", "scrape_status_bdti", "scrape_status_oil_web", "scrape_status_vessels_web", "verdict_latest", "bdti_latest", "aircraft_state", "seismic_state", "gdelt_state", "weather_state", "news_headlines", "ofac_state", "currency_irr"];
  for (const k of kvKeys) {
    try {
      const raw = await env.OIL_KV.get(k);
      if (!raw) { out.feeds[k] = { ok: false, reason: "missing" }; continue; }
      const data = JSON.parse(raw);
      const fetchedAt = data.fetchedAt || data.ts || null;
      out.feeds[k] = {
        ok: true,
        ageSec: fetchedAt ? now - fetchedAt : null,
        ageMin: fetchedAt ? Math.round((now - fetchedAt) / 60) : null,
        preview: JSON.stringify(data).slice(0, 200),
      };
    } catch (e) { out.feeds[k] = { ok: false, reason: String(e).slice(0, 100) }; }
  }

  // D1 — last snapshot
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT ts, verdict FROM snapshots ORDER BY ts DESC LIMIT 1").first();
      if (row) {
        out.feeds.d1_snapshot = {
          ok: true,
          ts: row.ts,
          ageSec: now - row.ts,
          ageMin: Math.round((now - row.ts) / 60),
          verdict: row.verdict || null,
        };
      } else {
        out.feeds.d1_snapshot = { ok: false, reason: "no rows" };
      }
      const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM snapshots").first();
      out.feeds.d1_total_rows = cnt?.c || 0;
    } catch (e) { out.feeds.d1_snapshot = { ok: false, reason: String(e).slice(0, 100) }; }
  }

  // Overall health rollup — per-feed staleness limits in minutes.
  // Each limit ≈ feed's cron cadence × ~4 + headroom for GitHub Actions
  // scheduled-run delay. A blanket 30-min limit (the old logic) permanently
  // false-flagged every hourly / 6-hourly feed as stale. (Batch C · 2026-05-14)
  const MAX_AGE_MIN = {
    latest: 60, oil_scraped: 60,          // oil scrapers every 15 min
    ais_state: 30, scrape_status_ais: 30, // AIS scraper every 5 min
    scrape_status_oil: 60,
    vessel_count_scraped: 360,            // vessel-scrape every 4 h
    verdict_latest: 60,                   // written by data-refresh every 15 min
    bdti_latest: 12960,                   // BDTI publishes weekly (9 days)
    aircraft_state: 60, scrape_status_aircraft: 60,   // every 15 min
    seismic_state: 150, scrape_status_seismic: 150,   // hourly
    gdelt_state: 150, scrape_status_gdelt: 150,       // hourly
    weather_state: 45, scrape_status_weather: 45,     // every 10 min
    news_headlines: 90, scrape_status_news: 90,       // every 30 min
    ofac_state: 480, scrape_status_ofac: 480,         // every 6 h
    currency_irr: 150, scrape_status_currency: 150,   // hourly
    scrape_status_oil_web: 60,                        // every 15 min
    scrape_status_vessels_web: 360,                   // every 4 h
    scrape_status_bdti: 12960,                        // BDTI publishes weekly
    d1_snapshot: 90,                                  // hourly snapshot writer
  };
  const DEFAULT_MAX_AGE_MIN = 60;
  const stale = Object.entries(out.feeds).filter(([k, v]) => {
    if (!v || v.ageMin == null) return false;
    const limit = MAX_AGE_MIN[k] ?? DEFAULT_MAX_AGE_MIN;
    return v.ageMin > limit;
  });
  out.healthy = stale.length === 0;
  out.staleFeeds = stale.map(([k, v]) => `${k}:${v.ageMin}m`);

  // ── AIS key health probe ─────────────────────────────────────────────────
  // When AISStream silently revokes the key, the scraper still runs (fresh
  // fetchedAt) but messagesProcessed is 0. Regular staleness check passes,
  // so we'd never alert. This probe catches that specifically.
  out.aisHealthCheck = "ok";
  try {
    const raw = await env.OIL_KV.get("ais_state");
    if (raw) {
      const ais = JSON.parse(raw);
      const fetchedAt = ais.fetchedAt || ais.ts || 0;
      const ageSec = now - fetchedAt;
      const msgs = ais.messagesProcessed;
      // Scraper recently ran (< 1 hour) AND got zero messages — key likely revoked
      if (msgs === 0 && ageSec < 3600) {
        out.aisHealthCheck = "no_messages_recent";
        out.staleFeeds.push("ais_zero_messages");
        out.healthy = false;
      }
    }
  } catch { /* AIS state already covered by feeds.ais_state */ }

  // ── AIS recovery markers (last working timestamp + last recovery event) ──
  // These let dashboard show "AIS last working: <date>" when currently broken.
  // Written by scrape_ais.py when messagesProcessed > 0.
  out.aisLastSuccessTs = null;
  out.aisLastSuccessAgo = null;
  out.aisLastRecoveryTs = null;
  try {
    const lastSucc = await env.OIL_KV.get("ais_last_success_ts");
    if (lastSucc) {
      const ts = parseInt(lastSucc, 10);
      if (ts) {
        out.aisLastSuccessTs = ts;
        out.aisLastSuccessAgo = formatAgo(now - ts);
      }
    }
    const lastRec = await env.OIL_KV.get("ais_last_recovery_ts");
    if (lastRec) out.aisLastRecoveryTs = parseInt(lastRec, 10);
  } catch { /* keys may not exist yet */ }

  // ── Secret rotation tracking ────────────────────────────────────────────
  // SECRETS_LAST_ROTATED env var is YYYY-MM-DD format, set manually in CF Pages
  // when secrets are rotated. Watchdog alerts if >90 days.
  if (env.SECRETS_LAST_ROTATED) {
    const rotDate = new Date(env.SECRETS_LAST_ROTATED + "T00:00:00Z").getTime();
    if (isFinite(rotDate)) {
      const ageDays = Math.floor((Date.now() - rotDate) / 86400000);
      out.secretsAgeDays = ageDays;
      out.secretsStale = ageDays > 90;
      if (out.secretsStale) {
        out.healthy = false;
        out.staleFeeds.push(`secrets:${ageDays}d`);
      }
    }
  } else {
    out.secretsAgeDays = null;
    out.secretsStale = null;
    out.staleFeeds.push("secrets:not_tracked");
  }

  return new Response(JSON.stringify(out, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function formatAgo(seconds) {
  if (!seconds || seconds < 0) return null;
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h";
  const d = Math.floor(h / 24);
  return d + "d";
}
