# Hormuz Watch v3 — Redesign Plan

**Status:** awaiting user approval. No production code changes until the
mockup is reviewed and this plan is signed off.

**Date:** 2026-05-15

**Linked artifact:** `mockups/2026-05-15-redesign-v3.html` (deployed at
`https://hormuz-watch-2.pages.dev/mockups/2026-05-15-redesign-v3.html`)

---

## 1. Goals

Three concrete goals, in priority order:

1. **Become the most comprehensive free Hormuz Strait tracker.** Match or
   exceed every data point shown by hormuztracker.com, straitofhormuz.report,
   WTO Datalab. Where they have things we don't (carrier suspensions, pipeline
   bypass, cross-chokepoint comparison, prediction markets, war-risk premium,
   stranded vessel count, Cape rerouting, LNG/fertilizer flow,
   sanctioned-vessel-match) — add them.
2. **Keep and sharpen our moat:** the analytical layer (composite verdict +
   cross-signal verification + India equity angle). No competitor synthesises
   the basket the way we do.
3. **Cut the noise.** Conditions card (weather + seismic + aerial all carry
   ≤0.03 weight in the verdict) and the static Closure Scenario table are
   dead weight. Removing them reclaims the most valuable real estate.

---

## 2. Information architecture

### Page layout (one page, sticky anchor-tab navigation)

```
┌─ HERO STRIP (across full width) ───────────────────────────────┐
│   Status band     Day counter (when ≠ NORMAL)     Last-update  │
│   Daily brief (2-3 sentences, manually written)                │
│   [Overview] [Supply] [Markets] [Macro] [India]    ← anchor tabs│
└────────────────────────────────────────────────────────────────┘

┌─ SECTION: OVERVIEW ──────┐
│ Verdict (Option C)        │   ← already shipped
│ Cross-chokepoint strip    │   ← NEW
│ Market pulse + baseline   │   ← UPDATED (pre-crisis comparison)
│ Vessel movement + stranded│   ← UPDATED
│ Cross-signal verification │   ← keep, tighten copy
│ Headline pulse            │   ← keep
└───────────────────────────┘

┌─ SECTION: SUPPLY ────────┐
│ Pipeline bypass capacity  │   ← NEW
│ Carrier suspension        │   ← NEW
│ Cape of Good Hope reroute │   ← NEW
│ Vessel type mix (tightened)│  ← UPDATED (4 buckets)
└───────────────────────────┘

┌─ SECTION: MARKETS ───────┐
│ Tanker plays              │   ← keep
│ TD3C VLCC rate            │   ← NEW
│ War-risk insurance        │   ← NEW
│ Prediction markets        │   ← NEW
└───────────────────────────┘

┌─ SECTION: MACRO ─────────┐
│ Macro context (existing)  │   ← demoted from top, kept
│ UNCTAD scenario panel     │   ← NEW
│ LNG flow                  │   ← NEW
│ Fertilizer flow           │   ← NEW
│ Vessel traffic trend      │   ← keep
│ Historical comparison     │   ← NEW (replaces Closure Scenario)
└───────────────────────────┘

┌─ SECTION: INDIA ─────────┐
│ India equity watch        │   ← keep, promote (was buried)
│ India import dependency   │   ← NEW
│ Sanctioned vessel match   │   ← NEW (cross-cuts)
└───────────────────────────┘
```

**Removed entirely:**
- `Conditions` card — weather, seismic, aerial fold into one XV row only
- `Closure scenario impact` static table — replaced by `Historical comparison`

---

## 3. Component manifest

### Cards to ADD (12 new)

| # | Card | Tab | Data source | Cadence | Effort |
|---|---|---|---|---|---|
| 1 | Hero strip (status, day counter, daily brief) | Header | Daily brief from KV (admin form); day counter derived from `closure_date` const | Manual / derived | Low |
| 2 | Cross-chokepoint strip (Hormuz/Suez/Cape/Bab/Malacca) | Overview | New AIS scrape with multi-bbox (extend existing scraper) | 30 min | Medium |
| 3 | Pipeline bypass capacity | Supply | Static config (`config/pipelines.json`); utilization manually | Manual quarterly | Low |
| 4 | Carrier suspension (9 majors) | Supply | Static config + admin form for updates (`config/carriers.json`) | Manual weekly | Low |
| 5 | Cape of Good Hope rerouting | Supply | New AIS bbox scraper for SA waters | 4 hr | Medium |
| 6 | TD3C VLCC rate | Markets | Admin form / KV (`td3c_latest`) | Manual weekly | Low |
| 7 | War-risk insurance premium | Markets | Admin form / KV (`war_risk_latest`) | Manual weekly | Low |
| 8 | Prediction markets (Kalshi/Polymarket) | Markets | New scraper hitting public APIs | Hourly | Medium |
| 9 | UNCTAD scenario panel | Macro | Static config (`config/unctad_scenarios.json`) | Manual when UNCTAD republishes | Low |
| 10 | LNG flow through Hormuz | Macro | AIS filter on ship type "Liquefied Gas Carrier" + WTO Datalab static | 4 hr | Medium |
| 11 | Fertilizer flow | Macro | UN Comtrade API or admin form (WTO Datalab snapshot) | Monthly | Medium |
| 12 | Sanctioned vessel SDN match | India / Overview | Cross of OFAC SDN list (existing) × ais_state (existing) | 30 min | Low |
| 13 | Historical comparison table | Macro | Static config (`config/historical_events.json`) | Manual one-shot | Low |
| 14 | India import dependency | India | Static config (`config/india_exposure.json`) | Manual one-shot | Low |

