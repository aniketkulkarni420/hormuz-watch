# Aniket Design OS — canonical reference

**Status:** authored by Aniket Kulkarni · 2026-05-17 · governing document.

This document is the canonical Design Operating System for Aniket's products.
It is referenced by every design and product decision in this repository.
Where any rule in this repo conflicts with the OS, the OS wins unless the
conflict is explicitly logged and overridden in `.process/DECISIONS.md` with
the reason.

The OS is **product-mode aware** — Hormuz Watch consumes it primarily as
Mode 3 (dashboard / intelligence cockpit) with secondary Mode 2 (financial
analyser) for any India-equity / suitability-bearing surface. See
`.process/HORMUZ_MODE.md` for the project-specific mapping.

---

## Purpose

Reusable design decision system that adapts across product types while
keeping the same underlying standards of clarity, trust, usability, beauty,
accessibility, and business impact.

## Core philosophy

Do not ask: *"Does this look good?"*

Ask: *"Does this help the right user make the right decision with the right
level of trust?"*

The design must combine the **science** of design (usability, hierarchy,
accessibility, cognitive load, decision architecture, behavioral UX,
information design, data visualization, conversion, responsiveness,
performance, component reuse) with the **art** of design (taste, rhythm,
typography, spacing, emotion, brand feel, micro-interactions, visual
composition, premium perception, narrative, memorability).

## The final design should feel

premium · calm · serious · clear · trustworthy · data-backed ·
founder-led where relevant · decision-oriented · mobile-first but not
desktop-last.

## The design should never feel

generic SaaS · flashy for no reason · over-animated · cluttered · visually
impressive but functionally confusing · financially misleading ·
dashboard-heavy without prioritization · copied from creators or reference
products.

---

## Product modes (the seven)

Every project must be classified into one (or, sparingly, two) of these
before any design work begins.

1. **Founder / personal brand** — editorial, narrative, warm but serious
2. **Financial analyser** — trust-first, evidence-first, suitability-led
3. **Dashboard / intelligence cockpit** — compact, signal-first, timestamped
4. **Marketing / landing page** — clear, benefit-led, conversion-oriented
5. **Internal tool / workflow** — utilitarian, fast, forgiving
6. **Research interface** — document-like, evidence-first, citation-heavy
7. **AI assistant / guided decision** — conversational but controlled

Each mode has its own information density, visual language, trust
requirements, interaction style, and success metric. Do not force one
aesthetic across modes.

---

## Non-negotiable design principles

1. One primary job per screen.
2. One primary CTA per screen.
3. The user should understand the main point within 5 seconds.
4. Mobile-first information priority, desktop-native execution.
5. Do not make the desktop version look like stretched mobile.
6. Do not overload the first view with too many numbers.
7. Use progressive disclosure for depth.
8. Separate facts, interpretation, and recommendation.
9. Show sources and timestamps wherever data is used.
10. Avoid unsupported claims.
11. Avoid vague labels like "Insights" unless the insight is specific.
12. Avoid generic SaaS fluff.
13. Avoid unnecessary gradients, shadows, glassmorphism, or animation.
14. Use micro-interactions only to clarify, guide, confirm, or reduce anxiety.
15. Do not make financial products feel like games.
16. Do not hide important risks, caveats, assumptions, or methodology.
17. Every component should be reusable or intentionally one-off.
18. Every design decision should support clarity, trust, conversion, or usability.
19. Accessibility is not optional.
20. Old rules must not be blindly carried forward if newer decisions override them.

---

## Information hierarchy defaults

### Default (decision-bearing)

1. Verdict / key message
2. Reason
3. Evidence
4. Risk / caveat
5. Next action
6. Deep details

### Data-heavy (Mode 3 dashboards)

1. Current state
2. Change
3. Severity
4. Why it matters
5. Source
6. Action
7. Detail

### Marketing (Mode 4)

1. Promise
2. Relevance
3. Proof
4. Mechanism
5. CTA
6. Objection handling

### Required separation (Mode 2 financial)

Always separate, with visual or structural distance:

- **data / fact** — what the numbers say
- **interpretation** — what it appears to mean
- **recommendation or next step** — what to consider doing

Example phrasing:

- *Data:* Fund has underperformed category average over 3-year rolling
  periods.
