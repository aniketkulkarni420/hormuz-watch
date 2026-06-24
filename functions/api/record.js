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

// ─── Verdict engine ─────────────────────────────────────────────────────
// All per-signal scorers, override triggers, and the two-stage computeVerdict
// live in functions/_lib/verdict.js (pure, no I/O) so they are unit-testable
// in isolation — see tests/verdict.test.mjs. (Batch H1, 2026-06-23)
import { computeVerdict } from "../_lib/verdict.js";

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
  // Don't feed degraded / zero-message AIS into the verdict — a fresh-but-dead
  // feed would otherwise select ais-primary weights off stale data and defeat
  // the whole composite-mode design (Batch A · 2026-05-14).
  const aisDegraded = !!(aisD && aisD.degraded);
  const vTransit24h = (!aisDegraded && isFinite(aisSummary.transits24h)) ? aisSummary.transits24h : null;
  const vTransiting = isFinite(aisSummary.categories?.transit)  ? aisSummary.categories.transit  : null;
  const vAnchored   = isFinite(aisSummary.categories?.anchored) ? aisSummary.categories.anchored : null;
  const vApproach   = isFinite(aisSummary.categories?.approach) ? aisSummary.categories.approach : null;

  // 2026-05-21: same bug class as dashboard's wtiPrice $105.1 incident —
  // checked only tier==="primary" but our tier is "tier0-xverified" or
  // "scrape" today, so verdict was being computed against EIA-daily $116
  // (3 days stale) instead of live $105. Now accept tier0/scrape/primary
  // (all are real-time-ish), fall to EIA only if all live tiers fail.
  let brent = null, wti = null, brentSource = "none";
  const LIVE_TIERS = ["tier0-xverified", "scrape", "primary", "primary-stale"];
  if (oilD && LIVE_TIERS.includes(oilD.tier) && oilD.brent && isFinite(oilD.brent.level)) {
    brent = oilD.brent.level;
    wti = isFinite(oilD.wti?.level) ? oilD.wti.level : null;
    brentSource = oilD.tier;
  } else if (stooqD && isFinite(stooqD.today)) {
    brent = stooqD.today;
    brentSource = oilD && oilD.tier === "secondary" ? "etf+eia" : "eia";
  } else if (eiaD && eiaD.response && eiaD.response.data && eiaD.response.data[0]) {
    brent = parseFloat(eiaD.response.data[0].value); brentSource = "eia-weekly";
  }
  if (oilD && LIVE_TIERS.includes(oilD.tier) && oilD.wti && isFinite(oilD.wti.level)) wti = oilD.wti.level;

  const bwSpread = (isFinite(brent) && isFinite(wti)) ? (brent - wti) : null;

  let gfwEnc = (gfwEncD && Array.isArray(gfwEncD.entries)) ? gfwEncD.entries.length : null;
  let gfwLoi = (gfwLoiD && Array.isArray(gfwLoiD.entries)) ? gfwLoiD.entries.length : null;

  // KV side-load for verdict inputs (preserves prior behaviour when /api/snapshot is incomplete)
  let aircraftKv = null, seismicKv = null, gdeltKv = null, weatherKv = null, bdtiKv = null;
  if (env.OIL_KV) {
    try {
      const [acR, seR, gdR, wxR, bdR] = await Promise.all([
        env.OIL_KV.get("aircraft_state"),
        env.OIL_KV.get("seismic_state"),
        env.OIL_KV.get("gdelt_state"),
        env.OIL_KV.get("weather_state"),
        env.OIL_KV.get("bdti_latest"),
      ]);
      if (acR) aircraftKv = JSON.parse(acR);
      if (seR) seismicKv = JSON.parse(seR);
      if (gdR) gdeltKv = JSON.parse(gdR);
      if (wxR) weatherKv = JSON.parse(wxR);
      if (bdR) bdtiKv = JSON.parse(bdR);
    } catch { /* best effort */ }
  }

  // BDTI — read from KV (manual-verified entry or scraper value). No more
  // hardcoded 2841 in the verdict or D1 history (Batch A · 2026-05-14).
  // null when KV is empty: scoreBdti() returns null → verdict skips it
  // rather than scoring a fabricated value as "calm".
  const bdtiValue = (bdtiKv && isFinite(bdtiKv.value))   ? bdtiKv.value   : null;
  const bdtiWow   = (bdtiKv && isFinite(bdtiKv.wow_pct)) ? bdtiKv.wow_pct : null;

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
  // PortWatch (2026-06-12): when live AIS is dead, the transits slot gets the
  // IMF daily transit count — REAL strait crossings, lagged ~5-10d (only used
  // when the data as-of is < 12 days old). scoreTransits(2, 22) = 3: the
  // blockade finally scores in the slot built for it.
  let pwTransits = null;
  const pwAsOf = snapshotD?.portwatch_as_of ? Date.parse(snapshotD.portwatch_as_of) : null;
  if (vTransit24h == null && snapshotD?.portwatch_transits_daily != null
      && pwAsOf && (Date.now() - pwAsOf) < 12 * 86400000) {
    pwTransits = snapshotD.portwatch_transits_daily;
  }

  // ── H3 rolling baselines (2026-06-24) ──────────────────────────────────────
  // baseline_transits: trailing-30d median of REAL AIS transit counts from D1.
  // Needs ≥14 non-null samples or we fall back to the constant (cold start /
  // AIS dark). prewar_brent: a deliberate env knob (NEVER a trailing stat — all
  // D1 history is wartime, so a rolling oil baseline would normalize the war
  // away). anchor_review_suggested flags when trailing Brent has run far above
  // the anchor for a while → a human should consider re-baselining (no auto-act).
  let baselineTransits = null;
  let anchorReviewSuggested = false;
  const prewarBrent = (() => {
    const v = parseFloat(env.HORMUZ_PREWAR_BRENT);
    return isFinite(v) && v > 0 ? v : 72.0;
  })();
  if (env.DB) {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
      const rows = await env.DB.prepare(
        "SELECT transits_24h FROM snapshots WHERE ts > ? AND transits_24h IS NOT NULL ORDER BY transits_24h"
      ).bind(cutoff).all();
      const vals = (rows?.results || []).map(r => r.transits_24h).filter(v => Number.isFinite(v));
      if (vals.length >= 14) {
        const mid = Math.floor(vals.length / 2);
        baselineTransits = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
      }
      // Anchor-staleness probe: trailing-30d median Brent vs the anchor.
      const br = await env.DB.prepare(
        "SELECT brent_price FROM snapshots WHERE ts > ? AND brent_price IS NOT NULL ORDER BY brent_price"
      ).bind(cutoff).all();
      const bvals = (br?.results || []).map(r => r.brent_price).filter(v => Number.isFinite(v));
      if (bvals.length >= 14) {
        const bmid = Math.floor(bvals.length / 2);
        const bmedian = bvals.length % 2 ? bvals[bmid] : (bvals[bmid - 1] + bvals[bmid]) / 2;
        anchorReviewSuggested = bmedian > prewarBrent * 1.25;   // sustained >25% above anchor
      }
    } catch { /* best effort — fall back to constants */ }
  }
  const verdictInput = {
    transits_24h:               vTransit24h != null ? vTransit24h : pwTransits,
    // 2026-05-18: pass scraped_vessel_total so computeVerdict can fall back
    // to it when AIS is dormant (vTransit24h is null in that case).
    scraped_vessel_total:       snapshotD?.scraped_vessel_total ?? null,
    brent_price:                brent,
    brent_dp_24h:               brentDp,
    tanker_index:               tankerIdx,
    military_aircraft_count:    milAircraft,
    gdelt_neg_tone:             negTone,
    earthquake_count_7d:        eqCount7d,
    max_mag:                    maxMag,
    seismic_max_mag:            maxMag,
    rough_conditions:           roughWeather,
    bdti:                       bdtiValue, bdti_wow: bdtiWow,
    // NEW
    ofac_iran_actions_30d:      snapshotD?.ofac_iran_actions_30d ?? null,
    // Direction-split OFAC (2026-06-23): net designations (designations −
    // waivers) is what the verdict scores; the 48h trigger fires on a new
    // DESIGNATION only, never on a waiver (a waiver is de-escalation).
    ofac_net_designations_30d:  snapshotD?.ofac_iran_net_designations_30d ?? null,
    ofac_latest_action_date:    snapshotD?.ofac_latest_action_date ?? null,
    ofac_latest_designation_date: snapshotD?.ofac_latest_designation_date ?? null,
    irr_spread_pct:             snapshotD?.irr_spread_pct ?? null,
    news_count_24h:             snapshotD?.news_count_24h ?? null,
    // Direction-aware news sentiment (2026-06-23): the fix for "de-escalation
    // news read as escalation". net < 0 = de-escalating.
    news_sentiment:             snapshotD?.news_sentiment ?? null,
    news_net_sentiment:         snapshotD?.news_net_sentiment ?? null,
    spr_wow_pct:                snapshotD?.spr_wow_pct ?? null,
    opec_production_mbpd:       snapshotD?.opec_production_mbpd ?? null,
    // UKMTO conflict feed (2026-06-10) — drives the ukmto override trigger
    ukmto_latest_attack_ts:     snapshotD?.ukmto_latest_attack_ts ?? null,
    ukmto_hormuz_7d:            snapshotD?.ukmto_hormuz_7d ?? null,
    incidents_30d:              snapshotD?.incidents_30d ?? null,
    transits_source:            vTransit24h != null ? "ais" : (pwTransits != null ? "portwatch_lagged" : null),
    // Per-signal ages (H2) — drive freshness-based confidence in the contract.
    // Only the feeds whose age snapshot exposes today; others default fresh.
    news_age_sec:               snapshotD?.news_age_sec ?? null,
    currency_age_sec:           snapshotD?.currency_age_sec ?? null,
    ofac_age_sec:               snapshotD?.ofac_age_sec ?? null,
    // H3 rolling baselines (null → module uses constant fallback)
    baseline_transits:          baselineTransits,
    prewar_brent:               prewarBrent,
  };

  const verdictResult = computeVerdict(verdictInput);
  const verdict = verdictResult.verdict;
  const now = Math.floor(Date.now() / 1000);

  const verdictPayload = {
    verdict,
    structural_verdict: verdictResult.structural_verdict,
    structural_score:   verdictResult.structural_score,
    stage1_inputs:      verdictResult.stage1_inputs,
    stage1_signals:     verdictResult.stage1_signals,   // H2 typed contract
    baselines:          verdictResult.baselines,        // H3 baselines actually used
    anchor_review_suggested: anchorReviewSuggested,      // H3: re-baseline hint (no auto-act)
    stage1_weights:     verdictResult.weights,
    stage2_triggers:    verdictResult.stage2_triggers,
    stage2_fired_count: verdictResult.stage2_fired_count,
    residual_risk_floor: verdictResult.residual_risk_floor,
    mode:               verdictResult.mode,
    confidence:         verdictResult.confidence,
    inputs_used_count:  verdictResult.inputs_used_count,
    inputs_total:       verdictResult.inputs_total,
    coverage_pct:       verdictResult.coverage_pct,
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
      ofac_net_designations_30d: verdictInput.ofac_net_designations_30d,
      ofac_latest_action_date: verdictInput.ofac_latest_action_date,
      ofac_latest_designation_date: verdictInput.ofac_latest_designation_date,
      irr_spread_pct: verdictInput.irr_spread_pct,
      news_count_24h: verdictInput.news_count_24h,
      news_sentiment: verdictInput.news_sentiment,
      news_net_sentiment: verdictInput.news_net_sentiment,
      spr_wow_pct: verdictInput.spr_wow_pct,
      opec_production_mbpd: verdictInput.opec_production_mbpd,
      // Vessel composition history (2026-06-10) — persisted hourly so trend
      // tiles (in-port accumulation = blockade signature) have a series.
      ships_in_port: snapshotD?.scraped_vessel_total ?? null,
      arrivals_24h: snapshotD?.scraped_vessel_arrivals ?? null,
      tanker_count_est: snapshotD?.tanker_count ?? null,
      iran_port_vessels: snapshotD?.iran_port_vessels ?? null,
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
      isFinite(bdtiValue) ? bdtiValue : null,
      isFinite(bdtiWow) ? bdtiWow : null,
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
