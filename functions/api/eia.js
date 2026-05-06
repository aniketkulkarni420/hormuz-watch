// Cloudflare Pages Function — EIA v2 proxy
// Holds EIA_KEY server-side. Client calls /api/eia?series=RBRTE&length=6
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const series = url.searchParams.get("series");
  const length = url.searchParams.get("length") || "6";
  const frequency = url.searchParams.get("frequency") || "weekly"; // weekly|daily|monthly

  if (!series || !/^[A-Z0-9]{1,12}$/.test(series)) {
    return json({ error: "invalid series" }, 400);
  }
  if (!/^\d{1,3}$/.test(length)) {
    return json({ error: "invalid length" }, 400);
  }
  if (!/^(weekly|daily|monthly)$/.test(frequency)) {
    return json({ error: "invalid frequency" }, 400);
  }
  if (!env.EIA_KEY) {
    return json({ error: "EIA_KEY not configured" }, 500);
  }

  const eiaUrl = "https://api.eia.gov/v2/petroleum/pri/spt/data/"
    + "?api_key=" + encodeURIComponent(env.EIA_KEY)
    + "&frequency=" + frequency
    + "&data%5B0%5D=value"
    + "&facets%5Bseries%5D%5B%5D=" + encodeURIComponent(series)
    + "&sort%5B0%5D%5Bcolumn%5D=period"
    + "&sort%5B0%5D%5Bdirection%5D=desc"
    + "&offset=0&length=" + length;

  try {
    const r = await fetch(eiaUrl, { cf: { cacheTtl: 3600, cacheEverything: true } });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
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
