# VERIFICATION.md — Post-Change Verification

After any code change, run these in order. Skip none.

## 1. JSON shape unchanged
Confirm affected endpoints still return same fields, same types.

```bash
curl -s https://hormuz-watch-2.pages.dev/api/snapshot | python -m json.tool | head -80
curl -s https://hormuz-watch-2.pages.dev/api/oil      | python -m json.tool | head -80
curl -s https://hormuz-watch-2.pages.dev/api/bdti     | python -m json.tool
```

If a field disappeared or its type changed, an IRM consumer or scraper may break.

## 2. Homepage DOM grep
Confirm the change actually deployed (CF Pages occasionally serves stale cache for ~minutes).

```bash
curl -s https://hormuz-watch-2.pages.dev/ | grep -o '<the-affected-selector[^>]*>'
curl -s https://hormuz-watch-2.pages.dev/ | grep 'data-version\|build-ts'
```

## 3. Smoke test
If a smoke test workflow exists for the affected area, trigger it.

```bash
gh workflow run smoke-test --repo aniketkulkarni420/hormuz-watch
gh run watch
```

## 4. Visual mode verification
For visual changes, verify all relevant modes from MODES.md render correctly.

- AIS-mode: requires AISStream working — currently broken, can't verify until recovery
- Scrape-mode: the current default — load https://hormuz-watch-2.pages.dev and confirm
- Empty / Loading / Error: simulate via DevTools (block fetch, slow network, return 500)

For automated verification use Playwright (`tests/dashboard.spec.js`).

## 5. Console clean
Open DevTools console on production page. Zero errors expected. Specifically watch for:
- `Cannot read properties of null` — orphan ID reference
- `Cannot set property of undefined` — DOM elem removed but JS still writes
- `Failed to fetch` — endpoint broken

## 6. Orphan ID audit
Any time you `display:none` an element OR remove it, grep for `getElementById("thatId")` and `querySelector("#thatId")`. If JS still references it, either delete those references or null-guard them.

```bash
grep -rn "getElementById(\"<id>\")" .
grep -rn "querySelector(\"#<id>\")" .
```
