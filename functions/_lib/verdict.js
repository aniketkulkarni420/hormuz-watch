// ─── Verdict engine — PURE module (no fetch / no KV / no I/O) ───────────────
// Extracted verbatim from functions/api/record.js (2026-06-23, Batch H1) so the
// verdict logic is unit-testable in isolation. record.js imports computeVerdict
// from here; tests/verdict.test.mjs imports the same module and asserts the
// band + key triggers for ~15 labelled scenarios. Keeping this pure (a snapshot
// object in → a verdict object out, deterministic except for Date.now() in the
// time-window triggers) is the precondition for the golden-fixture tests and
// for the Verdict Engine v2 refactor (.process/VERDICT_ENGINE_V2.md).
//
// IMPORTANT: behaviour must stay byte-identical to the previous inline version.
// Any scoring/threshold change goes through tests/verdict.test.mjs.

// ─── Per-signal scorers · each returns 0 (calm) → 4 (critical) ──────────────
// Pre-crisis normal daily transit count (Batch F · 2026-06-24: unified 22→42).
// 42 = the documented derivation (21M bbl/d ÷ ~500k bbl/vessel) and matches
// config/regions.json transitsPerDay + the methodology page. The old 22 made
// the blockade scorer LESS sensitive (needed transits < 18.7 vs < 35.7 to
// flag) — wrong direction for a war monitor. Used only as the fallback when
// the rolling baseline (H3) has no data (AIS dark / cold start).
export const BASELINE_TRANSITS = 42;
// Pre-war Brent anchor (2026-02-27 close, before the Iran conflict began).
// Used to score the WAR PREMIUM LEVEL, not just daily spikes — three months
// into a conflict, prices plateau and a Δ-only scorer decays to NORMAL while
// the strait is under blockade. (2026-06-10 verdict-engine repair.)
export const PREWAR_BRENT = 72.0;

// ─── H2 signal contract (2026-06-23) ────────────────────────────────────────
// Every signal is described by {level, direction, confidence, asOf}, not a bare
// 0–4 scalar. This makes direction a first-class, uniform property instead of
// being special-cased in two places, and surfaces per-signal confidence for the
// UI (H5) and for downweighting stale feeds. The weighted AVERAGE still uses
// `level` (so behaviour is locked by tests/verdict.test.mjs), but the contract
// is now the structure H3/H4 build on. See .process/VERDICT_ENGINE_V2.md.
//
//   direction: +1 escalatory · 0 neutral/calm · -1 de-escalatory
//     Most signals are magnitude-only (a low oil price is not "de-escalation
//     pressure") → +1 when level>0 else 0. Genuinely bidirectional signals —
//     NEWS (sentiment) and OFAC (designations vs waivers) — can be -1.
//   confidence: 0 when the signal is absent; otherwise freshness-scaled when a
//     per-signal age is available, else 1.0.

// Per-signal max-age (seconds) for freshness-based confidence — mirrors the
// cron cadences in functions/api/diag.js. Only signals whose age is threaded
// from snapshot.js appear here; the rest default to confidence 1.0 when present.
export const SIGNAL_MAX_AGE_SEC = {
  news: 5400,      // every 30 min
  currency: 9000,  // hourly
  ofac: 28800,     // every 6 h
};

function freshnessConfidence(key, ageSec) {
  if (ageSec == null || !isFinite(ageSec)) return 1;   // no age info → assume fresh
  const maxAge = SIGNAL_MAX_AGE_SEC[key];
  if (maxAge == null) return 1;
  if (ageSec <= maxAge) return 1;
  if (ageSec >= maxAge * 3) return 0.3;                 // very stale → low confidence
  // linear 1 → 0.3 between maxAge and 3×maxAge
  return Math.round((1 - 0.7 * ((ageSec - maxAge) / (maxAge * 2))) * 100) / 100;
}