### Cards to UPDATE (existing visuals enriched)

| # | Card | Change |
|---|---|---|
| 15 | Market pulse | Show `value vs pre-crisis · ±N%` on Brent + WTI + spread |
| 16 | Vessel movement | Add stranded count; show transit baseline comparison |
| 17 | Vessel type mix | Tighten to 4 buckets (Tanker / Cargo / Military / Other) |
| 18 | Cross-signal verification | Tighten row bodies to 1 sentence; add an "Environmental" row that absorbs weather + seismic + aerial |

### Cards to REMOVE

| # | Card | Why | Migration |
|---|---|---|---|
| 19 | Conditions (weather + seismic + aerial) | Each carries ~0.03 weight; this is noise dressed as signal | Fold into one XV row ("Environmental: NORMAL · wind 12kn · 3 quakes mag ≥4 · 10 aircraft") |
| 20 | Closure Scenario Impact (static table) | Invented future-scenarios; doesn't reference real history | Replaced by dynamic Historical Comparison (real events 1973–2024) |

---

## 4. Data architecture

### Static configs (JSON in `config/`)

```
config/pipelines.json          — 4 pipelines: name, capacity_bpd, route, operator, utilization_pct, last_updated
config/carriers.json           — 9 carriers: name, status, surcharge_usd_per_teu, stranded_vessels, stranded_teu, last_updated
config/historical_events.json  — 6 events: name, year, duration, oil_spike, trade_impact
config/unctad_scenarios.json   — 3 scenarios + trade-growth ranges + GDP ranges
config/india_exposure.json     — sectors, % exposure, top-3 stocks per sector
config/pre_crisis.json         — baseline values locked to 2026-02-26
config/closure_date.json       — { closure_date: "2026-02-28", status: "DEGRADED" | "CLOSED" | "NORMAL" }
```

### KV keys (new)

```
daily_brief        — { text, ts, author }     ← admin form POSTs
td3c_latest        — { ws, tce_usd_day, asOf, source }   ← admin form
war_risk_latest    — { hull_pct, vlcc_usd, p_and_i_clubs_withdrawn, asOf, source }   ← admin form
predictions_latest — { kalshi: {...}, polymarket: {...}, fetchedAt }   ← scraper
chokepoints_latest — { hormuz, suez, cape, bab, malacca }   ← scraper
cape_reroute_latest— { tanker, cargo, other, total, sa_ports: {...} }   ← scraper
sanctioned_match   — { matches: [...], total_listed, last_checked }   ← derived
lng_flow_latest    — { transits_24h, pct_pre_crisis, source }   ← scraper or admin
fertilizer_latest  — { transits_pct_drop, commodity_breakdown }   ← admin
```

### New API endpoints (or extended `/api/snapshot`)

Two options:

**Option A** — extend `/api/snapshot` with all new fields (single endpoint
remains the canonical state). Pro: one fetch, one cache. Con: monolithic.

**Option B** — new endpoints per concern: `/api/chokepoints`, `/api/predictions`,
`/api/td3c`, `/api/war-risk`, etc. Pro: granular caching. Con: more fetches.

**Recommended: Hybrid.** Keep `/api/snapshot` for the strait + market basics
(already heavy). Spin out cards that have independent caches as separate
endpoints (`/api/predictions` 5-min cache, `/api/td3c` 1-day cache,
`/api/war-risk` 1-day cache). Cross-chokepoint and Cape rerouting live in
`/api/snapshot` since they share the AIS feed.

### New scrapers needed

1. **Cross-chokepoint AIS** (`scripts/scrape_chokepoints.py`) — extends the
   existing AIS scraper with 5 bboxes (Hormuz already covered). Same
   AISStream feed; just more bbox filters per message. Cron: every 30 min.
