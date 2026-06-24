// Golden-fixture regression tests for the verdict engine (Batch H1, 2026-06-23).
//
// WHY: the verdict engine has had the SAME class of bug four times
// (ships-in-port-as-transits ×2, NORMAL-during-war, de-escalation-read-as-HIGH),
// each shipped because nothing asserted "this input bundle → this band". These
// fixtures lock the known-correct behaviour: any future weight/threshold tweak
// that would re-break a labelled scenario fails CI. See .process/VERDICT_ENGINE_V2.md.
//
// Run: node --test tests/    (no dependencies — pure node:test + node:assert)
//
// NOTE on time: computeVerdict() uses Date.now() in the OFAC-48h / UKMTO-72h
// triggers. Fixtures that exercise those use offsets from Date.now() (see
// hoursAgo/daysAgo) so they stay valid regardless of when the suite runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVerdict } from "../functions/_lib/verdict.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const hoursAgo = (h) => nowSec() - h * 3600;
const isoDaysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);

// A neutral, fully-populated baseline. Each fixture overrides only what it tests
// so a failure points at one cause, not a tangle.
const BASE = {
  transits_24h: null,                 // AIS dark = composite-fallback mode
  brent_price: 70,                    // ~pre-war, no premium
  brent_dp_24h: 0,
  tanker_index: 0,
  military_aircraft_count: 0,
  gdelt_neg_tone: 30,
  earthquake_count_7d: 0, max_mag: 0, seismic_max_mag: 0,
  rough_conditions: false,
  bdti: 900, bdti_wow: 0,
  ofac_iran_actions_30d: 0, ofac_net_designations_30d: 0,
  ofac_latest_action_date: isoDaysAgo(40), ofac_latest_designation_date: isoDaysAgo(40),
  irr_spread_pct: 20,
  news_count_24h: 5, news_sentiment: "neutral", news_net_sentiment: 0,
  spr_wow_pct: 0,
  opec_production_mbpd: 28, opec_production_mom_pct: 0,
  ukmto_latest_attack_ts: null, ukmto_hormuz_7d: 0,
};
const fx = (over) => ({ ...BASE, ...over });
const firedIds = (r) => r.stage2_triggers.filter((t) => t.fires).map((t) => t.id);

// ── 1. Calm baseline → NORMAL ──────────────────────────────────────────────
test("1 · calm baseline → NORMAL", () => {
  const r = computeVerdict(fx({}));
  assert.equal(r.verdict, "NORMAL");
});

// ── 2. The 2026-06-23 thaw → ELEVATED (floor), NOT HIGH ─────────────────────
test("2 · de-escalation thaw with residual premium → ELEVATED (not HIGH)", () => {
  const r = computeVerdict(fx({
    brent_price: 77.94,          // +8% war premium → residual-risk floor
    bdti: 2176,
    gdelt_neg_tone: 68.7,
    news_count_24h: 59, news_sentiment: "de-escalating", news_net_sentiment: -1,
    ofac_iran_actions_30d: 3, ofac_net_designations_30d: -2,  // waiver-heavy
    irr_spread_pct: 28,
  }));
  assert.equal(r.verdict, "ELEVATED");
  assert.ok(firedIds(r).includes("deescalation"), "de-escalation de-trigger should fire");
  assert.ok(!firedIds(r).includes("news"), "news volume trigger must NOT fire on de-escalation");
});

// ── 3. Genuine calm thaw (no residual premium) → NORMAL ─────────────────────
test("3 · de-escalation + Brent at pre-war + low BDTI → NORMAL", () => {
  const r = computeVerdict(fx({
    brent_price: 71, bdti: 900,
    news_count_24h: 59, news_sentiment: "de-escalating", news_net_sentiment: -1,
  }));
  assert.equal(r.verdict, "NORMAL");
  assert.equal(r.residual_risk_floor, false);
});

// ── 4. Active war → CRITICAL ────────────────────────────────────────────────
test("4 · active war (escalating news + UKMTO attack + war premium) → CRITICAL", () => {
  const r = computeVerdict(fx({
    brent_price: 95,                 // +32% premium
    gdelt_neg_tone: 82,
    news_count_24h: 60, news_sentiment: "escalating", news_net_sentiment: 0.8,
    ofac_net_designations_30d: 5, ofac_latest_designation_date: isoDaysAgo(0),
    ukmto_latest_attack_ts: hoursAgo(5),
  }));
  assert.equal(r.verdict, "CRITICAL");
});