// SINGLE SOURCE OF TRUTH for news direction (2026-06-23). Used by both the
// signal contract and the de-escalation de-trigger so they can never disagree.
// Identical semantics to the prior inline `newsDeescalating` derivation.
export function newsDirection(snapshot) {
  const net = snapshot.news_net_sentiment;
  if ((net != null && isFinite(net) && net <= -0.33) || snapshot.news_sentiment === "de-escalating") return -1;
  if ((net != null && isFinite(net) && net >= 0.33) || snapshot.news_sentiment === "escalating") return +1;
  return 0;
}

function signalDirection(level) {
  // H2.5: signed `level` now carries the sign itself (news/OFAC can be < 0);
  // direction is simply its sign. Magnitude-only signals are ≥ 0 → +1/0.
  if (level == null || level === 0) return 0;
  return level > 0 ? +1 : -1;
}

export function scoreTransits(t, baseline) {
  if (t == null || !isFinite(t)) return null;
  if (t === 0) return 4;
  if (t < 12) return 3;
  if (t < 18) return 2;
  if (t < baseline * 0.85) return 1;
  return 0;
}
export function scoreOilSpike(price, dp24h, anchor = PREWAR_BRENT) {
  if (!isFinite(price)) return null;
  const dp = isFinite(dp24h) ? Math.abs(dp24h) : 0;
  let spike = 0;
  if (price > 130 || dp > 8) spike = 4;
  else if (price > 110 || dp > 5) spike = 3;
  else if (price > 95 || dp > 3) spike = 2;
  else if (dp > 1.5) spike = 1;
  // War-premium LEVEL vs pre-war anchor (2026-06-10): a sustained +27% level
  // with calm dailies is NOT calm — it is the market pricing a standing
  // conflict. Score the premium and take the worse of the two reads.
  // H3 (2026-06-24): `anchor` is overridable (snapshot.prewar_brent →
  // env HORMUZ_PREWAR_BRENT) but is NEVER a trailing average — all D1 history
  // is wartime (starts May 2026; war began Feb), so a rolling baseline would
  // normalize the war away. The anchor is a deliberate pre-conflict reference.
  const a = (isFinite(anchor) && anchor > 0) ? anchor : PREWAR_BRENT;
  const premPct = (price - a) / a * 100;
  let prem = 0;
  if (premPct >= 40) prem = 4;
  else if (premPct >= 25) prem = 3;
  else if (premPct >= 15) prem = 2;
  else if (premPct >= 8) prem = 1;
  return Math.max(spike, prem);
}
export function scoreTankerStocks(tankerIndex) {
  if (tankerIndex == null || !isFinite(tankerIndex)) return null;
  if (tankerIndex < -5) return 4;
  if (tankerIndex < -3) return 3;
  if (tankerIndex < -1.5) return 2;
  if (tankerIndex > 5) return 2;
  return 0;
}
export function scoreAircraft(milCount) {
  if (milCount == null || !isFinite(milCount)) return null;
  if (milCount >= 8) return 4;
  if (milCount >= 5) return 3;
  if (milCount >= 3) return 2;
  if (milCount >= 1) return 1;
  return 0;
}
export function scoreEvents(negTonePct) {
  if (negTonePct == null || !isFinite(negTonePct)) return null;
  if (negTonePct > 70) return 4;
  if (negTonePct > 55) return 3;
  if (negTonePct > 40) return 2;
  if (negTonePct > 30) return 1;
  return 0;
}
export function scoreSeismic(count7d, maxMag) {
  if (count7d == null) return null;
  if ((maxMag || 0) >= 6.5) return 3;
  if ((maxMag || 0) >= 6) return 2;
  if (count7d >= 15 || (maxMag || 0) >= 5) return 1;
  return 0;
}
export function scoreWeather(rough) {
  if (rough == null) return null;
  return rough ? 2 : 0;
}
export function scoreBdti(bdti, wow) {
  if (bdti == null || !isFinite(bdti)) return null;
  const w = isFinite(wow) ? Math.abs(wow) : 0;
  if (bdti > 2500 || w > 20) return 3;
  if (bdti > 1800 || w > 10) return 2;
  if (w > 5) return 1;
  return 0;
}

