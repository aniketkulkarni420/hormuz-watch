// Cloudflare Pages Function — read latest AIS aggregation from KV.
// Populated by .github/workflows/ais-scraper.yml every 10 min.
// Dashboard polls this to show authoritative cross-user transit counts.
export async function onRequestGet({ env }) {
  if (!env.OIL_KV) return json({ error: "KV binding missing" }, 500);
  try {
    const raw = await env.OIL_KV.get("ais_state");
    if (!raw) return json({ error: "no state yet", summary: null }, 200);
    const data = JSON.parse(raw);
    const ageSec = Math.floor(Date.now() / 1000) - data.fetchedAt;
    return json({
      ageSec,
      summary: data.summary || {},
      // Don't return full vesselState/transits arrays by default — they're heavy
      hasState: !!(data.vesselState && Object.keys(data.vesselState).length),
      source: "GHA AIS aggregator",
    });
  } catch (e) {
    return json({ error: "kv parse failed", detail: String(e) }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
    },
  });
}
