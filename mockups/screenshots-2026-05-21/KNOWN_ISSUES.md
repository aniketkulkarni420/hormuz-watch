# Known issues — explicit punch list for the designer

These are weaknesses the redesign should explicitly solve. Ranked by user impact.

## P0 — hierarchy & narrative

### 1. No clear 5-second story
The dashboard answers "what is happening?" through ~25 tiles. Persona 1 (trader) needs the answer in 5 seconds; today they need ~30. The verdict block exists but doesn't dominate. The cargo ticker is signature but disconnected from verdict.

**Fix direction:** create a true above-the-fold "hero verdict" that visually dominates and links to the supporting signals. Treat the right panel as the "details" surface, not as a parallel-priority panel.

### 2. Right panel = scroll fatigue
20+ cards stacked vertically. No grouping, no sticky sub-nav, no progressive disclosure beyond manual scrolling. Users either skim past the bottom half or never reach it.

**Fix direction:** group related cards into 4-5 sections with sticky sub-headers (Markets · Geopolitics · Macro · India · Reference). Optionally lazy-render or collapse below-the-fold sections.

### 3. Verdict tile feels disconnected from individual signals
The verdict block shows a level (e.g., "ELEVATED · score 0.99") and a list of stage-1 inputs. But there's no visual line connecting the verdict to the individual signal cards below. User can't see "this card is what's pushing the verdict to ELEVATED."

**Fix direction:** consider a sparkline of the score over time, or highlight which cards contributed positively/negatively to the current verdict (color-coded ring around card?).

## P1 — interactions

### 4. Mobile signal bar swipe isn't discoverable enough
Just shipped a right-edge fade-mask hint, but it's subtle. Users who don't notice the mask may think the dashboard "only has 2 signals" (BDTI + Brent visible at 375px without scrolling).

**Fix direction:** consider a one-time animated nudge (3-second swipe arrow on first load), or visible "1 of 5" dots above/below the strip.

### 5. Verdict transitions are instant
When the verdict changes (e.g., NORMAL → ELEVATED), the change happens silently. No animation, no sound, no notification.

**Fix direction:** define a verdict-change transition. Subtle pulse, color cross-fade. NEVER auto-play sound. Respect `prefers-reduced-motion`.

### 6. Tooltip hover-only on desktop, awkward on touch
The `.sig-tooltip` opens on hover (desktop) and tap (mobile). On mobile it appears as a fixed bottom-sheet which is good. On desktop the tooltip can extend past viewport edges and gets clipped.

**Fix direction:** redesign the desktop signal-tile tooltip as either an in-place expansion (no positioning math) or a properly anchored popover with collision detection.

## P2 — visual polish

### 7. Conditions block (weather + aircraft + seismic) reads as random
Three unrelated signals stacked together because they're all "background conditions." User can't tell why they're grouped or what to do with them collectively.

**Fix direction:** either give the group a clearer collective story ("Operating environment: calm"), split into 3 separate cards, or merge into the verdict as supporting context.

### 8. Cross-signal verdict list isn't visually distinct from regular tiles
The "Cross-signal" tile (`#xvList`) is the only place that shows multi-factor analysis (flow / dark / rate / divergence). It's visually identical to single-metric tiles, which mis-signals its analytical weight.

**Fix direction:** give it a distinct visual treatment (wider, taller, accent border, or "synthesis" badge).

### 9. Spacing scale is ad-hoc
14+ different padding/margin values across the codebase. Causes visual inconsistency that compounds across cards.

**Fix direction:** consolidate to a real 4px or 8px scale. Already noted in `DESIGN_TOKENS.md`.

### 10. Font-size cliff at 10px
Mobile floor is 10px; many desktop sites use 11-12px. Users with reduced vision still find 10px hard to read. The information density argument is real but worth challenging.

**Fix direction:** consider a 11px floor with selective 10px for labels only; or add a "comfortable / dense" view toggle (desktop only).

## P3 — content / copy gaps

### 11. No empty states beyond "—"
When a feed is dormant, we show "—". When the brief is empty, the block is hidden. When OFAC has zero actions in 30 days, the tile shows "0" with no context. Empty/zero needs better treatment.

**Fix direction:** define empty states with explanatory copy. "No OFAC enforcement actions in the last 30 days — calm enforcement environment" reads very differently from "0".

### 12. Loading state is just "—" or "loading…"
We don't show skeletons or progressive content. On first load (cold cache), tiles flash empty before populating.

**Fix direction:** define skeleton states for each card archetype. Consider staggering reveal so the whole panel doesn't flash at once.

### 13. Error state is largely undefined
If `/api/oil` returns 500, the tile shows "$—". User can't tell if data is missing because we don't have it or because the feed broke.

**Fix direction:** define an explicit error state per card. Small icon + tooltip explaining "Oil feed unreachable — retrying in 5m."

## P4 — accessibility

### 14. No ARIA labels on numeric tiles
Screen readers announce the value but not the metric. "1054" instead of "Brent crude oil price: 105.4 dollars per barrel as of 12:34 UTC."

**Fix direction:** add `aria-label` to every value tile.

### 15. Color contrast on muted text
`--muted2` (#627a95) on `--panel` (#11161f) hits ~4.0:1 contrast. WCAG AA requires 4.5:1 for body text.

**Fix direction:** lighten `--muted2` to ~`#7a92ad` or restrict to ≥ 14px text where 3:1 is allowed.

### 16. Focus states are inconsistent
Some buttons have focus rings, some don't. Tab navigation through the dashboard is incomplete.

**Fix direction:** define a consistent `:focus-visible` style. Audit tab order through the page.

## P5 — performance

### 17. Mobile signal-bar fade-mask uses `mask-image`
Works on iOS Safari and modern Android Chrome, but eats GPU on lower-end devices.

**Fix direction:** consider a gradient overlay element instead of a mask filter on the parent.

### 18. 23+ `<svg>` elements rendered always
Even cards below the fold render their SVGs immediately. Mobile cold-load could be sped by deferring off-screen SVGs.

**Fix direction:** lazy-render cards in the right panel using `IntersectionObserver`. Especially impactful for mobile Intel tab.
