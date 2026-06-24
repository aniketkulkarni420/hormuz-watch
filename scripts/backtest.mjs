// Verdict backtest harness (#1 · 2026-06-24). Pure Node, no deps.
//
// THE QUESTION: does the composite verdict actually anticipate Hormuz-driven
// market moves — and does it beat the naive baseline of "just watch the oil
// premium"? If the verdict adds nothing over oil alone, the 13-signal composite
// is theatre and we should simplify (#2).
//
// DATA: /api/backtest (D1 history) — ts, brent, bdti, transits, stored verdict
// band/score. Outcomes: forward Brent return + forward BDTI change at 1/3/7d.
// Three "predictors" are compared:
//   1. stored   — the verdict as it actually ran (mixed engine versions, but it
//                 had all 13 signals live at the time).
//   2. recomputed — the CURRENT engine re-run over historical oil+bdti only
//                 (the other inputs weren't persisted → null).
//   3. naive    — the oil premium vs the $72 pre-war anchor. The baseline to beat.
//
// HONESTY: ~6 weeks of data dominated by ONE war arc. Hourly rows are highly
// autocorrelated, so we resample to DAILY (effective n ≈ days). This is a
// directional sanity check + a reusable harness, NOT a significance test. The
// report says so loudly.
//
// Run: node scripts/backtest.mjs [BASE_URL]
import { computeVerdict } from "../functions/_lib/verdict.js";

const BASE = process.argv[2] || "https://hormuz-watch-2.pages.dev";
const BAND_RANK = { NORMAL: 0, ELEVATED: 1, HIGH: 2, CRITICAL: 3 };