// ─── NEW SCORERS (2026-05-14) ────────────────────────────────────────────
export function scoreOfac(netDesignations, totalActions) {
  // 2026-06-23: score NET designations (designations − waivers), not raw
  // action volume. When the direction split is unavailable (older payloads),
  // fall back to total actions.
  // H2.5 (2026-06-24): SIGNED. Net designations > 0 → positive (escalation
  // pressure, same magnitudes as before). Net < 0 (waiver-heavy thaw) →
  // NEGATIVE, so unwinding sanctions actively offsets risk in the weighted
  // average rather than just scoring 0. Escalation side is unchanged.
  const v = (netDesignations != null && isFinite(netDesignations))
    ? netDesignations
    : (isFinite(totalActions) ? totalActions : null);
  if (v == null) return null;
  if (v === 0) return 0;
  const a = Math.abs(v);
  const mag = a >= 10 ? 4 : a >= 6 ? 3 : a >= 3 ? 2 : 1;
  return v < 0 ? -mag : mag;
}
export function scoreCurrency(spread) {
  if (spread == null || !isFinite(spread)) return null;
  if (spread >= 500) return 4;
  if (spread >= 200) return 3;
  if (spread >= 100) return 2;
  if (spread >= 50) return 1;
  return 0;
}
export function scoreNews(count24h, netSentiment) {
  // 2026-06-23 DIRECTION-AWARE / 2026-06-24 H2.5 SIGNED. Volume sets the
  // MAGNITUDE (a quiet news day can't be a crisis); net sentiment sets the
  // SIGN. Returns a signed effective level in [-4, +4]:
  //   strongly escalating  (net ≥ +0.33) → +ceiling  (adds risk; same as H2)
  //   strongly de-escalating (net ≤ -0.33) → -ceiling (OFFSETS risk; was 0 in H2)
  //   neutral (-0.33..+0.33) → linear through 0
  // The escalation half is IDENTICAL to H2 — only the de-escalation half moves
  // (0 → negative), so war/blockade verdicts are unchanged while a thaw now
  // pulls the weighted average down instead of merely not contributing.
  if (count24h == null || !isFinite(count24h)) return null;
  let ceiling;
  if (count24h >= 50) ceiling = 4;
  else if (count24h >= 25) ceiling = 3;
  else if (count24h >= 10) ceiling = 2;
  else if (count24h >= 3) ceiling = 1;
  else ceiling = 0;
  // H2.5 SIGNED & SYMMETRIC. Strong escalation (net ≥ +0.33) → +ceiling
  // (IDENTICAL to H2 — real escalation verdicts don't move). Strong
  // de-escalation (net ≤ -0.33) → -ceiling (was 0; a thaw now OFFSETS risk).
  // The neutral band maps linearly THROUGH ZERO, so genuinely neutral news
  // contributes ~0 — H2's "neutral = +half-ceiling background tension" is
  // dropped as an always-on upward bias that inflated the verdict.
  if (netSentiment == null || !isFinite(netSentiment)) return Math.round(ceiling * 0.5); // unknown direction → mild caution
  if (netSentiment <= -0.33) return -ceiling;
  if (netSentiment >= 0.33) return ceiling;
  return Math.round(ceiling * (netSentiment / 0.33));   // -0.33..+0.33 → -ceiling..+ceiling through 0
}
export function scoreInventory(sprWow) {
  if (sprWow == null || !isFinite(sprWow)) return null;
  if (sprWow < -3) return 4;
  if (sprWow < -1.5) return 3;
  if (sprWow < -0.5) return 2;
  if (sprWow < 0) return 1;
  return 0;
}
export function scoreProduction(mbpd, momPct) {
  // EIA STEO 'PAPR_OPEC' currently reads 20.16 — likely a sub-component series
  // (real OPEC total petroleum supply is ~27-32 mbpd). Absolute-level scoring
  // against a static target gave a false-positive extreme signal.
  // Switched to MoM% change: production REGIME SHIFTS are what matter, not
  // arbitrary baselines. Missing MoM → score 0 (neutral) instead of penalizing.
  if (momPct == null || !isFinite(momPct)) return 0;
  const abs = Math.abs(momPct);
  if (abs >= 10) return 4;   // 10%+ MoM swing — major supply disruption
  if (abs >= 5)  return 3;   // 5-10% — meaningful change
  if (abs >= 2)  return 2;   // 2-5% — notable but not crisis
  if (abs >= 1)  return 1;   // 1-2% — minor flex
  return 0;
}

