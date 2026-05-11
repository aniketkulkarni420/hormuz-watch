// Cloudflare Pages Function — Brent + WTI live prices
// PRIORITY: read from OIL_KV (populated by GitHub Action with yfinance — actual futures BZ=F/CL=F).
// Falls back through legacy tiers if KV empty or stale.
//   1. KV (GHA scraper) → real futures, 15-min refresh, the authoritative source
//   2. Twelve Data BRENT/WTI (Pro+ only — free tier 404s)
//   3. FinnHub BNO/USO ETF (proxy, NYSE hours only)
//   4. EIA daily (always-on fallback, 1-2 day lag)
export async function onRequestGet({ env }) {
  // Tier 1: KV (GitHub Action scraper)
  if (env.OIL_KV) {
    try {
      const raw = await env.OIL_KV.get("latest");
      if (raw) {
        const data = JSON.parse(raw);
        const ageMin = (Date.now() / 1000 - data.fetchedAt) / 60;
        const stale = ageMin > 60; // 60 min freshness window
        if (!stale && data.symbols && data.symbols.brent && data.symbols.wti) {
          const b = data.symbols.brent;
          const w = data.symbols.wti;
          return json({
            source: "GitHub Actions · yfinance (BZ=F + CL=F)",
            tier: "primary",
            brent: { level: b.c, change: b.d, changePct: b.dp, open: b.o, prevClose: b.pc, high: b.h, low: b.l, t: b.t },
            wti:   { level: w.c, change: w.d, changePct: w.dp, open: w.o, prevClose: w.pc, high: w.h, low: w.l, t: w.t },
            fetchedAt: data.fetchedAt * 1000,
            ageMin: Math.round(ageMin * 10) / 10
          });
        }
      }
    } catch (e) { /* fall through */ }
  }

  // Tier 2: Twelve Data (Pro+)
  if (env.TWELVE_KEY) {
    try {
      const [bRes, wRes] = await Promise.all([
        fetch("https://api.twelvedata.com/quote?symbol=BRENT&apikey=" + encodeURIComponent(env.TWELVE_KEY),
          { cf: { cacheTtl: 600, cacheEverything: true } }),
        fetch("https://api.twelvedata.com/quote?symbol=WTI&apikey=" + encodeURIComponent(env.TWELVE_KEY),
          { cf: { cacheTtl: 600, cacheEverything: true } })
      ]);
      const [b, w] = await Promise.all([bRes.json(), wRes.json()]);
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
    } catch (e) { /* fall through */ }
  }

  // Tier 3: FinnHub BNO/USO ETF intraday %
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
          note: "ETF dp% only; apply to EIA daily level. NYSE hours only.",
          brent: { proxyDp: bno.dp, proxyPrice: bno.c, t: bno.t },
          wti:   { proxyDp: uso.dp, proxyPrice: uso.c, t: uso.t },
          fetchedAt: Date.now()
        });
      }
    } catch (e) { /* fall through */ }
  }

  // Tier 4 fallback handled client-side via /api/stooq (EIA daily)
  return json({
    source: "none",
    tier: "tertiary-required",
    note: "KV empty/stale, paid APIs unavailable. Client should use /api/stooq for EIA daily level with 1-2 day lag disclosure."
  }, 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*"
    }
  });
}
