// Cloudflare Pages Function — historical time series reader (D1)
// GET /api/history?metric=transits_24h&range=7d
// Returns time series for use in dashboard trend charts, comparisons, alerts.
export async function onRequestGet({ request, env }) {
  if (!env.DB) {
    return json({ error: "D1 binding 'DB' missing" }, 500);
  }
  const url = new URL(request.url);
  const metric = url.searchParams.get("metric") || "transits_24h";
  const range  = url.searchParams.get("range")  || "7d";

  // Whitelist columns
  const ALLOWED = new Set([
    "transits_24h", "vessels_transiting", "vessels_anchored", "vessels_approach",
    "brent_price", "wti_price", "bw_spread",
    "bdti", "bdti_wow",
    "gfw_encounters", "gfw_loitering", "dark_pct",
    "india_via_hormuz_pct"
  ]);
  if (!ALLOWED.has(metric)) {
    return json({ error: "invalid metric", allowed: [...ALLOWED] }, 400);
  }

  // Parse range
  const m = range.match(/^(\d+)([hdw])$/);
  if (!m) return json({ error: "invalid range, format like 7d, 24h, 4w" }, 400);
  const n = parseInt(m[1], 10);
  const unitSecs = m[2] === "h" ? 3600 : m[2] === "d" ? 86400 : 604800;
  const fromTs = Math.floor(Date.now() / 1000) - n * unitSecs;

  try {
    // Use parameterized query (metric was whitelisted above so the column name is safe)
    const stmt = env.DB.prepare(`SELECT ts, ${metric} AS v FROM snapshots WHERE ts >= ? ORDER BY ts ASC`);
    const result = await stmt.bind(fromTs).all();
    return json({
      metric,
      range,
      points: result.results.map(r => ({ ts: r.ts, v: r.v })),
      count: result.results.length
    });
  } catch (e) {
    return json({ error: "D1 query failed", detail: String(e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*"
    }
  });
}