// ─── STAGE 2 · override triggers ────────────────────────────────────────
export function computeOverrides(snapshot) {
  const triggers = [];

  // OFAC: new Iran DESIGNATION in last 48h (2026-06-23: was latest_action_date,
  // which fired on waivers too — a sanctions waiver is de-escalation, it must
  // not raise the verdict). Falls back to latest_action_date for old payloads.
  const ofacDesig = snapshot.ofac_latest_designation_date || snapshot.ofac_latest_action_date;
  if (ofacDesig) {
    const t = new Date(ofacDesig + "T00:00:00Z").getTime();
    const ageSec = isFinite(t) ? (Date.now() - t) / 1000 : Infinity;
    if (ageSec < 48 * 3600) {
      triggers.push({ id: "ofac", reason: "OFAC Iran designation in last 48h", fires: true });
    } else {
      triggers.push({ id: "ofac", reason: "Last OFAC designation: " + ofacDesig, fires: false });
    }
  } else {
    triggers.push({ id: "ofac", reason: "No OFAC designation date available", fires: false });
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

  // News volume — gated by DIRECTION (2026-06-23). 40+ headlines in 24h fires
  // an escalation override ONLY if the coverage is not de-escalatory. The old
  // volume-only trigger fired during a US-Iran rapprochement (59 headlines about
  // sanctions waivers + talks) and single-handedly pushed ELEVATED → HIGH.
  const news24 = snapshot.news_count_24h || 0;
  const newsNet = snapshot.news_net_sentiment;
  // Direction via the single-source-of-truth helper (H2) — the contract and
  // this de-trigger can no longer disagree about what "de-escalating" means.
  const newsDeescalating = newsDirection(snapshot) === -1;
  if (news24 >= 40 && !newsDeescalating) {
    const dir = (newsNet != null && newsNet >= 0.33) ? "escalatory" : "mixed";
    triggers.push({ id: "news", reason: news24 + " headlines in 24h (" + dir + ")", fires: true });
  } else if (news24 >= 40 && newsDeescalating) {
    triggers.push({ id: "news", reason: news24 + " headlines in 24h but DE-ESCALATORY — not fired", fires: false });
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

  // ── Interim conflict triggers (2026-06-10) — stand-ins until the UKMTO
  // incidents feed exists. The engine previously had NO conflict-state input.
  // War-level media tone: GDELT >= 70% negative is wartime coverage — BUT
  // gated by news direction (2026-06-23). GDELT tone is conflict-vocabulary,
  // not direction: a sanctions-relief story reads as negative tone because the
  // words "sanctions/Iran/strike" are negative. Don't let it fire when the
  // human-readable news is clearly de-escalating.
  const tone = snapshot.gdelt_neg_tone || 0;
  if (tone >= 70 && !newsDeescalating) {
    triggers.push({ id: "war_tone", reason: tone.toFixed(0) + "% negative tone (war-level coverage)", fires: true });
  } else if (tone >= 70 && newsDeescalating) {
    triggers.push({ id: "war_tone", reason: tone.toFixed(0) + "% negative tone but news DE-ESCALATORY — not fired", fires: false });
  } else {
    triggers.push({ id: "war_tone", reason: tone.toFixed(0) + "% negative tone (threshold 70)", fires: false });
  }
  // Standing war premium: Brent >= +20% over the pre-war anchor means the
  // market is pricing a live conflict regardless of daily calm. H3: anchor
  // overridable via snapshot.prewar_brent (env), never a trailing stat.
  const bp = snapshot.brent_price;
  const anchorBp = (snapshot.prewar_brent != null && isFinite(snapshot.prewar_brent) && snapshot.prewar_brent > 0)
                    ? snapshot.prewar_brent : PREWAR_BRENT;
  if (isFinite(bp) && anchorBp > 0) {
    const prem = (bp - anchorBp) / anchorBp * 100;
    if (prem >= 20) {
      triggers.push({ id: "war_premium", reason: "Brent +" + prem.toFixed(0) + "% vs pre-war (standing conflict pricing)", fires: true });
    } else {
      triggers.push({ id: "war_premium", reason: "Brent " + (prem >= 0 ? "+" : "") + prem.toFixed(0) + "% vs pre-war (threshold +20%)", fires: false });
    }
  }

  // UKMTO — the REAL conflict input (2026-06-10, replaces the engine's
  // conflict blindness). Fires on an attack within 72h anywhere in the AO,
  // or any Hormuz-region incident within 7 days.
  const atkTs = snapshot.ukmto_latest_attack_ts;
  const hormuz7 = snapshot.ukmto_hormuz_7d;
  if (atkTs != null || hormuz7 != null) {
    const atkAgeH = atkTs ? (Date.now() / 1000 - atkTs) / 3600 : Infinity;
    if (atkAgeH <= 72) {
      triggers.push({ id: "ukmto", reason: "UKMTO-reported ATTACK " + atkAgeH.toFixed(0) + "h ago", fires: true });
    } else if ((hormuz7 || 0) >= 1) {
      triggers.push({ id: "ukmto", reason: hormuz7 + " Hormuz-region incident(s) in 7d (UKMTO)", fires: true });
    } else {
      triggers.push({ id: "ukmto", reason: "no recent UKMTO attack/Hormuz incident", fires: false });
    }
  } else {
    triggers.push({ id: "ukmto", reason: "UKMTO feed unavailable", fires: false });
  }

  // ── De-escalation (2026-06-24, H2.5) ───────────────────────────────────────
  // The blunt -1-level de-trigger (2026-06-23) is RETIRED: the weighted average
  // is now symmetric by construction (de-escalatory news + OFAC waivers carry
  // NEGATIVE level, so a thaw pulls the structural score down proportionally —
  // a graduated offset, not an all-or-nothing step). We keep an INFORMATIONAL
  // (non-acting) marker so the UI can still say "news de-escalating" without it
  // moving the band a second time. A real UKMTO attack still wins via its own
  // +level trigger, which outweighs the negative news contribution.
  if (newsDeescalating) {
    triggers.push({
      id: "deescalation",
      reason: "News de-escalating — already reflected as a negative contribution in the structural score",
      fires: false, informational: true,
    });
  }

  return triggers;
}

export function applyOverrides(baseVerdict, triggers) {
  // Escalation triggers add levels. De-escalation is no longer a -level step
  // (H2.5): it lives in the symmetric weighted average as a negative
  // contribution, so there is nothing to subtract here. `informational`
  // triggers never move the band.
  const firedCount = triggers.filter(t => t.fires && !t.informational).length;
  const levels = ["NORMAL", "ELEVATED", "HIGH", "CRITICAL"];
  let idx = levels.indexOf(baseVerdict);
  if (idx < 0) idx = 0;
  // Escalation capped at +2 levels (2026-06-10): with 7 possible triggers,
  // uncapped stacking pegs the scale at CRITICAL and destroys its meaning.
  // CRITICAL should require a HIGH structural base plus corroboration.
  idx = idx + Math.min(firedCount, 2);
  idx = Math.max(0, Math.min(idx, levels.length - 1));
  return levels[idx];
}

// ─── STAGE 1 · structural weighted average (13 inputs) ──────────────────
export function computeVerdict(snapshot) {
  // 2026-06-10 REPAIR: the 2026-05-18 fallback that fed scraped_vessel_total
  // (ships IN PORT) into the transits slot was a CATEGORY INVERSION. During a
  // blockade ships pile up in port because they cannot leave — so the in-port
  // count RISES, scored against a transit baseline it read as "flow excellent"
  // (score 0 at 30% weight), making the verdict CALMER precisely because of
  // the blockade. This is how the engine said NORMAL during active missile
  // exchanges. In-port counts must NEVER enter the transits slot. When AIS is
  // dormant, transits = null → W_COMPOSITE mode (transits weight 0).
  // H3 (2026-06-24): rolling baselines with constant fallback.
  //   baseline_transits — trailing-30d median of real AIS transits (record.js
  //     computes it from D1); falls back to BASELINE_TRANSITS when history is
  //     thin. This is the CORRECT rolling case (the transit "normal" should
  //     adapt). Dormant while AIS is dark (transits null) but ready on recovery.
  //   prewar_brent — the war-premium anchor; overridable via env but NEVER a
  //     trailing stat (see scoreOilSpike note). Fallback to PREWAR_BRENT.
  const baselineTransits = (snapshot.baseline_transits != null && isFinite(snapshot.baseline_transits) && snapshot.baseline_transits > 0)
                            ? snapshot.baseline_transits : BASELINE_TRANSITS;
  const prewarBrent = (snapshot.prewar_brent != null && isFinite(snapshot.prewar_brent) && snapshot.prewar_brent > 0)
                            ? snapshot.prewar_brent : PREWAR_BRENT;
  const transitsRaw = (snapshot.transits_24h != null && snapshot.transits_24h > 0)
                        ? snapshot.transits_24h : null;
  const transitsScore = transitsRaw != null
                          ? scoreTransits(transitsRaw, baselineTransits) : null;
  const oilScore        = scoreOilSpike(snapshot.brent_price, snapshot.brent_dp_24h, prewarBrent);
  const stocksScore     = scoreTankerStocks(snapshot.tanker_index);
  const aircraftScore   = scoreAircraft(snapshot.military_aircraft_count);
  const eventsScore     = scoreEvents(snapshot.gdelt_neg_tone);
  const seismicScore    = scoreSeismic(snapshot.earthquake_count_7d, snapshot.max_mag);
  const weatherScore    = scoreWeather(snapshot.rough_conditions);
  const bdtiScore       = scoreBdti(snapshot.bdti, snapshot.bdti_wow);
  const ofacScore       = scoreOfac(snapshot.ofac_net_designations_30d, snapshot.ofac_iran_actions_30d);
  const currencyScore   = scoreCurrency(snapshot.irr_spread_pct);
  const newsScore       = scoreNews(snapshot.news_count_24h, snapshot.news_net_sentiment);
  const inventoryScore  = scoreInventory(snapshot.spr_wow_pct);
  const productionScore = scoreProduction(snapshot.opec_production_mbpd, snapshot.opec_production_mom_pct);

  // AIS-primary weights (when AIS working — adds transits, reduces others proportionally)
  // Composite-fallback weights (when AIS down — current state)
  const W_AIS = {
    transits: 0.30, oil: 0.13, stocks: 0.09, bdti: 0.05,
    aircraft: 0.09, events: 0.07, seismic: 0.02, weather: 0.02,
    ofac: 0.07, currency: 0.04, news: 0.04, inventory: 0.04, production: 0.04
  };
  const W_COMPOSITE = {
    // 2026-06-23 REBALANCE: GDELT neg-tone ("events") cut 0.18 → 0.07. Its tone
    // is conflict-VOCABULARY, not direction — "U.S. waives Iran oil sanctions"
    // scores as negative tone because "sanctions/Iran/oil" are conflict words,
    // so it read a de-escalation as a crisis. The freed weight goes to the now
    // direction-aware `news` signal (0.05 → 0.14), which is the most direct
    // read of escalation-vs-de-escalation we hold while AIS is dark.
    // (2026-06-10 had raised events to 0.18 during the active war; the war has
    // since de-escalated and tone-without-direction became the top false driver.)
    transits: 0,
    oil: 0.18, stocks: 0.08, bdti: 0.07,
    aircraft: 0.13, events: 0.07, seismic: 0.03, weather: 0.03,
    ofac: 0.10, currency: 0.06, news: 0.14, inventory: 0.05, production: 0.02
  };
  const weights = transitsScore !== null ? W_AIS : W_COMPOSITE;

  const inputs = {
    transits: transitsScore, oil: oilScore, stocks: stocksScore,
    aircraft: aircraftScore, events: eventsScore, seismic: seismicScore,
    weather: weatherScore, bdti: bdtiScore,
    ofac: ofacScore, currency: currencyScore, news: newsScore,
    inventory: inventoryScore, production: productionScore
  };

  // ── H2 signal contract — rich {level, direction, confidence, asOf} per signal.
  // `inputs` (numeric levels) is kept for the weighted average + back-compat;
  // `signals` is the typed contract surfaced for the UI and downstream gating.
  const ageOf = {
    news: snapshot.news_age_sec, currency: snapshot.currency_age_sec, ofac: snapshot.ofac_age_sec,
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const signals = {};
  for (const k of Object.keys(inputs)) {
    const lvl = inputs[k];
    const ageSec = ageOf[k];
    signals[k] = {
      level: lvl,
      direction: signalDirection(lvl),
      confidence: lvl == null ? 0 : freshnessConfidence(k, ageSec),
      asOf: (ageSec != null && isFinite(ageSec)) ? nowSec - ageSec : null,
    };
  }

  let weighted = 0;
  let used = 0;          // sum of WEIGHTS of inputs that had data
  let usedCount = 0;     // COUNT of inputs that had data
  let totalCount = 0;    // COUNT of inputs with a positive weight in this mode
  for (const k in weights) {
    if (weights[k] > 0) {
      totalCount++;
      if (inputs[k] != null) {
        weighted += inputs[k] * weights[k];
        used += weights[k];
        usedCount++;
      }
    }
  }
  if (used > 0 && used < 1) weighted = weighted / used;

  // Verdict confidence (Batch D · 2026-05-14): a verdict computed from 2 of 13
  // signals must NOT be presented identically to a full one. `used` is the
  // fraction of total weight that actually had data. Consumers gate on this.
  const confidence = (usedCount === 0) ? "none"
                   : (used < 0.5 || usedCount < 4) ? "low"
                   : (used < 0.8 || usedCount < 7) ? "medium"
                   : "high";

  // H2.5: `weighted` is now SIGNED (range ~ -4..+4). A net-negative score means
  // de-escalatory signals outweigh escalatory ones → NORMAL (there is no band
  // below NORMAL; the negative value's job is to offset, not to create a
  // "calmer than calm" tier). Escalation thresholds are unchanged.
  const structural = weighted >= 3.0 ? "CRITICAL"
                   : weighted >= 2.0 ? "HIGH"
                   : weighted >= 1.0 ? "ELEVATED"
                   : "NORMAL";

  const triggers = computeOverrides(snapshot);
  const firedCount = triggers.filter(t => t.fires).length;
  let final = applyOverrides(structural, triggers);

  // ── "Calmer but not all-clear" floor (2026-06-23) ────────────────────────
  // A de-escalation can pull the verdict toward NORMAL, but while the market
  // still carries a standing war premium (Brent ≥ +8% over the pre-war anchor)
  // OR tanker freight is still elevated (BDTI > 1800), the strait is not
  // all-clear. Floor the verdict at ELEVATED in that residual-risk state so a
  // thaw reads as "winding down, watch it" — never a premature NORMAL.
  const bpFloor = snapshot.brent_price;
  const premFloor = (isFinite(bpFloor) && prewarBrent > 0) ? (bpFloor - prewarBrent) / prewarBrent * 100 : 0;
  const residualRisk = (premFloor >= 8) || (isFinite(snapshot.bdti) && snapshot.bdti > 1800);
  const levelsF = ["NORMAL", "ELEVATED", "HIGH", "CRITICAL"];
  if (residualRisk && levelsF.indexOf(final) < 1) {
    final = "ELEVATED";
  }

  return {
    verdict: final,
    residual_risk_floor: residualRisk,
    structural_verdict: structural,
    structural_score: Math.round(weighted * 100) / 100,
    score: Math.round(weighted * 100) / 100,
    // H3 baselines actually used (audit trail): whether rolling values were
    // applied or the constant fallbacks. `source` flags which.
    baselines: {
      prewar_brent: prewarBrent,
      prewar_brent_source: (snapshot.prewar_brent != null && isFinite(snapshot.prewar_brent) && snapshot.prewar_brent > 0) ? "configured" : "default",
      baseline_transits: baselineTransits,
      baseline_transits_source: (snapshot.baseline_transits != null && isFinite(snapshot.baseline_transits) && snapshot.baseline_transits > 0) ? "rolling" : "default",
    },
    stage1_inputs: inputs,
    stage1_signals: signals,   // H2 typed contract: {level, direction, confidence, asOf}
    weights,
    stage2_triggers: triggers,
    stage2_fired_count: firedCount,
    inputs,
    // Confidence surfacing — consumers MUST gate on this. A "low"/"none"
    // confidence verdict is computed from too few live signals to trust.
    confidence,
    inputs_used_count: usedCount,
    inputs_total: totalCount,
    coverage_pct: totalCount > 0 ? Math.round(usedCount / totalCount * 100) : 0,
    mode: transitsScore !== null ? "ais-primary" : "composite-fallback"
  };
}

// ─── H4 · Regime state machine (hysteresis) ─────────────────────────────────
// The verdict above is INSTANTANEOUS (recomputed each run). On its own it can
// flap band-to-band hour to hour, and it has no memory. computeRegime layers a
// slower "regime" on top with ASYMMETRIC hysteresis:
//   • Escalation is IMMEDIATE — a HIGH/CRITICAL read raises the regime at once
//     (never dampen an emerging crisis).
//   • De-escalation is DAMPED — the regime only steps down after the lower band
//     has held continuously for `dwellSec` (default 12 h). A single calm hour
//     during a war can't flip the regime to all-clear; a real UKMTO attack
//     still wins instantly via the escalation path.
// This kills whipsaw, gives the dashboard memory ("HIGH for 3 days, now
// de-escalating — confirms in 9 h"), and is what H5 surfaces as the headline.
//
// PURE: pass `nowSec` in (no Date.now) so it's deterministic + testable.
// `prev` is the persisted regime_state object (or null on cold start).
const _BAND_RANK = { NORMAL: 0, ELEVATED: 1, HIGH: 2, CRITICAL: 3 };
export const REGIME_DEESC_DWELL_SEC = 12 * 3600;

export function computeRegime(prev, band, nowSec, dwellSec = REGIME_DEESC_DWELL_SEC) {
  const rank = _BAND_RANK[band];
  if (rank == null) {
    // Unknown band — don't move the regime; echo prev or seed NORMAL.
    return prev && _BAND_RANK[prev.regime] != null
      ? { ...prev, instantaneous: band, trajectory: "stable", pending: null }
      : { regime: "NORMAL", regime_since: nowSec, candidate: null, candidate_since: null, instantaneous: band, trajectory: "stable", pending: null };
  }
  // Cold start.
  if (!prev || _BAND_RANK[prev.regime] == null) {
    return { regime: band, regime_since: nowSec, candidate: null, candidate_since: null, instantaneous: band, trajectory: "stable", pending: null };
  }
  const regRank = _BAND_RANK[prev.regime];

  // Escalation or unchanged → snap up immediately, clear any de-escalation timer.
  if (rank >= regRank) {
    return {
      regime: band,
      regime_since: rank > regRank ? nowSec : prev.regime_since,
      candidate: null, candidate_since: null,
      instantaneous: band,
      trajectory: rank > regRank ? "escalating" : "stable",
      pending: null,
    };
  }

  // De-escalation → require the lower band to hold continuously for dwellSec.
  // candidate_since is set when we FIRST drop below the regime and persists
  // across further drops (sustained-below-regime clock); cleared only by a
  // re-escalation (above branch) or a confirmed step-down (below).
  const candidate_since = (prev.candidate == null) ? nowSec : prev.candidate_since;
  const held = nowSec - candidate_since;
  if (held >= dwellSec) {
    return {
      regime: band, regime_since: nowSec,
      candidate: null, candidate_since: null,
      instantaneous: band, trajectory: "de-escalating", pending: null,
    };
  }
  return {
    regime: prev.regime, regime_since: prev.regime_since,
    candidate: band, candidate_since,
    instantaneous: band, trajectory: "de-escalating",
    pending: { to: band, dwell_needed_sec: dwellSec, dwell_so_far_sec: held },
  };
}
