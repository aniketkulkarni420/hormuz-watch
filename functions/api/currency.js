// Cloudflare Pages Function — reads currency_irr from KV.
// Populated by .github/workflows/currency-scraper.yml (hourly).
// Schema: { fetchedAt, official:{usd_irr,src}, blackMarket:{usd_irr,src},
//           spread_pct, aed_usd, sources_succeeded, interpretation }
export async function onRequestGet({ env }) {
  if (!env.OIL_KV) return json({ error: "KV binding missing" }, 500);
  try {
    const raw = await env.OIL_KV.get("currency_irr");
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