// ── 5. Single tanker seizure (Hormuz incident) → at least HIGH ──────────────
test("5 · UKMTO Hormuz incident → escalated above baseline", () => {
  const r = computeVerdict(fx({ ukmto_hormuz_7d: 1, news_count_24h: 30, news_net_sentiment: 0.4 }));
  assert.ok(firedIds(r).includes("ukmto"), "ukmto trigger should fire on a Hormuz incident");
  assert.ok(["ELEVATED", "HIGH", "CRITICAL"].includes(r.verdict), `expected raised, got ${r.verdict}`);
});

// ── 6. High news VOLUME but de-escalatory → volume must NOT raise verdict ────
test("6 · 60 de-escalatory headlines → news score 0, volume trigger idle", () => {
  const r = computeVerdict(fx({ news_count_24h: 60, news_sentiment: "de-escalating", news_net_sentiment: -0.8 }));
  assert.equal(r.stage1_inputs.news, 0, "de-escalatory news scores 0 regardless of volume");
  assert.ok(!firedIds(r).includes("news"));
});

// ── 7. High news VOLUME and escalatory → volume trigger fires ───────────────
test("7 · 60 escalatory headlines → news volume trigger fires", () => {
  const r = computeVerdict(fx({ news_count_24h: 60, news_sentiment: "escalating", news_net_sentiment: 0.8 }));
  assert.ok(firedIds(r).includes("news"));
  assert.equal(r.stage1_inputs.news, 4, "escalatory high-volume news → full ceiling");
});

// ── 8. OFAC waiver wave (net negative) → OFAC score 0 ───────────────────────
test("8 · OFAC waiver-heavy (net -3) → score 0", () => {
  const r = computeVerdict(fx({ ofac_iran_actions_30d: 4, ofac_net_designations_30d: -3 }));
  assert.equal(r.stage1_inputs.ofac, 0, "net de-escalatory OFAC must not score as pressure");
});

// ── 9. OFAC fresh designation (<48h) → OFAC trigger fires ───────────────────
test("9 · fresh Iran designation <48h → ofac trigger fires", () => {
  const r = computeVerdict(fx({
    ofac_net_designations_30d: 5,
    ofac_latest_designation_date: isoDaysAgo(0),
  }));
  assert.ok(firedIds(r).includes("ofac"));
});
test("9b · fresh WAIVER (no designation) → ofac trigger does NOT fire", () => {
  const r = computeVerdict(fx({
    ofac_net_designations_30d: -2,
    ofac_latest_designation_date: isoDaysAgo(40),   // last designation is old
    ofac_latest_action_date: isoDaysAgo(0),          // recent action is a waiver
  }));
  assert.ok(!firedIds(r).includes("ofac"), "a recent waiver must not fire the escalation trigger");
});

// ── 10. AIS dark + high port count → transits NOT scored (no "551%" inversion) ─
test("10 · AIS dark, port count irrelevant → transits null, composite mode", () => {
  // scraped_vessel_total is intentionally NOT a verdict input anymore.
  const r = computeVerdict(fx({ transits_24h: null, scraped_vessel_total: 760 }));
  assert.equal(r.stage1_inputs.transits, null, "in-port count must never enter the transits slot");
  assert.equal(r.mode, "composite-fallback");
});

// ── 11. Blockade — real AIS transits collapse to ~0 → CRITICAL ──────────────
test("11 · blockade (AIS transits → 2) → strongly escalated", () => {
  const r = computeVerdict(fx({
    transits_24h: 2,                 // real AIS gate-crossings near zero
    brent_price: 95, gdelt_neg_tone: 80,
    news_count_24h: 50, news_sentiment: "escalating", news_net_sentiment: 0.7,
    ukmto_latest_attack_ts: hoursAgo(10),
  }));
  assert.equal(r.mode, "ais-primary");
  assert.ok(["HIGH", "CRITICAL"].includes(r.verdict), `blockade must not read calm, got ${r.verdict}`);
});

// ── 12. Low coverage → confidence flagged ───────────────────────────────────
test("12 · only 2 signals present → confidence low", () => {
  // Null out everything except oil + bdti.
  const sparse = {};
  for (const k of Object.keys(BASE)) sparse[k] = null;
  sparse.brent_price = 80; sparse.brent_dp_24h = 0; sparse.bdti = 1500; sparse.bdti_wow = 0;
  const r = computeVerdict(sparse);
  assert.ok(["low", "none"].includes(r.confidence), `expected low/none, got ${r.confidence}`);
  assert.ok(r.coverage_pct < 50);
});

// ── 13. GDELT tone high but news de-escalatory → war_tone gated off ─────────
test("13 · GDELT 75% neg but news de-escalating → war_tone does NOT fire", () => {
  const r = computeVerdict(fx({
    gdelt_neg_tone: 75,
    news_count_24h: 50, news_sentiment: "de-escalating", news_net_sentiment: -0.7,
  }));
  assert.ok(!firedIds(r).includes("war_tone"), "tone-without-direction must not fire during a thaw");
});

