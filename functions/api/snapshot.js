// Cloudflare Pages Function — Hormuz state snapshot for downstream consumers.
//
// India Risk Monitor (https://india-risk-monitor.pages.dev) polls this
// endpoint each cron tick to populate the `hormuz_throughput` metric.
//
// V2 (2026-05-12): Reads from OIL_KV key `ais_state` (written every 5 minutes
//   by scripts/scrape_ais.py via .github/workflows/ais-scraper.yml). When that
//   scraper has captured fresh data, the live `summary.transits24h` count
//   takes precedence over the env-var fallback. The `is_static` + `live_*`
//   fields tell downstream consumers (IRM) which mode is active so they can
//   render PROVISIONAL pills only when truly using static fallback.
//
// Schema accepted by IRM's hormuz_v1 parser (any of these field names work):
//   daily_transit_estimate     (preferred — 24h transit count)
//   transits_per_day | transits_24h | vessel_count_total | total_active

const AIS_STATE_KEY = "ais_state";
// How recent must scraper output be for us to use it (vs fall back to env vars)?
const AIS_STATE_FRESH_SECONDS = 30 * 60; // 30 minutes · scraper runs every 5

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";

  // ── Live AIS state · written by scripts/scrape_ais.py every 5 minutes ──
  // If the scraper has fresh data (last 30 min) with > 0 transits, use it.
  // Otherwise fall back to env-var-overridable static values.
  let aisLive = null;          // { transits24h, inbound, outbound, vesselCount, ageSec, source }
  if (env.OIL_KV) {
    try {
      const raw = await env.OIL_KV.get(AIS_STATE_KEY);
      if (raw) {
        const kv = JSON.parse(raw);
        const summary = kv?.summary || kv;
        const fetchedAt = kv?.fetchedAt || 0;
        const ageSec = fetchedAt ? Math.floor(Date.now() / 1000 - fetchedAt) : null;
        const t24h = Number(summary?.transits24h);
        // Only treat as live if scraper saw actual data AND it's fresh
        if (Number.isFinite(t24h) && t24h > 0 && ageSec != null && ageSec < AIS_STATE_FRESH_SECONDS) {
          aisLive = {
            transits24h: t24h,
            inbound: Number(summary.currentInbound ?? 0) || 0,
            outbound: Number(summary.currentOutbound ?? 0) || 0,
            vesselCount: Number(summary.vesselCount ?? 0) || 0,
            eastbound: Number(summary.eastbound24h ?? 0) || 0,
            westbound: Number(summary.westbound24h ?? 0) || 0,
            uniqueImos: Number(summary.uniqueImos24h ?? 0) || 0,
            typeBreakdown: summary.typeBreakdown || null,
            categories: summary.categories || null,
            ageSec,
            source: "GHA AISStream scraper · ais_state KV (every 5 min)"
          };
        }
      }
    } catch { /* fall through to static */ }
  }

  // Resolve final values · live wins when available
  const transits24h = aisLive ? aisLive.transits24h : numFromEnv(env.HORMUZ_TRANSITS_24H, 84);
  const baseline = numFromEnv(env.HORMUZ_BASELINE_30D, 140);
  const inbound = aisLive ? aisLive.inbound : numFromEnv(env.HORMUZ_INBOUND, 38);
  const outbound = aisLive ? aisLive.outbound : numFromEnv(env.HORMUZ_OUTBOUND, 42);
  const dark = numFromEnv(env.HORMUZ_DARK, 947);

  // ─── Composite signals · Path D (May 2026) ────────────────────────────────
  // Read 4 new KV keys; surface counts in snapshot for downstream consumers.
  let aircraft = null, seismic = null, gdelt = null, weather = null;
  if (env.OIL_KV) {
    const safeGet = async (k) => {
      try { const r = await env.OIL_KV.get(k); return r ? JSON.parse(r) : null; }
      catch { return null; }
    };
    [aircraft, seismic, gdelt, weather] = await Promise.all([
      safeGet("aircraft_state"),
      safeGet("seismic_state"),
      safeGet("gdelt_state"),
      safeGet("weather_state"),
    ]);
  }

  // BDTI: existing OIL_KV lookup · preserved unchanged
  let bdti = numFromEnv(env.HORMUZ_BDTI, 14);
  let bdti_as_of = null;
  let bdti_stale = false;
  if (env.OIL_KV) {
    try {
      const raw = await env.OIL_KV.get("bdti_latest");
      if (raw) {
        const kv = JSON.parse(raw);
        if (kv && kv.value) {
          bdti = kv.value;
          bdti_as_of = kv.asOf || null;
          const ageDays = Math.floor((Date.now() - (kv.ts || 0) * 1000) / 86400000);
          bdti_stale = ageDays > 9;
        }
      }
    } catch { /* fall back to env default */ }
  }

  const totalActive = inbound + outbound;
  const pctOfNormal = +((transits24h / baseline) * 100).toFixed(1);

  const payload = {
    as_of: new Date().toISOString(),
    daily_transit_estimate: transits24h,
    transits_per_day: transits24h,
    vessel_count_inbound: inbound,
    vessel_count_outbound: outbound,
    total_active: totalActive,
    baseline_30d: baseline,
    pct_of_normal: pctOfNormal,
    dark_vessels: dark,
    bdti: bdti,
    bdti_as_of: bdti_as_of,
    bdti_stale: bdti_stale,
    oil_transit_value_usd_per_day: 1120000000,
    incidents_30d: 58,
    india_import_dependency_pct: 58.0,
    // V2 honesty fields · downstream consumers detect static vs live
    is_static: !aisLive,
    live_source_count: aisLive ? 1 : 0,
    ais_state_age_sec: aisLive?.ageSec ?? null,
    source: aisLive
      ? aisLive.source
      : "hormuz-watch · static fallback · env-var defaults (AIS scraper stale or no data)",
    // Expose richer AIS payload when live
    eastbound_24h: aisLive?.eastbound ?? null,
    westbound_24h: aisLive?.westbound ?? null,
    unique_imos_24h: aisLive?.uniqueImos ?? null,
    vessel_count_in_bbox: aisLive?.vesselCount ?? null,
    type_breakdown: aisLive?.typeBreakdown ?? null,
    // ── Composite signals (Path D) ─────────────────────────────────────────
    aircraft_count:          aircraft?.count ?? null,
    military_aircraft_count: aircraft?.militaryCount ?? null,
    earthquake_count_7d:     seismic?.count_7d ?? null,
    seismic_max_mag:         seismic?.max_mag ?? null,
    gdelt_article_count_24h: gdelt?.article_count_24h ?? null,
    gdelt_neg_tone_pct:      gdelt?.neg_tone_pct ?? null,
    weather_rough:           weather?.roughConditions ?? null,
    weather_wind_max_knots:  weather?.windMaxKnots ?? null,
    upgrade_note: debug
      ? `Reads ais_state from OIL_KV (written by scrape_ais.py every 5 min). Live mode when age < ${AIS_STATE_FRESH_SECONDS}s AND transits24h > 0. Otherwise env-var fallback.`
      : undefined
  };

  return json(payload, 200);
}

function numFromEnv(envVar, fallback) {
  if (envVar == null || envVar === "") return fallback;
  const n = Number(envVar);
  return Number.isFinite(n) ? n : fallback;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300, s-maxage=300",
      "access-control-allow-origin": "*"
    }
  });
}
