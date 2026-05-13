// Cloudflare Pages Function — read scraped vessel count from KV.
// Fallback signal when AIS is down; scraped every 4h via vessel-scrape workflow.
//
// Honest source attribution: this is a vessel-tracking-site web scrape, not real
// AIS. Use as a coarse proxy, not authoritative live data.

export async function onRequestGet({ env }) {
  if (!env.OIL_KV) return json({ error: "KV binding missing" }, 500);
  try {
    const raw = await env.OIL_KV.get("vessel_count_scraped");
    if (!raw) return json({ error: "no state yet", state: null });
    const data = JSON.parse(raw);
    const now = Math.floor(Date.now() / 1000);
    const ageSec = data.fetchedAt ? now - data.fetchedAt : null;
    const ageHours = ageSec != null ? Math.round(ageSec / 3600 * 10) / 10 : null;
    // Surface byType explicitly so consumers don't have to dig through perSite
    return json({ ...data, byType: data.byType || null, ageSec, ageHours });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
