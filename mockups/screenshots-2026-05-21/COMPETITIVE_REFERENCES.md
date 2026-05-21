# Competitive references — what to learn from each

Designer shouldn't reinvent solved problems. These are the products to mine for visual + interaction patterns, and what NOT to copy.

## Bloomberg Terminal
- **Strength:** Information density done right. 30+ panels on screen with zero visual fatigue
- **Lesson:** Color is informational, not decorative. Borders > shadows. Tabular numerals everywhere
- **Don't copy:** The 1990s keyboard-first interaction model — our audience won't memorize commands
- **Specific elements to study:** GNRL — top-banner pulse, color-coded session bars, function-key navigation chrome

## TradingView
- **Strength:** Chart-first dashboards, mobile-class experience that doesn't feel dumbed down
- **Lesson:** Sticky sub-headers, lazy-rendered tiles below the fold, clean dark theme
- **Don't copy:** Heavy hover popups, social annotation layers (out of scope for us)
- **Specific elements:** Watchlist tiles · Sparkline + delta in one row · Hot-key zoom interactions

## Stratfor / Janes 360
- **Strength:** Geopolitical narrative + map-anchored intelligence
- **Lesson:** Story-mode (chronological event scroll) alongside data-mode
- **Don't copy:** Long-form prose-first layout, paywall everything
- **Specific elements:** Color-coded event timelines · Severity badges · Regional risk heatmaps

## MarineTraffic / VesselFinder
- **Strength:** Maritime-specific UI, vessel tracking density
- **Lesson:** Map-as-primary, filter chrome that doesn't overwhelm
- **Don't copy:** Pop-up ad chrome, free-tier nag screens
- **Specific elements:** Vessel marker hover-cards · Filter rail · Density heat overlays

## Stratfor — Worldview free dashboard
- **Strength:** Editorial voice + data context blended
- **Lesson:** Hero "today's read" + supporting evidence cards
- **Don't copy:** Tabbed nav that fragments scanning

## FT Markets dashboard
- **Strength:** Newspaper-grade typography, restrained color
- **Lesson:** Headlines + delta + sparkline in disciplined 3-column rows
- **Don't copy:** Pay-to-read affordances

## Visual Capitalist
- **Strength:** Information-rich infographics, "viral chart" energy
- **Lesson:** Annotation as design pattern (e.g., labeled peaks + troughs)
- **Don't copy:** Decorative chart junk, gradient explosions

## Quartz / Axios charts
- **Strength:** Minimal chart vocabulary, repeatable patterns
- **Lesson:** Less is more. Two colors per chart maximum
- **Don't copy:** Light-theme-only design

## Specific micro-interactions to study

| Reference | What | Why |
|---|---|---|
| Stripe dashboard | Skeleton loading | Best-in-class shimmer/skeleton patterns |
| Linear | Verdict color transitions | Subtle but informative state changes |
| Vercel | Hover tooltips | Position-aware, never clipped |
| Notion | Empty states | Conversational copy in zero-data tiles |
| GitHub | Mobile bottom-tab nav | Same pattern we use, refined chrome |
| Apple Maps | Map+overlay panel composition | When to obscure map vs preserve it |

## Anti-patterns — visible in many fintech products, AVOID

- **Glassmorphism** — frosted backgrounds eat readability
- **Neon accents** — eye fatigue for trader users
- **Excessive shadows** — flatness > depth in dark UIs
- **Skeuomorphic gauges** — info-density loss
- **Vague verdicts ("Caution", "Trending")** — be precise
- **Confetti / celebration animations** — never in geopolitical context
- **AI-summary tags** — we cite humans, not models, for editorial copy
- **"For You" personalization** — we have one audience, one dashboard
- **Streaks / gamification** — wrong product category
- **Dark-pattern "free trial"** — we are free forever

## Worth a deep dive

For the designer's first week, suggest spending an hour each with:

1. **Bloomberg Terminal demo videos** (YouTube has plenty) — for density patterns
2. **TradingView mobile app** — for chart+control mobile composition
3. **Stratfor Worldview** — for the editorial+data hybrid
4. **Apple Stocks app** — for clean dark-mode price-tile patterns
5. **Reuters Eikon** — for the closer-to-our-target enterprise feel

Then we'll know we're not redesigning in a vacuum.
