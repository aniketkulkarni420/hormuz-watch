// Cloudflare Pages Function — Brent + WTI dual-track price feed
//
// DUAL TRACK ARCHITECTURE (set by GHA scraper):
//   symbols.brent / symbols.wti          → live estimate (~5-min lag, OilPriceAPI demo)
//   symbols.brent_official / wti_official → EIA/FRED daily spot with explicit publish date
//
// Response shape:
//   brent        { level, change, changePct, t, src, updatedAt }  ← live estimate
//   wti          { level, change, changePct, t, src, updatedAt }
//   brentOfficial{ level, change, changePct, asOf, src }           ← EIA official spot
//   wtiOfficial  { level, asOf, src }
//
// Falls back through legacy tiers if KV empty or stale.
export async function onRequestGet({ env }) {
  // Tier 1: KV (GitHub Action scraper)
  if (env.OIL_KV) {
    try {
      const raw = await env.OIL_KV.get("latest");
      if (raw) {
        const data = JSON.parse(raw);
        const ageMin = (Date.now() / 1000 - data.fetchedAt) / 60;
        const stale = ageMin > 60;
        const veryStale = ageMin > 360;
        const staleMin = stale ? Math.round(ageMin) : 0;
        if (!veryStale && data.symbols && data.symbols.brent && data.symbols.wti) {
          const b  = data.symbols.brent;
          const w  = data.symbols.wti;
          const bo = data.symbols.brent_official;
          const wo = data.symbols.wti_official;

          const tier = stale ? "primary-stale" : "primary";

          const resp = {
            source:   "Live commodity feed",
            tier,
            stale,
            staleMin,
            brent: {
              level: b.c, change: b.d, changePct: b.dp,
              open: b.o, prevClose: b.pc, high: b.h, low: b.l,
              t: b.t, src: b.src,
              ...(b.updatedAt ? { updatedAt: b.updatedAt } : {})
            },
            wti: {
              level: w.c, change: w.d, changePct: w.dp,
              open: w.o, prevClose: w.pc, high: w.h, low: w.l,
              t: w.t, src: w.src,
              ...(w.updatedAt ? { updatedAt: w.updatedAt } : {})
            },
            fetchedAt: data.fetchedAt * 1000,
            ageMin: Math.round(ageMin * 10) / 10,
          };

          // Official EIA/FRED reference — always included when available
          if (bo) {
            resp.brentOfficial = {
              level: bo.c, change: bo.d, changePct: bo.dp,
              asOf: bo.date || null, src: bo.src
            };
          }
          if (wo) {
            resp.wtiOfficial = {
              level: wo.c, change: wo.d, changePct: wo.dp,
              asOf: wo.date || null, src: wo.src
            };
          }

          return json(resp);
        }
      }
    } catch (e) { /* fall through */ }
  }

  // Tier 2 (Twelve Data) removed — free tier doesn't support commodity futures

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
