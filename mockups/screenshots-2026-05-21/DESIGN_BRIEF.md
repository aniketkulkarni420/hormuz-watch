# Hormuz Watch — Design Brief

## 1. What this product IS (and isn't)

**IS:** A real-time intelligence dashboard for the Strait of Hormuz — the chokepoint through which ~21M barrels/day of oil + most LNG transit. When tensions spike (Iran sanctions, missile strikes, vessel seizures), this dashboard lets sophisticated observers read the actual signal vs. the noise.

**ISN'T:**
- ❌ A trading platform (no buy/sell buttons — SEBI compliance hard-stop)
- ❌ A retail consumer app (this is not Robinhood)
- ❌ A news aggregator (we have a news tile but the dashboard is data-first)
- ❌ A geopolitical opinion site (we cite numbers, never recommend)

## 2. Who uses it

Three primary personas, ranked by importance:

| # | Persona | Frequency | Job-to-be-done |
|---|---|---|---|
| 1 | **Commodity desk analyst** (oil major, trading house, hedge fund) | Daily, multiple visits | "Is something happening RIGHT NOW that I need to react to in the next 30 min?" |
| 2 | **Geopolitical / energy researcher** (think tank, consultancy, sovereign analyst) | Weekly | "Track developing situation over weeks; cite metrics in research notes" |
| 3 | **Sophisticated retail / family-office investor** | Episodic (when news breaks) | "Did the headline I just saw actually matter? Quick reality check." |

**Designer takeaway:** persona 1 is the sharp-pencil audience. They read densely, value tabular numerals, hate decorative chrome, and will leave instantly if the dashboard feels like a "fintech app." Design for them; the others get pulled along for free.

## 3. Primary user task (the 5-second test)

> A trader opens the page. In 5 seconds, can they answer: **"Is the Hormuz situation NORMAL / ELEVATED / HIGH / CRITICAL right now, and what specifically changed in the last 24h to move it?"**

If the redesign passes this test better than the current dashboard, it wins.

## 4. Voice & tone

- **Data-first** — every claim cites a number with a date
- **No hedging language** — "may", "could", "potentially" are banned for verdict copy
- **No recommendation grammar** — "you should...", "consider...", "we suggest..." are SEBI-prohibited
- **Punchy** — one-line interpretations, never paragraphs
- **Honest about uncertainty** — explicit "STALE", "—", "feed dormant" when we don't know

The voice is closer to a Reuters wire than a fintech app. Closer to a Bloomberg desk note than a Twitter thread.

## 5. Visual identity (current)

