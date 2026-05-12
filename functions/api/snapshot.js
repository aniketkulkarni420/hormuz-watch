// Cloudflare Pages Function — Hormuz state snapshot for downstream consumers.
//
// India Risk Monitor (https://india-risk-monitor.pages.dev) polls this
// endpoint each cron tick to populate the `hormuz_throughput` metric.
//
// V1 (this file): returns a static known-good snapshot of current state +
//   ISO timestamp. Update the constants below when regime shifts (or wire
//   them to env vars). Acceptable because IRM treats the value as a daily
//   indicator, not a real-time feed.
//
// V2 (planned): swap to a Worker scheduled every hour that connects to
//   AISStream, counts transits in the Hormuz bounding box over rolling 24h,
//   writes to Cloudflare KV. This function then reads from KV.
//
// Schema accepted by IRM's hormuz_v1 parser (any of these field names work):
//   daily_transit_estimate     (preferred — 24h transit count)
//   transits_per_day | transits_24h | vessel_count_total | total_active

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";

  // ── Current state · update when the dashboard's main reading shifts ──
  // Numbers below match the live hormuz-watch dashboard's last verified
  // observation. Tweak them when you spot a meaningful regime change, or
  // override via env vars HORMUZ_TRANSITS_24H / HORMUZ_BDTI / etc.
  const transits24h = numFromEnv(env.HORMUZ_TRANSITS_24H, 84);
  const baseline = numFromEnv(env.HORMUZ_BASELINE_30D, 140);
  const inbound = numFromEnv(env.HORMUZ_INBOUND, 38);
  const outbound = numFromEnv(env.HORMUZ_OUTBOUND, 42);
  const dark = numFromEnv(env.HORMUZ_DARK, 947);
  // BDTI: prefer KV (set via /admin/bdti or weekly scraper), fall back to env default
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
    daily_transit_estimate: transits24h,        // primary IRM hormuz_throughput input
    transits_per_day: transits24h,              // alias
    vessel_count_inbound: inbound,
    vessel_count_outbound: outbound,
    total_active: totalActive,                  // current snapshot count
    baseline_30d: baseline,                     // 30-day rolling reference
    pct_of_normal: pctOfNormal,
    dark_vessels: dark,                         // suspect AIS-off
    bdti: bdti,                                 // Baltic Dirty Tanker Index
    bdti_as_of: bdti_as_of,                     // ISO date of BDTI publish week (null if env-default)
    bdti_stale: bdti_stale,                     // true if >9 days old (missed weekly publish)
    oil_transit_value_usd_per_day: 1120000000,  // baseline 21M b/d × $80 = $1.12 Bn
    incidents_30d: 58,
    india_import_dependency_pct: 58.0,
    source: "hormuz-watch · static snapshot · v1",
    upgrade_note: debug
      ? "V1 ships static state. V2 will read live from KV updated by AISStream worker."
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
