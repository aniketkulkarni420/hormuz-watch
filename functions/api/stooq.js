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
    + "&facets%5Bseries%5D%5B%5D=RWTC"
    + "&sort%5B0%5D%5Bcolumn%5D=period"
    + "&sort%5B0%5D%5Bdirection%5D=desc"
    + "&offset=0&length=12";
  try {
    // EIA weekly series changes at most weekly; the CDN caches the RESPONSE
    // (cache-control max-age=1800 below) so this upstream fetch isn't hit every
    // call. (Batch F · 2026-06-24: removed stale "cache disabled for debugging".)
    const r = await fetch(eiaUrl, { cf: { cacheTtl: 1800, cacheEverything: true } });
    if (!r.ok) return json({ error: "eia " + r.status }, 502);
    const data = await r.json();
    const rows = data && data.response && data.response.data;
    if (!rows || rows.length < 2) return json({ error: "eia: not enough rows" }, 502);
    // Filter null values. Rows hold both series (RBRTE Brent, RWTC WTI), newest first.
    const valid = rows.filter(x => x.value !== null && x.value !== "" && isFinite(parseFloat(x.value)));
    const brentRows = valid.filter(x => (x.series || "RBRTE") === "RBRTE");
    const wtiRows = valid.filter(x => x.series === "RWTC");
    if (brentRows.length < 2) return json({ error: "eia: insufficient valid points" }, 502);
    const today = parseFloat(brentRows[0].value);
    const yest = parseFloat(brentRows[1].value);
    const change = today - yest;
    const pct = (change / yest) * 100;
    // WTI spot for the SAME day as the Brent print, so the Brent-WTI spread
    // compares like with like (2026-11-05). Null when EIA has no WTI that day.
    const wtiSame = wtiRows.find(x => x.period === brentRows[0].period);
    const wti = wtiSame ? parseFloat(wtiSame.value) : null;
    return json({
      today: today,
      yesterday: yest,
      todayDate: brentRows[0].period,
      yesterdayDate: brentRows[1].period,
      change: change,
      pct: pct,
      wti: wti,
      wtiDate: wtiSame ? wtiSame.period : null,
      source: "EIA:RBRTE+RWTC:daily"
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
