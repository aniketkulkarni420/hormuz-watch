# .process/ — Mistake-Prevention System

This directory contains **operational rules** that future agents and sessions MUST follow. These are not aspirational documentation; they are gates.

## Philosophy

Visual + verification gates BEFORE any code change touching UX. Tunnel-vision fixes (e.g., widening a label without checking bar width impact, hiding an element without understanding why it existed) have caused real production regressions on this repo. This system makes those regressions impossible-to-miss instead of easy-to-miss.

## Files

| File | Purpose |
|---|---|
| `MOCKUP_FIRST.md` | Rule: visual changes need a `mockups/YYYY-MM-DD-FEATURE.html` mockup BEFORE code touched |
| `HARD_RULES.md` | The "never do" list. Read before any UI/UX change. |
| `MODES.md` | The 5 rendering modes every visual element must work in (AIS / Scrape / Empty / Loading / Error) |
| `CHECKLIST.md` | Pre-change checklist template — fill out before any UI change |
| `VERIFICATION.md` | Post-change verification commands (curl, DOM grep, smoke) |
| `DECISIONS.md` | Running architectural decision log |

## When this system applies

- ANY change to: CSS dimensions, layout, new tiles, card restructuring, color schemes, visual flow
- ANY change to data-source attribution badges (`src-green`, `src-blue`, `src-amber`, `src-red`)
- ANY change to JS that reads/writes DOM IDs that render in the right sidebar
- ANY change to scrape-mode / AIS-mode branching

If your change is purely backend (Python scraper, CF Function logic with no UI touch), this system is still recommended but the gate is lighter.

## Origin

Installed 2026-05-14 after recurring regressions:
1. `.tbar-label` width fix that broke bar widths
2. Stale AIS-era placeholder text visible in scrape-mode
3. `display:none` applied without understanding original purpose
