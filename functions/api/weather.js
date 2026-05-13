// Cloudflare Pages Function — reads weather_state from KV.
// Populated by .github/workflows/weather-scraper.yml (OpenWeather, hourly).
export async function onRequestGet({ env }) {
  if (!env.OIL_KV) return json({ error: "KV binding missing" }, 500);
  try {
    const raw = await env.OIL_KV.get("weather_state");
    if (!raw) return json({ error: "no state yet", state: null }, 200);
    const data = JSON.parse(raw);
    const ageSec = Math.floor(Date.now() / 1000) - (data.fetchedAt || 0);
    return json({ ageSec, ...data });
  } catch (e) {
    return json({ error: "kv parse failed", detail: String(e) }, 502);
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
