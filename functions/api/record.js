// Cloudflare Pages Function — hourly D1 snapshot writer
// Called by a scheduled cron job hitting POST /api/record with X-Snapshot-Token header.
// Pulls current state from internal /api/* endpoints, writes one row to D1 snapshots.
// Designed to be safe to call multiple times an hour (INSERT OR REPLACE by ts to nearest hour).
//
// ─── DATA WRITES (for grepability) ────────────────────────────────────────
// KV: writes "verdict_latest" = full two-stage breakdown (see end of file)
// KV: writes "last_snapshot_ts" = unix seconds (used by scraper's maybe_snapshot guard)
// D1: INSERT INTO snapshots(...) — verdict column stores JSON.stringify(verdict_latest)
// ──────────────────────────────────────────────────────────────────────────
//
// 2026-05-14 — Two-stage verdict:
//   Stage 1: structural weighted-average over 13 inputs (5 new scorers added)
//   Stage 2: override triggers — OFAC/currency/news/aircraft/seismic; each +1 level

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
  if (tankerIndex < -5) return 4;
  if (tankerIndex < -3) return 3;
  if (tankerIndex < -1.5) return 2;
  if (tankerIndex > 5) return 2;
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

// ─── NEW SCORERS (2026-05-14) ────────────────────────────────────────────
function scoreOfac(actions) {
  if (actions == null || !isFinite(actions)) return null;
  if (actions >= 10) return 4;
  if (actions >= 6) return 3;
  if (actions >= 3) return 2;
  if (actions >= 1) return 1;
  return 0;
}
function scoreCurrency(spread) {
  if (spread == null || !isFinite(spread)) return null;
  if (spread >= 500) return 4;
  if (spread >= 200) return 3;
  if (spread >= 100) return 2;
  if (spread >= 50) return 1;
  return 0;
}
function scoreNews(count24h) {
  if (count24h == null || !isFinite(count24h)) return null;
  if (count24h >= 100) return 4;
  if (count24h >= 50) return 3;
  if (count24h >= 25) return 2;
  if (count24h >= 10) return 1;
  return 0;
}
function scoreInventory(sprWow) {
  if (sprWow == null || !isFinite(sprWow)) return null;
  if (sprWow < -3) return 4;
  if (sprWow < -1.5) return 3;
  if (sprWow < -0.5) return 2;
  if (sprWow < 0) return 1;
  return 0;
}
function scoreProduction(mbpd, target = 29.5) {
  if (mbpd == null || !isFinite(mbpd)) return null;
  const dev = Math.abs(mbpd - target);
  if (dev >= 2.0) return 4;
  if (dev >= 1.0) return 3;
  if (dev >= 0.5) return 2;
  if (dev >= 0.25) return 1;
  return 0;
}

// ─── STAGE 2 · override triggers ────────────────────────────────────────
function computeOverrides(snapshot) {
  const triggers = [];

  // OFAC: new Iran action in last 48h
  const ofacLatest = snapshot.ofac_latest_action_date;
  if (ofacLatest) {
    const t = new Date(ofacLatest + "T00:00:00Z").getTime();
    const ageSec = isFinite(t) ? (Date.now() - t) / 1000 : Infinity;
    if (ageSec < 48 * 3600) {
      triggers.push({ id: "ofac", reason: "OFAC Iran-related designation in last 48h", fires: true });
    } else {
      triggers.push({ id: "ofac", reason: "OFAC last action: " + ofacLatest, fires: false });
    }
  } else {
    triggers.push({ id: "ofac", reason: "No OFAC date available", fires: false });
  }

  // Currency: absolute spread > 150%
  const spread = snapshot.irr_spread_pct;
  if (spread != null && isFinite(spread)) {
    if (spread > 150) {
      triggers.push({ id: "currency", reason: "IRR spread > 150% (severe capital flight)", fires: true });
    } else {
      triggers.push({ id: "currency", reason: "IRR spread " + Math.round(spread) + "%", fires: false });
    }
  } else {
    triggers.push({ id: "currency", reason: "IRR spread unavailable", fires: false });
  }

  // News volume: 40+ headlines in 24h ≈ 10+ in 6h
  const news24 = snapshot.news_count_24h || 0;
  if (news24 >= 40) {
    triggers.push({ id: "news", reason: news24 + " headlines in 24h", fires: true });
  } else {
    triggers.push({ id: "news", reason: news24 + " headlines in 24h (threshold 40)", fires: false });
  }

  // Aircraft: >5 military aircraft
  const milAir = snapshot.military_aircraft_count || 0;
  if (milAir > 5) {
    triggers.push({ id: "aircraft", reason: milAir + " military aircraft (anomalous)", fires: true });
  } else {
    triggers.push({ id: "aircraft", reason: milAir + " military aircraft", fires: false });
  }

  // Seismic: 5.5+ magnitude
  const maxMag = snapshot.seismic_max_mag || 0;
  if (maxMag >= 5.5) {
    triggers.push({ id: "seismic", reason: "Mag " + maxMag + " earthquake (significant)", fires: true });
  } else {
    triggers.push({ id: "seismic", reason: "Max mag " + maxMag, fires: false });
  }

  return triggers;
}

