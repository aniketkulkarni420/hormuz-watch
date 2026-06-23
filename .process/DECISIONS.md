# DECISIONS.md — Running Architectural Decision Log

Append-only. Each entry follows the template. Sorted newest-first.

---

## 2026-05-15 — Design showcase + overflow tripwire (`/showcase/`)

**Context:** Two design bugs shipped to production back-to-back — the Vessel
Type Mix count overflow (count text wider than the bar fill, spilling onto
the gray track) and the Vessel Traffic Trend sublabel overflow
(`white-space:nowrap` on ~74px columns let "Feb-Mar '26 est" bleed into
neighbours). Both passed every existing check (`node --check`, `py_compile`,
HARD_RULES, mockup approved). Root cause: there is no visual safety net.
The agent cannot see rendered output; mockups are static and use the
typical-case data; bugs that only appear at edge data shapes (a 1% row,
a long sublabel) ship past every gate.

**Chosen:** New `/showcase/index.html` — a deployed page that renders each
right-sidebar card across **6 data permutations** spanning the failure-mode
space (typical / empty / one-dominant / all-equal / long-label edge / max
stress). Covers Vessel Type Mix, Vessel Traffic Trend, Conditions, Political
Signals, Market Pulse, Headline Pulse. Three sidebar widths (280 / 340 / 480
px) selectable. Card render code is **copied verbatim** from `index.html`
with `BEGIN-MIRRORED` / `END-MIRRORED` markers so drift is grep-detectable.
Self-test at the bottom walks every rendered card and flags any child whose
right/left edge extends >1px beyond its parent — the overflow tripwire
that would have caught both shipped bugs. A coverage check fetches
`/index.html` and warns when a new `.rblock` ID exists live but not in the
showcase.

**HARD_RULE #11 added:** Touch a live card renderer → mirror to showcase.
The showcase is the lock-in for "design bug → regression test."

**Blindspots explicitly accepted:**
- Only catches **render** bugs given data — does NOT catch upstream data
  bugs (those need the data audit this session has been doing).
- DOM bounding-box check has ±1px tolerance for sub-pixel rendering;
  hairline overflow can still slip.
- Drift between showcase and live is a discipline problem, not a system
  one — the BEGIN-MIRRORED markers make it grep-able but not automatic.
- Only covers 6 cards today; the sidebar has more. Coverage check nags
  when new ones get added.
- Showcase renders the *final* state with transitions disabled. Mid-
  transition rendering bugs are out of scope.
- Currently a human-eyeball + tripwire combo, not a Playwright screenshot
  CI. The Playwright job is the natural next step — emits PNG diffs on
  PRs — but adds ~2 min to every push, deferred.

**Where to find it:** https://hormuz-watch-2.pages.dev/showcase/

---

## 2026-05-14 — Post-audit fixes: BDTI source, fake-data removal, AIS-dependent UI

**Context:** User audit pass — flagged the Conditions card as "not real", a
+219% BDTI WoW, and the whole tool degrading when one feed (AIS) failed.

**BDTI — StockQ-only scraper (`scrape_bdti.py` rewrite):**
- Root cause of +219%: `wow_pct` in `bdti.js` was `(new − last KV value)`, NOT
  week-over-week. A manual 3063 entry (which was actually the **BDI**, the
  wrong index) got diffed against a ~960 noise-median left by the old
  investing.com (frozen at 1107 since 31-Mar) + macrotrends (813) pair.
- `bdti.js`: WoW now computed from a dated `bdti_history` KV array against the
  entry closest to 7 days prior (4–11d window); ±60% sanity guard on both read
  and write neutralises the frozen 219.1 with no re-POST.
- Scraper: **StockQ (`en.stockq.org/index/BDTI.php`) is the sole source** per
  user instruction — plain HTML, no Playwright. Propagates StockQ's own quote
  date as `asOf` (never stamps today on unverified-fresh data); 12-day
  staleness gate; verified live (2429 / 2026-05-13). `bdti-weekly.yml` drops
  the chromium install, 15→5 min timeout.
- **Supersedes** the "Multi-source cross-verification" + "BDTI confidence gate"
  entries below *for BDTI specifically*: investing.com froze, macrotrends was a
  loose regex, TE serves the BDI fallback — there was no reliable multi-source
  set. Oil/vessels keep the multi-source pattern.

**Conditions card — removed fake "Dark vessel share":**
- It was `env.HORMUZ_DARK || 947` (a frozen constant) divided by the live
  vessel count, so the "share" moved *inversely* to real traffic and was even
  bumping the Cross-signal tension gauge to HIGH. `snapshot.js` now emits
  `dark_vessels: null`; the Conditions row is removed; the XV row auto-degrades
  to "unavailable". No genuine dark-traffic feed exists — restore when one does.

**AIS-dependent UI pulled while AISStream is down:**
- Removed the full-width amber "AIS feed degraded" banner (visually
  disproportionate for a known multi-week outage; degraded state still shown on
  the Vessel Movement card).
