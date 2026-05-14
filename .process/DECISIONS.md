# DECISIONS.md — Running Architectural Decision Log

Append-only. Each entry follows the template. Sorted newest-first.

---

## 2026-05-14 — Install .process/ mistake-prevention system

**Context:** Repeat regressions from tunnel-vision fixes: `.tbar-label` width broke bar rhythm; stale AIS-era placeholders left visible in scrape-mode; `display:none` applied without understanding original element purpose. Each was a single-line edit that shipped without visual review.

**Options considered:**
- (a) Verbal commitment + hope. Tried, failed.
- (b) Pre-commit hook that blocks dimension changes. Friction too high for personal repo.
- (c) Documented hard rules + checklist + mockup-first rule, with CLAUDE.md pointing future agents at them. **Chosen.**

**Chosen:** Option (c). `.process/` directory with HARD_RULES, MOCKUP_FIRST, MODES, CHECKLIST, VERIFICATION, DECISIONS. CLAUDE.md updated to load them.

**Tradeoffs:** Adds reading cost for new agents. Pays for itself in one prevented regression.

---

## 2026-05-14 — Vessel Type Mix 1B (abbreviated labels + 66px column)

**Context:** `.tbar-label` width was widened to 96px in a prior fix to stop "Container Ship" / "Offshore/Service" from truncating. Side effect: bars compressed to ~140px, killing the visual rhythm the card was designed around.

**Options considered:**
- 1A: Keep 96px labels, accept narrow bars.
- 1B: 66px labels + abbreviations (Container, Offshore, Bulker). Restores wide bars while keeping label readable. **Chosen.**
- 1C: Two-line labels. Adds vertical bulk, breaks alignment with .tbar-pct.

**Chosen:** 1B. Abbreviation map in updateTypeBars; CSS width 96 → 66; overflow:hidden + ellipsis preserved as safety net.

**Tradeoffs:** Loses "Ship" suffix on Container; loses "Carrier" suffix on Bulk. Acceptable — domain users will recognize.

---

## 2026-05-14 — Vessel Movement scrape-mode 2B (hide AIS-era placeholders)

**Context:** When `data_source === "web_scrape"`, the direction bar (E/W) and 3-tile category grid (Transit/Anchored/Approach) still rendered with stale or em-dash values because those metrics don't exist in scrape data. Created a "half AIS, half scrape" look that confused users about what's actually live.

**Options considered:**
- 2A: Leave placeholders, label them "AIS PENDING". Visual clutter remains.
- 2B: Hide direction bar + E/W labels + 3-tile grid entirely when scrape-mode active. Show clean port-activity headline + per-port bars + explanation tile. **Chosen.**
- 2C: Render a totally different card in scrape-mode. Too much code, two cards to maintain.

**Chosen:** 2B. Toggle via `applyAisDegradedMode` adding/removing display:none on the AIS-only elements. Reversible when AIS recovers.

**Tradeoffs:** Mode-toggle logic concentrated in one function — single point of failure. Mitigated by VERIFICATION.md curl checks.

---

## 2026-05-14 — Source-badge color standardization

**Context:** Source badges drifted: some "src-blue" badges were on data >24h old; some "src-green" badges were on single-source unverified data. Violated honest-source-attribution rule.

**Chosen rules:**
- `src-green` = live, <10 min old, ≥2 sources or trusted single-source
- `src-blue`  = recent, 10 min – 24h old (web scrape, hourly cron)
- `src-amber` = historical, >24h or known-stale (EIA weekly, etc.)
- `src-red`   = stale / error (only when actually broken — fetch failed, KV null, etc.)

**Tradeoffs:** Need a watchdog to age-out badges automatically; for now agents must check manually.

---

## Retroactive entries

### 2026-04-?? — AISStream pivot to composite signals

**Context:** AISStream WebSocket dropped subscriptions silently for weeks. 4+ GitHub issues open against the provider, no maintainer response. Single-source dependency was unacceptable for a "freshness moat" product.

**Chosen:** Build out 12 independent composite signals (aircraft, oil multi-source, BDTI multi-source, vessels via VesselFinder scrape, GDELT, USGS seismic, weather, news, OFAC, currency, EIA inventory, OPEC production). Dashboard is now antifragile to AIS being down.

**Tradeoffs:** Increased scraper surface area = more things that can break. Mitigated by multi-source cross-verify + watchdog email alerts.

### 2026-04-?? — Multi-source cross-verification pattern

**Context:** Yahoo Finance selectors broke without warning, returning $212 for Brent (wrong DOM node). Single-source numeric scrapes are not safe.

**Chosen:** For oil + BDTI + vessels: fetch 2-3 independent sources, sanity-bound each value, compute median, expose confidence rating (high / medium / low based on spread). Frontend displays median with confidence indicator.

### 2026-04-?? — BDTI confidence gate

**Context:** Investing.com BDTI scrape returned 1107; Macrotrends returned 813. Disagreement ≈36%. Writing either to KV would mislabel as "LIVE".

**Chosen:** When sources disagree >15%, mark as low-confidence, expose both sources in API response, do NOT overwrite manually-entered admin value if one exists.

### 2026-04-?? — Two-stage verdict

**Context:** Single weighted-average verdict missed acute escalation events (OFAC sanction + news spike), because hours of normal signals dragged the average down.

**Chosen:** Stage 1 = weighted-average structural baseline. Stage 2 = override triggers that each fire +1 verdict level (OFAC last 48h, IRR spread >150%, news >40 in 24h, military aircraft >5, seismic 5.5+). Composite-aware: weights re-balance when AIS is broken.

### 2026-04-?? — Tile consolidation

**Context:** Right sidebar had 13+ individual tiles. Visual fatigue. Some tiles redundant.

**Chosen:** Consolidate to 10 tiles by grouping: Political Signals (OFAC + News + GDELT + Currency), Macro Context (OPEC + SPR + crude + PG imports), Conditions (aerial + weather + seismic + dark vessels). Old tiles kept in DOM with display:none so their JS writers don't error.

**Tradeoffs:** Dead DOM (`display:none` tiles) accumulates. Acceptable cost for not breaking JS during the migration.