function applyOverrides(baseVerdict, triggers) {
  const firedCount = triggers.filter(t => t.fires).length;
  const levels = ["NORMAL", "ELEVATED", "HIGH", "CRITICAL"];
  let idx = levels.indexOf(baseVerdict);
  if (idx < 0) idx = 0;
  idx = Math.min(idx + firedCount, levels.length - 1);
  return levels[idx];
}

// ─── STAGE 1 · structural weighted average (13 inputs) ──────────────────
function computeVerdict(snapshot) {
  const transitsScore   = (snapshot.transits_24h != null && snapshot.transits_24h > 0)
                            ? scoreTransits(snapshot.transits_24h, BASELINE_TRANSITS) : null;
  const oilScore        = scoreOilSpike(snapshot.brent_price, snapshot.brent_dp_24h);
  const stocksScore     = scoreTankerStocks(snapshot.tanker_index);
  const aircraftScore   = scoreAircraft(snapshot.military_aircraft_count);
  const eventsScore     = scoreEvents(snapshot.gdelt_neg_tone);
  const seismicScore    = scoreSeismic(snapshot.earthquake_count_7d, snapshot.max_mag);
  const weatherScore    = scoreWeather(snapshot.rough_conditions);
  const bdtiScore       = scoreBdti(snapshot.bdti, snapshot.bdti_wow);
  const ofacScore       = scoreOfac(snapshot.ofac_iran_actions_30d);
  const currencyScore   = scoreCurrency(snapshot.irr_spread_pct);
  const newsScore       = scoreNews(snapshot.news_count_24h);
  const inventoryScore  = scoreInventory(snapshot.spr_wow_pct);
  const productionScore = scoreProduction(snapshot.opec_production_mbpd);

  // AIS-primary weights (when AIS working — adds transits, reduces others proportionally)
  // Composite-fallback weights (when AIS down — current state)
  const W_AIS = {
    transits: 0.30, oil: 0.13, stocks: 0.09, bdti: 0.05,
    aircraft: 0.09, events: 0.07, seismic: 0.02, weather: 0.02,
    ofac: 0.07, currency: 0.04, news: 0.04, inventory: 0.04, production: 0.04
  };
  const W_COMPOSITE = {
    transits: 0,
    oil: 0.18, stocks: 0.13, bdti: 0.07,
    aircraft: 0.13, events: 0.10, seismic: 0.03, weather: 0.03,
    ofac: 0.10, currency: 0.06, news: 0.05, inventory: 0.05, production: 0.02
  };
  const weights = transitsScore !== null ? W_AIS : W_COMPOSITE;

  const inputs = {
    transits: transitsScore, oil: oilScore, stocks: stocksScore,
    aircraft: aircraftScore, events: eventsScore, seismic: seismicScore,
    weather: weatherScore, bdti: bdtiScore,
    ofac: ofacScore, currency: currencyScore, news: newsScore,
    inventory: inventoryScore, production: productionScore
  };
  let weighted = 0;
  let used = 0;
  for (const k in weights) {
    if (inputs[k] != null && weights[k] > 0) {
      weighted += inputs[k] * weights[k];
      used += weights[k];
    }
  }
  if (used > 0 && used < 1) weighted = weighted / used;

  const structural = weighted >= 3.0 ? "CRITICAL"
                   : weighted >= 2.0 ? "HIGH"
                   : weighted >= 1.0 ? "ELEVATED"
                   : "NORMAL";

  const triggers = computeOverrides(snapshot);
  const firedCount = triggers.filter(t => t.fires).length;
  const final = applyOverrides(structural, triggers);

  return {
    verdict: final,
    structural_verdict: structural,
    structural_score: Math.round(weighted * 100) / 100,
    score: Math.round(weighted * 100) / 100,
    stage1_inputs: inputs,
    weights,
    stage2_triggers: triggers,
    stage2_fired_count: firedCount,
    inputs,
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
  const tsHour = Math.floor(Date.now() / 3600000) * 3600;

  const [oilR, stooqR, eiaR, gfwEncR, gfwLoiR, aisR, snapshotR] = await Promise.allSettled([
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
    fetch(origin + "/api/ais"),
    fetch(origin + "/api/snapshot")
  ]);

  const parseJson = async (r) => {
    if (r.status !== "fulfilled" || !r.value.ok) return null;
    try { return await r.value.json(); } catch { return null; }
  };
  const [oilD, stooqD, eiaD, gfwEncD, gfwLoiD, aisD, snapshotD] = await Promise.all([
    parseJson(oilR), parseJson(stooqR), parseJson(eiaR), parseJson(gfwEncR), parseJson(gfwLoiR), parseJson(aisR), parseJson(snapshotR)
  ]);

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

  // KV side-load for verdict inputs (preserves prior behaviour when /api/snapshot is incomplete)
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

  const milAircraft = aircraftKv?.militaryCount ?? snapshotD?.military_aircraft_count ?? null;
  const totalAircraft = aircraftKv?.count ?? snapshotD?.aircraft_count ?? null;
  const eqCount7d = seismicKv?.count_7d ?? snapshotD?.earthquake_count_7d ?? null;
  const maxMag = seismicKv?.max_mag ?? snapshotD?.seismic_max_mag ?? null;
  const negTone = gdeltKv?.neg_tone_pct ?? snapshotD?.gdelt_neg_tone_pct ?? null;
  const articleCount = gdeltKv?.article_count_24h ?? snapshotD?.gdelt_article_count_24h ?? null;
  const roughWeather = weatherKv?.roughConditions ?? snapshotD?.weather_rough ?? null;
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

  // Build verdict input bundle — includes NEW signals
  const verdictInput = {
    transits_24h:               vTransit24h,
    brent_price:                brent,
    brent_dp_24h:               brentDp,
    tanker_index:               tankerIdx,
    military_aircraft_count:    milAircraft,
    gdelt_neg_tone:             negTone,
    earthquake_count_7d:        eqCount7d,
    max_mag:                    maxMag,
    seismic_max_mag:            maxMag,
    rough_conditions:           roughWeather,
    bdti:                       2841, bdti_wow: 3.2,
    // NEW
    ofac_iran_actions_30d:      snapshotD?.ofac_iran_actions_30d ?? null,
    ofac_latest_action_date:    snapshotD?.ofac_latest_action_date ?? null,
    irr_spread_pct:             snapshotD?.irr_spread_pct ?? null,
    news_count_24h:             snapshotD?.news_count_24h ?? null,
    spr_wow_pct:                snapshotD?.spr_wow_pct ?? null,
    opec_production_mbpd:       snapshotD?.opec_production_mbpd ?? null,
  };

  const verdictResult = computeVerdict(verdictInput);
  const verdict = verdictResult.verdict;
  const now = Math.floor(Date.now() / 1000);

  const verdictPayload = {
    verdict,
    structural_verdict: verdictResult.structural_verdict,
    structural_score:   verdictResult.structural_score,
    stage1_inputs:      verdictResult.stage1_inputs,
    stage1_weights:     verdictResult.weights,
    stage2_triggers:    verdictResult.stage2_triggers,
    stage2_fired_count: verdictResult.stage2_fired_count,
    mode:               verdictResult.mode,
    ts:                 now,
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
      ofac_iran_actions_30d: verdictInput.ofac_iran_actions_30d,
      ofac_latest_action_date: verdictInput.ofac_latest_action_date,
      irr_spread_pct: verdictInput.irr_spread_pct,
      news_count_24h: verdictInput.news_count_24h,
      spr_wow_pct: verdictInput.spr_wow_pct,
      opec_production_mbpd: verdictInput.opec_production_mbpd,
    }
  };

  try {
    // Store full breakdown as JSON in D1 verdict column (legacy column kept)
    const verdictColumnPayload = JSON.stringify({
      verdict,
      structural_verdict: verdictResult.structural_verdict,
      structural_score:   verdictResult.structural_score,
      triggers_fired:     verdictResult.stage2_fired_count,
    });
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
      verdictColumnPayload
    ).run();

    if (env.OIL_KV) {
      await env.OIL_KV.put("verdict_latest", JSON.stringify(verdictPayload));
    }

    return json({
      ok: true, tsHour, brent, wti, gfwEnc, gfwLoi, brentSource, sourceHealth,
      vTransit24h, vTransiting, vAnchored, vApproach,
      verdict, verdictBreakdown: verdictPayload
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
