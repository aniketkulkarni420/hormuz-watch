// Cloudflare Pages Function — daily Brent + WTI history from Yahoo Finance.
//
// Replaces the EIA-weekly-only sparkline source. EIA weekly publishes once
// per week (Wed for prior-Friday's close) so the "4-week trend" rendered
// from it had at most 4 data points across a month — and they could be
// up to a week stale. Yahoo's v8 chart endpoint returns daily settlements
// with ~5-min lag during US session, no auth, no rate limit on bbox queries.
//
//   GET /api/oil-history?range=1mo   (range: 5d|1mo|3mo|1y · default 1mo)
//
// Returns: { brent: [{date, close}], wti: [{date, close}], asOf, source }
//
// Cached at the edge for 30 min — Yahoo updates intra-day but daily-close
// granularity means 30-min cache is plenty fresh for a sparkline.

const UA = "Mozilla/5.0 (HormuzWatch-OilHistory/1.0)";

async function fetchYahoo(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/json" },
    cf: { cacheTtl: 1800, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`Yahoo ${symbol} HTTP ${r.status}`);
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol} no result`);
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    if (close == null || !isFinite(close)) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    out.push({ date, close: Math.round(close * 100) / 100 });
  }
  return out;
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "1mo";
  if (!/^(5d|1mo|3mo|6mo|1y)$/.test(range)) {
    return _json({ error: "invalid range — use 5d|1mo|3mo|6mo|1y" }, 400);
  }

  const t0 = Date.now();
  try {
    const [brent, wti] = await Promise.all([
      fetchYahoo("BZ=F", range),
      fetchYahoo("CL=F", range),
    ]);
    if (!brent.length || !wti.length) {
      return _json({ error: "empty series from Yahoo" }, 502);
    }
    return _json({
      brent,
      wti,
      asOf: brent[brent.length - 1].date,
      latest: { brent: brent[brent.length - 1].close, wti: wti[wti.length - 1].close },
      source: "Yahoo Finance v8 chart (BZ=F / CL=F)",
      range,
      points: { brent: brent.length, wti: wti.length },
      elapsedMs: Date.now() - t0,
    });
  } catch (e) {
    return _json({ error: "fetch failed", detail: String(e).slice(0, 240) }, 502);
  }
}

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      // Daily close — 30 min cache plenty. SWR keeps response snappy on
      // expiry while quietly revalidating.
      "cache-control": "public, max-age=1800, stale-while-revalidate=600",
      "access-control-allow-origin": "*",
    },
  });
}
