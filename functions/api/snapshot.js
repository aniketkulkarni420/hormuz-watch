// Cloudflare Pages Function — Hormuz state snapshot for downstream consumers.
//
// India Risk Monitor (https://india-risk-monitor.pages.dev) polls this
// endpoint each cron tick to populate the `hormuz_throughput` metric.
//
// V2 (2026-05-12): Reads from OIL_KV key `ais_state` (written every 5 minutes
//   by scripts/scrape_ais.py via .github/workflows/ais-scraper.yml). When that
//   scraper has captured fresh data, the live `summary.transits24h` count
//   takes precedence over the env-var fallback. The `is_static` + `live_*`
//   fields tell downstream consumers (IRM) which mode is active so they can
//   render PROVISIONAL pills only when truly using static fallback.
//
// Schema accepted by IRM's hormuz_v1 parser (any of these field names work):
//   daily_transit_estimate     (preferred — 24h transit count)
//   transits_per_day | transits_24h | vessel_count_total | total_active

const AIS_STATE_KEY = "ais_state";
// How recent must scraper output be for us to use it (vs fall back to env vars)?
const AIS_STATE_FRESH_SECONDS = 30 * 60; // 30 minutes · scraper runs every 5

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";

  // ── Live AIS state · written by scripts/scrape_ais.py every 5 minutes ──
  // If the scraper has fresh data (last 30 min) with > 0 transits, use it.
  // Otherwise fall back to env-var-overridable static values.
  let aisLive = null;          // { transits24h, inbound, outbound, vesselCount, ageSec, source }
  if (env.OIL_KV) {
    try {
      const raw = await env.OIL_KV.get(AIS_STATE_KEY);
      if (raw) {
        const kv = JSON.parse(raw);
        const summary = kv?.summary || kv;
        const fetchedAt = kv?.fetchedAt || 0;
        const ageSec = fetchedAt ? Math.floor(Date.now() / 1000 - fetchedAt) : null;
        const t24h = Number(summary?.transits24h);
        // Only treat as live if scraper saw actual data AND it's fresh
        if (Number.isFinite(t24h) && t24h > 0 && ageSec != null && ageSec < AIS_STATE_FRESH_SECONDS) {
          aisLive = {
            transits24h: t24h,
            inbound: Number(summary.currentInbound ?? 0) || 0,
            outbound: Number(summary.currentOutbound ?? 0) || 0,
            vesselCount: Number(summary.vesselCount ?? 0) || 0,
            eastbound: Number(summary.eastbound24h ?? 0) || 0,
            westbound: Number(summary.westbound24h ?? 0) || 0,
            uniqueImos: Number(summary.uniqueImos24h ?? 0) || 0,
            typeBreakdown: summary.typeBreakdown || null,
            categories: summary.categories || null,
            ageSec,
            source: "GHA AISStream scraper · ais_state KV (every 5 min)"
          };
        }
      }
    } catch { /* fall through to static */ }
  }

  // ─── Composite signals · Path D (May 2026) ────────────────────────────────
  // Read 5 KV keys; surface counts in snapshot for downstream consumers.
  let aircraft = null, seismic = null, gdelt = null, weather = null, vesselScrape = null, news = null, currency = null, ofac = null, oilLatest = null;
  if (env.OIL_KV) {
    const safeGet = async (k) => {
      try { const r = await env.OIL_KV.get(k); return r ? JSON.parse(r) : null; }
      catch { return null; }
    };
    [aircraft, seismic, gdelt, weather, vesselScrape, news, currency, ofac, oilLatest] = await Promise.all([
      safeGet("aircraft_state"),
      safeGet("seismic_state"),
      safeGet("gdelt_state"),
      safeGet("weather_state"),
      safeGet("vessel_count_scraped"),
      safeGet("news_headlines"),
      safeGet("currency_irr"),
      safeGet("ofac_state"),
      safeGet("latest"),
    ]);
  }

  // Web-scraped vessel count fallback when AIS is unavailable.
  // 137 vessels across 5 Gulf ports ≈ Persian Gulf traffic proxy.
  // Used only when (1) AIS not flowing AND (2) scraped data is fresh (< 24h) AND (3) not blocked.
  // Window widened 6h→24h (2026-05-18): GHA cron is throttled to ~10h actual cadence;
  // 6h window kept tripping us into full-static fallback even when vessel scrape was valid.
  if (!aisLive && vesselScrape && !vesselScrape.blocked) {
    const scrapeAgeSec = vesselScrape.fetchedAt ? Math.floor(Date.now() / 1000 - vesselScrape.fetchedAt) : null;
    const scrapeTotal = vesselScrape?.totals?.all ?? null;
    if (scrapeAgeSec != null && scrapeAgeSec < 24 * 3600 && Number.isFinite(scrapeTotal) && scrapeTotal > 0) {
      aisLive = {
        transits24h: scrapeTotal,
        inbound: 0, outbound: 0,
        vesselCount: scrapeTotal,
        eastbound: 0, westbound: 0,
        uniqueImos: scrapeTotal,
        typeBreakdown: null, categories: null,
        ageSec: scrapeAgeSec,
        source: `Web scrape · VesselFinder Gulf ports (${vesselScrape.sites_succeeded}/2 sites · confidence ${vesselScrape.confidence})`,
        dataSource: "web_scrape",
      };
    }
  }

  // Resolve final values · live (AIS or scraped) wins when available
  const transits24h = aisLive ? aisLive.transits24h : numFromEnv(env.HORMUZ_TRANSITS_24H, 84);
  const baseline = numFromEnv(env.HORMUZ_BASELINE_30D, 140);
  const inbound = aisLive ? aisLive.inbound : numFromEnv(env.HORMUZ_INBOUND, 38);
  const outbound = aisLive ? aisLive.outbound : numFromEnv(env.HORMUZ_OUTBOUND, 42);
  // Dark-vessel count: we have NO real source for this. The old
  // numFromEnv(env.HORMUZ_DARK, 947) shipped a frozen constant that the UI
  // then divided by the live vessel count to render a "Dark vessel share"
  // — which moved inversely to live traffic (fewer tracked ships → higher
  // fake "dark %") and even bumped the Cross-signal tension gauge to HIGH.
  // Emit null until a genuine dark-traffic feed exists; both UI consumers
  // already degrade null to an honest "not available". (2026-05-14)
  const dark = null;

  // BDTI: KV-backed. null when KV is empty — never invent a value. The old
  // env fallback of 14 was nonsensical (real BDTI ~800–3000) and scores as
  // "calm" in the verdict engine. (Batch A · 2026-05-14)
  let bdti = null;
  let bdti_as_of = null;
  let bdti_stale = true;   // stays true until KV provides a tracked value
  if (env.OIL_KV) {
    try {
      const raw = await env.OIL_KV.get("bdti_latest");
      if (raw) {
        const kv = JSON.parse(raw);
        if (kv && kv.value) {
          bdti = kv.value;
          bdti_as_of = kv.asOf || null;
          const ageDays = Math.floor((Date.now() - (kv.ts || 0) * 1000) / 86400000);
          bdti_stale = ageDays > 9;
        }
      }
    } catch { /* fall back to env default */ }
  }

  const totalActive = inbound + outbound;
  const pctOfNormal = +((transits24h / baseline) * 100).toFixed(1);

  const payload = {
    as_of: new Date().toISOString(),
    daily_transit_estimate: transits24h,
    transits_per_day: transits24h,
    vessel_count_inbound: inbound,
    vessel_count_outbound: outbound,
    total_active: totalActive,
    baseline_30d: baseline,
    pct_of_normal: pctOfNormal,
    dark_vessels: dark,
    bdti: bdti,
    bdti_as_of: bdti_as_of,
    bdti_stale: bdti_stale,
    oil_transit_value_usd_per_day: 1120000000,
    incidents_30d: 58,
    india_import_dependency_pct: 58.0,
    // V2 honesty fields · downstream consumers detect static vs live
    // static_fields: keys below are structural constants, NOT live-tracked —
    // they carry the response's fresh `as_of` only because they ship in the
    // same payload. Consumers must not treat them as time-series data.
    // (Batch A · 2026-05-14)
    static_fields: [
      "oil_transit_value_usd_per_day",
      "incidents_30d",
      "india_import_dependency_pct",
    ],
    // is_static / live_source_count (rewritten 2026-05-18):
    //   AIS-only gating was wrong — many other streams (oil, vessel scrape, bdti, ofac,
    //   news, currency, aircraft, seismic) are independently alive and should count as
    //   "live" even when AIS is down. We count any KV stream with a non-null payload
    //   AND a fetchedAt within its expected freshness window.
    is_static: ((() => {
      const liveCount = (aisLive ? 1 : 0)
        + (oilLatest?.fetchedAt && (Date.now()/1000 - oilLatest.fetchedAt) < 6*3600 ? 1 : 0)
        + (vesselScrape?.fetchedAt && (Date.now()/1000 - vesselScrape.fetchedAt) < 24*3600 ? 1 : 0)
        + (bdti != null && !bdti_stale ? 1 : 0)
        + (news?.fetchedAt && (Date.now()/1000 - news.fetchedAt) < 24*3600 ? 1 : 0)
        + (currency?.fetchedAt && (Date.now()/1000 - currency.fetchedAt) < 24*3600 ? 1 : 0)
        + (ofac?.fetchedAt && (Date.now()/1000 - ofac.fetchedAt) < 48*3600 ? 1 : 0)
        + (aircraft?.fetchedAt && (Date.now()/1000 - aircraft.fetchedAt) < 24*3600 ? 1 : 0)
        + (seismic?.fetchedAt && (Date.now()/1000 - seismic.fetchedAt) < 24*3600 ? 1 : 0);
      return liveCount === 0;
    })()),
    live_source_count: (aisLive ? 1 : 0)
      + (oilLatest?.fetchedAt && (Date.now()/1000 - oilLatest.fetchedAt) < 6*3600 ? 1 : 0)
      + (vesselScrape?.fetchedAt && (Date.now()/1000 - vesselScrape.fetchedAt) < 24*3600 ? 1 : 0)
      + (bdti != null && !bdti_stale ? 1 : 0)
      + (news?.fetchedAt && (Date.now()/1000 - news.fetchedAt) < 24*3600 ? 1 : 0)
      + (currency?.fetchedAt && (Date.now()/1000 - currency.fetchedAt) < 24*3600 ? 1 : 0)
      + (ofac?.fetchedAt && (Date.now()/1000 - ofac.fetchedAt) < 48*3600 ? 1 : 0)
      + (aircraft?.fetchedAt && (Date.now()/1000 - aircraft.fetchedAt) < 24*3600 ? 1 : 0)
      + (seismic?.fetchedAt && (Date.now()/1000 - seismic.fetchedAt) < 24*3600 ? 1 : 0),
    ais_state_age_sec: aisLive?.ageSec ?? null,
    source: aisLive
      ? aisLive.source
      : "hormuz-watch · live composite (oil/vessel/bdti/ofac/news/currency) · AIS feed dormant",
    // Expose richer AIS payload when live
    eastbound_24h: aisLive?.eastbound ?? null,
    westbound_24h: aisLive?.westbound ?? null,
    unique_imos_24h: aisLive?.uniqueImos ?? null,
    vessel_count_in_bbox: aisLive?.vesselCount ?? null,
    // type_breakdown: AIS payload first, else fall back to vesselScrape.byType
    // (2026-05-18 — same shape {tanker: N, cargo: N, ...}; AIS-dormant safe).
    type_breakdown: aisLive?.typeBreakdown
      ?? (vesselScrape?.byType && Object.keys(vesselScrape.byType).length ? vesselScrape.byType : null),
    // ── Composite signals (Path D) ─────────────────────────────────────────
    // Scraped vessel data — web fallback when AIS is unavailable
    scraped_vessel_total:    vesselScrape?.totals?.all ?? null,
    scraped_vessel_perport:  vesselScrape?.perSite?.vesselfinder?.perPort
                              ? Object.fromEntries(Object.entries(vesselScrape.perSite.vesselfinder.perPort).map(([k,v]) => [k, v?.data?.total ?? null]))
                              : null,
    scraped_vessel_types:    vesselScrape?.byType && Object.keys(vesselScrape.byType).length ? vesselScrape.byType : null,
    scraped_vessel_arrivals: vesselScrape?.totals?.arrivals ?? null,
    scraped_vessel_departures: vesselScrape?.totals?.departures ?? null,
    scraped_vessel_expected_24h: vesselScrape?.totals?.expected_24h ?? null,
    scraped_age_sec:         vesselScrape?.fetchedAt ? Math.floor(Date.now()/1000 - vesselScrape.fetchedAt) : null,
    scraped_confidence:      vesselScrape?.confidence ?? null,
    data_source:             aisLive?.dataSource ?? (aisLive ? "ais" : "static"),
    aircraft_count:          aircraft?.count ?? null,
    military_aircraft_count: aircraft?.militaryCount ?? null,
    earthquake_count_7d:     seismic?.count_7d ?? null,
    seismic_max_mag:         seismic?.max_mag ?? null,
    gdelt_article_count_24h: gdelt?.article_count_24h ?? null,
    gdelt_neg_tone_pct:      gdelt?.neg_tone_pct ?? null,
    weather_rough:           weather?.roughConditions ?? null,
    weather_wind_max_knots:  weather?.windMaxKnots ?? null,
    // News headlines (Hormuz/Iran/tanker RSS aggregator, every 30 min)
    news_count_24h:          news?.count_24h ?? null,
    news_top_keywords:       Array.isArray(news?.top_keywords) ? news.top_keywords.slice(0, 3).map(x => Array.isArray(x) ? x[0] : x) : null,
    news_sources_succeeded:  news?.sources_succeeded ?? null,
    news_age_sec:            news?.fetchedAt ? Math.floor(Date.now()/1000 - news.fetchedAt) : null,
    // Iranian Rial FX (capital-flight / sanction-pressure proxy, hourly)
    irr_usd_official:        currency?.official?.usd_irr ?? null,
    irr_usd_blackmarket:     currency?.blackMarket?.usd_irr ?? null,
    irr_spread_pct:          currency?.spread_pct ?? null,
    aed_usd:                 currency?.aed_usd ?? null,
    currency_age_sec:        currency?.fetchedAt ? Math.floor(Date.now()/1000 - currency.fetchedAt) : null,
    currency_interpretation: currency?.interpretation ?? null,
    // OFAC Iran-related sanctions activity (every 6h via scrape_ofac.py).
    // ofac_recent_actions: titles + dates + urls for the 5 latest Iran-related
    // press releases — drives the "Sanctions enforcement" timeline card.
    // (Phase 2 #2, 2026-05-17 — full vessel-level SDN match deferred to a
    // later phase pending OFAC SDN.csv scraper + AIS recovery.)
    ofac_iran_actions_30d:   ofac?.iran_related_actions_30d ?? null,
    ofac_latest_action_date: ofac?.latest_action_date ?? null,
    ofac_recent_actions:     Array.isArray(ofac?.recent_actions) ? ofac.recent_actions.slice(0, 5) : [],
    ofac_age_sec:            ofac?.fetchedAt ? Math.floor(Date.now()/1000 - ofac.fetchedAt) : null,
    // EIA weekly inventory + SPR (written by scrape_oil.py weekly_stocks block)
    spr_level_kbbl:          oilLatest?.symbols?.weekly_stocks?.spr_kbbl ?? null,
    crude_inventory_kbbl:    oilLatest?.symbols?.weekly_stocks?.commercial_crude_kbbl ?? null,
    inventory_wow_pct:       oilLatest?.symbols?.weekly_stocks?.crude_wow_pct ?? null,
    spr_wow_pct:             oilLatest?.symbols?.weekly_stocks?.spr_wow_pct ?? null,
    weekly_stocks_as_of:     oilLatest?.symbols?.weekly_stocks?.asOf ?? null,
    // OPEC monthly production (STEO PAPR_OPEC, mbpd)
    opec_production_mbpd:    oilLatest?.symbols?.opec_production?.value_mbpd ?? null,
    opec_production_mom_pct: oilLatest?.symbols?.opec_production?.mom_pct ?? null,
    opec_production_as_of:   oilLatest?.symbols?.opec_production?.asOf ?? null,
    upgrade_note: debug
      ? `Reads ais_state from OIL_KV (written by scrape_ais.py every 5 min). Live mode when age < ${AIS_STATE_FRESH_SECONDS}s AND transits24h > 0. Otherwise env-var fallback.`
      : undefined
  };

  return json(payload, 200);
}

function numFromEnv(envVar, fallback) {
  if (envVar == null || envVar === "") return fallback;
  const n = Number(envVar);
  return Number.isFinite(n) ? n : fallback;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300, s-maxage=300",
      "access-control-allow-origin": "*"
    }
  });
}
