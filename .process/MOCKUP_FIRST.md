# MOCKUP_FIRST.md

## Rule

Any change to:

- CSS dimensions (width / height / padding / margin / gap)
- Layout (grid, flex, ordering)
- New tiles or removed tiles
- Card restructuring
- Color schemes or source-badge colors
- Visual flow (what appears above/below what)

**REQUIRES a mockup HTML file BEFORE any code changes.**

## Mockup requirements

The mockup must:

1. **Show current state** — render the deployed look so the reviewer can compare
2. **Show proposed state(s)** — at least 2 options when there's a real design decision
3. **Be openable in a browser** — standalone HTML, no build step
4. **Be saved as** `mockups/YYYY-MM-DD-FEATURE.html`
5. **Get explicit user approval** before code changes land

## Why

- Agents cannot see rendered UI. The mockup is the only way the user can give informed approval before code lands in production.
- "Looks fine to me" from an agent is meaningless for visual changes — they didn't see it.
- A 10-minute mockup prevents a 2-hour revert + redeploy + apology cycle.

## When you may skip

- Backend-only changes (scraper logic, CF Function returning JSON, KV writes)
- Pure copy edits (changing a label string by ≤3 chars) — but flag in commit message
- Removing dead code that has never rendered (confirmed via grep — no readers, no writers)

If unsure → make the mockup. Cost is low.
