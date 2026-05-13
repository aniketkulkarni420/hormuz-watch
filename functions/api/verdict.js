// Cloudflare Pages Function — public read of the latest two-stage verdict.
// Reads OIL_KV key `verdict_latest` (written by /api/record).
// Front-end Tension Gauge / Verdict tile polls this endpoint.

export async function onRequestGet({ env }) {
  if (!env.OIL_KV) return json({ error: "KV not bound" }, 500);
  try {
    const raw = await env.OIL_KV.get("verdict_latest");
    if (!raw) return json({ error: "no verdict yet" }, 404);
    const data = JSON.parse(raw);
    return json(data, 200);
  } catch (e) {
    return json({ error: "verdict read failed", detail: String(e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60, s-maxage=60",
      "access-control-allow-origin": "*"
    }
  });
}
