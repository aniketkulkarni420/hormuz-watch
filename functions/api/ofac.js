// Cloudflare Pages Function — OFAC Iran-related sanctions actions.
//
//   GET /api/ofac  — public, returns latest OFAC Iran/tanker actions from KV.
//
// Storage: KV key "ofac_state" written every 6h by scripts/scrape_ofac.py
//   via .github/workflows/ofac-scraper.yml.
//
// Schema:
//   { fetchedAt, iran_related_actions_30d, total_actions_30d,
//     recent_actions: [{date, title, url}], latest_action_date }

export async function onRequestGet({ env }) {
  if (!env.OIL_KV) {
    return json({ error: "KV binding missing" }, 500);
  }
  let data = null;
  try {
    const raw = await env.OIL_KV.get("ofac_state");
    if (raw) data = JSON.parse(raw);
  } catch { /* fall through */ }

  if (!data) {
    return json({
      fetchedAt: null,
      ageSec: null,
      stale: true,
      iran_related_actions_30d: null,
      recent_actions: [],
      latest_action_date: null,
      source: "no data — scraper has not run yet",
    });
  }
  const ageSec = data.fetchedAt ? Math.floor(Date.now() / 1000 - data.fetchedAt) : null;
  return json({
    ...data,
    ageSec,
    stale: ageSec != null && ageSec > 24 * 3600,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300, s-maxage=300",
      "access-control-allow-origin": "*",
    },
  });
}