- *Interpretation:* Performance consistency appears weak compared with peers.
- *Next step:* Compare with funds that have better downside control and
  similar investment style.

---

## Typography system

**Default sans-serif (pick one):** Manrope · Inter · Geist · IBM Plex Sans.
Mode 1 may add an editorial serif. Modes 2 + 3 prefer sans-serif only.
Tabular numerals are mandatory for financial and dashboard data.

### Type scale — desktop

| Level | Size |
|---|---|
| Display | 44–56 px |
| H1 | 36–44 px |
| H2 | 28–34 px |
| H3 | 20–24 px |
| Body | 15–17 px |
| Small | 12–14 px |
| Data labels | 11–13 px |

### Type scale — mobile

| Level | Size |
|---|---|
| Display | 32–40 px |
| H1 | 28–34 px |
| H2 | 22–28 px |
| H3 | 18–22 px |
| Body | 15–16 px |
| Small | 12–14 px |

### Type rules

1. Medium weight more than heavy weight.
2. Avoid shouting with excessive bold.
3. Body readable.
4. Tabular numerals for financial and dashboard data.
5. Short, human labels.
6. No decorative type where comprehension matters.
7. Specific headings, not generic.
8. Avoid all-caps except for tiny labels.
9. Heading line-height ~1.35.
10. Body line-height 1.5–1.65.

---

## Color system

Start with **roles**, not hex codes.

### Core roles

background · surface · elevated surface · primary text · secondary text ·
muted text · border · primary action · secondary action · positive ·
negative · warning · neutral · information · locked / premium · evidence /
source · AI interpretation · human review required.

### Direction by mode

- **Personal brand:** warm off-white bg · charcoal text · muted blue/green
  /stone/graphite accent · one signature accent · minimal but memorable
- **Financial analyser:** light bg preferred · calm navy / graphite / deep
  blue base · muted green for verified positive · amber for caution · red
  only for material risk · blue for evidence · avoid trading-signal colours
- **Dashboard:** dark or light · dark only if it improves cockpit
  monitoring · avoid neon · status colours accessible · do not rely on
  colour alone

### Color rules

1. Every colour must have a role.
2. No green/red without text labels.
3. No financial safety implied by colour alone.
4. Muted colours for serious financial products.
5. Sufficient contrast for accessibility.
6. Sparse accent colour use.
7. Few status colours per screen.
8. Premium ≠ low contrast.

---

## Spacing system

| Token | Px |
|---|---|
| micro | 4 |
| compact | 8 |
| small | 12 |
| default | 16 |
| section | 24 |
| large | 32 |
| major | 48 |
| hero | 64 |

### Spacing rules

1. Consistent rhythm > one-off spacing.
2. More whitespace around important decisions.
3. Tighter spacing for related items.
4. Generous spacing for mode shifts.
5. No cramped mobile cards.
6. No overly dispersed desktop pages.

---

## Radius system

- 8 px: inputs, chips, small controls
- 12 px: compact cards
- 16 px: standard cards
- 24 px: premium hero / feature containers

### Radius rules

1. Not huge radius everywhere.
2. Financial UI feels stable, not playful.
3. Personal brand can be expressive.
4. Dashboards use radius to group, not decorate.

---

## Elevation / shadow

Prefer borders, subtle backgrounds, and layering before heavy shadows.

1. Financial products feel grounded.
2. Dashboards feel layered, not floating.
3. Personal brand sites may use more depth.
4. Avoid heavy drop shadows.
5. Use elevation to show hierarchy and interactivity.

---

## Layout system

### Mobile rules

1. Start at 360 px width.
2. One decision at a time.
3. Sticky key actions only when needed.
4. Comfortable tap targets.
5. Accordions and drawers for details.
6. No hover-only information.
7. Keep important labels visible.
8. Avoid wide tables — use cards, comparison drawers, or horizontal scroll
   only when necessary.

### Desktop rules

1. Do not stretch mobile.
2. Multi-column where useful.
3. Controlled reading width.
4. Side panels for context.
5. Split layouts for analysis + evidence.
6. More density only if it improves decision-making.
7. Avoid excessive vertical scrolling from mobile-first overcorrection.

### Grid rules

1. 4-column mobile logic.
2. 8 or 12-column desktop logic.
3. Consistent card and section alignment.
4. No random widths.
5. Layout shows priority.

