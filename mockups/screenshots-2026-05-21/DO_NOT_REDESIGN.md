# DO NOT REDESIGN — patterns that must survive

These are not preferences. They are compliance-, brand-, or research-locked decisions. Any redesign proposal that violates them gets rejected.

## 1. SEBI compliance pattern (legal hard-stop)

### `.disclaimer` block must appear above any analytical card
> *"This is not investment advice. Hormuz Watch is an intelligence aggregator..."*

Don't move it to a footer or modal. Don't reduce its visual weight. Don't remove the SEBI registration number `INH000009843`. This is a Research Analyst regulation in India and removing/diminishing it = a regulatory violation.

### 3-layer treatment on the India panel
Every interpretation-style card must show:
- **Data** (blue tag) — what the number is
- **Interpretation** (amber tag) — what it suggests
- **Not Investment Advice** (muted tag) — explicit disclaimer

You may redesign the visual treatment of the tags themselves. You may NOT collapse the three layers into one row or move the disclaimer to a tooltip.

### No recommendation grammar
The copy never says:
- "Buy", "Sell", "Hold"
- "We recommend"
- "You should consider"
- "Target price"
- "Position should be"

Redesign the layout all you want; do not introduce affordances (CTA buttons, action chips) that imply transactional advice.

## 2. Signature features — brand identity

### Cargo ticker (`$X transited today`)
The live-counting dollar figure at the top is the product's signature. It says "this is happening live, right now." Don't:
- Replace with a static number
- Move below the fold
- Reduce font size below 22px on desktop
- Remove the count-up animation

You MAY redesign the visual chrome (currently mono 24-28px amber). You may NOT remove the live ticker behavior.

### Map as canonical geographic reference
The Strait of Hormuz is a geographic story. The map is the anchor. Don't:
- Replace the map with a chart-only view
- Demote the map to a sub-card
- Remove the vessel markers

You MAY swap tile providers, redesign the markers, change the map control chrome. You MAY have the map collapse on mobile (it currently does — `display:none` until Map tab tap).

### Brent 4-week trend (just shipped — Option A)
Smooth line + filled area + collision-safe min/max/now markers. Just shipped after a 6-pass audit, hand-verified pixel-perfect. Don't:
- Replace with bars or candles in this iteration
- Remove the peak/trough/now labels
- Drop the weekly grid lines

You MAY adjust colors, label sizes (currently 9-10px), or extend the time range. The structural pattern stays.

## 3. Verdict taxonomy

The four-level verdict is research-locked:
- **NORMAL** (green) — score < 1.5
- **ELEVATED** (amber) — 1.5 ≤ score < 2.5
- **HIGH** (red) — 2.5 ≤ score < 3.5
- **CRITICAL** (red, pulsing) — score ≥ 3.5

Don't:
- Add a fifth level
- Rename the levels
- Change the score thresholds without research-side approval
- Remove the color mapping

You MAY redesign how the verdict is presented (card layout, badge shape, copy). You MAY add visual emphasis at CRITICAL (pulse, full-bleed banner). The taxonomy itself stays.

## 4. Data integrity patterns

### Tabular numerals on every number
`font-variant-numeric: tabular-nums` is on every numeric tile. Designer must keep this — variable-width digits in price displays are a usability violation for the trader audience.

### "Last publish" labeling on slow-cadence feeds
BDTI, EIA daily Brent, OFAC actions all show explicit publish dates like *"last publish Tue 19 May"*. This prevents users from reading staleness as our staleness. Don't:
- Replace dates with relative time only ("2 days ago")
- Hide the publish date inside a tooltip
- Remove the date when it's recent

### Stale / dormant indicators
When a feed is dead (AIS currently is), the dashboard renders honest states:
- `$—` (not a fake number)
- "AIS dormant" (not a hidden zero)
- "STALE" tag (not the prior cached number passing as live)

Designer must preserve this honesty pattern. Never invent a fallback that pretends data is fresh.

## 5. Information architecture survivors

### Right panel = analytical depth
The 20+ cards in the right panel are intentional. This is the "drill down" surface for persona 1 (commodity desk). Don't reduce it to 5 cards. You may:
- Reorder
- Group with section dividers
- Add a sticky sub-nav
- Lazy-render off-screen cards

Don't:
- Hide cards behind tabs that fragment the analytical flow
- Move cards into modals
- Replace cards with a single "data table"

### Mobile bottom-tab nav (Map / Ships / Intel)
Just shipped + audit-clean. Don't replace with a hamburger or a horizontal scroll-strip. You may redesign the tab visual treatment.

## 6. Technical constraints

### Single `index.html`, no SPA framework
Hot-load performance + deployability + auditability. Don't propose React/Vue/Svelte/Next/etc. The redesign must compile to vanilla HTML + CSS + JS (with inline `<script>` blocks).

### Cloudflare Pages deployment
Static site + Pages Functions only. No Node server, no edge SSR framework. Pages Functions are fine for new endpoints (we have ~25 already).

### Google Fonts only
Manrope + JetBrains Mono. No self-hosted fonts, no paid foundries, no variable font experiments beyond what Google Fonts hosts.

## 7. URL structure

Routes that must survive a redesign:
- `/` — dashboard
- `/admin/brief/` — admin form (internal)
- `/admin/bdti/` — admin form (internal)
- `/api/*` — Pages Functions

Don't introduce client-side routing. Don't move the dashboard to a sub-path. The root URL is the dashboard, period.

## 8. Things that are explicitly OPEN for redesign

To balance the above: these are fair game.

- All card chrome (padding, borders, headers)
- Color palette (subject to keeping the 4 brand colors recognizable)
- Typography scale (subject to mono+sans split)
- Spacing system (formalize the ad-hoc into a proper scale)
- Card hierarchy + grouping
- Section headers / dividers
- Loading skeletons (we don't have any)
- Empty states (we have minimal handling)
- Error states (we have minimal handling)
- Mobile layout above 480px (currently a vertical stack)
- Animation system (currently mostly absent)
- Onboarding flow (just shipped, can iterate)
- Help/methodology pages (`/methodology`, `/terms` — open canvas)
- Footer / legal block (must contain SEBI reg, otherwise design as you like)
