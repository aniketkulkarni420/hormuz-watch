# Verdict Engine v2 — Design Recommendation (Batch H)

**Status:** proposed (not implemented). Author note 2026-06-23.
**Owner doc** — the design rationale for rebuilding the verdict engine. The
incremental fixes in `record.js` are working; this is the plan for making the
*class* of bug that keeps recurring structurally impossible.

---

## Why this exists — the recurring flaw

The verdict engine has had the **same category of bug four times**, each patched
reactively (see `.process/DECISIONS.md` + git history):

| Date | Symptom | Root cause (all the same shape) |
|------|---------|--------------------------------|
| 2026-05-18 | NORMAL during a blockade | ships-IN-PORT fed into the transits slot |
| 2026-06-10 | NORMAL during missile exchanges | engine had no conflict-state input; tone under-weighted |
| 2026-06-23 (a) | "551% of normal transits" | scraped port count rendered as transits |
| 2026-06-23 (b) | HIGH/CRITICAL during a US-Iran *de-escalation* | signals measured VOLUME + conflict-VOCABULARY, not DIRECTION; every trigger could only push UP |

**The common root:** signals encode *magnitude* ("how much is happening") but
not *direction* ("which way") or *category* ("is this even the right metric").
A stateless hourly re-compute with hardcoded anchors then amplifies it. Patches
fix the instance; the next variant ships anyway.

**v2 goal:** make direction, category-safety, symmetry, and regression-coverage
*structural properties of the design*, not things a future edit can quietly
break.

---

## The six principles

### 1. Signal contract: `{level, direction, confidence, asOf}` — never a bare 0–4
Every scorer returns a typed object, not a scalar:
```
{ level: 0..4,            // magnitude
  direction: -1 | 0 | +1, // de-escalatory / neutral / escalatory
  confidence: 0..1,       // source freshness × reliability
  asOf: unix }            // for staleness weighting
```
The weighted average multiplies `level × direction-aware-sign × weight`. A
signal *cannot* contribute escalation pressure unless its direction says so —
which makes "lots of de-escalation news = risk" a **type error**, not a
judgment call. (Today's fix did this ad hoc for news + OFAC; v2 makes it the
contract every signal obeys.)

> **H2 status (2026-06-23, DONE):** the contract is implemented as
> `stage1_signals` in `functions/_lib/verdict.js` — every signal carries
> `{level, direction, confidence, asOf}`. It is **additive**: the weighted
> average still uses `level` (numeric `stage1_inputs`), so all 16 original
> fixtures + 5000-input equivalence stay identical. `direction` is now a uniform
> first-class field (magnitude-only signals +1/0; news + OFAC bidirectional),
> sourced from `newsDirection()`/`signalDirection()`. The *signed* weighted
> average (where a de-escalatory signal contributes NEGATIVELY, replacing the
> de-trigger) is the remaining piece — deferred to **H2.5** because it MOVES
> verdict numbers and must land behind its own fixtures. The current symmetric
> behaviour is delivered by the contract-driven de-escalation de-trigger.

### 2. Symmetric by construction
The pre-2026-06-23 engine had 7 ways UP and 0 ways DOWN — it *had* to lag any
thaw. In v2 the weighted average spans calm↔crisis natively (a de-escalatory
signal pushes the score *below* baseline), and overrides are ±level pairs. The
`deescalation` de-trigger shipped today is the patch; v2 makes symmetry the
default so you never again add an up-only signal by reflex.

