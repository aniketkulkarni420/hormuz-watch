// Cloudflare Pages Function — Global Fishing Watch v3 proxy
// Holds GFW_TOKEN (JWT) server-side. Client POSTs JSON body, we forward + add auth.
export async function onRequestPost({ request, env }) {
  if (!env.GFW_TOKEN) {
    return json({ error: "GFW_TOKEN not configured" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  // Whitelist allowed datasets to prevent abuse of the JWT
  const allowed = new Set([
    "public-global-encounters-events:latest",
    "public-global-loitering-events-carriers:latest"
  ]);
  if (!Array.isArray(body.datasets) || !body.datasets.every(d => allowed.has(d))) {
    return json({ error: "dataset not allowed" }, 400);
  }

  const url = "https://gateway.api.globalfishingwatch.org/v3/events?limit=200&offset=0";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.GFW_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      cf: { cacheTtl: 1800, cacheEverything: true }
    });
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=1800",
        "access-control-allow-origin": "*"
      }
    });
  } catch (e) {
    return json({ error: "upstream fetch failed", detail: String(e) }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
  });
}