---

## Component library

### Universal

Button · Link · Input · Select · Checkbox · Radio · Tabs · Pills/chips ·
Card · Modal · Drawer · Tooltip · Popover · Accordion · Toast · Badge ·
Empty state · Loading state · Error state · Source label ·
Timestamp label · Section header · Page header · Navigation · Breadcrumb.

### Financial analyser (Mode 2)

Verdict card · Score card · Suitability card · Risk card · Evidence panel ·
Assumption panel · Methodology drawer · Comparison table ·
Holding-quality card · Expense-comparison block · Rolling-return block ·
Drawdown block · Portfolio-overlap block · Locked-insight card ·
Compliance-disclaimer block · Source-and-freshness block.

### Dashboard (Mode 3)

Metric card · Signal card · Alert row · Trend chip · Severity badge ·
Confidence badge · Compact chart · Source map · Drilldown drawer ·
Watchlist row · Review flag · Change-since-previous-update label ·
Top status strip · *Ignore / Monitor / Act* classifier.

### Personal brand (Mode 1)

Hero block · Proof strip · Case study card · Principle card · Timeline ·
Essay card · Featured project card · Contact block · Collaboration CTA ·
Founder-note block.

### Specification format for every component

1. Purpose
2. Anatomy
3. Variants
4. States
5. Behavior
6. Accessibility rules
7. Content rules
8. Mobile behavior
9. Desktop behavior
10. When *not* to use it

---

## Component rules

### Button rules

1. One primary button per screen.
2. Secondary buttons must not compete visually.
3. Button copy is action-specific.
4. Avoid vague CTAs ("Submit", "Learn more") unless context is obvious.
5. Hover, active, disabled, loading, and focus states must be visible.

### Card rules

1. Cards group one concept.
2. No unrelated data in the same card.
3. Cards have clear headings.
4. Cards are not decorative boxes.
5. Avoid nesting.
6. Cards improve scanning.

### Tooltip rules

1. Tooltips explain, do not hide core information.
2. Essential information cannot live only in a tooltip.
3. Tooltips are short.
4. Tooltips work on mobile or have an alternative.
5. Use for definitions, caveats, methodology snippets.

---

## Micro-interactions

### Purpose of motion

Hierarchy · confirmation · reveal · state change · loading-anxiety
reduction · attention guidance. Not "because it looks cool."

### Recommended

- hover: subtle border or background shift
- tap: immediate feedback
- loading: skeletons for data-heavy content
- success: calm confirmation
- error: explain what happened and how to fix
- expand/collapse: smooth but fast
- chart update: animate changed value only
- locked content: gently signal premium, do not annoy

### Avoid

Confetti in financial products · flashing alerts · excessive parallax ·
fake AI typing delays · animations that slow decisions · hover-only on
mobile · gamified investment decisions.

---

## Data visualization rules

**Core:** start with the question, not the chart type.

For every chart or metric, define:

1. What question does it answer?
2. Why does it matter?
3. What timeframe is used?
4. What is the source?
5. What is the interpretation?
6. What caveat exists?
7. What should the user do with it?

### Chart selection

- Line chart: trend over time
- Bar chart: comparison
- Scatter plot: relationship between variables
- Table: precision + detailed comparison
- Heatmap: scanning many values
- Area chart: cumulative / composition trend
- Small multiples: comparing trends across categories

### Avoid

Pie charts unless composition is extremely simple · 3D charts · decorative
charts · unlabeled charts · charts without timeframe · charts without
source · charts where colour alone communicates meaning.

---

## Content / UX copy rules

1. Plain English.
2. Specific.
3. No vague labels.
4. No inflated claims.
5. No overpromising.
6. Human but serious.
7. Explain why something matters.
8. Labels reduce confusion.
9. Fewer words, not at the cost of clarity.
10. No generic SaaS phrases.

### Good replacements

| Instead of | Use |
|---|---|
| "Unlock powerful insights" | "See what changed and why it matters." |
| "Explore funds" | "Compare this fund with peers." |
| "AI-powered intelligence" | "AI-assisted summary with source-backed evidence." |
| "High risk" | "High downside risk based on past drawdowns." |

---

## Trust rules for financial products (Mode 2)

