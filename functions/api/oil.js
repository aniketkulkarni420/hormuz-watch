// Cloudflare Pages Function — Brent + WTI live prices
// SOURCE PRIORITY (forward-compatible):
//   1. Twelve Data BRENT/WTI    — real commodity prices (free tier 404s; works on Pro+)
//   2. FinnHub BNO/USO ETF      — proxy intraday %, NYSE hours only (free tier OK)
//   3. EIA daily RBRTE/RWTC     — accurate level, 1-2 day lag (caller already fetches via /api/stooq)
// Returns first working source with explicit `source` field so dashboard labels honestly.
export async function onRequestGet({ env }) {
  // Try Twelve Data first (real commodity prices when account allows)
  if (env.TWELVE_KEY) {
    try {
      const [bRes, wRes] = await Promise.all([
        fetch("https://api.twelvedata.com/quote?symbol=BRENT&apikey=" + encodeURIComponent(env.TWELVE_KEY),
          { cf: { cacheTtl: 600, cacheEverything: true } }),
        fetch("https://api.twelvedata.com/quote?symbol=WTI&apikey=" + encodeURIComponent(env.TWELVE_KEY),
          { cf: { cacheTtl: 600, cacheEverything: true } })
      ]);
      const [b, w] = await Promise.all([bRes.json(), wRes.json()]);
      // Only accept if both came back with valid commodity quotes (not stock substitutions)
      const validCommodity = (q) => q && !q.code && q.exchange && /NYMEX|ICE|CME|MTA/i.test(q.exchange) && isFinite(parseFloat(q.close));
      if (validCommodity(b) && validCommodity(w)) {
        return json({
          source: "TwelveData",
          tier: "primary",
          brent: { level: parseFloat(b.close), change: parseFloat(b.change), changePct: parseFloat(b.percent_change), open: parseFloat(b.open), prevClose: parseFloat(b.previous_close), t: b.timestamp },
          wti:   { level: parseFloat(w.close), change: parseFloat(w.change), changePct: parseFloat(w.percent_change), open: parseFloat(w.open), prevClose: parseFloat(w.previous_close), t: w.timestamp },
          fetchedAt: Date.now()
        });
      }
      // Otherwise fall through to ETF / EIA. Don't fail.
    } catch (e) { /* fall through */ }
  }

  // Tier 2: FinnHub BNO/USO ETF intraday % (NYSE hours only)
  if (env.FINNHUB_KEY) {
    try {
      const [bnoRes, usoRes] = await Promise.all([
        fetch("https://finnhub.io/api/v1/quote?symbol=BNO&token=" + encodeURIComponent(env.FINNHUB_KEY),
          { cf: { cacheTtl: 600, cacheEverything: true } }),
        fetch("https://finnhub.io/api/v1/quote?symbol=USO&token=" + encodeURIComponent(env.FINNHUB_KEY),
          { cf: { cacheTtl: 600, cacheEverything: true } })
      ]);
      const [bno, uso] = await Promise.all([bnoRes.json(), usoRes.json()]);
      if (isFinite(bno.c) && bno.c > 0 && isFinite(uso.c) && uso.c > 0) {
        return json({
          source: "FinnHub ETF proxy (BNO/USO)",
          tier: "secondary",
          note: "ETF dp% only; apply to EIA daily level for live tracking. NYSE hours only.",
          brent: { proxyDp: bno.dp, proxyPrice: bno.c, t: bno.t },
          wti:   { proxyDp: uso.dp, proxyPrice: uso.c, t: uso.t },
          fetchedAt: Date.now()
        });
      }
    } catch (e) { /* fall through */ }
  }

  // Tier 3 (handled client-side via /api/stooq which queries EIA daily directly)
  return json({
    source: "none",
    tier: "tertiary-required",
    note: "TwelveData free tier blocks BRENT/WTI; FinnHub ETF unavailable. Client should use /api/stooq (EIA daily) for level + display 1-2 day lag honestly."
  }, 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=600",
      "access-control-allow-origin": "*"
    }
  });
}
