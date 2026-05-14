# Hormuz Watch — Handoff (2026-05-14, post Batches A–D)
**Paste this file into a new Claude session to resume. Supersedes `HANDOFF_2026-05-14.md`.**

---

## TL;DR — where to pick up

A tool-wide audit (4 parallel agents) ran on 2026-05-14. It found one systemic disease — **hardcoded/stale data dressed as live** — and ~80 findings. Fixes were organised into batches **A–G**. **Batches A, B, C, D are DONE and pushed.** Pick up at:

1. **Batch E** — delete the rot
2. **Batch F** — unify config
3. **Batch G** — 14-item catch-all bucket
4. **Testing systems** — stand up the 10-layer QA system (proposal below)

Plus 2 user manual actions still open (UptimeRobot, secrets).

**Latest commit on `origin/main`:** `33377c6` (Batch D).
**Production:** https://hormuz-watch-2.pages.dev (Git-integrated CF Pages, auto-deploys on push to `main`).
**Decision log:** `.process/DECISIONS.md` — every batch is logged there with rationale. Read it first.

---

## 0. CRITICAL RULES — read before any code change

`.process/` is a mistake-prevention system. **Read `.process/HARD_RULES.md` and `.process/DECISIONS.md` before touching anything.** Key rules:
- NEVER push CSS dimension changes without a mockup (`.process/MOCKUP_FIRST.md`).
- NEVER push to `main` without explicit user authorization ("push it").
- NEVER change a value used in 3+ places without a grep audit.
- NEVER label data "LIVE" when >1h old / single-source unverified.
- NEVER trust "looks good" without curl/DOM verification — agents can't see rendered UI.
- Test all 5 render modes (`.process/MODES.md`: AIS / scrape / empty / loading / error).
- **Auto mode is on.** Execute autonomously; still get explicit auth before pushing or doing destructive/shared-system actions.
- Verify edited JS with `node --check`, Python with `python -m py_compile`.

---

## 1. What's DONE (Batches A–D) — context for the new session

### Batch A — kill fake-live data (commit `384f027`)
- `index.html`: removed `TODAY_LOG` (fake animated 19-vessel arrivals log) → honest empty state; killed 3 hardcoded `LIVE FEED` badges → driven by real freshness; replaced hardcoded BDTI `2841`/`BDTI_LAST_UPDATE` with live `/api/bdti` fetch; "12.3M bbl/mo" imports → "no feed".
- `record.js`: BDTI `2841/3.2` was hardcoded into the verdict + every D1 row → now reads `bdti_latest` KV (null when empty); degraded/zero-message AIS no longer feeds verdict mode.
- `bdti.js` / `snapshot.js`: removed `env.HORMUZ_BDTI || 14` fallback (14 scored as "calm").
- `snapshot.js`: added `static_fields[]` flagging structural constants.
- `ais.js`: added `stale`/`degraded`/`liveness`/`messagesProcessed`.
- **ALSO in `384f027`:** Map B-interactive — replaced `SIM_FLEET` animation with real-data Leaflet layers (Port Pressure / Aircraft / Seismic); `scrape_aircraft.py` emits `positions[]`.

### Batch B — methodology truth pass (commit `384f027`)
- `methodology/index.html`: dropped `noindex`; vessel feed → `degraded`; dark-traffic % marked not-computed; composite source table corrected to real providers.
- `subscribe.js`: removed the "weekly digest every Monday" promise (no digest exists).
- `robots.txt`: removed dead `Sitemap:` line.
- `api/index.html`: corrected `/api/oil` tier enum + `/api/snapshot` sample; marked AIS-aggregator Worker endpoints offline.

### Batch C — operational visibility (commits `7e275c2`, `9a6d84d`)
- **Root cause found:** all scheduled GitHub Actions stopped ~9h (2026-05-13 23:43Z). Not billing (repo is public), not disabled workflows — **GHA scheduled-event throttling**. The watchdog couldn't catch it because the watchdog is itself a GHA scheduled workflow.
- `diag.js`: blanket 30-min staleness → per-feed `MAX_AGE_MIN` table; added 6 new `scrape_status_*` keys.
- `scraper-canary.yml`: was failing every run (no Playwright) → fixed.
- `ais-scraper.yml`: cron `*/5` → `*/30` (AISStream dead for weeks; reduces GHA load).
- `scripts/_status.py`: NEW shared `write_status()` helper.
- Scraper hardening: floor checks on `news`/`ofac`/`gdelt` (silent zero-data no longer corrupts the verdict); status writes added to `currency`/`bdti`/`oil_web`/`vessels_web`.
- `functions/api/health.js`: NEW public token-free `HEALTHY`/`DEGRADED` endpoint + HTTP 503 — the hook for an external monitor. Headline check = "all scrapers stopped" (freshest feed >90m).

