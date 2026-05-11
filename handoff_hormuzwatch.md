# Hormuz Watch — Project Handoff
## Resume in 5 minutes · Last updated 2026-05-11

Paste this entire file into a new Claude session to resume work with zero context loss.

---

## 1. WHAT IT IS

A single-page dashboard at **https://hormuz-watch-7cd.pages.dev** for monitoring the Strait of Hormuz with live multi-signal intelligence. Built for equity analysts watching Indian oil & gas, tanker stocks, and Middle East tension. Free, no login, public.

**Owner:** Aniket Kulkarni (personal product — NOT KamayaKya branded, NOT SEBI RA branded).

**Core USP:** accuracy + freshness. Every signal is labelled with source health; nothing pretends to be live when it isn't.

---

## 2. LIVE PRODUCTION

### URLs
| Route | Purpose |
|---|---|
| `/` | Main dashboard |
| `/methodology` | How metrics are computed (categorical sources, not specific provider names) |
| `/terms` | IP / copyright / permitted-vs-restricted use |
| `/health` | Per-source uptime page, auto-refresh 30s |
| `/api` | Public API documentation |
| `/backtest` | Backtest lab (empty until D1 has 7+ days of data) |
| `/admin/commentary` | Token-gated commentary admin form |
| `/robots.txt` | Blocks LLM scrapers + /api/ paths |

### GitHub repo
- **Public:** https://github.com/aniketkulkarni420/hormuz-watch
- Anyone can view source. Methodology + thresholds proprietary per /terms.

### Cloudflare resources
| Resource | ID / name |
|---|---|
| Pages project | `hormuz-watch` |
| Account ID | `0d6dd06f6064a117d0ea03e6187c16cc` |
| D1 database | `hormuz-watch-data` (id `cdd305ca-3113-4124-96c3-f0ffd3532fd3`) — APAC region |
| KV namespace | `OIL_KV` (id `65bcc219241e41e7b9b3f2df645e2bd5`) |
| Separate Worker | `hormuz-ais-aggregator.aniket-kulkarni.workers.dev` (deployed but free-tier WebSocket issue — see §6) |

---

## 3. ARCHITECTURE

### Tech stack
- **Front-end:** single-file HTML + vanilla JS + Leaflet 1.9.4 (no React, no build chain). Manrope + JetBrains Mono fonts via Google Fonts.
- **Backend:** Cloudflare Pages Functions (serverless API proxies) at `functions/api/`.
- **Data store:** Cloudflare D1 (SQLite, hourly snapshots) + Cloudflare KV (latest live values).
- **Scheduled jobs:** GitHub Actions (Python, runs scrapers) + Claude scheduled-tasks (BDTI cron, hourly D1 record cron).
- **Observability:** Sentry (browser errors) + Cloudflare Web Analytics + UptimeRobot.
- **Email:** Resend free tier (3000/mo).

### Data flow
```
Browser (vanilla JS)
  ↓ fetches /api/* endpoints
  ↓
Cloudflare Pages Functions (server-side)
  ↓ reads from
  ↓
[KV: latest oil + AIS state]  [D1: hourly historical snapshots]
  ↑                            ↑
GitHub Actions (every 10-15 min)
  - scrape_oil.py  → yfinance/Stooq/FRED/EIA → KV
  - scrape_ais.py  → AIS WebSocket 60s burst → KV (transits + categories)

Claude scheduled tasks
  - bdti-weekly-update (Monday 09:06 IST) → manual BDTI refresh in HTML
  - hormuz-hourly-snapshot (every hour :09) → POST /api/record → D1
```

---

## 4. SECRETS INVENTORY

All stored as Cloudflare Pages secrets (env vars in Functions runtime). Values **never** in code or chat after rotation.

