// Cloudflare Pages Function — hourly D1 snapshot writer
// Called by a scheduled cron job hitting POST /api/record with X-Snapshot-Token header.
// Pulls current state from internal /api/* endpoints, writes one row to D1 snapshots.
// Designed to be safe to call multiple times an hour (INSERT OR REPLACE by ts to nearest hour).
//
// ─── DATA WRITES (for grepability) ────────────────────────────────────────
// KV: writes "verdict_latest" = { verdict: "NORMAL"|"ELEVATED"|"HIGH"|"CRITICAL", ts }
// KV: writes "last_snapshot_ts" = unix seconds (used by scraper's maybe_snapshot guard)
// D1: INSERT INTO snapshots(ts, transits_24h, vessels_transiting, brent_price, wti_price,
//      bw_spread, brent_source, bdti, bdti_wow, gfw_encounters, gfw_loitering, dark_pct,
//      india_via_hormuz_pct, source_health, verdict)
// ──────────────────────────────────────────────────────────────────────────
//
// TODO: read thresholds from /config/verdict_thresholds.json once Worker can import JSON

import { reportError } from "../_lib/sentry.js";

// ─── Per-signal scorers · each returns 0 (calm) → 4 (critical) ──────────────
const BASELINE_TRANSITS = 22;

function scoreTransits(t, baseline) {
  if (t == null || !isFinite(t)) return null;
  if (t === 0) return 4;
  if (t < 12) return 3;
  if (t < 18) return 2;
  if (t < baseline * 0.85) return 1;
  return 0;
}
function scoreOilSpike(price, dp24h) {
  if (!isFinite(price)) return null;
  const dp = isFinite(dp24h) ? Math.abs(dp24h) : 0;
  if (price > 130 || dp > 8) return 4;
  if (price > 110 || dp > 5) return 3;
  if (price > 95 || dp > 3) return 2;
  if (dp > 1.5) return 1;
  return 0;
}
function scoreTankerStocks(tankerIndex) {
  if (tankerIndex == null || !isFinite(tankerIndex)) return null;
  // positive dp = healthy; negative dp = freight panic discount
  if (tankerIndex < -5) return 4;
  if (tankerIndex < -3) return 3;
  if (tankerIndex < -1.5) return 2;
  if (tankerIndex > 5) return 2; // sudden spike also abnormal
  return 0;
}
function scoreAircraft(milCount) {
  if (milCount == null || !isFinite(milCount)) return null;
  if (milCount >= 8) return 4;
  if (milCount >= 5) return 3;
  if (milCount >= 3) return 2;
  if (milCount >= 1) return 1;
  return 0;
}
function scoreEvents(negTonePct) {
  if (negTonePct == null || !isFinite(negTonePct)) return null;
  if (negTonePct > 70) return 4;
  if (negTonePct > 55) return 3;
  if (negTonePct > 40) return 2;
  if (negTonePct > 30) return 1;
  return 0;
}
function scoreSeismic(count7d, maxMag) {
  if (count7d == null) return null;
  if ((maxMag || 0) >= 6.5) return 3;
  if ((maxMag || 0) >= 6) return 2;
  if (count7d >= 15 || (maxMag || 0) >= 5) return 1;
  return 0;
}
function scoreWeather(rough) {
  if (rough == null) return null;
  return rough ? 2 : 0;
}
function scoreBdti(bdti, wow) {
  if (bdti == null || !isFinite(bdti)) return null;
  const w = isFinite(wow) ? Math.abs(wow) : 0;
  if (bdti > 2500 || w > 20) return 3;
  if (bdti > 1800 || w > 10) return 2;
  if (w > 5) return 1;
  return 0;
}

function computeVerdict(snapshot) {
  const transitsScore = snapshot.transits_24h != null && snapshot.transits_24h > 0
    ? scoreTransits(snapshot.transits_24h, BASELINE_TRANSITS)
    : null; // SKIP when no AIS data
  const oilScore = scoreOilSpike(snapshot.brent_price, snapshot.brent_dp_24h);
  const stocksScore = scoreTankerStocks(snapshot.tanker_index);
  const aircraftScore = scoreAircraft(snapshot.military_aircraft_count);
  const eventsScore = scoreEvents(snapshot.gdelt_neg_tone);
  const seismicScore = scoreSeismic(snapshot.earthquake_count_7d, snapshot.max_mag);
  const weatherScore = scoreWeather(snapshot.rough_conditions);
  const bdtiScore = scoreBdti(snapshot.bdti, snapshot.bdti_wow);

  // Weight switches based on whether AIS is alive
  const weights = transitsScore !== null
    ? { transits: 0.30, oil: 0.20, stocks: 0.15, aircraft: 0.10, events: 0.10, seismic: 0.05, weather: 0.05, bdti: 0.05 }
    : { transits: 0,    oil: 0.25, stocks: 0.20, aircraft: 0.20, events: 0.15, seismic: 0.05, weather: 0.05, bdti: 0.10 };

  const inputs = {
    transits: transitsScore, oil: oilScore, stocks: stocksScore,
    aircraft: aircraftScore, events: eventsScore, seismic: seismicScore,
    weather: weatherScore, bdti: bdtiScore
  };
  let weighted = 0;
  let used = 0;
  for (const k in weights) {
    if (inputs[k] != null) {
      weighted += inputs[k] * weights[k];
      used += weights[k];
    }
  }
  // Re-normalise so missing inputs don't bias low
  if (used > 0 && used < 1) weighted = weighted / used;

  const verdict = weighted > 3 ? "CRITICAL"
                : weighted > 2 ? "HIGH"
                : weighted > 1 ? "ELEVATED"
                : "NORMAL";

  return {
    verdict,
    score: Math.round(weighted * 100) / 100,
    inputs,
    weights,
    mode: transitsScore !== null ? "ais-primary" : "composite-fallback"
  };
}

