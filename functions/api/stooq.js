// Cloudflare Pages Function — Brent daily DoD
// Path kept as /api/stooq for client compatibility.
// Source: EIA v2 daily Brent (RBRTE @ frequency=daily) — same upstream as Market Pulse,
// just at daily granularity instead of weekly. Cleaner than Stooq/Yahoo/FRED (all blocked
// Cloudflare Worker egress in May 2026 testing).
export async function onRequestGet({ env }) {
  if (!env.EIA_KEY) {
    return json({ error: "EIA_KEY not configured" }, 500);
  }
  const eiaUrl = "https://api.eia.gov/v2/petroleum/pri/spt/data/"
    + "?api_key=" + encodeURIComponent(env.EIA_KEY)
    + "&frequency=daily"
    + "&data%5B0%5D=value"
    + "&facets%5Bseries%5D%5B%5D=RBRTE"
    + "&sort%5B0%5D%5Bcolumn%5D=period"
    + "&sort%5B0%5D%5Bdirection%5D=desc"
    + "&offset=0&length=5";
  try {
    // EIA weekly series changes at most weekly; the CDN caches the RESPONSE
    // (cache-control max-age=1800 below) so this upstream fetch isn't hit every
    // call. (Batch F · 2026-06-24: removed stale "cache disabled for debugging".)
    const r = await fetch(eiaUrl, { cf: { cacheTtl: 1800, cacheEverything: true } });
    if (!r.ok) return json({ error: "eia " + r.status }, 502);
    const data = await r.json();
    const rows = data && data.response && data.response.data;
    if (!rows || rows.length < 2) return json({ error: "eia: not enough rows" }, 502);
    // Filter null values
    const valid = rows.filter(x => x.value !== null && x.value !== "" && isFinite(parseFloat(x.value)));
    if (valid.length < 2) return json({ error: "eia: insufficient valid points" }, 502);
    const today = parseFloat(valid[0].value);
    const yest = parseFloat(valid[1].value);
    const change = today - yest;
    const pct = (change / yest) * 100;
    return json({
      today: today,
      yesterday: yest,
      todayDate: valid[0].period,
      yesterdayDate: valid[1].period,
      change: change,
      pct: pct,
      source: "EIA:RBRTE:daily"
    });
  } catch (e) {
    return json({ error: "upstream fetch failed", detail: String(e) }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=1800",
      "access-control-allow-origin": "*"
    }
  });
}
