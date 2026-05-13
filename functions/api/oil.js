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
  // Tier 0: oil_scraped KV (cross-verified 2-3 sources) — PREFER when fresh + high-confidence
  // This is more accurate than Tier 1 single-source OPA demo. Returns median of consensus.
  if (env.OIL_KV) {
    try {
      const rawScraped = await env.OIL_KV.get("oil_scraped");
      if (rawScraped) {
        const dataS = JSON.parse(rawScraped);
        const ageMinS = (Date.now() / 1000 - dataS.fetchedAt) / 60;
        const isFresh = ageMinS <= 30;
        const isHighConf = dataS.brent?.confidence === "high" && dataS.wti?.confidence === "high";
        if (isFresh && isHighConf && dataS.brent && dataS.wti) {
          const b = dataS.brent, w = dataS.wti;
          // Also try to pull official EIA reference from `latest` for the dual-display
          let bo = null, wo = null;
          try {
            const rawLatest = await env.OIL_KV.get("latest");
            if (rawLatest) {
              const dataL = JSON.parse(rawLatest);
              const boRaw = dataL.symbols?.brent_official;
              const woRaw = dataL.symbols?.wti_official;
              if (boRaw) bo = { level: boRaw.c, change: boRaw.d, changePct: boRaw.dp, asOf: boRaw.date, src: boRaw.src };
              if (woRaw) wo = { level: woRaw.c, change: woRaw.d, changePct: woRaw.dp, asOf: woRaw.date, src: woRaw.src };
            }
          } catch (e) { /* ignore */ }
          const resp = {
            source: "Cross-verified · " + (b.sources?.length || 0) + " sources",
            tier: "tier0-xverified",
            stale: false, staleMin: 0,
            brent: {
              level: b.value, change: null, changePct: null,
              src: "cross-verified",
              sources: b.sources, confidence: b.confidence,
              median: b.median, min: b.min, max: b.max,
            },
            wti: {
              level: w.value, change: null, changePct: null,
              src: "cross-verified",
              sources: w.sources, confidence: w.confidence,
              median: w.median, min: w.min, max: w.max,
            },
            fetchedAt: dataS.fetchedAt * 1000,
            ageMin: Math.round(ageMinS * 10) / 10,
            scrapeSources: dataS.sources_succeeded,
          };
          if (bo) resp.brentOfficial = bo;
          if (wo) resp.wtiOfficial = wo;
          return json(resp);
        }
      }
    } catch (e) { /* fall through to Tier 1 */ }
  }

  // Tier 1: KV (GitHub Action scraper — single-source OPA demo)
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

          // EIA Persian Gulf imports (monthly slow signal)
          if (data.symbols.pg_imports) {
            const pg = data.symbols.pg_imports;
            resp.pgImports = {
              value: pg.value, asOf: pg.asOf || null,
              src: pg.src, units: pg.units || "MBBL"
            };
          }

          // OPEC monthly production (STEO PAPR_OPEC)
          if (data.symbols.opec_production) {
            const op = data.symbols.opec_production;
            resp.opecProduction = {
              valueMbpd: op.value_mbpd ?? null,
              momPct:    op.mom_pct ?? null,
              asOf:      op.asOf || null,
              src:       op.src || "eia-steo",
            };
          }

          // EIA weekly stocks — commercial crude + SPR (WCESTUS1 + WCSSTUS1)
          if (data.symbols.weekly_stocks) {
            const ws = data.symbols.weekly_stocks;
            resp.weeklyStocks = {
              commercialCrudeKbbl: ws.commercial_crude_kbbl ?? null,
              sprKbbl:             ws.spr_kbbl ?? null,
              crudeWowPct:         ws.crude_wow_pct ?? null,
              sprWowPct:           ws.spr_wow_pct ?? null,
              asOf:                ws.asOf || null,
              src:                 ws.src || "eia-weekly",
              units:               ws.units || "kbbl",
            };
          }

          // Tanker Activity Index — equal-weighted mean dp% of 6 tanker stocks
          const tankerKeys = ["fro", "insw", "stng", "tnk", "dht", "nat"];
          const components = {};
          const dps = [];
          for (const k of tankerKeys) {
            const sym = data.symbols[k];
            if (sym && isFinite(sym.dp)) {
              components[k] = { level: sym.c, dp: sym.dp };
              dps.push(sym.dp);
            }
          }
          if (dps.length > 0) {
            const meanDp = dps.reduce((a, b) => a + b, 0) / dps.length;
            resp.tankerActivityIndex = {
              value: Math.round(meanDp * 100) / 100,
              count: dps.length,
              components,
              interpretation: meanDp > 0
                ? "tanker equities up — healthy shipping demand"
                : "tanker equities down — softening freight market"
            };
          }

          return json(resp);
        }
      }
    } catch (e) { /* fall through */ }
  }

  // Tier 1.5: KV `oil_scraped` (multi-source web scraper, cross-verified)
  // Used when `latest` is empty or very stale. Fresh threshold: 45 min.
  if (env.OIL_KV) {
    try {
      const raw = await env.OIL_KV.get("oil_scraped");
      if (raw) {
        const data = JSON.parse(raw);
        const ageMin = (Date.now() / 1000 - data.fetchedAt) / 60;
        if (ageMin <= 45 && data.brent && data.wti) {
          const b = data.brent, w = data.wti;
          const confSuffix = (b.confidence === "high" && w.confidence === "high")
            ? "cross-verified"
            : `${b.confidence || "?"}-conf`;
          const lowConf = (b.confidence === "low" || w.confidence === "low");
          return json({
            source: "Web scrape · " + confSuffix,
            tier: "scrape",
            stale: false,
            staleMin: 0,
            brent: {
              level: b.value, change: null, changePct: null,
              src: "web-scrape",
              sources: b.sources, confidence: b.confidence,
              median: b.median, min: b.min, max: b.max,
            },
            wti: {
              level: w.value, change: null, changePct: null,
              src: "web-scrape",
              sources: w.sources, confidence: w.confidence,
              median: w.median, min: w.min, max: w.max,
            },
            fetchedAt: data.fetchedAt * 1000,
            ageMin: Math.round(ageMin * 10) / 10,
            scrapeSources: data.sources_succeeded,
            ...(lowConf ? { lowConfidence: true } : {}),
          });
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
