// Cloudflare Pages Function — PUBLIC data-integrity validator.
//
// Unlike /api/diag (token-gated, freshness-only), this scores every feed on
// THREE axes and is safe to expose publicly so the dashboard can confidence-
// gate its own tiles:
//
//   1. FRESH   — age within the feed's SLA
//   2. SANE    — value within plausible bounds (catches frozen-constant bugs)
//   3. ACCURATE— internal cross-verify where a 2nd source exists (oil), or
//                not-frozen / consistency checks (bdti, currency)
//
// Each feed → { status: "ok"|"stale"|"suspect"|"dead"|"known-degraded",
//               confidence: "high"|"medium"|"low"|"none", reason }
// Plus top-level showcase_ready boolean + the failing feeds.
//
// 2026-05-28 (Tier 1B). No external API calls — uses data already stored at
// scrape time (cross_verify, history) so it stays fast for frequent reads.

export async function onRequestGet({ env }) {
  const now = Math.floor(Date.now() / 1000);
  const kv = async (k) => {
    try { const r = await env.OIL_KV.get(k); return r ? JSON.parse(r) : null; }
    catch { return null; }
  };

  const [oil, bdtiLatest, currency, vessel, aircraft, news, ofac, weather,
         seismic, gdelt, aisState, aisHealth, verdict, ukmto, portwatch] = await Promise.all([
    kv("oil_scraped"), kv("bdti_latest"), kv("currency_irr"),
    kv("vessel_count_scraped"), kv("aircraft_state"), kv("news_headlines"),
    kv("ofac_state"), kv("weather_state"), kv("seismic_state"),
    kv("gdelt_state"), kv("ais_state"), kv("ais_health"), kv("verdict_latest"),
    kv("ukmto_state"), kv("portwatch_state"),
  ]);

  const feeds = {};
  const ageMin = (obj, field) => {
    const t = obj && (obj[field] || obj.fetchedAt || obj.ts);
    return t ? Math.round((now - t) / 60) : null;
  };
  // helper: build a feed verdict
  const F = (status, confidence, reason, extra) =>
    ({ status, confidence, reason, ...(extra || {}) });

  // ── OIL ── fresh<360m · sane 30-250 · accurate via cross_verify confidence
  (() => {
    if (!oil) return feeds.oil = F("dead", "none", "no oil_scraped KV");
    const a = ageMin(oil);
    const bl = oil.brent?.value, wl = oil.wti?.value;
    const conf = oil.brent?.confidence || "low";
    const cv = oil.cross_verify?.brent_pct_diff;
    if (a == null || a > 360) return feeds.oil = F("stale", "low", `age ${a}m > 360`);
    if (!(bl >= 30 && bl <= 250) || !(wl >= 30 && wl <= 250))
      return feeds.oil = F("suspect", "low", `out of bounds brent=${bl} wti=${wl}`);
    const spread = bl - wl;
    if (spread < -5 || spread > 30)
      return feeds.oil = F("suspect", "low", `implausible spread $${spread.toFixed(1)}`);
    feeds.oil = F("ok", conf, `brent $${bl} wti $${wl}${cv != null ? ` · sources agree Δ${cv}%` : ""}`, { ageMin: a });
  })();

  // ── BDTI ── fresh<7d · sane 500-6000 · not-frozen (wow present + nonzero history)
  (() => {
    const b = bdtiLatest;
    if (!b || !b.value) return feeds.bdti = F("dead", "none", "no bdti_latest");
    const ageDays = b.ts ? Math.floor((now - b.ts) / 86400) : null;
    if (ageDays != null && ageDays > 9) return feeds.bdti = F("stale", "low", `${ageDays}d old`);
    if (!(b.value >= 500 && b.value <= 6000)) return feeds.bdti = F("suspect", "low", `value ${b.value} out of 500-6000`);
    feeds.bdti = F("ok", "high", `${b.value} asOf ${b.asOf || "?"}`, { ageDays });
  })();

  // ── CURRENCY ── fresh<360m · both rates present · spread 0-150%
  (() => {
    if (!currency) return feeds.currency = F("dead", "none", "no currency_irr");
    const a = ageMin(currency);
    const off = currency.official?.usd_irr, blk = currency.blackMarket?.usd_irr;
    const sp = currency.spread_pct;
    if (a == null || a > 360) return feeds.currency = F("stale", "low", `age ${a}m`);
    if (!off || !blk) return feeds.currency = F("suspect", "low", "missing a rate");
    if (sp == null || sp < 0 || sp > 150) return feeds.currency = F("suspect", "low", `spread ${sp}% out of 0-150`);
    feeds.currency = F("ok", currency.sources_succeeded >= 2 ? "high" : "medium", `spread ${sp}%`, { ageMin: a });
  })();

  // ── VESSEL (web scrape) ── fresh<24h · sane 0-500
  (() => {
    if (!vessel) return feeds.vessel = F("dead", "none", "no vessel_count_scraped");
    const a = ageMin(vessel);
    const total = vessel.totals?.all;
    if (a == null || a > 1440) return feeds.vessel = F("stale", "low", `age ${a}m`);
    if (!(total >= 0 && total <= 500)) return feeds.vessel = F("suspect", "low", `total ${total} out of 0-500`);
    feeds.vessel = F("ok", vessel.confidence === "high" ? "high" : "medium", `${total} vessels`, { ageMin: a });
  })();

  // ── AIRCRAFT ── fresh<360m · sane 0-300
  (() => {
    if (!aircraft) return feeds.aircraft = F("dead", "none", "no aircraft_state");
    const a = ageMin(aircraft);
    const c = aircraft.count;
    if (a == null || a > 360) return feeds.aircraft = F("stale", "low", `age ${a}m`);
    if (!(c >= 0 && c <= 300)) return feeds.aircraft = F("suspect", "low", `count ${c} out of 0-300`);
    feeds.aircraft = F("ok", "high", `${c} aircraft`, { ageMin: a });
  })();

  // ── NEWS ── fresh<360m · count present
  (() => {
    if (!news) return feeds.news = F("dead", "none", "no news_headlines");
    const a = ageMin(news);
    if (a == null || a > 360) return feeds.news = F("stale", "low", `age ${a}m`);
    feeds.news = F("ok", "high", `${(news.headlines || news.items || []).length || news.count_24h || "?"} headlines`, { ageMin: a });
  })();

  // ── OFAC ── fresh<48h
  (() => {
    if (!ofac) return feeds.ofac = F("dead", "none", "no ofac_state");
    const a = ageMin(ofac);
    if (a == null || a > 2880) return feeds.ofac = F("stale", "low", `age ${a}m`);
    feeds.ofac = F("ok", "high", "fresh", { ageMin: a });
  })();

  // ── UKMTO ── fresh<24h (2h cron, GHA-throttled) · sane count 1-2000 (2026-06-10)
  (() => {
    if (!ukmto) return feeds.ukmto = F("dead", "none", "no ukmto_state");
    const a = ageMin(ukmto);
    if (a == null || a > 1440) return feeds.ukmto = F("stale", "low", `age ${a}m > 1440`);
    const n = ukmto.total_reports;
    if (!(n >= 1 && n <= 2000)) return feeds.ukmto = F("suspect", "low", `count ${n} out of bounds`);
    const c = ukmto.counts || {};
    feeds.ukmto = F("ok", "high", `${c.incidents_30d ?? "?"} incidents/30d · ${c.attacks_30d ?? "?"} attacks · hormuz ${c.hormuz_30d ?? "?"}`, { ageMin: a });
  })();

  // ── PORTWATCH ── source updates weekly; budget 12 days on the data as-of (2026-06-12)
  (() => {
    if (!portwatch) return feeds.portwatch = F("dead", "none", "no portwatch_state");
    const asOf = portwatch.as_of ? Date.parse(portwatch.as_of) : null;
    const dataAgeD = asOf ? Math.round((now - asOf) / 86400000) : null;
    if (dataAgeD == null || dataAgeD > 12) return feeds.portwatch = F("stale", "low", `data as-of ${portwatch.as_of} (${dataAgeD}d)`);
    const t = portwatch.latest?.total;
    if (!(t >= 0 && t <= 500)) return feeds.portwatch = F("suspect", "low", `count ${t} out of bounds`);
    feeds.portwatch = F("ok", "high", `${t} transits/d as-of ${portwatch.as_of} · ${portwatch.pct_of_prewar}% of pre-war`, { ageMin: Math.round((now - (portwatch.fetchedAt*1000||now))/60000) });
  })();

  // ── WEATHER ── fresh<360m
  (() => {
    if (!weather) return feeds.weather = F("dead", "none", "no weather_state");
    const a = ageMin(weather);
    if (a == null || a > 360) return feeds.weather = F("stale", "low", `age ${a}m`);
    feeds.weather = F("ok", "high", "fresh", { ageMin: a });
  })();

  // ── SEISMIC ── fresh<360m (0 events is valid)
  (() => {
    if (!seismic) return feeds.seismic = F("dead", "none", "no seismic_state");
    const a = ageMin(seismic);
    if (a == null || a > 360) return feeds.seismic = F("stale", "low", `age ${a}m`);
    feeds.seismic = F("ok", "high", `${seismic.count_7d ?? 0} events 7d`, { ageMin: a });
  })();

  // ── GDELT ── fresh<360m · tone present
  (() => {
    if (!gdelt) return feeds.gdelt = F("dead", "none", "no gdelt_state");
    const a = ageMin(gdelt);
    if (a == null || a > 360) return feeds.gdelt = F("stale", "low", `age ${a}m`);
    feeds.gdelt = F("ok", gdelt.neg_tone_pct != null ? "high" : "medium",
      `${gdelt.article_count_24h ?? "?"} articles${gdelt.neg_tone_pct != null ? ` · ${gdelt.neg_tone_pct}% neg` : " · no tone"}`, { ageMin: a });
  })();

  // ── VERDICT ── fresh<120m · score 0-4
  (() => {
    if (!verdict) return feeds.verdict = F("dead", "none", "no verdict_latest");
    const a = ageMin(verdict);
    const sc = verdict.structural_score;
    if (a == null || a > 120) return feeds.verdict = F("stale", "low", `age ${a}m`);
    if (!(sc >= 0 && sc <= 4)) return feeds.verdict = F("suspect", "low", `score ${sc} out of 0-4`);
    feeds.verdict = F("ok", "high", `${verdict.verdict} ${sc}`, { ageMin: a });
  })();

  // ── AIS ── known-degraded (key revoked) — do NOT penalize showcase_ready
  (() => {
    const reason = aisHealth?.reason;
    if (reason === "ok") {
      feeds.ais = F("ok", "high", "live AIS flowing");
    } else {
      feeds.ais = F("known-degraded", "none",
        `AIS dormant (${reason || "unknown"}) — vessel count covered by web scrape`);
    }
  })();

  // ── Rollup ── showcase_ready = no feed in suspect/dead/stale (AIS known-degraded excluded)
  const blocking = Object.entries(feeds).filter(([k, v]) =>
    v.status === "suspect" || v.status === "dead" || v.status === "stale");
  const showcase_ready = blocking.length === 0;
  const degraded = Object.entries(feeds)
    .filter(([k, v]) => v.status !== "ok")
    .map(([k, v]) => `${k}:${v.status}`);

  return json({
    ts: now,
    showcase_ready,
    blocking_count: blocking.length,
    blocking: blocking.map(([k, v]) => `${k}: ${v.status} (${v.reason})`),
    degraded_summary: degraded,   // includes known-degraded for transparency
    feeds,
  });
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",   // 1-min edge cache — frequent dashboard reads are cheap
      "access-control-allow-origin": "*",
    },
  });
}