2. **Cape rerouting AIS** (`scripts/scrape_cape.py`) — separate scraper with
   the SA-waters bbox; outputs transit count by vessel type. Cron: every 4
   hours.
3. **Prediction markets** (`scripts/scrape_predictions.py`) — hits Kalshi
   public API and Polymarket public API for the regime-fall and
   strait-normal-by-date contracts. Cron: hourly.

### Admin forms (extend `/admin/` pattern)

- `/admin/brief` — daily brief 2-3 sentences
- `/admin/td3c` — VLCC rate from Baltic Exchange weekly report
- `/admin/war-risk` — premium % + VLCC $ + P&I clubs withdrawn count
- `/admin/carriers` — paste-in template to update carrier statuses
- `/admin/lng` (optional) — LNG flow snapshot

All token-gated like `/admin/bdti` — `ADMIN_TOKEN` env var.

---

## 5. Implementation phases (ordered for risk)

### Phase A — Demolition + UI patterns (LOW RISK, HIGH VISIBLE IMPACT)

Goal: cut the noise, apply the UX patterns. No new data sources required.

1. Remove `#conditionsBlock` from DOM (JS-null-guarded already)
2. Replace `#scenarioRows` static table with `#historicalRows` dynamic table
   from new `config/historical_events.json`
3. Tighten Vessel Type Mix buckets — collapse 6 → 4 in `_classify_type`
4. Apply pre-crisis baseline pattern — Market Pulse and Vessel Movement
   render `value vs pre-crisis ±N%` from `config/pre_crisis.json`
5. Build hero strip — status band + day counter + daily brief slot
6. Build anchor-tab navigation (sticky, scroll-spy)
7. Per-feed freshness chips on every card header
8. Add `/admin/brief` form

**Estimated commits:** 5-7. **Production risk:** low. **User-visible impact:**
significant.

### Phase B — New AIS-derived cards (MEDIUM RISK)

Goal: leverage existing AIS infrastructure for new cards.

1. Cross-chokepoint strip — extend AIS bboxes, new scraper or extend
   `scrape_ais.py`. New `/api/chokepoints` endpoint.
2. Cape of Good Hope rerouting — new scraper, new endpoint
3. Stranded vessel count — derive from existing `ais_state` (vessels with
   `category: "anchored"` near strait for >Nh)
4. Sanctioned vessel SDN match — cross OFAC SDN list (already scraped) ×
   ais_state vessel IDs

**Estimated commits:** 4-6. **Production risk:** medium (new AIS bbox math).
**User-visible impact:** high — cross-chokepoint is the single most powerful
new signal.

### Phase C — Static configs + admin forms (LOW RISK)

1. Pipeline bypass capacity
2. Carrier suspension table
3. UNCTAD scenarios
4. Historical comparison
5. India import dependency
6. Admin forms for war-risk, TD3C, carriers, LNG, fertilizer
7. Initial population of each via the admin forms

**Estimated commits:** 6-8. **Production risk:** low. **User-visible impact:**
high — these are the cards everyone else has and we don't.

### Phase D — New API integrations (HIGHER RISK)

1. Kalshi + Polymarket scraper + endpoint + card
2. Bunker fuel scraper (Ship & Bunker, Singapore + Fujairah)
3. Optional TD3C scraper (replaces admin entry if reliable)

**Estimated commits:** 3-4. **Production risk:** higher — public APIs change.
**User-visible impact:** medium — adds forward-looking layer.

### Phase E — Distribution (lower priority)

1. Embed widgets `/embed`
2. API/CSV exports `/api/data`
3. PDF Situation Report `/report.pdf`
4. Map enhancements (pipeline overlays, Cape arrows, port density)

**Estimated commits:** 5-7. **Production risk:** medium. **User-visible impact:**
strategic (distribution/credibility).

### Phase F — Testing hardening

1. Showcase coverage for every new card (6 permutations each)
2. Audit page rows for every new endpoint
3. CARD_ASSERTIONS for every new card
4. BEGIN-MIRRORED blocks for every new CSS
5. Playwright CI captures expanded card set automatically
6. Drift-detector regex v2 (fix the false negatives noted earlier)

---

## 6. Testing & audit strategy

Every new card MUST land with all of these before merge:

| Layer | What | Gate |
|---|---|---|
| Showcase | 6 permutations covering empty / typical / one-dominant / max-stress / long-label / edge | Must exist before card is wired to live |
| Per-card assertions | `CARD_ASSERTIONS` entry encoding spec-as-code | Pass in showcase before push |
| Drift mirror | CSS in `BEGIN-MIRRORED` block; `check_mirror.py` returns clean | Pre-commit (eventually pre-merge) |
| Data audit | `/audit/` row with sanity bounds + age gate per field | Audit page renders green |
| Playwright CI | Workflow `showcase-visual.yml` covers new card automatically | CI passes |
| Freshness chip | Card header shows last-update age + source label | Visible on the live tile |