### 3. Regime state machine (hysteresis) — stop the stateless whipsaw
A chokepoint has regimes: `CALM → TENSION → CONFLICT → DE-ESCALATION → RECOVERY`.
Today each hour is recomputed from scratch, so it whipsaws and needs frozen
anchors. v2 holds the current regime and requires N consecutive
corroborating reads to transition (e.g. "in DE-ESCALATION; need 6h of
escalatory signal to flip back to CONFLICT"). Benefits: no whipsaw, the stale
anchor problem disappears, and the verdict gains a memory analysts can read
("de-escalating for 3 days").

### 4. Rolling baselines — kill the magic constants
`PREWAR_BRENT = 72`, `BASELINE_TRANSITS = 22/42/140` are frozen-in-time and go
quietly wrong as the world moves (once $78 is the new normal, the +8% war
premium floor misfires forever). Replace with **rolling/relative baselines**
computed from the D1 history already stored: trailing-90d Brent median,
trailing-30d transit median, trailing-1y BDTI percentile. The verdict becomes
"vs recent normal," which is what an analyst actually means.

### 5. Golden-fixture regression tests — the missing safety net (DO FIRST)
The reason these bugs ship is there is **no test** asserting "this input bundle
→ this band." ~15 labelled historical scenarios as fixtures, run in CI on every
push. Any future weight tweak that would re-break a known case fails the build.
This is the highest-leverage item: it converts "we keep re-fixing this" into
"it stays fixed." Concrete starter set:

| # | Scenario | Inputs (sketch) | Expected |
|---|----------|-----------------|----------|
| 1 | Calm baseline | Brent ~prewar, BDTI <1000, news neutral, no UKMTO | NORMAL |
| 2 | **2026-06-23 thaw** | news de-esc net −1, waivers, Brent +8%, BDTI 2176 | ELEVATED (floor), not HIGH |
| 3 | Genuine calm thaw | as #2 but Brent prewar + BDTI 900 | NORMAL |
| 4 | **June war** | news esc, GDELT 82%, UKMTO attack <72h, Brent +30% | CRITICAL |
| 5 | Single tanker seizure | 1 UKMTO Hormuz incident, oil flat, news spike | HIGH |
| 6 | High news VOLUME, de-escalatory | 60 headlines, net −0.8 | not raised by volume |
| 7 | High news VOLUME, escalatory | 60 headlines, net +0.8 | volume trigger fires |
| 8 | OFAC waiver wave | 4 waivers, 0 designations | OFAC score 0 |
| 9 | OFAC designation burst | 5 designations <48h | OFAC trigger fires |
| 10 | AIS dark, port count high | scraped 760 in port, transits null | transits NOT scored; no "551%" |
| 11 | Blockade (ships pile in port) | in-port rising, transits→0 via AIS | CRITICAL, not calm |
| 12 | Low confidence | only 2 of 13 signals present | verdict tagged confidence=low |
| 13 | GDELT tone high, news de-esc | tone 75%, news net −0.7 | war_tone gated, doesn't fire |
| 14 | Stale feeds | all signals >cadence old | confidence=low, flagged |
| 15 | Mixed / ambiguous | news net 0, Brent +12%, BDTI 1900 | ELEVATED |

Implementation: extract `computeVerdict` into a pure module (no fetch), feed
fixtures, assert band + key trigger fires. Wire into `tests.yml` (testing
system #4 from the Batch E/F handoff).

**DONE 2026-06-23:** `functions/_lib/verdict.js` (pure module, record.js imports
it — equivalence vs old inline proven 4000/4000); `tests/verdict.test.mjs` (16
fixtures, all pass — the table above plus a fresh-waiver-doesn't-fire case);
`.github/workflows/tests.yml`; `package.json`. Run locally: `npm test`.

### 6. Provenance + explainability surfaced (the product moat)
You already half-do this (the "Why:" line). Extend it so every verdict states:
inputs used, their age, their direction, and **what would change it** ("would
drop to NORMAL if Brent < +8% and BDTI < 1800"). For a tool sold to analysts,
the auditability *is* the product.

---

## Recommended sequencing

| Phase | Work | Effort | Why this order |
|-------|------|--------|----------------|
| **H1 ✅ DONE** | Golden-fixture regression tests (#5) + extract verdict to pure module | ~0.5d | Protects everything else; lets v2 refactor proceed safely |
| **H2 ✅ DONE** | Signal contract {level,direction,confidence,asOf} (#1) — additive, behaviour-locked (5000/5000 equivalent). Symmetry (#2) realized via the contract-driven de-escalation de-trigger; full signed-average deferred. | ~1.5d | The core correctness refactor; fixtures catch regressions |
| **H3** | Rolling baselines (#4) | ~1d | Removes the frozen-anchor failure mode |
| **H4** | Regime state machine (#3) | ~2d | Larger; adds memory/hysteresis once contract is stable |
| **H5** | Explainability surfacing (#6) | ~0.5d | UI/payload polish on top of the new structure |

Do **H1 first, always.** It's the difference between "fixed" and "stays fixed."

## Scope note
This is its own workstream — **do NOT fold into Batch E (cleanup) or F (config
unification)**. It's architectural. The current `record.js` is working
(2026-06-23 direction fixes verified in prod: thaw → ELEVATED, war → CRITICAL),
so v2 is an improvement-under-test, not a firefight. Build it behind the
fixtures.
