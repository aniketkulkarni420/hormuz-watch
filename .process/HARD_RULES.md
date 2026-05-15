# HARD_RULES.md — Never Do

These rules exist because each one corresponds to a real production regression on this repo. Violating any of them must be a conscious, user-authorized exception.

1. **NEVER push CSS dimension changes without a mockup.**
   Width/height/padding/margin changes ripple through surrounding layout. The `.tbar-label` width fix was a single-line CSS change that broke bar visual rhythm because no one previewed the result.

2. **NEVER trust an agent's "looks good" without independent verification.**
   Agents cannot see rendered UI. "I checked and it looks correct" is meaningless for visual changes. Get a user screenshot or DOM-diff confirmation.

3. **NEVER change a value used in 3+ places without a grep audit.**
   Find ALL readers and writers FIRST. `grep -n` the variable/ID/class name. Update or confirm-safe each call site before touching the source.

4. **NEVER add `display:none` without understanding why an element exists.**
   An element that looks "unused right now" may be intentional state for another mode (scrape-mode vs AIS-mode). Read the surrounding JS for `style.display = ""` resets before hiding.

5. **NEVER make a fix that "works for current state" without testing other modes.**
   Scrape-mode regressions have hit production multiple times because fixes were validated only against AIS-mode. See MODES.md — all 5 modes get checked.

6. **NEVER push without verifying via curl + DOM grep.**
   After deploy: `curl URL | grep "selector_or_id"` to confirm the change actually landed. CF Pages can serve stale cached HTML for several minutes; do not assume push = live.

7. **NEVER skip the Pre-Change Checklist for visual changes.**
   See CHECKLIST.md. Fill it out for your records. "I'll just do this quick fix" is the failure mode this prevents.

8. **NEVER push directly to main without explicit user authorization.**
   Has caused security warnings + revert pressure. Even on a personal repo. Wait for the user to say "push it" or "authorized."

9. **NEVER overwrite manual data with auto-scrape low-confidence values.**
   BDTI admin form has user-set values. Confidence-gate every scraper write — if scraper confidence is low, write to a separate audit key and email instead of clobbering the displayed value.

10. **NEVER label data as "LIVE" when it's >1h old or single-source unverified.**
    Source-attribution rules in SESSION_HANDOFF.md §17. Use `WEB FEED · Nh` / `EIA SPOT · as of date` / `DATA PENDING` instead. The user has explicitly called out fake-LIVE badges as a trust-breaking bug.

11. **NEVER touch a card renderer in `index.html` without updating `showcase/index.html`.**
    The showcase at `/showcase/` is the visual safety net — it renders each right-sidebar card across 6 data permutations and runs a DOM overflow tripwire. It works only if its renderers and CSS match the live page. When you change `_typeBarRow` / `renderTrend` / `renderConditionsCard`-equivalents / `renderPulseCard`-equivalents / `renderHeadlinesCard` or any `.rblock`-class CSS, mirror the change into `showcase/index.html` (look for `BEGIN-MIRRORED` / `END-MIRRORED` markers — those blocks must stay in sync) and re-run its self-test. Adding a new `.rblock` card to the live sidebar? Add a section with 6 permutations and register its ID in the showcase's `covered` set, or the coverage hint will keep nagging.