For every new data source (scraper or admin entry):

| Layer | What | Gate |
|---|---|---|
| Scrape status | `write_status()` integration | Diag shows healthy |
| Fail-safe | Don't write low-confidence / sources-disagree values | Confirmed by dry-run |
| Staleness gate | Reject source values whose own asOf is too old | Coded in scraper |
| Sanity bounds | Min/max checks before KV write | Coded in scraper |
| Confidence label | Output includes `confidence: high/medium/low` | KV payload field |
| Audit page entry | Row with min/max/warnMin/warnMax thresholds | `/audit/` |

---

## 7. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tab nav breaks deep links | Low | Low | Keep hash anchors compatible (`#overview`, `#supply`, etc.) |
| 14 new cards bloat CF Pages function cold-start | Medium | Low | Static HTML rendered client-side; CF Pages handles static well |
| Manual entries (war-risk, TD3C, LNG, brief) get stale | High | Medium | Staleness gates per tile + audit-page flags + admin-form reminders |
| Cross-chokepoint scraper bbox math errors | Medium | High | Showcase permutations for each chokepoint; unit-test the bbox-classification logic |
| Prediction-market APIs change schemas | Medium | Medium | Cache-with-fallback pattern; staleness gate >2h |
| GHA scheduled-cron throttling (already biting) | High | High | Separate work-stream — consolidate dispatcher cron, decide on Cloudflare Cron Triggers migration |
| Removing Conditions card breaks XV row 6 (Environmental) | Low | Low | Keep XV row populating from underlying data, just remove the standalone card |
| Pre-crisis baseline values get out of date / debated | Low | Medium | Lock values in `config/pre_crisis.json` with comment citing source and date; user-approved before merge |

---

## 8. Open product decisions (need user input before Phase A)

| # | Decision | My recommendation | Notes |
|---|---|---|---|
| D1 | Page structure: one-page anchor-tabs vs SPA tabs (hide/show) vs separate pages | **One-page anchor-tabs** | SEO + mobile + deep-link friendly. Matches hormuztracker. |
| D2 | Hero status vocabulary: OPEN/CLOSED binary vs NORMAL/ELEVATED/HIGH/CRITICAL | **Match verdict bands** (NORMAL/ELEVATED/HIGH/CRITICAL) | One vocabulary across the page |
| D3 | Daily brief length | **2-3 sentences** | Long enough to give context, short enough to read in 10s |
| D4 | India section: top-level tab vs sub-section under Markets | **Top-level tab** | Your audience anchor |
| D5 | Pre-crisis baseline date | **2026-02-26 (eve of closure)** | Fixed reference. Any later date drags into the crisis itself. |
| D6 | Mobile tab behavior | **Horizontally-scrollable tabs**, no hamburger | Visible tabs build product awareness |
| D7 | Prediction markets in Markets or Overview tab | **Markets tab** | Forward signal, not status. Don't add to Overview cognitive load. |
| D8 | Demolition gated on user re-approval per card, or batch | **Batch with mockup approval** | Each kill is documented in the plan; reviewing 1 mockup is faster than 4 |
| D9 | Drop email digest: confirmed | **Out of scope this round** | Per user instruction |
| D10 | Map enhancements: now or later | **Later (Phase E)** | High-touch, low-marginal-data-value. Ship core cards first. |

---

## 9. Approval checklist

Before I touch production:

- [ ] Mockup reviewed (`mockups/2026-05-15-redesign-v3.html`)
- [ ] D1–D10 decisions confirmed or redirected
- [ ] Phase A green-lit (demolition + UI patterns)
- [ ] Phases B–E ordered (default: B → C → D → E)
- [ ] Any data point or card to drop from scope

After approval, I work phase-by-phase with the standard discipline (showcase
permutations → assertions → audit row → drift mirror → Playwright CI →
commit → push → verify).

---

## 10. What I will NOT do without your explicit instruction

- Push to main outside the planned phases
- Add data sources not listed here
- Skip showcase coverage for any new card
- Skip audit-page entry for any new endpoint
- Override an existing user-set value in admin-token-gated KV without the
  confidence gate
- Use AskUserQuestion to interrupt Phase work — questions go to a chat
  summary at end of phase

---

**Next action:** I commit + push this plan and the mockup. You open the
mockup in a browser at `https://hormuz-watch-2.pages.dev/mockups/2026-05-15-redesign-v3.html`
and reply with approval, redirects, or specific changes. Production code
work begins only after sign-off.