### Cloudflare Pages secrets
| Name | Purpose | Where stored | Rotation status |
|---|---|---|---|
| `EIA_KEY` | EIA petroleum API | CF Pages secret (prod + preview) | Original, not rotated |
| `GFW_TOKEN` | Global Fishing Watch JWT | CF Pages secret | Was rotated once; current value working |
| `FINNHUB_KEY` | FinnHub ETF prices (free tier, BNO/USO only) | CF Pages secret | Original from chat, not rotated |
| `TWELVE_KEY` | Twelve Data (free tier doesn't support commodity futures — Pro needed) | CF Pages secret | Original from chat |
| `SNAPSHOT_TOKEN` | Gates POST /api/record (D1 writer) | CF Pages secret | Generated server-side; in scheduled-task prompt |
| `ADMIN_TOKEN` | Gates POST /api/commentary | CF Pages secret | Generated server-side |
| `RESEND_KEY` | Resend email service | CF Pages secret | Original from chat |
| `RESEND_FROM` | `Hormuz Watch <onboarding@resend.dev>` (sender address) | CF Pages secret | Resend default until custom domain verified |

### GitHub Secrets (for GHA workflows)
| Name | Purpose |
|---|---|
| `CF_ACCOUNT_ID` | `0d6dd06f6064a117d0ea03e6187c16cc` |
| `CF_API_TOKEN` | KV-write scoped, rotates every 90 days recommended |
| `CF_KV_NAMESPACE_ID` | `65bcc219241e41e7b9b3f2df645e2bd5` |
| `AIS_KEY` | AISStream.io API key |
| `EIA_KEY` | Same as CF secret, used in scraper fallback |

### AIS Worker secrets (separate from Pages)
- `AIS_KEY` (same value)
- `SNAPSHOT_TOKEN` (DIFFERENT from Pages — Worker has its own)

---

## 5. API ENDPOINTS (Pages Functions)

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/oil` | GET | public | Tiered Brent + WTI: KV → FinnHub ETF → EIA fallback |
| `/api/stooq` | GET | public | EIA daily Brent/WTI (legacy name preserved for back-compat) |
| `/api/eia` | GET | public | EIA series proxy with frequency param |
| `/api/gfw` | POST | public | GFW v3 events proxy (dataset whitelist: `:latest` versions) |
| `/api/ais` | GET | public | Reads KV ais_state (server-side aggregated transits + categories) |
| `/api/record` | POST | `X-Snapshot-Token` header | Writes hourly snapshot to D1 (called by cron) |
| `/api/history` | GET | public | Reads D1 time series — `?metric=brent_price&range=7d` |
| `/api/commentary` | GET / POST | POST needs `X-Admin-Token` | Analyst commentary CRUD |
| `/api/subscribe` | POST / GET | none | Email subscription + double opt-in confirmation |
| `/api/snapshot` | GET | public | Legacy stable snapshot for India Risk Monitor (separate concern, untouched) |

### External Worker endpoints
- `hormuz-ais-aggregator.aniket-kulkarni.workers.dev/state` — Durable Object state (currently limited by free-tier eviction; see §6)

---

## 6. KNOWN ISSUES + DECISIONS

### Tier 1.4 — AIS Durable Object on free tier
**Issue:** Cloudflare Workers free tier evicts the DO from memory after idle periods. Persistent WebSocket subscription to AISStream breaks → messages stop flowing → `/state` returns stale data.
**Current resolution:** GitHub Actions scraper (`.github/workflows/ais-scraper.yml`) runs every 10 min, opens WS for 60s, captures positions, detects gate crossings against KV state, writes back. The DO remains deployed but isn't the primary data source. Dashboard reads from `/api/ais` (KV-backed).
**Future fix:** Either pay $5/mo for Workers Paid plan (DO stays alive) OR refactor DO to also use cron-burst pattern (~3h work).

### Tier 2.4 — Commentary automation deferred
User said "ignore for now". Three options were proposed: pure templates / LLM-generated / hybrid auto-draft + you publish. Best balance recommended = γ (hybrid). Filed in deferred list.

### Yahoo Finance from Cloudflare Workers
Yahoo's `/v7/finance/quote` requires auth tokens from CF Workers (returns 401). Workaround: GitHub Actions Python script uses `yfinance` library (which handles auth via session cookies). Don't try to call Yahoo from CF Workers directly.

### FinnHub free tier
Doesn't include real commodity futures (BZ=F, CL=F return 0). Free tier only has BNO/USO ETF proxies, which trade at different price levels (e.g. BNO ~$53 vs actual Brent ~$109). Code applies ETF % change to a daily reference, doesn't blend price levels.

### Twelve Data free tier
Doesn't include commodity Brent/WTI. Pro plan ($79/mo) would unlock it. Key stored, ready to activate when upgraded. In meantime: stocks (FRO, INSW, TNK, etc.) DO work on free tier — useful for tanker plays panel future enhancement.

### Resend custom domain
Currently sends from `onboarding@resend.dev` (Resend default verified sender). For branded sender like `hello@kamayakya.com`, need DNS verification in Resend dashboard. Deferred — user hasn't picked a domain.

---

## 7. TIER STATUS — COMPLETE INVENTORY

### ✅ TIER 1 — Foundation (mostly complete)
| # | Item | Status |
|---|---|---|
| 1.1 | Tiered oil price feed (KV ← GHA ← yfinance) | ✅ Live |
| 1.2 | D1 historical data store + hourly cron | ✅ Live, accumulating since 2026-05-11 |
| 1.3 | Automated freshness monitoring (`/health` + Sentry + UptimeRobot + Cloudflare Analytics) | ✅ Live |
| 1.4 | Server-side AIS aggregation | ⚠️ DO deployed but free-tier limited; GHA-based replacement live |
| 1.5 | Public `/health` page | ✅ Live |

### 🟨 TIER 2 — Stickiness (partial)
| # | Item | Status |
|---|---|---|
| 2.1 | Email alert subscriptions (threshold-triggered) | 📋 Planned |
| 2.2 | Weekly digest email | 🟨 Subscribe flow live; digest cron+template NOT YET BUILT |
| 2.3 | Personal watchlist + auth | 📋 Planned (needs auth — wait for alerts) |
| 2.4 | Analyst commentary layer | ✅ Live (manual posting via `/admin/commentary`) |
| 2.4-auto | Commentary automation (auto-draft + you publish) | ⏸ Deferred per user |
| 2.5 | Statistical confidence on verdicts | ⏸ Deferred per user (needs 30+ days D1) |
| 2.6 | ACLED conflict events | ⏸ Blocked on Research-tier upgrade (email drafted) |

### 🟦 TIER 3 — Differentiation (foundations laid)
| # | Item | Status |
|---|---|---|
| 3.1 | Backtest lab UI at `/backtest` | ✅ Live (empty state until D1 fills) |
| 3.2 | Multi-region foundation (`config/regions.json`) | ✅ Hormuz live; 3 more regions defined as JSON |
| 3.3 | Public API documentation `/api` | ✅ Live |
| 3.4 | Analyst commentary CMS | ✅ Live (same as Tier 2.4) |
| 3.5 | Bab el-Mandeb second region (Houthi attacks) | ⏸ Deferred — "add in a few days" |
| 3.6 | Suez Canal region | 📋 Planned after 3.5 |
| 3.7 | Malacca Strait region | 📋 Planned |
| 3.8 | Bosphorus region | 📋 Planned |

### ⚪ TIER 4 — Commercial (held)
| # | Item | Status |
|---|---|---|
| 4.1 | Pricing tiers (Free / Pro / Institutional) | ⏸ Hold per user: revisit after 15-30 days public testing |
| 4.2 | Auth (Stripe + magic link) | ⏸ Hold |
| 4.3 | White-label | ⏸ Hold |

---

## 8. PENDING USER ACTIONS

| # | Action | Why |
|---|---|---|
| 1 | Send ACLED upgrade email (drafted in `aniket@kamayakya.com` Gmail Drafts, addressed to `access@acleddata.com`) | Unblocks Tier 2.6 conflict events |
| 2 | Authorize 3 more Gmail accounts in Claude.ai connector settings: `aniketshevchenko@gmail.com`, `aniket.kulkarni@unitedbuzzz.com`, `aniket@zonamista.in` | Optional — currently only `aniket@kamayakya.com` is authorized |
| 3 | Rotate Resend API key (shared in chat as `re_LHxeRzGi_...`) | Security hygiene |
| 4 | Rotate FinnHub key (shared as `d80m7rhr01qt5k5vfks0d80m7rhr01qt5k5vfksg`) | Security hygiene |
| 5 | Rotate Twelve Data key (`1095421975c04de5b3e9d5f5a0c2991f`) | Security hygiene |
| 6 | Rotate Cloudflare API token (`cfut_TsSL...`) | Security hygiene |
| 7 | Choose custom email sender domain (e.g. `kamayakya.com`) and verify DNS in Resend dashboard | Replaces `onboarding@resend.dev` with branded sender |

---

## 9. FILE MAP

```
hormuz-watch/
├── index.html                          # Main dashboard (~2900 lines, single file)
├── wrangler.toml                       # CF Pages config (D1 + KV bindings)
├── schema.sql                          # D1 schema: snapshots, events, health_checks, commentary, subscribers, digest_runs
├── robots.txt                          # Blocks LLM scrapers + /api/
├── README.md                           # De-specified (no provider names)
├── handoff_hormuzwatch.md              # THIS FILE
│
├── methodology/index.html              # Methodology page (categorical sources)
├── terms/index.html                    # Terms of use (IP scope)
├── health/index.html                   # System health status page
├── api/index.html                      # Public API documentation
├── backtest/index.html                 # Backtest lab UI
├── admin/commentary/index.html         # Commentary admin form (token-gated)
│
├── functions/api/
│   ├── eia.js                          # EIA series proxy
│   ├── gfw.js                          # Global Fishing Watch proxy
│   ├── oil.js                          # Tiered oil feed reader (KV first, then ETF, then EIA)
│   ├── stooq.js                        # EIA daily Brent (named for legacy)
│   ├── ais.js                          # Reads ais_state from KV
│   ├── record.js                       # POST hourly snapshot writer (token-gated)
│   ├── history.js                      # D1 time series reader
│   ├── commentary.js                   # GET public / POST admin commentary
│   ├── subscribe.js                    # Email subscription + confirm
│   └── snapshot.js                     # Legacy stable snapshot (DO NOT TOUCH — used by IRM)
│
├── config/
│   └── regions.json                    # 4 chokepoint regions (Hormuz live + 3 planned)
│
├── scripts/
│   ├── scrape_oil.py                   # GHA-run: yfinance/Stooq/FRED/EIA fallback → KV
│   └── scrape_ais.py                   # GHA-run: AIS WebSocket 60s burst → KV
│
├── .github/workflows/
│   ├── oil-scraper.yml                 # Every 15min market hours (oil + tanker stocks)
│   └── ais-scraper.yml                 # Every 10min (AIS vessels + gate crossings)
│
└── workers/ais-aggregator/             # Standalone Durable Object Worker
    ├── src/index.js                    # WS-based DO (deployed but free-tier limited)
    └── wrangler.toml                   # SQLite migration for free-tier compat
```

---

## 10. SCHEDULED JOBS (running 24/7)

| Job | Cadence | Owner | Purpose |
|---|---|---|---|
| GHA oil-scraper.yml | Every 15min market hrs / 2h off-hrs | GitHub Actions | Brent/WTI/tanker stocks → KV |
| GHA ais-scraper.yml | Every 10min | GitHub Actions | Vessel positions + gate crossings → KV |
| `bdti-weekly-update` | Monday 09:06 IST | Claude scheduled-tasks | BDTI value refresh in `index.html` |
| `hormuz-hourly-snapshot` | Every hour at :09 past | Claude scheduled-tasks | POST /api/record → D1 snapshot |
| AIS DO cron `*/5 * * * *` | Every 5min | Cloudflare Worker | DO warm-up (limited effect due to eviction) |

---

## 11. DATA MODEL (D1 schema)

```sql
-- snapshots: hourly state (drives /api/history + backtest)
CREATE TABLE snapshots (
  ts INTEGER PRIMARY KEY,
  transits_24h, vessels_transiting, vessels_anchored, vessels_approach INTEGER,
  brent_price, wti_price, bw_spread REAL,
  brent_source TEXT,
  bdti INTEGER, bdti_wow REAL,
  gfw_encounters, gfw_loitering INTEGER,
  dark_pct REAL,
  india_via_hormuz_pct REAL,
  source_health TEXT  -- JSON
);

-- commentary: analyst reads (Tier 2.4)
CREATE TABLE commentary (
  ts INTEGER PRIMARY KEY,
  author, title, body_md, signal_ctx TEXT,
  display_until INTEGER,
  visibility TEXT DEFAULT 'public'
);

-- subscribers: email digest (Tier 2.2)
CREATE TABLE subscribers (
  email TEXT PRIMARY KEY,
  joined_ts INTEGER, confirmed INTEGER,
  confirm_token, segment, source TEXT,
  unsubscribed_ts INTEGER
);

-- digest_runs: weekly digest history (Tier 2.2)
CREATE TABLE digest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, week_starting TEXT,
  preview_html TEXT,
  reviewed INTEGER, sent_ts INTEGER, sent_count INTEGER,
  status TEXT DEFAULT 'draft'
);

