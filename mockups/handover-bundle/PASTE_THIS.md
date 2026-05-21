# Claude Project setup — copy/paste guide

Three things to copy into claude.ai when you create the new Project.

---

## 1. Project NAME

```
Hormuz Watch — Redesign · 2026-05-21
```

---

## 2. Project DESCRIPTION (optional one-liner)

```
Redesign brief for the Hormuz Watch real-time intelligence dashboard. Live at hormuz-watch-2.pages.dev. Trader audience, SEBI-compliant, single index.html.
```

---

## 3. Project INSTRUCTIONS (system prompt for the Project)

Paste this into the Project's **"Custom instructions"** or **"Set project instructions"** field:

```
You are an expert product/UI designer working on a redesign of Hormuz Watch — a public-good real-time intelligence dashboard for the Strait of Hormuz crisis.

CONTEXT
- Live URL: https://hormuz-watch-2.pages.dev/
- Single index.html file, no SPA framework (Cloudflare Pages)
- Dark theme, mono-numeric, trader-density-first
- Three audiences (in priority order): commodity desk analysts, geopolitical researchers, sophisticated retail
- Voice: data-first, no hedging, no recommendation grammar (SEBI compliance hard-stop)

WHAT'S IN THIS PROJECT
8 markdown docs and 25 curated screenshots, all uploaded as Project files:

DOCS (read in this order)
1. README.md — folder map, 30-second orientation
2. DESIGN_BRIEF.md — MASTER doc covering who/why/voice/IA/success
3. DESIGN_TOKENS.md — current color/type/spacing system
4. DO_NOT_REDESIGN.md — 8 compliance/brand-locked patterns
5. KNOWN_ISSUES.md — 18-item punch list (P0 to P5) the redesign must solve
6. EDGE_CASES.md — data/layout/interaction states designer must handle
7. DATA_DICTIONARY.md — every metric explained
8. COMPETITIVE_REFERENCES.md — Bloomberg / TradingView / Stratfor patterns

SCREENSHOTS (in screenshots/ subfolder)
25 curated PNGs:
- 6 full-page layout shots across viewports (375 / 768 / 1440)
- 4 signature feature isolations (cargo ticker, brent trend, verdict, india panel)
- 8 weak-card isolations (conditions, xv-list, historical, unctad, cape, fertilizer, lng, currency)
- 5 mobile-specific (signal bar, tabs, cargo, intel scroll, footer)
- 2 interaction states (signal tile tooltip, cargo tooltip)

YOUR FIRST OUTPUT
Don't propose any visual design yet. First read DESIGN_BRIEF.md end-to-end and produce:
1. A summary of your understanding of the product, audience, and constraints
2. Your interpretation of the primary user task (the 5-second test)
3. Three sharp questions you have before designing anything
4. Your proposed redesign methodology (research → IA → component → animation, in what order, at what fidelity)

After I respond to those questions, you'll proceed to actual redesign work.

CONSTRAINTS YOU MUST NEVER VIOLATE
- SEBI Research Analyst regulation (no buy/sell/recommend language)
- The 3-layer compliance treatment on the India panel (Data / Interpretation / Not Advice)
- Single index.html, no React/Vue/Svelte/Next
- Cloudflare Pages deployment
- Google Fonts only (Manrope + JetBrains Mono)
- Tabular numerals on all numbers
- Dark theme only
- Map (Leaflet) must remain

Full constraint list is in DO_NOT_REDESIGN.md.

OUTPUT FORMAT
When you propose layouts or components, you may use ASCII wireframes, written specifications, or describe Figma frames. You do NOT need to write code — implementation is downstream. Focus on visual + interaction + information-architecture decisions.
```

---

## 4. First MESSAGE (paste this as your first chat message after upload)

```
The 8 docs and 25 screenshots are uploaded to this Project. Live dashboard is at https://hormuz-watch-2.pages.dev/ if you want to see the real thing.

Please start by reading DESIGN_BRIEF.md end-to-end, then skim DO_NOT_REDESIGN.md and KNOWN_ISSUES.md. Then give me your "first output" as specified in the project instructions — understanding summary, 5-second-test interpretation, three sharp questions, proposed methodology.

Don't propose any visual design yet. We'll iterate on methodology first, then move to wireframes, then to component-level redesigns of the 8 weakest cards in KNOWN_ISSUES.md.
```

---

## 5. The actual click-through (60 seconds)

1. Open https://claude.ai/projects
2. Click **"+ Create project"**
3. Name + description from sections 1-2 above
4. Click into the new project → **"Add knowledge"** or **"Set instructions"** → paste section 3
5. Drag the ZIP onto the upload zone:
   ```
   C:\Users\anike\Desktop\hormuz-watch\mockups\handover-bundle\hormuz-watch-redesign-handover.zip
   ```
   Or extract the ZIP first and drag the 8 .md files + screenshots/ folder
6. Open a new conversation in the project → paste section 4 as the first message
7. Wait for Claude Design to respond with its understanding + questions

---

## 6. If Claude.ai's Project upload doesn't accept ZIPs

Extract the ZIP first:
```
Right-click the ZIP → Extract All → choose any folder
```
You'll get:
- 8 .md files at root
- `screenshots/` folder with 25 PNGs

Drag everything as individual files into the Project's knowledge area. Claude.ai accepts multi-file uploads.

---

## 7. Suggested follow-up prompts after Claude's first response

Once Claude gives its understanding + questions, you can respond with these in sequence:

**Round 2 — answer their questions, then ask for IA proposal:**
```
[Answer their 3 questions in your own words]

Now propose: a new information hierarchy. Take the 20+ tiles currently in the right panel and group them into 3-5 sections. For each section, explain why those tiles belong together and what the user task is for that section. Use the EDGE_CASES.md crisis scenario as a stress test — does the hierarchy hold up when the verdict goes CRITICAL?
```

**Round 3 — first component redesign:**
```
Now redesign the verdict-block component (see cards/05-desktop-verdict-block.png and the discussion in KNOWN_ISSUES.md item #3). Provide:
1. ASCII wireframe or written spec
2. Three variants at different levels of visual prominence
3. How each variant behaves in NORMAL / ELEVATED / HIGH / CRITICAL states
4. Animation/transition spec when verdict level changes
```

**Round 4 — mobile-first revisit:**
```
Now take the verdict redesign you just proposed and adapt it for iPhone SE (375px). Reference cards/01-iphone-se-tab-intel.png for the current mobile state.
```

**Round 5+ — repeat for each P0-P1 item in KNOWN_ISSUES.md.**

---

## 8. What to expect from Claude Design

A good first response from Claude Design should:
- Demonstrate it actually read DESIGN_BRIEF.md (cite specific sections)
- Ask about THE WHO, not just the WHAT (e.g. "is persona 1 reading on a 4K monitor or laptop screen at a desk?")
- Question something in DO_NOT_REDESIGN.md (challenge a locked pattern, even if you ultimately keep it)
- Propose methodology that prioritizes research over pixels

A weak first response will jump straight to "here's my idea for a new color palette." If that happens, send back:
```
You're starting at pixels. Go back to DESIGN_BRIEF.md §3 (the 5-second test) and tell me how you'd verify the redesign passes it before any visual work begins.
```

---

That's the complete bundle. Three copy-paste blocks + one ZIP upload + one starting message. ~60 seconds of clicking.