- Removed the **Flag state flow** card entirely — it is 100% AIS-derived and
  had no real data. JS (`updateFlagDisplay`/`trackFlag`) kept and null-guarded
  so it repopulates automatically when `#flagRows` is restored post-recovery.

**Tradeoffs:** BDTI now single-source (user-accepted — StockQ is dated/daily/
clean; confidence honestly labelled "medium"). Flag state flow + dark-vessel
share are gone from the UI until real feeds exist.

**Follow-ups done same day:**
- BDTI WoW seeded immediately — StockQ ships ~20 recent daily rows on the
  page; `scrape_bdti.py` now extracts them and POSTs a `history` array that
  `bdti.js` merges into `bdti_history`, so WoW computes on the first run
  (−9.2%: 2429 vs 2676 on 05-06) instead of accumulating over weeks.
- Vessel Type Mix **Option A wired in** — 14px bars (was 4px hairlines), count
  inside the fill / `N · P%` in the column on narrow bars (fixes the clipped
  28px pct column), sample size in a subhead that states the classified-row
  count explicitly (so 185 is not read as the 148 headline). Dropped the
  Inbound/Outbound tcards (redundant with the Vessel Movement card).

**Deferred:** TD3C + Gulf war-risk premium — verified real but no free
auto-feed; sourcing decision still open. The 185-vs-148 scraper reconciliation
(`scrape_vessels_web.py` counts typed rows vs de-duplicated total) also open.

---

## 2026-06-23 — Batch H1 DONE: verdict extracted to pure module + golden fixtures

First phase of Verdict Engine v2 shipped (the "do first" item).
- **Extracted** all scorers + computeOverrides/applyOverrides/computeVerdict
  verbatim from `record.js` into `functions/_lib/verdict.js` (pure, no I/O).
  `record.js` now `import { computeVerdict }`s it. **Equivalence proven**: new
  module == old inline across 4000 randomized snapshots (0 mismatches).
- **`tests/verdict.test.mjs`** — 16 golden fixtures (node:test, no deps): calm,
  the 2026-06-23 thaw → ELEVATED, genuine calm → NORMAL, active war → CRITICAL,
  Hormuz incident, de-esc vs esc high-volume news, OFAC waiver vs designation,
  port-count-not-transits, blockade, low-confidence, war_tone gating, mixed.
  All pass.
- **`.github/workflows/tests.yml`** — runs the suite on push (paths: verdict
  module / record.js / tests / package.json) + PR + dispatch. No deps.
- **`package.json`** added (`npm test` → node --test) — also closes G12.

This is the safety net for H2–H5: any future weight/threshold change that
re-breaks a labelled scenario now fails CI before shipping. Next: H2 (signal
contract {level,direction,confidence,asOf} + symmetric-by-construction).

---

## 2026-06-23 — Batch H opened: Verdict Engine v2 (design recommendation)

After the direction-awareness fix (below), recognised this was the 4th instance
of the SAME class of bug (volume/category/direction confusion), each patched
reactively. Wrote a design doc — `.process/VERDICT_ENGINE_V2.md` — to make the
class structurally impossible rather than fixing instances.

Six principles: typed signal contract (level/direction/confidence/asOf),
symmetric-by-construction, regime state machine w/ hysteresis, rolling baselines
(kill PREWAR_BRENT=72 / 22-42-140 constants), golden-fixture regression tests
(DO FIRST — 15 scenarios specced), explainability surfacing.

Sequence H1 fixtures → H2 contract → H3 baselines → H4 regime → H5 explain.
Architectural workstream, NOT folded into E/F. Current record.js works (today's
fixes verified in prod), so v2 is built behind the fixtures as improvement-
under-test. User approved writing the design; implementation not yet scheduled.

---

## 2026-06-23 — Verdict direction-awareness (de-escalation false-positive fix)

**Problem:** Verdict read HIGH/CRITICAL during a clear US-Iran *de-escalation*
(sanctions waivers, $12B unfrozen, successful talks, Brent only +8%). Root
cause: the engine measured news VOLUME and conflict-VOCABULARY, not DIRECTION.
59 headlines about a peace deal fired the same escalation paths as 59 about a
tanker war. Every trigger could only push UP — nothing could pull down.

**Six fixes (all shipped together):**
1. **Direction-aware news** — `scrape_news.py` now classifies each headline via
   escalation/de-escalation lexicons → window `sentiment`/`net_sentiment`
   (−1..+1). `record.js scoreNews(count, netSentiment)`: volume sets the
   ceiling, direction sets the level (de-escalating → 0 even at high volume).
2. **News-volume trigger gated** — fires only if volume ≥40 AND not
   de-escalating (was volume-only; was the ELEVATED→HIGH bump).
3. **GDELT tone de-weighted** — `events` weight 0.18→0.07 (it's vocabulary not
   direction; "U.S. waives Iran sanctions" reads as negative tone). Freed
   weight → `news` 0.05→0.14. `war_tone` trigger gated by news direction.