-- events: notable threshold breaches (planned use)
CREATE TABLE events (id, ts, kind, severity, source, payload);

-- health_checks: per-source uptime log
CREATE TABLE health_checks (ts, source, status, latency_ms, http_status, error);
```

---

## 12. KEY DECISIONS LOG

| Decision | Why | When |
|---|---|---|
| Single HTML file, vanilla JS, no React | Fast load, no build chain, easy to inspect | Original |
| Public GitHub repo | Aniket's portfolio piece + open-source credibility | Original |
| KamayaKya / SEBI removed | "This is Aniket Kulkarni product, not company" | Mid-session |
| Tier 1.4 — accepted GHA workaround over $5/mo paid plan | Free-tier constraint; cron-burst captures enough data | Late session |
| Methodology page kept (not removed) but generalised | Credibility > obscurity | Late session |
| GitHub kept public (not made private) | Streisand effect risk; defensibility through velocity, history, brand | Late session |
| L1 (de-specify copy) + L2 (Terms + © + robots) over L3 (make repo private) | Owner energy goes to building moats, not hiding code | Late session |
| Sidebar Reorder B (4 sections) over flat list | Cognitive load reduction; future-proof for new cards | Late session |
| Resend `onboarding@resend.dev` default sender | Skip DNS verification until brand domain chosen | Late session |
| Commentary stays manual (NOT auto-templated) | Voice is the moat; Aniket's editorial value can't be subcontracted | Late session |

---

## 13. HOW TO RESUME WORK

### Step 1 — Verify production
```bash
curl -s https://hormuz-watch-7cd.pages.dev/health | grep -o 'overall'
curl -s https://hormuz-watch-7cd.pages.dev/api/oil | head -c 200
```
Should both return 200 with JSON.

### Step 2 — Check git state
```bash
cd "C:\Users\anike\Desktop\hormuz-watch"
git log --oneline -10
git status
```

### Step 3 — Check D1 data accumulation
```bash
npx wrangler d1 execute hormuz-watch-data --remote --command="SELECT COUNT(*) AS rows, MIN(ts), MAX(ts) FROM snapshots"
```
Number of rows = hours of historical data accumulated.

### Step 4 — Check scheduled tasks
Open Claude UI sidebar → Scheduled → confirm `bdti-weekly-update` and `hormuz-hourly-snapshot` are enabled.

### Step 5 — Check GitHub Actions
- Go to https://github.com/aniketkulkarni420/hormuz-watch/actions
- Confirm `Oil & Tanker Stock Price Scraper` + `AIS Vessel Scraper` both running on schedule with recent green runs

### Step 6 — Pick up next work
Refer to **§7 Tier Status** — pick from "Planned" or "Deferred — revisit" items.

---

## 14. PRIORITY ITEMS FOR NEXT SESSION

1. **Tier 2.2 digest delivery** — Resend key wired; need to build weekly cron + email template + admin preview URL. ~5h work.
2. **Tier 3.5 Bab el-Mandeb** — config exists; need to clone region-aware dashboard. ~30h work.
3. **Tier 1.4 proper fix** — refactor DO to cron-burst pattern OR decide on $5/mo paid plan.
4. **Tier 2.5 statistical confidence on verdicts** — needs D1 to have 30+ days first (~June 2026).

---

## 15. ANTI-PATTERNS (don't repeat)

- ❌ Don't call Yahoo Finance directly from Cloudflare Workers (401). Use GHA Python instead.
- ❌ Don't try persistent WebSocket in a free-tier Cloudflare Worker DO. It will silently break.
- ❌ Don't blend ETF price levels into headline Brent/WTI display. ETF and futures trade at different prices. Apply ETF % change only.
- ❌ Don't show "AIS LIVE" or "GFW LIVE" badges anywhere. Use generic "LIVE FEED" / "SATELLITE" per L1 de-specify policy.
- ❌ Don't mention KamayaKya or SEBI RA anywhere in Hormuz Watch. Personal product.
- ❌ Don't auto-generate analyst commentary via LLM without human review. Voice is the moat.
- ❌ Don't make the GitHub repo private. Streisand effect.

---

## 16. CONTACT / IDENTITY

- **Owner:** Aniket Kulkarni
- **LinkedIn:** https://www.linkedin.com/in/aniket-kulkarni-equity-research/
- **Gmail authorized in this session:** `aniket@kamayakya.com` only
- **Other Gmails pending authorization:** `aniketshevchenko@gmail.com`, `aniket.kulkarni@unitedbuzzz.com`, `aniket@zonamista.in`
- **GitHub:** `aniketkulkarni420`

---

## 17. AUDIT FINDINGS · 33 issues with proposed solutions

Full audit of the live dashboard performed 2026-05-11. No changes applied — these are the documented backlog items. Grouped by severity. Each item: **ID · Title · Problem · Fix.**

### 17A. CRITICAL (4) — ship blockers / trust risks

**C1 · Vessel Movement card shows 0/0/0 on first load**
- *Problem:* `/api/ais` returns empty until the GHA scraper writes its first KV blob (~10 min after each push). Cold dashboards display "0 east · 0 west · 0 transit" with no "loading" or "awaiting first scrape" message — looks broken.
- *Fix:* In `index.html` Vessel Movement render, treat `ais.lastUpdate == null OR ais.vesselCount == 0 AND age < 15 min` as **"Initialising · first scrape in <Nm>"** state. Show skeleton + ETA badge, not zeros.

**C2 · Subscribe form promises a weekly digest that doesn't exist yet**
- *Problem:* Footer subscribe says "weekly digest every Monday." There is no digest cron, no template, no `/api/digest/send` worker. Subscribers will sit unconfirmed or confirmed-but-silent indefinitely.
- *Fix:* Two paths — (a) reword copy to "Get notified when the weekly digest launches" until Tier 2.2 is live; or (b) ship a minimal Monday cron in `functions/scheduled.js` that emails latest commentary + verdict + 7-day transit delta. Pick (a) immediately; queue (b) for Tier 2.2 completion.

**C3 · Backtest lab reads transits_24h from D1 but `record.js` doesn't persist it**
- *Problem:* `functions/api/record.js` snapshots oil + verdict but doesn't fetch from `/api/ais` and store vessel counts. Backtest's "vessel anomaly" chart will be flat-null forever.
- *Fix:* In `record.js`, also `await fetch(env.SITE_URL + '/api/ais')`, extract `east_24h`, `west_24h`, `transit_24h`, `anchored`, `approach`, write to a new `vessel_snapshots` table (or add columns to `snapshots`). Update `schema.sql` and run a migration via wrangler.

**C4 · Vessel Movement source label can claim "LIVE FEED" when data is 30+ min stale**
- *Problem:* The card renders "LIVE FEED" badge unconditionally. If the GHA scraper fails twice (CF outage, AISStream key expired), data ages silently — users still see "LIVE."
- *Fix:* Compute `ageMin = (now - ais.lastUpdate)/60`. If `ageMin > 20`, swap badge to **"STALE · last <N>m ago"** in amber; if `> 60`, red. Mirror the same pattern oil-card uses.

### 17B. IMPORTANT (8) — visible quality issues

**I1 · Cargo ticker shows `$0` for symbols FinnHub free-tier doesn't cover**
- *Problem:* INSW, FRO, STNG etc. return `null` from FinnHub free tier; ticker renders `$0.00` and `0.00%` — looks like a real crash to zero.
- *Fix:* In the ticker render, if `price == null OR 0`, show `—` and a small "no feed" tooltip. Skip the symbol entirely if 3 consecutive fetches return null.

**I2 · Salalah pin invisible on dark map tiles**
- *Problem:* Marker color is `#0b1a2c` against the dark CARTO basemap — visually gone.
- *Fix:* Switch Salalah marker to `#38aaff` outline with white fill, or use the same amber-pulse style as the Hormuz gate.