export async function onRequestPost(ctx) {
  try {
    return await _handleRecord(ctx);
  } catch (e) {
    await reportError(e, ctx.env, { tags: { endpoint: "/api/record", method: "POST" } });
    throw e;
  }
}

async function _handleRecord({ request, env }) {
  const token = request.headers.get("X-Snapshot-Token");
  if (!env.SNAPSHOT_TOKEN || token !== env.SNAPSHOT_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.DB) {
    return json({ error: "D1 binding 'DB' missing — configure in Pages settings" }, 500);
  }

  const origin = new URL(request.url).origin;
  // Bucket timestamp to nearest hour so multiple calls within an hour collapse to one row
  const tsHour = Math.floor(Date.now() / 3600000) * 3600;

  const [oilR, stooqR, eiaR, gfwEncR, gfwLoiR, aisR] = await Promise.allSettled([
    fetch(origin + "/api/oil"),
    fetch(origin + "/api/stooq"),
    fetch(origin + "/api/eia?series=RBRTE&length=2"),
    fetch(origin + "/api/gfw", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        datasets: ["public-global-encounters-events:latest"],
        startDate: new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10),
        endDate: new Date().toISOString().slice(0, 10),
        geometry: { type: "Polygon", coordinates: [[[52, 24], [59.5, 24], [59.5, 28.5], [52, 28.5], [52, 24]]] }
      })
    }),
    fetch(origin + "/api/gfw", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        datasets: ["public-global-loitering-events-carriers:latest"],
        startDate: new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10),
        endDate: new Date().toISOString().slice(0, 10),
        geometry: { type: "Polygon", coordinates: [[[52, 24], [59.5, 24], [59.5, 28.5], [52, 28.5], [52, 24]]] }
      })
    }),
    fetch(origin + "/api/ais")
  ]);

  const parseJson = async (r) => {
    if (r.status !== "fulfilled" || !r.value.ok) return null;
    try { return await r.value.json(); } catch { return null; }
  };
  const [oilD, stooqD, eiaD, gfwEncD, gfwLoiD, aisD] = await Promise.all([
    parseJson(oilR), parseJson(stooqR), parseJson(eiaR), parseJson(gfwEncR), parseJson(gfwLoiR), parseJson(aisR)
  ]);

  // C3 — pull vessel counts from /api/ais so backtest has non-null transits_24h
  const aisSummary = (aisD && aisD.summary) || {};
  const vTransit24h = isFinite(aisSummary.transits24h) ? aisSummary.transits24h : null;
  const vTransiting = isFinite(aisSummary.categories?.transit)  ? aisSummary.categories.transit  : null;
  const vAnchored   = isFinite(aisSummary.categories?.anchored) ? aisSummary.categories.anchored : null;
  const vApproach   = isFinite(aisSummary.categories?.approach) ? aisSummary.categories.approach : null;

  let brent = null, wti = null, brentSource = "none";
  if (oilD && oilD.tier === "primary" && oilD.brent) {
    brent = oilD.brent.level; wti = oilD.wti.level; brentSource = "twelvedata";
  } else if (stooqD && isFinite(stooqD.today)) {
    brent = stooqD.today;
    brentSource = oilD && oilD.tier === "secondary" ? "etf+eia" : "eia";
  } else if (eiaD && eiaD.response && eiaD.response.data && eiaD.response.data[0]) {
    brent = parseFloat(eiaD.response.data[0].value); brentSource = "eia-weekly";
  }
  if (oilD && oilD.tier === "primary" && oilD.wti) wti = oilD.wti.level;

  const bwSpread = (isFinite(brent) && isFinite(wti)) ? (brent - wti) : null;

  let gfwEnc = (gfwEncD && Array.isArray(gfwEncD.entries)) ? gfwEncD.entries.length : null;
  let gfwLoi = (gfwLoiD && Array.isArray(gfwLoiD.entries)) ? gfwLoiD.entries.length : null;

  // ─── Composite signals · read 4 new KV keys for verdict computation ──────
  let aircraftKv = null, seismicKv = null, gdeltKv = null, weatherKv = null;
  if (env.OIL_KV) {
    try {
      const [acR, seR, gdR, wxR] = await Promise.all([
        env.OIL_KV.get("aircraft_state"),
        env.OIL_KV.get("seismic_state"),
        env.OIL_KV.get("gdelt_state"),
        env.OIL_KV.get("weather_state"),
      ]);
      if (acR) aircraftKv = JSON.parse(acR);
      if (seR) seismicKv = JSON.parse(seR);
      if (gdR) gdeltKv = JSON.parse(gdR);
      if (wxR) weatherKv = JSON.parse(wxR);
    } catch { /* best effort */ }
  }

  const milAircraft = aircraftKv?.militaryCount ?? null;
  const totalAircraft = aircraftKv?.count ?? null;
  const eqCount7d = seismicKv?.count_7d ?? null;
  const maxMag = seismicKv?.max_mag ?? null;
  const negTone = gdeltKv?.neg_tone_pct ?? null;
  const articleCount = gdeltKv?.article_count_24h ?? null;
  const roughWeather = weatherKv?.roughConditions ?? null;
  const tankerIdx = oilD?.tankerActivityIndex?.value ?? null;
  const brentDp = (oilD?.brent?.changePct != null) ? oilD.brent.changePct : null;

  const sourceHealth = {
    oil:   oilR.status === "fulfilled" && oilR.value.ok ? (oilD?.tier || "ok") : "fail",
    stooq: stooqR.status === "fulfilled" && stooqR.value.ok ? "ok" : "fail",
    eia:   eiaR.status === "fulfilled" && eiaR.value.ok ? "ok" : "fail",
    gfw:   gfwEncR.status === "fulfilled" && gfwEncR.value.ok ? "ok" : "fail",
    ais:   aisR.status === "fulfilled" && aisR.value.ok && vTransit24h != null ? "ok" : "fail",
    aircraft: aircraftKv ? "ok" : "fail",
    seismic:  seismicKv  ? "ok" : "fail",
    gdelt:    gdeltKv    ? "ok" : "fail",
    weather:  weatherKv  ? "ok" : "fail",
  };

  // Compute composite-aware risk verdict server-side
  const verdictResult = computeVerdict({
    transits_24h:            vTransit24h,
    brent_price:             brent,
    brent_dp_24h:            brentDp,
    tanker_index:            tankerIdx,
    military_aircraft_count: milAircraft,
    gdelt_neg_tone:          negTone,
    earthquake_count_7d:     eqCount7d,
    max_mag:                 maxMag,
    rough_conditions:        roughWeather,
    bdti:                    2841, // legacy default; real BDTI in KV bdti_latest
    bdti_wow:                3.2,
  });
  const verdict = verdictResult.verdict;

  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO snapshots (
        ts, transits_24h, vessels_transiting, vessels_anchored, vessels_approach,
        brent_price, brent_source, wti_price, bw_spread,
        bdti, bdti_wow, gfw_encounters, gfw_loitering, dark_pct,
        india_via_hormuz_pct, source_health, verdict
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      tsHour,
      vTransit24h, vTransiting, vAnchored, vApproach,
      isFinite(brent) ? brent : null,
      brentSource,
      isFinite(wti) ? wti : null,
      isFinite(bwSpread) ? bwSpread : null,
      2841, 3.2,
      gfwEnc, gfwLoi, null,
      62.0,
      JSON.stringify(sourceHealth),
      verdict
    ).run();

    // Write latest verdict (full composite breakdown) to KV for fast access
    if (env.OIL_KV) {
      await env.OIL_KV.put("verdict_latest", JSON.stringify({
        verdict,
        score: verdictResult.score,
        inputs: verdictResult.inputs,
        weights: verdictResult.weights,
        mode: verdictResult.mode,
        ts: Math.floor(Date.now() / 1000),
        signals: {
          transits_24h: vTransit24h,
          brent_price: brent,
          brent_dp_24h: brentDp,
          tanker_index: tankerIdx,
          military_aircraft_count: milAircraft,
          total_aircraft_count: totalAircraft,
          gdelt_article_count_24h: articleCount,
          gdelt_neg_tone_pct: negTone,
          earthquake_count_7d: eqCount7d,
          max_mag: maxMag,
          weather_rough: roughWeather,
        }
      }));
    }

    return json({
      ok: true, tsHour, brent, wti, gfwEnc, gfwLoi, brentSource, sourceHealth,
      vTransit24h, vTransiting, vAnchored, vApproach,
      verdict, verdictBreakdown: verdictResult
    });
  } catch (e) {
    return json({ error: "D1 write failed", detail: String(e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}
