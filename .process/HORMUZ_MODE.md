# Hormuz Watch — Design OS mode mapping

**Companion to:** `.process/DESIGN_OS.md` (the canonical Design OS).
**Purpose:** apply the OS to this specific project — classify mode, list
applicable rules, identify gaps, and surface compliance / trust risks
before they reach production.

---

## 1. Mode classification

| Layer | Mode | Why |
|---|---|---|
| **Primary** | **3 · Dashboard / intelligence cockpit** | Compact, signal-first, timestamped, source-backed. Job: monitor change, detect what matters, decide ignore / monitor / act. |
| **Secondary** | **2 · Financial analyser** | The India equity panel makes investment-relevant claims about specific named stocks (IOC, BPCL, ONGC, etc.). When the dashboard surfaces these names with directional language ("HIGH exposure", "+2.1%", trade-bias), Mode 2 trust rules apply to that surface. |
| **Not in scope** | 1, 4, 5, 6, 7 | No personal-brand pages, no marketing landing page yet, not a workflow tool, not a pure research interface, not an AI-guided wizard. |

**Implication:** Mode 3 rules govern global density, signal-first
treatment, severity bands, timestamps, and the cockpit visual language.
**Mode 2 rules apply specifically to** the India-equity surface and to any
forward-looking statement about market positioning ("trade bias",
"reaffirm if X", "long upstream / short refiners").

---

## 2. Mode 3 (Dashboard) rules — current compliance state

| OS rule | Status | Notes |
|---|---|---|
| Compact, signal-first | 🟡 partial | We have signal cards but 13+ visible — violates 3–7 metric rule |
| Timestamped | 🟡 partial | Per-feed `Nm ago` chips exist but inconsistent across cards |
| Source-backed | 🟢 good | Source attribution in card headers (`AIS · 12m`, `Stooq · 3m`) |
| Cockpit-like, not cluttered | 🔴 violation | Long vertical scroll, 13+ cards |
| **"Ignore / Monitor / Act" classifier** | 🔴 missing | OS Mode 3 mandates this. We have severity bands but no action classifier. |
| Severity badges | 🟢 good | Verdict band system covers this |
| Confidence badges | 🟢 good | BDTI confidence labels, oil tier labels |
| **Change-since-previous-update** | 🔴 missing | OS Mode 3 information-hierarchy item #2. Not implemented. |
| **Top status strip** | 🟡 partial | Recent mockups add this; not yet in live |
| Compact charts | 🟢 good | Bar-driven; no decorative charts |
| Drill-down drawer | 🟡 partial | Verdict has `<details>`; other cards don't |
| **What changed** panel | 🔴 missing | Top of OS Mode 3 information hierarchy. Not implemented. |
| Watchlist row | 🟡 sketched | V3 mockup proposes; not implemented |

---

## 3. Mode 2 (Financial analyser) rules — current compliance state

These apply to the India equity panel and any forward-looking surface.

| OS rule | Status | Notes |
|---|---|---|
| Always show source | 🟢 good | NSE, intraday |
| Always show "as on" date | 🟢 good | Timestamps present |
| **Separate data, interpretation, recommendation** | 🔴 violated | V3 mockup mixes data + interpretation + recommendation in one paragraph |
| Show methodology | 🔴 missing | No "Why this score?" drawer for the India exposure ranking |
| Show assumptions | 🔴 missing | No statement of "we assume X holding period / risk tolerance" |
| Show caveats before strong conclusions | 🔴 missing | No caveat block before the trade-bias callout |
| Avoid misleading certainty | 🔴 violated | "Reaffirm if BDTI rises + Hormuz transits stay < 10/day" is a deterministic-sounding rule without confidence band |
| **Avoid language that sounds like personalized investment advice unless licensed and appropriate** | 🔴 violated | Specific long/short on named stocks without suitability profile or RA disclosure |
| No false urgency | 🟢 good | We don't manufacture urgency |
| Explain limitations | 🔴 missing | No "this excludes positions, leverage, holding period, risk tolerance" |
| Show benchmark context | 🟡 partial | Pre-crisis baseline is a benchmark; not consistently shown |
| Show both positives and risks | 🟢 good | ONGC/SCI positive + refiners negative both shown |
| **Compliance disclaimer block** | 🔴 missing | OS Mode 2 lists this as required. Absent. |

---

## 4. Critical issues to fix before any India-equity surface ships

### 4.1 — The trade-bias callout (V3 mockup) is recommendation-grade content

Current text from `mockups/2026-05-17-control-room.html` (Version 3):

> *"Trade-bias from the basket: long upstream (ONGC) + Indian tanker (SCI),
> short refiners (IOC / BPCL / HPCL). RIL hedge-neutral given downstream
> offset. Reaffirm if BDTI continues to rise + Hormuz transits stay
> < 10 / day."*

This is named-stock directional advice with a conditional execution
criterion. Aniket is SEBI RA-registered (INH000009843), but the dashboard
product has no suitability gate, no client onboarding, no risk-profile
capture. The OS Mode 2 rule is explicit: *"Avoid language that sounds like
personalized investment advice unless licensed and appropriate."*

**Required restructure (replace the callout with three separated layers):**

