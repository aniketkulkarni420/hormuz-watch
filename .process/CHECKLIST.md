# CHECKLIST.md — Pre-Change Checklist

For any UI/UX change, fill out the following BEFORE editing code. Paste a filled copy into your commit message body or session notes.

```
Change: [one-line description of what is changing]

Files affected:
  - [path/to/file.html] — [what part]
  - [path/to/file.js]   — [what part]

Modes affected (see .process/MODES.md):
  [ ] AIS-mode
  [ ] Scrape-mode
  [ ] Empty-mode
  [ ] Loading-mode
  [ ] Error-mode

Downstream impact:
  - Who else reads this value/element/class?
  - Who else writes to it?
  - List grep results: `grep -rn "selectorOrId" .`

Mockup created:
  [ ] yes — path: mockups/YYYY-MM-DD-FEATURE.html
  [ ] no — reason: [must justify; see MOCKUP_FIRST.md for when skip is OK]

Tested in browser:
  [ ] yes — screenshot or DOM-diff reference: [where]
  [ ] no — reason: [must justify]

Verification commands (run AFTER push):
  curl -s https://hormuz-watch-2.pages.dev/ | grep '<selector>'
  curl -s https://hormuz-watch-2.pages.dev/api/snapshot | python -m json.tool | head -50
  [other curls relevant to the change]

User approved:
  [ ] yes — by whom + when
  [ ] no — STOP. Get approval first.
```

## Filled example

```
Change: Vessel Type Mix abbreviated labels + narrower .tbar-label column

Files affected:
  - index.html line 259 (.tbar-label CSS width)
  - index.html line 2303 (updateTypeBars function — abbreviation map)

Modes affected:
  [x] AIS-mode — bars render with new abbreviated labels + 66px column
  [x] Scrape-mode — same, scraped types pass through abbreviation map
  [ ] Empty-mode — no bars render, unaffected
  [ ] Loading-mode — no bars render, unaffected
  [ ] Error-mode — no bars render, unaffected

Downstream impact:
  - .tbar-label class: only used inside #typeBars > .tbar-row by updateTypeBars
  - No other CSS or JS reads .tbar-label width
  - grep confirmed 4 callsites all under updateTypeBars

Mockup created:
  [x] yes — design-audit.html section "1B"

Tested in browser:
  [x] design-audit.html locally; production curl post-push

User approved:
  [x] yes — "1B + 2B + all 8" message
```