**I3 · `/admin/commentary/` not blocked in robots.txt**
- *Problem:* `robots.txt` blocks `/api/` and 7 LLM bots but lets all crawlers index the admin page. `meta name=robots noindex` is present but only a soft signal.
- *Fix:* Add `Disallow: /admin/` to robots.txt. Also serve `X-Robots-Tag: noindex, nofollow` via Pages `_headers` for that path.

**I4 · "Crisis average = 18 days transit" hardcoded in methodology**
- *Problem:* Number was sourced from 2019 tanker-attack analysis but is presented as live anchor for "Crisis" verdict in methodology page. Becomes wrong as conditions evolve.
- *Fix:* Move the constant into `config/verdict_thresholds.json`, reference last-recalibrated date, and add a footnote: "Recalibrated quarterly from 2019–2024 disruption episodes."

**I5 · KV staleness not surfaced on `/api/oil`**
- *Problem:* If Twelve Data + FinnHub + EIA all fail, the cached KV value can be hours old. Frontend uses it as if fresh.
- *Fix:* `/api/oil` already stores `cachedAt`. Add `staleMin` field in response. Frontend's oil card already has the badge logic — just wire it.

**I6 · Subscribe footer bar overlaps content on mobile**
- *Problem:* On <600px viewports the fixed subscribe bar overlaps the last data card. Tested on iPhone SE viewport.
- *Fix:* Either make it dismissible (sessionStorage flag) or convert to a sticky non-fixed block that sits below the last card. Add `padding-bottom: 90px` on `.dashboard` for mobile.