1. Always show source.
2. Always show "as on" date.
3. Separate data from interpretation.
4. Show methodology where scores are used.
5. Show assumptions clearly.
6. Show caveats before strong conclusions.
7. Avoid misleading certainty.
8. Use suitability language carefully.
9. Avoid language that sounds like personalized investment advice unless
   licensed and appropriate.
10. No false urgency.
11. Explain limitations.
12. Show benchmark context.
13. Show both positives and risks.
14. Make locked content ethical and transparent.

---

## Accessibility rules

1. Sufficient contrast.
2. Visible focus states.
3. Keyboard navigation.
4. Comfortable tap targets.
5. Not colour-only.
6. Screen-reader semantic structure.
7. Proper input labels.
8. No tiny text for important information.
9. Accessible modals and drawers.
10. Reduced-motion alternatives.
11. Clear, field-connected error messages.
12. Tested at 360 px mobile width.

---

## QA checklist (every design)

### Clarity gate
- Main point in 5 seconds?
- Primary CTA obvious?
- Is the screen trying to do too much?

### Trust gate
- Data, interpretation, recommendation separated?
- Sources visible?
- Timestamps visible?
- Caveats visible?

### Hierarchy gate
- One dominant message?
- Sections ordered by decision importance?
- Visual weights controlled?

### Accessibility gate
- Contrast acceptable?
- Focus states visible?
- Tap targets comfortable?
- Keyboard navigation possible?
- Colour supported by text or icons?

### Mobile gate
- Works at 360 px?
- Important actions reachable?
- Tables handled well?
- Detail progressively disclosed?

### Desktop gate
- Desktop space used intelligently?
- Not just stretched mobile?
- Content not overly dispersed?

### Data gate
- Every chart answers a real question?
- Timeframe visible?
- Source visible?
- Interpretation visible?

### Component gate
- Components reusable?
- States defined?
- Variants controlled?
- Avoidable one-off styling absent?

### Compliance gate
- Financial language careful?
- Assumptions and limitations clear?
- UI avoiding false certainty?

---

## Governance

All rules tagged as one of: **latest approved · experimental · deprecated ·
product-specific · unresolved**.

Each rule carries metadata: mode · layer · source · confidence · date added
· reason · examples.

### Tag values

**Mode:** personal-brand · analyser · dashboard · landing-page ·
internal-tool · research-interface · AI-guided-flow.

**Layer:** typography · color · spacing · layout · component · interaction
· copy · data-viz · accessibility · trust · conversion.

**Confidence:** proven · inferred · experimental.

**Source:** creator video timestamp · Mobbin screenshot · official design
system · own product decision · user-approved rule.

---

## Devil's-advocate warnings

1. Do not overfit to design creators.
2. Do not confuse a moodboard with a system.
3. Do not mix product modes carelessly.
4. Do not over-design dashboards.
5. Do not make financial tools too confident.
6. Do not ignore desktop.
7. Do not carry forward stale rules.

---

## Open questions (Aniket's call)

These do not block work but should be resolved as the system matures:

1. Signature visual identity across personal brand and products.
2. Default product palette — warmer/editorial or colder/financial.
3. Dashboards default to light, dark, or both.
4. Financial analyser products use scores prominently or softer labels first.
5. Exact compliance disclaimer level per product type.
6. Which products get design tokens in code first.
7. Tailwind variables vs CSS variables vs Figma tokens (or all three).
8. Which 5 components built first as reusable production components.

### First-5 components proposed by the OS

1. Verdict card
2. Metric card
3. Evidence panel
4. Risk / caveat card
5. Source-and-timestamp label

### First-5 screens proposed by the OS

1. Personal brand homepage hero
2. Mutual fund analyser result screen
3. Dashboard overview screen
4. Research evidence screen
5. Landing page pricing / CTA screen

---

## Final instruction for any AI assistant using this document

Do not simply generate pretty designs. Use this document as a decision
system.

For every design task:

1. Classify the product mode.
2. Define the user's decision.
3. Choose the right information hierarchy.
4. Apply the correct visual language.
5. Use reusable components and tokens.
6. Separate facts, interpretation, and recommendation where relevant.
7. Show sources and timestamps for data-heavy products.
8. Use progressive disclosure.
9. Audit the result brutally.
10. Provide implementation-ready instructions.

The final output should be beautiful, but beauty is not the goal. The goal
is **trustworthy decision-making through excellent design.**