4. **OFAC designations vs waivers** — `scrape_ofac.py` classifies each action;
   `scoreOfac` scores NET designations (a waiver is de-escalation, not
   pressure); 48h trigger fires on a designation date, never a waiver.
5. **772-transit miscount killed** — `snapshot.js` was shoving scraped
   ships-IN-PORT (778) into the transits slot → "551% of normal". Now transits
   = null when AIS dark (honest); port count surfaced as its own `ships_in_port`.
6. **UI gauge reconciled** — `renderVerdictBlock` now drives the tension-gauge
   SVG from the authoritative `/api/verdict`, ending the stale-dial disagreement.

**Plus symmetric de-trigger:** `deescalation` override pulls verdict −1 level
when news decisively de-escalating AND no UKMTO attack in 72h AND war premium
< 25% (a real attack always wins).

**Verified (unit tests):** today's data → NORMAL (was HIGH); structural 1.51→
0.77; news score 3→0; ofac 2→0; de-trigger fires. Same 59-headline volume but
ESCALATING + UKMTO attack → CRITICAL (still screams during a real war).
Classifier on today's 10 real headlines → net −1.0 (8 de-esc / 0 esc).

**Files:** `scrape_news.py`, `scrape_ofac.py`, `snapshot.js`, `record.js`,
`index.html`. All pass node --check / py_compile.

---

## 2026-05-14 — Batch D (crisis-time accuracy + recalibration) + Batch G opened

**Batch D — done (crisis-time accuracy + honesty fixes):**
- `scrape_currency.py`: **bonbast toman→rial** — was conditional `×10` only for
  values in [10k,250k], so it silently STOPPED converting above 250k toman,
  under-reporting the rate 10× exactly in a crisis. Now unconditional (bonbast
  always publishes toman). Widened `IRR_MAX` 2M→5M for crisis headroom. Also
  relabelled `official` honestly: open.er-api is a mid-market aggregate, NOT
  the CBI official rate — added `spread_basis` field; `spread_pct` is a
  black-vs-mid-market premium, not black-vs-official.
- `record.js`: **verdict confidence surfacing** — a verdict computed from 2 of
  13 signals previously looked identical to a full one. Added `confidence`
  (none/low/medium/high), `inputs_used_count`, `inputs_total`, `coverage_pct`
  to `computeVerdict()` and the KV `verdict_latest` payload. Consumers gate on
  `confidence`.
- `scrape_aircraft.py`: relabelled `militaryCount` — `MIL_PREFIXES` are US/NATO
  callsigns; Iran rarely broadcasts ADS-B, so it's a coalition-posture proxy,
  NOT regional military activity. Added `militaryNote` field + comment.
- `scrape_gdelt.py`: GDELT doc API ArtList mode returns no per-article tone, so
  `avg_tone`/`neg_tone_pct` were ~always null/0. Now emitted as explicit null
  with `tone_available:false`; GDELT treated as a coverage-VOLUME signal
  (`article_count_24h`). Real tone needs the TimelineTone API → Batch G.

**Deferred from Batch D into Batch G** (recalibration, not crisis-time; each
needs verification work that shouldn't be rushed):
- EIA OPEC series swap — `PAPR_OPEC` returns a ~20 mbpd sub-total not ~29;
  candidate `PROD_OPEC_T_PETROLEUM.M` unverified, needs live EIA-key testing.
  Verdict is already protected (record.js uses MoM%, not the absolute value).
- BDTI Macrotrends staleness — needs the scraper restructured to capture the
  table row date so a weeks-stale value can be rejected.
- Stooq as independent oil cross-verify partner — new source function in
  scrape_oil_web.py (Stooq confirmed working: cb.f / cl.f return live OHLC).

## Batch G — pending + new (the catch-all bucket)
Opened per user request. Contents (from the audit's "not in any batch" bucket
+ Batch D deferrals + Batch A deferral):
1. AIS key hardcoded in client JS (Batch A deferral) — needs a WS-proxy Worker.
2. EIA OPEC series swap (Batch D deferral).
3. BDTI Macrotrends staleness / row-date capture (Batch D deferral).
4. Stooq independent oil cross-verify source (Batch D deferral).
5. record.js discards cross-verified tier0 oil, uses fallback for D1.
6. record.js `last_snapshot_ts` header lie + two snapshot writers race.
7. Auth: no constant-time compare, `?token=` in query string (logs leak).
8. GFW cache key truncated to 20 chars → collision risk.
9. `health/index.html` hardcoded GFW date window (not Date.now()-relative).
10. `subscribe.js` swallows email-send errors silently — add reportError.
11. `IP_HASH_SALT` defaults to a public string.
12. No `package.json` / reproducible dev setup.
13. GDELT TimelineTone API (real tone signal) — from Batch D #6.
14. Frontend: surface verdict `confidence` / `coverage_pct` in the UI.

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