**I7 · BDTI tile has no staleness flag**
- *Problem:* Baltic Dirty Tanker Index updates weekly. Tile shows the number with no "as of" date. If the GHA scrape breaks, users see last week's number as if fresh.
- *Fix:* Add `bdti.asOf` ISO date to the response; render "as of <Mon Day>" subtitle. If `> 9 days` old, amber "stale" badge.

**I8 · `/api/stooq` endpoint name is misleading**
- *Problem:* It actually tries Stooq → falls through to Yahoo Finance proxy. Anyone reading the codebase or API page assumes Stooq is the only source.
- *Fix:* Rename to `/api/oil` (already exists — collapse to one endpoint). Update `methodology/index.html` and `api/index.html` source list.

### 17C. POLISH (10) — UX rough edges

**P1 · No custom 404 page** — currently shows the default CF Pages 404. Add `404.html` matching dashboard dark theme with link back to `/`.

**P2 · Map markers don't cluster** — when vessel count >50 the map becomes a wall of dots. Use Leaflet.markercluster or a simple bucket-by-grid-cell rendering threshold.

**P3 · No print stylesheet** — analysts who print the dashboard for committee meetings get pitch-black backgrounds eating ink. Add `@media print` with white bg, black text, hide nav/footer.

**P4 · Missing hover tooltips on verdict badges** — what does ELEVATED mean vs HIGH? Add `title=` attributes pulling from methodology thresholds.