// ── stats helpers (no deps) ────────────────────────────────────────────────
function rank(arr) {            // average-rank (ties shared) for Spearman
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(x, y) {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}
function spearman(x, y) {
  const pairs = x.map((v, i) => [v, y[i]]).filter(p => p[0] != null && p[1] != null && isFinite(p[0]) && isFinite(p[1]));
  if (pairs.length < 5) return { rho: null, n: pairs.length };
  const rho = pearson(rank(pairs.map(p => p[0])), rank(pairs.map(p => p[1])));
  return { rho, n: pairs.length };
}
const fmt = (v) => v == null ? "  n/a" : (v >= 0 ? "+" : "") + v.toFixed(3);

// ── load ────────────────────────────────────────────────────────────────────
const res = await fetch(`${BASE}/api/backtest?days=365`);
if (!res.ok) { console.error("fetch failed", res.status); process.exit(1); }
const { count, rows } = await res.json();
console.log(`\n=== VERDICT BACKTEST · ${count} raw snapshot rows from ${BASE} ===`);
if (count < 10) { console.error("not enough history to backtest"); process.exit(0); }

// ── resample to one row per UTC day (last row of each day) ───────────────────
const byDay = new Map();
for (const r of rows) {
  if (r.brent == null) continue;
  const day = new Date(r.ts * 1000).toISOString().slice(0, 10);
  byDay.set(day, r);   // ordered asc → last write wins = end-of-day
}
const days = [...byDay.keys()].sort();
const daily = days.map(d => byDay.get(d));
console.log(`resampled to ${daily.length} daily observations (${days[0]} → ${days[days.length - 1]})`);
console.log(`NOTE: ~one macro event (the Iran war arc) dominates this window — treat as a sanity check, not significance.\n`);

// ── predictors ──────────────────────────────────────────────────────────────
const PREWAR = 72;
for (const r of daily) {
  r.storedScore = r.score;                                  // verdict as it ran
  r.naive = (r.brent != null) ? (r.brent - PREWAR) / PREWAR * 100 : null;  // oil premium %
  // recompute CURRENT engine over the only persisted inputs (oil + bdti)
  try {
    const v = computeVerdict({ brent_price: r.brent, bdti: r.bdti });
    r.recScore = v.structural_score;
    r.recBand = v.verdict;
  } catch { r.recScore = null; r.recBand = null; }
  r.storedRank = r.band != null ? BAND_RANK[r.band] : null;
}

// ── forward outcomes ─────────────────────────────────────────────────────────
function fwd(arr, i, key, h) {
  if (i + h >= arr.length) return null;
  const a = arr[i][key], b = arr[i + h][key];
  if (a == null || b == null || a === 0) return null;
  return (b - a) / a * 100;   // % change over h days
}
for (let i = 0; i < daily.length; i++) {
  for (const h of [1, 3, 7]) {
    daily[i][`brentFwd${h}`] = fwd(daily, i, "brent", h);
    daily[i][`bdtiFwd${h}`]  = fwd(daily, i, "bdti", h);
  }
}

// ── correlations: predictor vs forward outcome ───────────────────────────────
function col(key) { return daily.map(r => r[key]); }
function report(outcomeKey, label) {
  console.log(`── ${label} ──`);
  console.log("  predictor        " + [1, 3, 7].map(h => `fwd${h}d`).join("    "));
  for (const [name, key] of [["stored verdict", "storedScore"], ["recomputed(oil+bdti)", "recScore"], ["naive oil-premium", "naive"]]) {
    const cells = [1, 3, 7].map(h => {
      const s = spearman(col(key), col(`${outcomeKey}${h}`));
      return (s.rho == null ? " n/a " : fmt(s.rho)) ;
    });
    console.log(`  ${name.padEnd(20)} ` + cells.join("   "));
  }
  console.log("");
}

console.log("Spearman rank correlation — predictor (today) vs FORWARD % move. Higher = more anticipatory.\n");
report("brentFwd", "Outcome: forward BRENT return (noisy — global macro, not just Hormuz)");
report("bdtiFwd",  "Outcome: forward BDTI change (tanker freight — more Hormuz-specific)");

// ── the decisive comparison: does the verdict beat naive oil at the 3d horizon? ─
function skill(predKey, outKey) {
  const s = spearman(col(predKey), col(outKey));
  return s;
}
console.log("── DOES THE VERDICT BEAT 'JUST WATCH OIL'? (3-day BDTI outcome) ──");
const vS = skill("storedScore", "bdtiFwd3");
const nS = skill("naive", "bdtiFwd3");
console.log(`  stored verdict  rho=${fmt(vS.rho)} (n=${vS.n})`);
console.log(`  naive oil-prem  rho=${fmt(nS.rho)} (n=${nS.n})`);
if (vS.rho != null && nS.rho != null) {
  const verdictWins = Math.abs(vS.rho) > Math.abs(nS.rho) + 0.05;
  console.log(`  → ${verdictWins ? "verdict adds signal over oil alone" : "verdict does NOT clearly beat oil alone (argues for simplification)"}`);
}

// ── contingency: when band is HIGH+, what happens next? ──────────────────────
console.log("\n── CONTINGENCY: mean forward move by stored band ──");
const bands = ["NORMAL", "ELEVATED", "HIGH", "CRITICAL"];
console.log("  band        n     mean brentFwd3   mean bdtiFwd3");
for (const b of bands) {
  const grp = daily.filter(r => r.band === b);
  const mean = (key) => { const xs = grp.map(r => r[key]).filter(v => v != null && isFinite(v)); return xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null; };
  console.log(`  ${b.padEnd(10)} ${String(grp.length).padStart(3)}   ${fmt(mean("brentFwd3")).padStart(12)}    ${fmt(mean("bdtiFwd3")).padStart(10)}`);
}

// ── coverage / data-quality notes ────────────────────────────────────────────
const withScore = daily.filter(r => r.storedScore != null).length;
const withBdti = daily.filter(r => r.bdti != null).length;
console.log("\n── DATA QUALITY ──");
console.log(`  daily rows: ${daily.length} · with stored verdict score: ${withScore} · with bdti: ${withBdti}`);
console.log(`  band distribution: ` + bands.map(b => `${b}:${daily.filter(r => r.band === b).length}`).join(" "));
console.log("\nCAVEAT: n≈" + daily.length + " days, one dominant event. Correlations here are directional, not significant.");
console.log("Per-signal validation (news/ofac/aircraft/…) is IMPOSSIBLE from stored data — only band/score/oil/bdti/transits were persisted.\n");