// ── 14. Stale/empty feeds → confidence not 'high' ───────────────────────────
test("14 · almost everything null → confidence none/low, verdict NORMAL", () => {
  const empty = {};
  for (const k of Object.keys(BASE)) empty[k] = null;
  const r = computeVerdict(empty);
  assert.ok(["none", "low"].includes(r.confidence));
});

// ── 15. Mixed / ambiguous → ELEVATED (residual floor or mid score) ──────────
test("15 · neutral news + Brent +12% + BDTI 1900 → ELEVATED", () => {
  const r = computeVerdict(fx({
    brent_price: 80.6,    // +12% premium (oil prem score 1, residual floor)
    bdti: 1900,           // > 1800 → bdti score 2 + residual floor
    news_count_24h: 20, news_sentiment: "neutral", news_net_sentiment: 0,
  }));
  assert.equal(r.verdict, "ELEVATED");
});

// ─── H2 signal-contract fixtures (2026-06-23) ───────────────────────────────

// 16. Contract shape: every signal exposes {level, direction, confidence, asOf}
test("16 · stage1_signals present with full contract shape", () => {
  const r = computeVerdict(fx({}));
  assert.ok(r.stage1_signals, "stage1_signals must exist");
  for (const k of Object.keys(r.stage1_inputs)) {
    const s = r.stage1_signals[k];
    assert.ok(s, `signal ${k} missing`);
    assert.ok("level" in s && "direction" in s && "confidence" in s && "asOf" in s, `${k} contract incomplete`);
    assert.equal(s.level, r.stage1_inputs[k], `${k} level must match numeric stage1_inputs (back-compat)`);
    assert.ok([-1, 0, 1].includes(s.direction), `${k} direction must be -1|0|+1`);
    assert.ok(s.confidence >= 0 && s.confidence <= 1, `${k} confidence in [0,1]`);
  }
});

// 17. News direction: -1 on de-escalation, +1 on escalation, 0 neutral
test("17 · news direction tracks sentiment", () => {
  const de = computeVerdict(fx({ news_count_24h: 50, news_sentiment: "de-escalating", news_net_sentiment: -0.8 }));
  assert.equal(de.stage1_signals.news.direction, -1);
  const esc = computeVerdict(fx({ news_count_24h: 50, news_sentiment: "escalating", news_net_sentiment: 0.8 }));
  assert.equal(esc.stage1_signals.news.direction, 1);
  const neu = computeVerdict(fx({ news_count_24h: 50, news_sentiment: "neutral", news_net_sentiment: 0 }));
  assert.equal(neu.stage1_signals.news.direction, 0);
});

// 18. OFAC direction: -1 when net designations negative (waiver-heavy)
test("18 · OFAC direction is -1 when net designations < 0", () => {
  const r = computeVerdict(fx({ ofac_iran_actions_30d: 4, ofac_net_designations_30d: -3 }));
  assert.equal(r.stage1_signals.ofac.direction, -1);
  const r2 = computeVerdict(fx({ ofac_net_designations_30d: 4 }));
  assert.equal(r2.stage1_signals.ofac.direction, 1);
});

// 19. Magnitude-only signal (oil): direction +1 when level>0, 0 when calm
test("19 · oil direction is magnitude-only (+1 / 0)", () => {
  const hot = computeVerdict(fx({ brent_price: 110 }));
  assert.equal(hot.stage1_signals.oil.direction, 1);
  const calm = computeVerdict(fx({ brent_price: 70, brent_dp_24h: 0 }));
  assert.equal(calm.stage1_signals.oil.level, 0);
  assert.equal(calm.stage1_signals.oil.direction, 0);
});

// 20. Confidence: 0 for absent signal; freshness-scaled for stale feeds
test("20 · confidence reflects presence + freshness", () => {
  const missing = computeVerdict(fx({ irr_spread_pct: null }));
  assert.equal(missing.stage1_signals.currency.confidence, 0, "absent signal → confidence 0");
  const fresh = computeVerdict(fx({ news_count_24h: 20, news_net_sentiment: 0, news_age_sec: 600 }));
  assert.equal(fresh.stage1_signals.news.confidence, 1, "fresh news → confidence 1");
  const stale = computeVerdict(fx({ news_count_24h: 20, news_net_sentiment: 0, news_age_sec: 5400 * 4 }));
  assert.ok(stale.stage1_signals.news.confidence <= 0.3, "very stale news → low confidence");
});