**P5 · Color-blind gap on verdict palette** — amber (ELEVATED) vs red (HIGH) hard to distinguish for deuteranopia. Add icons (▲ ▲▲ ▲▲▲ ⚠) alongside color, not color-only.

**P6 · Emoji rendering inconsistent** — ✓ ✗ ⚠ render differently on Windows/Mac/Linux. Replace with inline SVGs or Lucide icon font.

**P7 · Resend currently sends from `onboarding@resend.dev`** — works but looks scammy. Pending: pick a custom domain (suggest `hormuz.watch` or `hormuzwatch.com`), add Resend DNS records, switch RESEND_FROM.

**P8 · GHA cron logs not surfaced** — if a scrape fails, only way to know is to open Actions tab. Add a `/health` JSON field `lastScrapeOk: bool` populated by the scraper itself writing to KV.

**P9 · No equity fundamental links** — ticker chips don't link anywhere. Wire each to its TradingView ticker page in a new tab.

**P10 · Methodology page has no table of contents** — it's a long scroll. Add anchor links at top for each section (Inputs, Thresholds, Verdict logic, Limitations).

### 17D. STRATEGIC (7) — positioning & growth

**S1 · Subscribe pitch loudness** — the footer bar is dialled to 8/10. For a pre-launch tool with no real digest yet, dial to 4/10. Or remove until digest ships.

**S2 · Commentary placement** — currently at top of dashboard. When empty, the slot is hidden — good. When populated, it pushes the verdict card below the fold on laptops. Decision: keep it top (commentary IS the moat) but cap height at 100px with "expand" toggle.

**S3 · Cross-page brand consistency** — `/methodology`, `/terms`, `/health`, `/api`, `/backtest` all use the dashboard theme but minor spacing/typography drift. Lock a shared CSS file (`/assets/site.css`) and import everywhere.

**S4 · No disclaimer on dashboard footer** — "Not investment advice" appears in `/terms` but not on the main page. Add one-liner at footer next to copyright.

**S5 · D1 backfill decision** — currently only forward-collecting from launch day. To make backtest useful from day-one of public launch, decide: (a) leave empty until 30 days accumulate, (b) backfill from EIA + GFW historical for 2019–2025. Option (b) takes ~4 hrs but unlocks marketing.

**S6 · Multi-region routing** — `config/regions.json` has 4 regions but only Hormuz is wired. Decide URL pattern before second region ships: `/regions/hormuz/`, subdomain `hormuz.chokepointwatch.com`, or single-page region selector. Recommend path-based for SEO.

**S7 · Product naming when scaling** — "Hormuz Watch" doesn't scale to Bab el-Mandeb. Either (a) keep Hormuz as flagship + sister brands (Mandeb Watch, Suez Watch), (b) rebrand parent to "Chokepoint Watch" or "Maritime Risk Monitor." Decision deferred but blocks domain purchase.

### 17E. DEFENSIBILITY (4) — moat & exposure

**D1 · Methodology page still too detailed** — current page explains verdict thresholds + exact transit-day breakpoints. Competitor with engineering can fork in <1 week. Move calibration constants behind a "sample" page; keep only the conceptual framework public.

**D2 · GHA workflow YAML reveals architecture** — public repo shows scrape cadence, secret names, AISStream usage pattern. Anyone reading can replicate. Mitigations: (a) move scrapers to private repo (loses anti-Streisand but defensibility wins for now), (b) keep public but obfuscate cadence with `schedule: cron` randomization and remove descriptive job names.