```
DATA · today's moves
  IOC −3.2%, BPCL −2.8%, HPCL −2.5%, ONGC +2.1%, SCI +4.5%

INTERPRETATION · how this basket has historically responded to Hormuz risk
  Crude-importing refiners typically underperform on Hormuz disruption
  due to feedstock-cost compression. Upstream and Indian tanker names
  historically benefit from elevated crude / freight rates.

NOT INVESTMENT ADVICE · for educational analysis only
  Past behaviour does not predict future returns. Position sizing,
  holding period, and personal risk tolerance not considered. See
  full disclosure → /disclosures
```

The "Reaffirm if BDTI rises..." conditional must be removed entirely.
Conditional execution language belongs in a discretionary advisory product,
not a public dashboard.

### 4.2 — Missing components before India surface ships

Per OS Mode 2 component list, the following must exist before the India
panel can render in production:

- **Compliance disclaimer block** (component, reusable, appears once per
  page that surfaces equity-specific guidance)
- **Methodology drawer** (explains how exposure bands are assigned)
- **Assumption panel** (states holding-period, time-horizon, risk-tolerance
  assumptions — or explicitly states "no assumption made; user must apply
  their own")
- **Source and freshness block** (already partially exists via per-card
  chips; needs canonicalisation)

### 4.3 — Verdict card violates "one concept per card"

Current verdict carries: band + score + structural verdict + override
status + top contributors + see-all toggle + override-trigger toggle. That
is ≥4 concepts.

Per OS card rule: *"cards group one concept."* The verdict card should be:
band + reason only. Drivers belong in a sibling card or drawer.

---

## 5. Mode 3 vs Mode 2 — when a surface is which

Rule of thumb:

- If the surface shows **only** market-context data (Brent, BDTI, vessel
  transits, war-risk, OFAC, news count, predictions) → **Mode 3**
- If the surface shows **named instruments** (IOC, BPCL, RIL, FRO, INSW,
  specific tickers) with directional language → **Mode 2 applies in
  addition to Mode 3**
- If the surface gives **forward-looking advice** ("long X", "short Y",
  "reaffirm if Z") → **Mode 2 hard-applies and a licensed-advisory wrapper
  is required**

The map is Mode 3 (informational, no names). Tanker plays card lists
tickers without recommendation language — Mode 2 light (source + as-on are
enough; no methodology drawer required because no scoring is exposed).
India equity panel is Mode 2 hard.

---

## 6. The OS's open questions, applied to Hormuz Watch

| OS question | This project's answer / position |
|---|---|
| Default palette warmer/editorial or colder/financial | **Colder/financial.** Mode 3 + Mode 2. Editorial is wrong genre. |
| Dashboards default to light, dark, or both | **Dark.** Cockpit-monitoring use case. Light theme is a Phase E addition, not P0. |
| Financial-analyser products use scores prominently or softer labels first | **Softer labels first** for India exposure (HIGH / MED / POS). The score behind the label lives in the methodology drawer. |
| Compliance disclaimer level | **Mode 2 surfaces (India equity) require explicit disclaimer + RA disclosure.** Mode 3 surfaces (market data) only require source + timestamp. |
| Design tokens in code first | **Hormuz Watch first**, since it's the most-touched project and the OS rules need a real-product test surface. |
| Tailwind vs CSS variables vs Figma tokens | **CSS variables** (we already use them in `index.html` :root); migration to a token JSON config when we add a build step. |
| Which 5 components first | OS proposes verdict + metric + evidence + risk + source-label. We extend with **Mode 3-specific** signal card + status strip + ignore/monitor/act classifier. |

---

## 7. Implications for the v3 redesign plan

`.process/REDESIGN_v3_PLAN.md` Phase 0 (Control Room) must now include the
OS-derived items before any new card lands:

1. **Add the "Ignore / Monitor / Act" classifier** to every signal that
   surfaces in the dashboard.
2. **Add a "What changed" panel** at the top of the Overview tab. This
   shows deltas since user's last session (cookie-tracked).
3. **Add the Compliance Disclaimer component** before the India panel can
   render.
4. **Build the Methodology Drawer and Assumption Panel** components.
5. **Split the verdict card** into band-only + drivers-drawer.
6. **Reformat the India trade-bias callout** as data / interpretation /
   disclosure (see §4.1).
7. **Enforce tabular numerals** everywhere financial figures appear.
8. **Add `prefers-reduced-motion` support** to all animated CSS.

These are not negotiable — they are OS-rule applications, not new design
choices.

---

## 8. What lands in `HARD_RULES.md`

The most actionable, immediate-violation OS rules become enforceable hard
rules in this repo:

- **HARD_RULE #12** (proposed): No surface naming a specific equity may
  ship without a Mode-2 compliance treatment (separated data /
  interpretation / disclosure + linked RA disclosure).
- **HARD_RULE #13** (proposed): Every signal card on the dashboard must
  carry an Ignore / Monitor / Act classifier or a documented exemption.
- **HARD_RULE #14** (proposed): Every numeric financial figure uses
  `font-variant-numeric: tabular-nums`.

These will be added in a separate commit, with the OS clause cited.

---

## 9. Status

| | |
|---|---|
| Date | 2026-05-17 |
| Author | Claude (per Aniket's Design OS, mapped to Hormuz Watch) |
| Status | Draft awaiting Aniket review |
| Next review | When Phase 0 (Control Room) ships, or when a new surface adds named-equity content |
