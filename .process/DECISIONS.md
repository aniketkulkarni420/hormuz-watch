# DECISIONS.md — Running Architectural Decision Log

Append-only. Each entry follows the template. Sorted newest-first.

---

## 2026-05-14 — Batch C (operational visibility) — part 1

**Root-cause finding:** ALL scheduled GitHub Actions stopped ~2026-05-13 23:43Z (~9h gap). Not billing (repo is public → free unlimited), not disabled workflows (all `active`), not broken code — manual `workflow_dispatch` runs succeed fine. Cause: GitHub Actions scheduled-event throttling/delay. The watchdog couldn't catch it because the watchdog is *itself* a GHA scheduled workflow — it stopped too. This is the exact silent-failure mode the audit predicted.

**Done (part 1):**
- Manually dispatched both oil scrapers → `/api/oil` restored to `tier:"primary"`, Brent $105.5 / WTI $100.59 (was serving garbage FinnHub ETF proxy $55.85/$142.04).
- `diag.js`: replaced the blanket 30-min staleness limit (which permanently false-flagged every hourly/6-hourly feed) with a per-feed `MAX_AGE_MIN` table sized to each cron cadence + GHA-delay headroom. Added the 4 unread `scrape_status_*` keys (aircraft/seismic/gdelt/weather) to the monitored key list.
- `scraper-canary.yml`: was failing every run — installed only `requests` but `scrape_bdti.py` uses Playwright even in `--dry-run`. Now installs Playwright + chromium. Fixed stale "HSN site" alert copy → Investing.com/Macrotrends.
- `ais-scraper.yml`: cron `*/5` → `*/30`. AISStream is in a multi-week outage producing 0 messages/run; `*/5` burned ~9 GHA-hours/day on a guaranteed-fail job and risked schedule-throttling the whole repo.

**Deferred (part 2 — needs user decision):**
- Per-scraper hardening: add `scrape_status_*` writes + zero-data floor checks to ~10 scrapers (news/gdelt/ofac write empty payloads + exit 0 on total failure; aircraft/gdelt/seismic/weather exit 0 on failure). Large mechanical pass.
- **External monitor (user manual action):** the watchdog cannot detect GHA being down. UptimeRobot (or equivalent) hitting `/api/diag` is the only real fix for "all scrapers silently stopped."
- Set `RESEND_KEY` + `ALERT_EMAIL` in GitHub Secrets — the entire alert layer (watchdog, canary) is inert without them.

---

## 2026-05-14 — Batch B (methodology truth pass)

**Context:** Audit Agent 4 found the public methodology page was written pre-AIS-outage and only half-patched — it labelled a dead feed LIVE, published a formula the code doesn't run, and named removed sources. Trust-critical, public-facing.

