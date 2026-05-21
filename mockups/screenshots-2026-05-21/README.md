# Hormuz Watch — Redesign handover · 2026-05-21

This folder is the **complete handover pack for Claude Design**. Drop the right files in the right order; the docs guide the brief.

## TL;DR for the designer

1. Read `DESIGN_BRIEF.md` first — covers who/why/constraints/success.
2. Read `DESIGN_TOKENS.md` — current palette + type + spacing.
3. Read `DO_NOT_REDESIGN.md` — patterns that are compliance- or brand-locked.
4. Then open the **curated 25** under `cards/` and `full/` (list in `DESIGN_BRIEF.md` §9). Skip the rest unless asked.
5. Use `KNOWN_ISSUES.md` and `EDGE_CASES.md` as the explicit punch list.

## Folder map

```
screenshots-2026-05-21/
├── README.md                  ← you are here
├── DESIGN_BRIEF.md            ← master brief (who/why/constraints/success)
├── DESIGN_TOKENS.md           ← current CSS variables + type system
├── DO_NOT_REDESIGN.md         ← patterns that must survive a redesign
├── KNOWN_ISSUES.md            ← explicit punch list of what's weak
├── EDGE_CASES.md              ← states designer must handle (loading/error/crisis/etc.)
├── DATA_DICTIONARY.md         ← every metric explained (what matters, what's noise)
├── COMPETITIVE_REFERENCES.md  ← comparable products + what to learn from each
├── contact-sheet.html         ← gallery view of every PNG
├── full/      6 PNGs          ← full-page per viewport (375→1920)
├── states/   38 PNGs          ← progressive disclosures (tabs, tooltips, scroll)
└── cards/   126 PNGs          ← isolated components per viewport
```

## Live reference

- **URL:** https://hormuz-watch-2.pages.dev/
- **Repo:** https://github.com/aniketkulkarni420/hormuz-watch
- **Single source file:** `index.html` (~5400 lines — intentional, no SPA framework)

## Who built this & why

- **Aniket Kulkarni** · SEBI-registered Research Analyst (INH000009843) · 15+ yrs in product/markets
- Built as a public-good intelligence aggregator for the Strait of Hormuz crisis tracker
- Free, no login, no ads
- Powers India Risk Monitor's `hormuz_throughput` metric via `/api/snapshot`

## How long the redesign should take

- Hierarchy + first principles: ~1 week
- High-fidelity mockups for top 8 cards + 2 viewports: ~1 week
- Iteration: ~1 week
- Implementation back into single `index.html`: ~3 days
- Total: 3-4 weeks