- **Dark theme only** — desks run dark all day, eyes thank us
- **Monospace numerals** (JetBrains Mono) — readability + alignment
- **Sans for prose** (Manrope)
- **Accent: amber** (#f09014) — primary brand color, used for verdict signal & cargo ticker
- **Green / Red / Blue** = green (calm/healthy), red (high/critical), blue (informational/proxy data)
- **Subtle gradients only** — never neon, never glassmorphism, never skeuomorphism

## 6. Information hierarchy (current — designer may challenge)

Reading order top-to-bottom:
1. **Cargo ticker** (signature feature) — $X transited today, scrolls live
2. **Signal bar** (top 5 metrics at a glance: Brent, BDTI, Transits, Dark, India)
3. **Map** (geographic context, vessel positions when AIS alive)
4. **Verdict block** (NORMAL/ELEVATED/HIGH/CRITICAL with 13 contributing signals)
5. **Daily brief** (editorial 2-3 sentences from analyst, optional)
6. **Intel panel** (right side on desktop, full-page Intel tab on mobile) — 20+ cards of supporting analysis

Tiles in the Intel panel, current rough priority order:
1. Brent + 4-week trend
2. WTI + spread
3. Vessel movement (today vs baseline)
4. BDTI freight rates
5. OFAC enforcement timeline
6. India exposure panel (3-layer compliance treatment)
7. Cross-signal verdict list
8. Historical comparison
9. Currency (IRR official vs black-market)
10. News
11. Weather / aircraft / seismic ("Conditions")
12. UNCTAD scenarios
13. LNG, fertilizer, CAPE-reroute supporting data

**Designer challenge:** is this order right? Should some be merged? Removed? Promoted?

## 7. What's working well (preserve)

Listed in `DO_NOT_REDESIGN.md`. Headline:
- Cargo ticker concept ($X transited live)
- Brent 4-week trend chart (Option A, just shipped)
- Verdict 4-level taxonomy
- 3-layer India panel (compliance treatment)
- Map as canonical geographic reference
- "Last publish" date labels on slow-cadence feeds (BDTI, EIA daily)

## 8. What's weak (fix)

Detailed in `KNOWN_ISSUES.md`. Headline:
- Too many tiles in Intel panel — fatigue
- Verdict feels disconnected from individual signals
- Mobile is functional but cramped
- No clear narrative arc from "open page" to "understand situation"
- Conditions block (weather + aircraft + seismic) reads as random
- Cross-signal verdict list isn't visually distinct from regular tiles

## 9. Curated 25 — drag these first into Claude Design

If you only look at 25 PNGs, look at these:

### Layout / hierarchy (6)
- `full/05-desktop-full.png`
- `full/01-iphone-se-full.png`
- `full/03-ipad-full.png`
- `states/05-desktop-sigtooltip-2.png` (hover state)
- `states/01-iphone-se-tab-intel.png` (mobile Intel)
- `states/01-iphone-se-signalbar-scrolled.png` (mobile signal swipe)

### Signature features (4)
- `cards/05-desktop-cargo-ticker.png`
- `cards/05-desktop-brent-tile.png` (new Option A trend)
- `cards/05-desktop-verdict-block.png`
- `cards/05-desktop-india-panel.png` (3-layer compliance)

### Components to redesign first (8)
- `cards/05-desktop-conditions.png`
- `cards/05-desktop-xv-list.png` (cross-signal)
- `cards/05-desktop-historical.png`
- `cards/05-desktop-unctad.png`
- `cards/05-desktop-cape.png`
- `cards/05-desktop-fertilizer.png`
- `cards/05-desktop-lng.png`
- `cards/05-desktop-currency-tile.png`

### Mobile-specific (5)
- `cards/01-iphone-se-signal-bar.png`
- `cards/01-iphone-se-mobile-tabs.png`
- `cards/01-iphone-se-cargo-ticker.png`
- `states/01-iphone-se-intel-scroll-3.png` (middle of Intel scroll)
- `cards/01-iphone-se-footer-discl.png`

### States (2)
- `states/05-desktop-cargo-tooltip.png`
- `states/04-laptop-sigtooltip-1.png`

## 10. Constraints (hard, non-negotiable)

| Constraint | Why | What it forbids |
|---|---|---|
| SEBI RA reg INH000009843 must appear in footer | Legal — Research Analyst regulations | Removing the disclaimer block |
| 3-layer compliance treatment (Data / Interpretation / Not Advice) on the India panel | Same regulation | Merging the 3 layers into single rows |
| No recommendation grammar in copy | Same | "Buy", "Sell", "Hold", "We recommend" |
| Single `index.html` file, no SPA framework | Hot-load performance + deployability | React/Vue/Svelte/Next/Astro/etc. |
| Cloudflare Pages deployment | Existing infra | Server-side rendering, Node runtimes |
| Google Fonts only (Manrope + JetBrains Mono) | Reliability + zero-cost CDN | Self-hosted fonts, paid foundries |
| Mobile must work in <768px viewport | iPhone SE still in use | Layouts that break below 375px |
| Map must remain (Leaflet) | Geographic anchor of the product | Replacing map with a chart-only view |
| All data from public APIs | Cost + transparency | Showing data we'd have to pay to display |
| Tabular numerals on all numbers | Trader readability | Variable-width digits in price tiles |

## 11. Success criteria

The redesign succeeds if:

1. **5-second test passes** (see §3) — verified with 5 unsuspecting persona-1 users
2. **Mobile audit clean** — 0 issues per viewport via the existing headless audit script
3. **No CSS regression on desktop** — existing desktop verify still passes 10/10
4. **No new JS errors** on page load at any viewport
5. **Cold load time ≤ 1.5s** on a 4G connection (current ~1.2s)
6. **Lighthouse score ≥ 85 on each** of Performance / Accessibility / Best Practices

## 12. Out of scope for this redesign

- Don't redesign the data pipeline or API endpoints
- Don't change which metrics are tracked (that's a separate research-led decision)
- Don't redesign the admin pages (/admin/brief, /admin/bdti) — internal-only
- Don't redesign the onboarding overlay (just shipped, separate iteration)
- Don't change the URL structure
- Don't redesign the map markers (Leaflet + our marker icons are deliberate)

## 13. Animation / interaction spec (designer to define)

We have no formal animation spec today. The dashboard uses these implicitly:
- Cargo ticker count-up: 1s per tick
- Hover→tooltip on signal tiles: 180ms ease
- Tab switch: instant (no transition)
- Verdict color change: instant
- Map zoom: Leaflet default
- Brent trend re-render: instant (full redraw on data refresh)

**Designer should explicitly specify:**
- Loading skeletons (currently we just show "—" / "loading…")
- State transitions (calm → elevated → high — should this animate?)
- Reduced-motion fallbacks (Apple/Android accessibility)
- Hover/tap feedback affordance
