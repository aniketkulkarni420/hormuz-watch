# Edge cases — states the redesign must handle

These are the moments when a dashboard looks brilliant or breaks. List is exhaustive; designer should explicitly mock the starred ones (★).

## Data-state cases

### ★ Cold load (first 1.5 seconds)
- All KV-backed endpoints fetching
- `_brentPrice` defaults to 80 (initial) then overwrites
- Brent trend SVG shows "loading…"
- Verdict shows "computing"
- Cargo ticker shows $0 then counts up
- Mobile signal bar tiles show "—"

**Design challenge:** make this 1.5-second window feel intentional, not broken.

### ★ Feed dormant (single source down)
- AIS feed dead (current state — multi-week outage)
- Snapshot shows `ais_health.reason: silent_no_messages, actionable: true`
- Vessel-movement card switches to "WEB FEED · 4h" badge
- Direction split bar replaced with per-port bars

**Design challenge:** make degraded mode obviously honest without alarming the user.

### ★ Multiple feeds down
- Cargo ticker keeps running (uses last-known Brent × static throughput)
- Headline price tiles show "$—"
- Verdict computes against partial inputs
- Mobile shows yellow "STALE" tag on EIA pulse

**Design challenge:** clear visual hierarchy of "what's still trustworthy?"

### ★ Crisis state — verdict CRITICAL
- Background tint shifts subtly red
- Verdict block pulses (subtle, not seizure-inducing)
- Brief should be displayed prominently (analyst's interpretation)
- Cross-signal verdict list bumps to top

**Design challenge:** convey urgency without becoming a panic button. No alarms, no auto-refresh storms.

### ★ Stale brief (>36h old)
- Block displays with red/amber border
- Tag reads "STALE — update needed"
- Author + timestamp shown

**Design challenge:** clear visual that this is the analyst's voice and it needs refreshing.

### ★ Zero events (calm period)
- OFAC actions: 0 in 30d
- News: 0 articles matching keywords in 24h
- Earthquakes: 0 over magnitude X

**Design challenge:** zero should feel like a positive signal, not broken data. Different from "—" (unavailable).

### Missing optional data
- WTI live but Brent stale (rare but possible)
- BDTI 2 days old (normal Mon-Tue when Baltic publishes Fri)
- Currency black-market unavailable, only official rate

**Design challenge:** partial data → still useful, just labeled.

## Layout cases

### ★ Very long brief (~800 chars)
- Brief is allowed 20-800 chars
- Designer should mock both ends — 50-char brief and 800-char brief
- Text wraps inside the card; card grows vertically

### ★ Very long news headline
- News tile shows top N headlines
- Some headlines wrap 3+ lines
- Some Arabic / Hebrew text right-to-left

### Long vessel names
- Vessel log on left panel shows ship names
- Some are >30 chars ("PALAUNAN PERIPLEAR PARAMOUNT")
- Should truncate with `text-overflow: ellipsis`

### Very small numbers ($0.94 diesel) vs very large ($4537 gold)
- All show in the same OPA demo response
- Different magnitudes need consistent visual weight

### Negative numbers in price changes
- "▼ -3.2%" — minus sign + arrow combo
- Should never read as "-▼ -3.2%" (double negative)

## Viewport cases

### ★ iPhone SE (375px) — smallest mainstream
- Already audited clean; designer should not regress
- Signal bar = horizontal scroll-snap
- Right panel = full-width inside Intel tab

### iPhone Pro Max (430px)
- Marginal cases — 5 tiles at 140px each = 700px → scrolls
- Should look natural

### iPad portrait (768px)
- Currently treated as mobile (below the 768 breakpoint by ≤ 1px)
- Designer may want to introduce a distinct tablet layout

### Desktop (1440px) — canonical
- This is what the designer should optimize first
- Three-column: left vessel log | map | right intel
- Right panel 360px wide (post bundle A)

### Ultrawide (1920px+)
- Currently the right panel stays 360px
- Lots of empty space on either side of the map
- Opportunity for additional cards or larger map

### Print / PDF
- Currently broken (dark theme prints badly)
- Designer could define a print stylesheet

## Interaction cases

### Tab switch flash (mobile)
- Active rpanel becomes `display:flex`
- Currently no transition — content jumps
- Should consider a 200ms cross-fade

### Tooltip open / close
- Hover-in: 180ms fade
- Hover-out: instant (could feel jarring)
- Touch tap on mobile: opens bottom sheet

### Long-press on a tile (mobile)
- Currently no behavior
- Opportunity for a "more details" reveal

### Pinch-zoom on the map
- Leaflet handles this
- Designer should not break it

### Back button after opening tooltip
- Currently no history integration — back button leaves the site
- Could push tooltip state to history if redesigned

### Resize from desktop → mobile
- Currently the page reloads its layout via media queries
- Tab state resets to "map"
- Some tiles may flash empty

## Browser cases

### Safari iOS
- Primary mobile target
- `mask-image` works
- `:focus-visible` works
- Bottom-tab nav must clear safe-area-inset

### Chrome Android
- Secondary mobile target
- Generally fine
- Watch tap-target minimums (32px floor)

### Firefox Desktop
- Lower priority but used by some analysts
- CSS grid + flexbox fine
- Custom scrollbar styling doesn't apply

### Old browsers
- Site shows degraded if JS disabled (text-only)
- Acceptable

## Time / date cases

### Day rollover during use
- Cargo ticker resets at UTC midnight
- "Yesterday" calculations shift
- BDTI date label may flip

### Weekend (no Baltic publish)
- BDTI tag shows "last publish Fri"
- Should NOT show "STALE" on weekends

### Daylight saving transitions
- Dashboard uses UTC throughout
- No DST issues

## Compliance cases

### India audience visits
- Currently no geo-blocking
- The 3-layer India panel is the compliance bridge
- Disclaimer + SEBI reg always visible

### EU audience visits
- No cookie banner currently
- We don't set cookies (one localStorage flag for Intel tab discovered)
- May need disclosure if redesign adds analytics

### Screen reader user
- Currently undefined experience
- All numeric tiles should have `aria-label`s with full context
- Verdict change should announce via `aria-live`