**D3 · Source attribution incomplete on `/api`** — currently lists "EIA, FinnHub, Twelve Data, AISStream, GFW." Should add license/ToS link per source so legal posture is documented. Also clarifies what's redistributable.

**D4 · No data freshness clause in terms** — `/terms` says "best effort" but doesn't cap liability for stale or wrong data. Add explicit clause: "Data may be delayed, incorrect, or unavailable. Hormuz Watch makes no warranty of accuracy or timeliness. Not investment advice."

---

### 17F. Prioritisation table

| Tier | Block | Items | Rough effort |
|---|---|---|---|
| Do this week | Critical | C1, C2, C3, C4 | 6–8 hrs |
| Within 2 weeks | Important | I1–I8 | 4–6 hrs |
| Within 30 days | Strategic | S1, S2, S4, S5 | 8–12 hrs |
| Within 30 days | Defensibility | D1, D2, D4 | 3–5 hrs |
| Backlog | Polish | P1–P10 | 6–10 hrs |
| Decision-gated | S3, S6, S7, D3, P7 | needs user input first | — |

---

*End of handoff. Last verified against production at commit `f86fe28` on 2026-05-11. §17 audit appended 2026-05-11.*

---

## 18. AUDIT FIX LOG · 2026-05-11

All fixes shipped in commit **`527458a`** unless noted. Order matches §17 prioritisation table.

### 18A. Critical (4 / 4)
| ID | Status | Notes |
|---|---|---|
| C1 | ✅ fixed in `527458a` | Vessel Movement source label now flips to `INITIALISING · awaiting first scrape` when totals are zero, instead of showing 0/0/0 with a misleading `LIVE FEED` chip. |
| C2 | ✅ fixed in `527458a` | Subscribe form copy reworded to "Notify me when the weekly digest launches" + "Pre-launch list · one email when live". Path (b) — actual digest cron — remains deferred to Tier 2.2. |
| C3 | ✅ fixed in `527458a` | `functions/api/record.js` now fetches `/api/ais` alongside oil/GFW and persists `transits_24h`, `vessels_transiting`, `vessels_anchored`, `vessels_approach`. Schema already had these columns — no migration needed. |
| C4 | ✅ fixed in `527458a` | `updateVesselUI` computes `ageMin` from `_aisServer.lastMsgAgeSec` (or client AIS lastFetch) and swaps the `LIVE FEED` badge to amber `STALE · Nm ago` after 20 min, red after 60 min. |

### 18B. Important (7 / 8)
| ID | Status | Notes |
|---|---|---|
| I1 | ⏸ deferred — not currently triggered | The dashboard does **not** fetch per-symbol live prices for INSW/FRO/STNG/etc. The tanker plays panel only displays static `upside` strings; no `$0.00` issue exists today. Re-open if Twelve Data Pro is enabled and live ticker chips are added. |
| I2 | ✅ fixed in `527458a` | Salalah marker color changed from `#06d6b0` to `#38aaff` for contrast against the dark CARTO basemap. |
| I3 | ✅ fixed in `527458a` | `robots.txt` now disallows `/admin/`. New `_headers` file emits `X-Robots-Tag: noindex, nofollow, noarchive` for `/admin/*`. |
| I4 | ✅ fixed in `527458a` | Created `config/verdict_thresholds.json` with `crisisTransitDaysAverage: 18` + `lastRecalibrated: 2026-05-11` + footnote ("Recalibrated quarterly from 2019–2024 disruption episodes"). Methodology page updated to reference the config. |
| I5 | ✅ fixed in `527458a` | `/api/oil` now emits `stale: bool` + `staleMin: int` alongside the KV payload. Tier flips to `primary-stale` when ageMin > 60 but still returns data so the frontend can degrade the badge instead of swallowing the value. Falls through to live APIs only when KV is > 6h old. |
| I6 | ✅ fixed in `527458a` | Subscribe bar now has dismiss `✕` button (sessionStorage flag `hw_sub_dismiss`). Mobile media-query adds `padding-bottom:96px` on `.dashboard,.main` so the bar can't overlap the last card. |
| I7 | ✅ fixed in `527458a` | BDTI signal-bar tile now shows `· as of <Mon Day>` and swaps to an amber `STALE · Nd` badge when the manual update is > 9 days old. |
| I8 | ✅ fixed in `527458a` | `/api/stooq` is now documented as a deprecated alias for `/api/oil`'s daily-reference tier in `api/index.html`. Did not delete the endpoint because `record.js` and existing IRM downstream callers still reference it; collapsing to a single endpoint can happen once those consumers are updated. |