### Batch D — crisis-time accuracy + recalibration (commit `33377c6`)
- `scrape_currency.py`: bonbast toman→rial now unconditional (was silently under-reporting 10× above 250k toman — i.e. in a crisis); `IRR_MAX` 2M→5M; relabelled `official` as a mid-market aggregate (not CBI rate) + added `spread_basis`.
- `record.js`: verdict **confidence surfacing** — added `confidence`/`inputs_used_count`/`inputs_total`/`coverage_pct` to `computeVerdict()` + `verdict_latest` payload.
- `scrape_aircraft.py`: relabelled `militaryCount` as a coalition-posture proxy (US/NATO callsigns) + `militaryNote`.
- `scrape_gdelt.py`: tone fields now explicit null + `tone_available:false` (ArtList API returns no tone); GDELT = coverage-volume signal.

**Note:** during Batch C, all stale scrapers were manually dispatched via `gh workflow run` to restore freshness. If scheduled runs are still throttled, the new session may need to re-dispatch.

---

## 2. Batch E — delete the rot

| # | Task | File(s) | Notes |
|---|------|---------|-------|
| E1 | Remove MyShiptracking from the vessel scraper | `scripts/scrape_vessels_web.py` | Known-dead (URL pattern unsolvable). Still in `PORTS` + `sites=["myshiptracking","vesselfinder"]` + `scrape_site()`. Burns ~half the job's runtime on a guaranteed-fail source. **After removal: rebase `confidence` logic** — currently `"high" if sites_succeeded==2` so it's permanently capped at "medium". Rebase on `ports_succeeded` within VesselFinder (5/5=high, 3-4=medium). |
| E2 | Delete dead scraper functions | `scrape_currency.py` (`scrape_yahoo_irr`, `scrape_xe_irr`, `scrape_yahoo_aed`), `scrape_oil_web.py` (`scrape_trading_economics`, `scrape_yahoo`), `scrape_bdti.py` (`scrape_trading_economics`) | All defined but never called. Rot that invites accidental re-enable of known-bad sources. |
| E3 | Delete `migrate-secrets-to-pages.yml` | `.github/workflows/` | One-shot migration; its own header says "delete after first run". Still `workflow_dispatch`-able — would overwrite live CF secrets. |
| E4 | Remove/supersede `handoff_hormuzwatch.md` | repo root | Old handoff (2026-05-11) describing superseded architecture (old CF project name, removed endpoints, Twelve Data, Claude scheduled tasks). Landmine. Either delete or add a "SUPERSEDED" banner. Also delete the now-stale `HANDOFF_2026-05-14.md` (this file supersedes it). |
| E5 | Clean map orphans | `index.html` | `SIM_FLEET` array (still defined, unused after Batch A's map work), `posOnPath`, `lerp`, `mkVIcon` — orphaned after the map B-interactive change. The log-entry click handler references the now-empty `simVessels`. Grep-audit before deleting (HARD_RULE #3). |

---

## 3. Batch F — unify config

| # | Task | File(s) | Notes |
|---|------|---------|-------|
| F1 | **Unify the transit baseline** | `record.js` (`BASELINE_TRANSITS=22`), `snapshot.js` (`HORMUZ_BASELINE_30D` default `140`), `config/regions.json` (`transitsPerDay:42`), `methodology/index.html` (says 42) | Four values for one concept. **42 is correct** (the 21M bbl/d ÷ ~500k bbl/vessel derivation + regions.json + methodology agree). Fix `record.js`→42 and `snapshot.js`→42. **RISK: ripples through verdict scoring** — do the verdict-regression tests (see §5) FIRST, or at minimum capture golden before/after verdict outputs. |
| F2 | Fix `brentSource="twelvedata"` mislabel | `record.js` (~line 331) | Twelve Data tier was removed from `oil.js`; the label is now a lie. Relabel to `"opa-demo"` or use `oilD.brent.src`. |
| F3 | Cron collisions + weekend throttle | `.github/workflows/` | `watchdog.yml` and `seismic-scraper.yml` both cron at `:17` — move watchdog to `:50`. `oil-scraper.yml` weekday `7,22,37,52` vs weekend `12 1,3,5,...` (every 2h) — a geopolitical monitor shouldn't slow down on weekends; use one flat `*/15`. |
| F4 | `stooq.js` cache-disabled debug comment | `functions/api/stooq.js` (~line 19) | `// cache disabled for debugging` left in production — every call hits EIA live. Re-enable `cf.cacheTtl` or remove the misleading comment. |
| F5 | Vessel-count doc drift | docs | `148` / `137` / `141` used for the same metric across `SESSION_HANDOFF.md`, `snapshot.js` comment, `design-audit.html`. Pick one. |

---

## 4. Batch G — pending + new (14 items)

Logged in `.process/DECISIONS.md` under "Batch G". Full list:

| # | Item | Severity | Pointer |
|---|------|----------|---------|
| G1 | AIS key hardcoded in client `index.html` JS (`AIS_KEY = "ec40…"`) | **High (security)** | Needs a WebSocket-proxying Worker. Cheap interim: rotate the key (it's free-tier, low value). |
| G2 | EIA OPEC series swap | Medium | `PAPR_OPEC` returns a ~20 mbpd sub-total, not ~29. Candidate `PROD_OPEC_T_PETROLEUM.M` — **needs live EIA-key API testing to verify the right ID**. Verdict already protected (record.js uses MoM%). |
| G3 | BDTI Macrotrends staleness | Medium | `scrape_bdti.py` `scrape_macrotrends()` extracts a number but not the row date — a weeks-stale value can enter the median as "current". Restructure to capture + age-check the row date (reject >10d). |
| G4 | Stooq independent oil cross-verify source | Medium | Add `scrape_stooq()` to `scrape_oil_web.py`. Stooq confirmed working: `stooq.com/q/l/?s=cb.f&f=sd2t2ohlcv&h&e=csv` returns Brent OHLC, `cl.f` for WTI. Replaces the near-identical Investing/OPA pairing with a genuinely independent source. **In the 2026-05-14 oil-accuracy check: OilPriceAPI was 0.09–0.14% off reference; Stooq close was 0.31% off but its intraday range covered the reference.** |
| G5 | `record.js` discards cross-verified tier0 oil | Medium | The brent/wti selection ladder only handles `tier:"primary"`; on the preferred `tier0-xverified` / `scrape` paths it falls through to stooq/eia — the good cross-verified data `oil.js` computed is fetched and thrown away for D1. |
| G6 | `record.js` `last_snapshot_ts` header lie + double-writer race | Medium | The file header claims it writes `last_snapshot_ts`; it doesn't (`scrape_oil.py` does). Both `record.js` and `scrape_oil.py`'s `maybe_snapshot()` may write `snapshots` with different dedup strategies. Reconcile to one writer. |
| G7 | Auth hardening | Medium | No constant-time token compare; `diag.js` accepts `?token=` in the query string (leaks to logs/history). Standardise a shared `checkAuth()` helper, header-only. |
| G8 | GFW cache key collision | Low | `gfw.js` cache key is `btoa(...).slice(0,20)` and drops `geometry` from the hash — truncation → collision risk. Use a full digest, include geometry. |
| G9 | `health/index.html` hardcoded GFW date window | Low | `startDate:"2026-04-05", endDate:"2026-05-05"` frozen — the health check queries an ever-staler window. Make it `Date.now()`-relative (record.js does this correctly). |
| G10 | `subscribe.js` swallows email-send errors | Low | `catch (e) { /* swallow */ }` — a Resend outage is indistinguishable from "not configured". Add `reportError`. |
| G11 | `IP_HASH_SALT` defaults to public string | Low (privacy) | `event.js` — `"default-salt-rotate-me"`. The "rainbow tables useless" claim is false until the env var is set. |
| G12 | No `package.json` / reproducible dev setup | Low | Repo has no `package.json`; `npx wrangler pages dev .` works ad hoc but nothing declares deps. |
| G13 | GDELT TimelineTone API | Low | Batch D made GDELT a coverage-volume signal (tone fields nulled). A real tone signal needs the TimelineTone API endpoint — separate integration. |
| G14 | Surface verdict `confidence` in the UI | Medium | Batch D added `confidence`/`coverage_pct` to the `verdict_latest` payload + `/api/record`. The frontend (`index.html`) should display "verdict computed from N/13 signals" so a low-confidence verdict doesn't look authoritative. |

---

## 5. Testing systems to stand up (the "expert tester" deliverable)

This is a data product — failure modes are *wrong numbers that look fine*, not crashes. 10 layers, priority-ordered. Wire #1–#4 + #7 into CI (`smoke.yml` / a new `tests.yml`) on every push **and** a cron.

| # | System | Catches | Priority |
|---|--------|---------|----------|
| 1 | **API contract tests** — schema/type/required-field assertions per `/api/*` | the `bdti:14` / tier-enum class | **P0** |
| 2 | **Data-sanity tests** — Brent∈[40,200], BDTI∈[400,5000], spreads sane, `ageMin` bounded | the "ETF `proxyPrice 55.85` served as Brent" bug | **P0** |
| 3 | **Cross-source deviation tests** — pull 2-3 independent sources, assert agreement within 0.2–0.3% | institutionalises "accuracy can't be average" | **P0** |
| 4 | **Verdict regression tests** — golden signal-bundle → expected band fixtures | miscalibration (the `scoreProduction` false-positive, F1's baseline change) | **P0** |
| 5 | **Visual regression** — Playwright screenshot diffs across all 5 render modes | the recurring `tbar-label`-width UI regressions | **P1** |
| 6 | **Freshness/liveness gate** — `/api/health` + external monitor | "all scrapers silently stopped" | ✅ done (C) |
| 7 | **Fake-live linter** — CI grep encoding HARD_RULES (no hardcoded "LIVE", no magic-number fallbacks) | the entire Batch A class, permanently | **P1** |
| 8 | **Scraper dry-run canary** — extend beyond BDTI to all scrapers | source-page structure changes | P2 |
| 9 | **Smoke tests** — expand existing: every page 200, no console errors, key DOM IDs present | broken deploys | P2 |
| 10 | **E2E pipeline test** — scraper→KV→API→frontend, scheduled | integration drift | P2 |

**If only 3:** #1 + #2 + #4 (correctness), then #5 (recurring UI pain), then #7 (locks in the audit's lessons). Note: do #4 (verdict regression) **before** F1 (baseline unification) so the baseline change is caught if it shifts verdicts unexpectedly.

---

## 6. User manual actions still open (cannot be done by Claude)

1. **UptimeRobot external monitor** — `https://hormuz-watch-2.pages.dev/api/health` is live and returns HTTP 503 on `DEGRADED`. Add an HTTP(s) monitor (5-min interval) — this is the *only* real fix for "all scrapers silently stopped" (the in-repo watchdog can't watch GHA being down). Account creation can't be done by Claude.
2. **Set GitHub Secrets** `RESEND_KEY` + `ALERT_EMAIL` — the entire alert layer (watchdog, canary) is inert without them.
3. (Optional) `SENTRY_DSN`, rotate `AIS_KEY`, set `IP_HASH_SALT`, set `SECRETS_LAST_ROTATED`.

---

## 7. Architecture quick-reference

- **Frontend:** `index.html` (~3300 lines, single-page) + static pages (`methodology/`, `api/`, `health/`, `terms/`, `404.html`, `admin/`).
- **API:** `functions/api/*.js` — Cloudflare Pages Functions. Public read endpoints, token-gated writers (`/api/record`, `/api/bdti` POST, `/api/diag`). New: `/api/health` (public, no token).
- **Storage:** Cloudflare KV (~20 keys: `latest`, `oil_scraped`, `bdti_latest`, `ais_state`, `verdict_latest`, `aircraft_state`, `seismic_state`, `gdelt_state`, `weather_state`, `news_headlines`, `ofac_state`, `currency_irr`, `vessel_count_scraped`, `scrape_status_*`) + D1 (`snapshots` table, hourly).
- **Scrapers:** `scripts/scrape_*.py` (Python, Playwright for JS-rendered sites) run by `.github/workflows/*.yml` on cron. `scripts/_status.py` is the shared status helper (Batch C).
- **Verdict:** two-stage in `record.js` — Stage 1 weighted average (13 inputs, AIS-primary vs composite-fallback weight sets), Stage 2 override triggers. Now emits `confidence`/`coverage_pct` (Batch D).
- **Known-dead:** AISStream (multi-week provider outage → composite-signal mode), MyShipTracking, TradingEconomics for BDTI, Yahoo currency selectors.

## 8. Quick commands

```bash
# verify before push
node --check functions/api/<file>.js
python -m py_compile scripts/<file>.py

# health + diagnostics
curl -s https://hormuz-watch-2.pages.dev/api/health
curl -s "https://hormuz-watch-2.pages.dev/api/diag?token=$SNAPSHOT_TOKEN"
curl -s https://hormuz-watch-2.pages.dev/api/oil

# workflow runs / manual dispatch
gh run list --limit 25
gh workflow run <name>.yml

# push (ONLY after explicit user authorization)
git add <files> && git commit -m "..." && git push origin main
```

---

## 9. Pickup plan for the new session

1. Read this file + `.process/HARD_RULES.md` + `.process/DECISIONS.md`.
2. Confirm with the user: proceed with **E → F → G → testing**, or reprioritise.
3. Check `gh run list` — if scheduled scrapers are still throttled, dispatch them, and check `/api/health`.
4. Do **Batch F1 (baseline) only after** the verdict-regression tests exist (testing #4) — it's the one change that can silently shift verdicts.
5. One batch at a time; verify (`node --check` / `py_compile` / curl); get explicit push authorization per HARD_RULE #8.
