# Working on this repo

## Before any UX/UI change, READ:
- `.process/MOCKUP_FIRST.md` — visual changes require a mockup first
- `.process/HARD_RULES.md` — the "never do" list (10 rules)
- `.process/CHECKLIST.md` — fill this out before editing
- `.process/MODES.md` — the 5 rendering modes every visual element must handle

## Before any code change:
- Read the file FULLY (not just the lines being changed)
- Grep for all readers/writers of any changed values, IDs, classes
- Test all 5 rendering modes (see `.process/MODES.md`)
- Get user approval for visual changes

## After any code change:
- Follow `.process/VERIFICATION.md` — curl + DOM grep + smoke + console check + orphan-ID audit

## Decisions
- Log architectural decisions in `.process/DECISIONS.md` (newest-first, append-only)

## Push to main
Don't push to main without explicit user authorization. The user explicitly grants this per-session.

## Full context
- `SESSION_HANDOFF.md` — current production state, all data sources, all decisions, all open items