**Changes:**
- `methodology/index.html`: dropped `noindex` (it's a public trust asset; robots.txt already allows it). Data-signal table: vessel AIS feed → `degraded` (not "live · sub-second"); added a "Port-level vessel activity" fallback row; commodity quotes reworded "cross-verified across providers" (was "Brent (ICE) + WTI (NYMEX)" implying exchange-direct). Dark-traffic section: now states the % is NOT currently computed (AIS denominator unavailable) and raw GFW encounter/loitering counts are shown instead. Composite-source table: Brent → "OilPriceAPI + Investing.com (cross-verified) → EIA → FinnHub ETF" (was "EIA/OilPriceAPI/Yahoo/FRED"); tanker stocks → "Yahoo Finance (yfinance)" (was "Yahoo/Stooq"); BDTI → "Investing.com + Macrotrends + manual admin" (was "Baltic Exchange manual").
- `subscribe.js`: removed "weekly digest every Monday" promise from confirmation email + confirm page — the digest cron doesn't exist. Now: "we'll email you when the digest launches."
- `robots.txt`: removed dead `Sitemap:` line pointing at the old `hormuz-watch-7cd` domain (no sitemap.xml exists).
- `api/index.html`: `/api/oil` tier enum corrected to the 6 real tiers + note that `secondary` proxyPrice is an ETF share price not an oil level; `/api/snapshot` sample fixed (`bdti:14` → realistic + `static_fields` documented); External Worker (AIS aggregator) endpoints marked deprecated/offline.

**Left as-is:** methodology baseline "42 transits/day" — it's the correct intended value (matches regions.json + the derivation); the bug is record.js using 22 / snapshot.js using 140, which Batch F unifies. snapshot.js `india_import_dependency_pct:58` vs methodology 62% — kept separate (different metric for the IRM consumer).

**Pending:** push to main requires user authorization. subscribe.js passes `node --check`.

---

## 2026-05-14 — Tool-wide audit + Batch A (kill fake-live data)

**Context:** 4 parallel agents audited index.html, functions/, scrapers+workflows, static content. Systemic finding: hardcoded/stale numbers dressed as live data across UI, verdict engine, D1 history, API samples, methodology page. User chose to fix all 6 batches in priority order A→B→E→C→D→F, reviewing each before push.

**Batch A — kill fake-live data. Changes:**
- `index.html`: removed `TODAY_LOG` (fake 19-vessel animated arrivals log) → honest empty state in `#logScroll`. Removed 3 hardcoded `LIVE FEED` badges (Transits/24h, Vessel-movement, Flag-state) → neutral defaults, driven dynamically by real freshness in `updateVesselUI`/`trackFlag`. Replaced hardcoded BDTI `2841`/`▲3.2%` + `BDTI_LAST_UPDATE` constant with a live `/api/bdti` fetch (`loadBdtiTile`). Persian Gulf imports `12.3M bbl/mo` → "no feed" placeholder.
- `record.js`: BDTI `2841`/`3.2` hardcoded into verdict input AND every D1 row → now reads `bdti_latest` KV (null when empty; `scoreBdti` skips null). Verdict no longer fed degraded/zero-message AIS (`aisDegraded` gate on `vTransit24h`).
- `bdti.js` / `snapshot.js`: removed nonsensical `env.HORMUZ_BDTI || 14` fallback → return `value:null, stale:true`. (14 scored as "calm" — broken feed read as all-clear.)
- `snapshot.js`: added `static_fields[]` marking `oil_transit_value_usd_per_day`, `incidents_30d`, `india_import_dependency_pct`, `dark_vessels` as structural constants, not live data.
- `ais.js`: added `stale`/`degraded`/`liveness`/`messagesProcessed` — zero-message AIS no longer presented as authoritative; `source` string downgrades to "DEGRADED".

**Deferred from Batch A:** AIS API key hardcoded in client source (`index.html` ~2576) — moving server-side needs a WebSocket-proxying Worker; flagged for a dedicated follow-up, not rushed blind.

**Pending:** visual verification across all 5 modes; push to main requires user authorization. All 4 edited JS functions pass `node --check`.

---

## 2026-05-14 — Map: Option B-interactive (real-data layers, kill SIM_FLEET)

**Context:** Map showed `SIM_FLEET` — 14 hardcoded vessels animated forever via `requestAnimationFrame`. Not a real feed. User: "map cannot be stopped, looks horrible." Mockup `mockups/2026-05-14-map-B-interactive.html` (Leaflet, geographically correct, pan/zoom) approved.

**Decision:** Keep the existing geographically-correct interactive Leaflet base (lanes, pipelines, routes, LOCS, basemap toggles — all real geography). Remove the `SIM_FLEET` animation. Add three real-data layer groups bound to feeds already polled:
- **Port Pressure** — circle per Gulf port, radius ∝ 24h vessel count from `_snapshotData.scraped_vessel_perport`.
- **Seismic** — pulsing markers from `_compositeData.seismic.events_near_ports` (has lat/lng).
- **Aircraft** — markers from `aircraft_state.positions[]`. Required scraper change: `scrape_aircraft.py` now emits per-aircraft `positions` (was aggregate counts only). Layer stays empty until `aircraft-scraper` workflow next runs post-deploy.

All three renderers are null-safe (empty layer until feed populates) and added as toggleable entries in `LAYER_DEFS`. `SIM_FLEET` array left defined but unused (harmless); `simVessels` kept declared-empty for the log click handler.

**Files:** `index.html` (4 edits), `scripts/scrape_aircraft.py` (3 edits).

**Pending:** visual verification across all 5 modes; layer-control panel now has 8 rows (was 5) — check for overflow; push to main requires user authorization.

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