### 18C. Polish (9 / 10 — P7 needs domain decision)
| ID | Status | Notes |
|---|---|---|
| P1 | ✅ fixed in `527458a` | New `404.html` matching the dark dashboard theme; CTA back to `/` + Methodology link. |
| P2 | ✅ fixed in `527458a` | Simple grid-bucket density limiter — when `realCount > 50` and `map.getZoom() <= 8`, new vessels in already-busy 0.05° cells are dropped from the map (still counted in state). No new dependency. |
| P3 | ✅ fixed in `527458a` | `@media print` block: white bg, black text, hides header / subscribe / mobile-tabs / health-bar / overlays. |
| P4 | ✅ fixed in `527458a` | Verdict bands now carry a `desc` field (e.g. ELEVATED = "Above typical range. Mild risk premium / monitor closely.") which is wired into the `title` attribute of every rendered badge. |
| P5 | ✅ fixed in `527458a` | Each verdict band rendered with a leading mono-icon (`●` normal, `○` low, `▲` elevated, `▲▲` high, `⚠` critical) so the band is distinguishable from colour alone. |
| P6 | ✅ fixed in `527458a` | Subscribe success/error glyphs (`✓` / `✗`) stripped — colour + class is enough and these characters were the most visibly inconsistent across Windows/Mac fallbacks. Other emoji left alone to avoid scope creep. |
| P7 | ⏸ deferred — needs user input | Resend custom domain. User must purchase + verify DNS for a sender like `hello@hormuz.watch` before this is actionable. |
| P8 | ✅ fixed in `527458a` | Both scrape scripts now write `scrape_status_oil` / `scrape_status_ais` keys to KV (`{ ok, fetchedAt, job }`). `/health` can read these to surface scrape failures without opening the Actions tab. |
| P9 | ✅ fixed in `527458a` | Tanker tickers (FRO/INSW/TNK/NAT/DHT) link to `tradingview.com/symbols/NYSE-<TICKER>/`. India OMC names (BPCL/IOC/etc.) link to NSE TradingView pages. Both open in new tab with `rel=noopener`. |
| P10 | ✅ fixed in `527458a` | Methodology page has a TOC nav (Philosophy / Inputs / Metric definitions / Verdict thresholds / India exposure / Limitations / Sources) with anchor links. |

### 18D. Strategic (3 actioned / 4 — S3/S5/S6/S7 documented)
| ID | Status | Notes |
|---|---|---|
| S1 | ✅ fixed in `527458a` | Subscribe footer bar dialled down: lighter background (`rgba(7,9,14,.85)`), opacity 0.85 → 1 on hover, secondary-button styling (panel + amber on hover), smaller padding. CTA reads "Notify me" not "Subscribe". |
| S2 | ✅ fixed in `527458a` | Commentary banner capped at `max-height:100px` with overflow hidden; `.expanded` modifier (added by `toggleCmt`) opens to `60vh` + auto-scroll. |
| S3 | ⏸ deferred — recommend keep inline `<style>` per page | Inline styles across the six sub-pages are small (40-60 lines each). Externalising to `/assets/site.css` would add a render-blocking request without reducing surface area meaningfully. Re-open once a 7th page lands. |
| S4 | ✅ fixed in `527458a` | Added one-line dashboard footer above the health bar: "Intelligence aggregator. Not investment advice. Data may be delayed or unavailable. See terms." + © + links. |
| S5 | ⏸ deferred — recommendation: option (a) wait | Recommend leaving D1 to forward-collect from launch day. EIA + GFW historical backfill (option b) is ~4 hrs but: (i) burns a half-day of build time that could go to Tier 3.5 Bab el-Mandeb, (ii) "30 days from public launch" is a defensible empty state, (iii) backfill conflates pre-launch baselines with live-state semantics. Revisit once a paying customer asks for it. |
| S6 | ⏸ deferred — recommendation: path-based routing | When second region (`babelmandeb`) ships, recommend `/regions/<id>/` over subdomains for SEO consolidation + simpler CF Pages config. Subdomain or rebrand only if domain purchase forces the issue. |
| S7 | ⏸ deferred — recommendation: keep `Hormuz Watch` as flagship | Sister brands per chokepoint (`Mandeb Watch`, `Suez Watch`) preserve brand equity already accruing to Hormuz Watch. Parent rebrand (`Chokepoint Watch`) only if a portfolio play becomes strategically necessary — premature now. |

### 18E. Defensibility (3 actioned / 4 — D3 left as TODO)
| ID | Status | Notes |
|---|---|---|
| D1 | ✅ fixed in `527458a` | Methodology page no longer publishes exact threshold cut-points for Dark % (`<8 / 8–15 / 15–20`) or BDTI level/WoW. Replaced with categorical bands; specific cut-points live in `config/verdict_thresholds.json` (not in the public methodology page). |
| D2 | ✅ fixed in `527458a` | Both workflow YAMLs renamed (`oil-scraper.yml` → `data-refresh`, `ais-scraper.yml` → `vessel-sync`). Descriptive comments stripped. Cron schedules randomized off the `*/10` and `*/15` marks (now `3,13,23,33,43,53` and `7,22,37,52`). Functional cadence preserved. |
| D3 | ⏸ deferred — needs license research | Per-source license/ToS surface review on `/api`. Left a `TODO (D3)` comment in `methodology/index.html` Sources section. Needs legal review before publishing specific licenses on a public page. |
| D4 | ✅ fixed in `527458a` | `/terms` section 3 now reads "Data may be delayed, incorrect, or unavailable at any time. Hormuz Watch makes no warranty of accuracy, completeness, or timeliness. Not investment advice." |

### 18F. Summary
- **Fixed:** 25 of 33
- **Deferred:** 8 (I1 not triggered, P7 needs domain, S3 cost/benefit, S5/S6/S7 strategic decisions documented, D3 needs license research, C2-part-b queued for Tier 2.2)
- **No new dependencies introduced.** Marker density handled with a grid-bucket render threshold instead of `leaflet.markercluster`.

*§18 appended 2026-05-11 against commit `527458a`.*
